// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV extra guides, Stage 2 (docs/superpowers/specs/2026-11-14-livetv-extra-guides-design.md *Import and refresh*): uploaded XMLTV
 * files. The upload is streamed to `<PREVIEW_DIR>/livetv-guides/<id>.pending.xml[.gz]`, imported through livetv's signed
 * `POST /v1/parse/xmltv` (faked here; the backend never parses XML) and only then becomes the guide's file.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { livetvKey, signLivetvHash } from '../src/livetv/client.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { nowNext } from '../src/livetv/epg.js';
import { guideDir } from '../src/livetv/guidefiles.js';
import { livetvRefreshTick, refreshRunning, uploadGuideFile } from '../src/livetv/refresh.js';
import { ENC_KEY, cfg, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
let anna: Sess;
const key = keyFromBase64(ENC_KEY);
const HINT = 'https://iptv.example.com/…';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- the fake livetv: `/v1/parse/xmltv` answers the guide registered for the posted file's bytes, filtered like livetv does ----
type Guide = { channels: Array<{ id: string; names: string[] }>; progs: Array<{ ch: string; start: number; end: number; title: string }> };
/** by the SHA-256 of the file as uploaded; `fail` = the programme run (or every run) ends with an error line */
const files = new Map<string, { guide: Guide; fail?: 'programmes' | 'always' }>();
type Parsed = { head: { from: number; to: number; channels?: string[] }; file: string };
const parsed: Parsed[] = [];
/** a parse that waits for this gate before it answers (a running import) */
let gate: Promise<void> | null = null;
const now = Date.now();
const guide = (chs: Array<[string, string]>): Guide => ({
  channels: chs.map(([id, name]) => ({ id, names: [name] })),
  progs: chs.map(([id, name]) => ({ ch: id, start: now - 30 * 60_000, end: now + 30 * 60_000, title: `Jetzt auf ${name}` })),
});
const SIGN_KEY = livetvKey(cfg.INTERNAL_SECRET);

async function parseAnswer(init: RequestInit): Promise<Response> {
  const h = init.headers as Record<string, string>;
  const bytes = Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
  // the body is the signed one: its hash is declared, signed, and the bytes match it; its length is declared too
  expect(sha(bytes)).toBe(h['x-ff-livetv-body-sha256']);
  expect(signLivetvHash(SIGN_KEY, 'POST', '/v1/parse/xmltv', sha(bytes), h['x-ff-livetv-ts'], h['x-ff-livetv-nonce'])['x-ff-livetv-signature']).toBe(h['x-ff-livetv-signature']);
  expect([h['content-type'], h['content-length']]).toEqual(['application/octet-stream', String(bytes.length)]);
  const nl = bytes.indexOf(0x0a);
  const head = JSON.parse(bytes.subarray(0, nl).toString('utf8')) as Parsed['head'];
  const file = bytes.subarray(nl + 1);
  parsed.push({ head, file: sha(file) });
  if (gate) await gate;
  const f = files.get(sha(file));
  const index = head.to === 1;
  const lines: unknown[] = [];
  if (!f || f.fail === 'always' || (f.fail === 'programmes' && !index)) lines.push({ t: 'channel', id: 'halb.int', names: ['Halb'] }, { t: 'error', code: 'invalid' });
  else {
    const want = (id: string) => !head.channels || head.channels.includes(id);
    for (const c of f.guide.channels) if (want(c.id)) lines.push({ t: 'channel', ...c });
    let programmes = 0;
    for (const p of f.guide.progs) {
      if (!want(p.ch) || p.end < head.from || p.start > head.to) continue;
      lines.push({ t: 'prog', ...p });
      programmes++;
    }
    lines.push({ t: 'end', programmes, channels: lines.length - programmes });
  }
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
}
const indexRuns = () => parsed.filter((p) => p.head.to === 1);

let addr = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
const upload = (id: string, bytes: Buffer, o: { type?: string; name?: string; headers?: Record<string, string> } = {}) =>
  env.app.inject({
    method: 'PUT', url: `/api/admin/livetv/sources/${id}/file${o.name ? `?name=${encodeURIComponent(o.name)}` : ''}`, payload: bytes, cookies: admin.cookies,
    headers: { 'x-csrf-token': admin.csrf, 'content-type': o.type ?? 'application/gzip', ...o.headers }, remoteAddress: `192.0.2.${++addr % 200 + 1}`,
  });
const row = async (id: string) => (await env.pool.query('select * from livetv_sources where id = $1', [id])).rows[0];
const view = async (id: string) => ((await call('GET', '/api/admin/livetv/sources')).json() as Array<Record<string, unknown> & { id: string }>).find((s) => s.id === id)!;
/** the upload's import runs after the 202: wait until its lock is gone */
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 200 && (await refreshRunning(env.ctx, id)); i++) await new Promise((r) => setTimeout(r, 10));
  expect(await refreshRunning(env.ctx, id)).toBe(false);
}
const dirFiles = (id: string) => { try { return readdirSync(guideDir(env.ctx)).filter((f) => f.startsWith(id)).sort(); } catch { return []; } };

async function addList(name = 'Nordlicht Paket'): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, position, last_refresh_at) values ($1, 'm3u', $2, $3, $4, 0, now())`,
    [id, name, encrypt(key, 'https://iptv.example.com/get.php?u=anna&p=geheim'), HINT]);
  return id;
}
async function addChannel(sourceId: string, name: string): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name) values ($1, $2, $3, $4, 'ts', $5)`,
    [id, sourceId, `k-${id}`, encrypt(key, 'https://iptv.example.com/live/1.ts'), name]);
  return id;
}
const createFileGuide = (b: Record<string, unknown> = {}) =>
  call('POST', '/api/admin/livetv/sources', { kind: 'guide', guideProvider: 'xmltv_file', name: 'Sternwarte Datei', guideScope: null, ...b });

// two guide files: A knows Sternwarte 24, B knows Sternwarte 24 and Hafenkanal
const FILE_A = gzipSync(Buffer.from('<tv><!-- Datei A: Sternwarte --></tv>'));
const FILE_B = Buffer.from('<tv><!-- Datei B: Sternwarte und Hafen --></tv>');

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  await env.pool.query(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
     values (gen_random_uuid(), 'sub-anna', 'anna@friend.example.com', 'Anna Beispiel', 'family', $1, 'Anna', $2) on conflict do nothing`,
    ['3'.repeat(32), encrypt(key, 'pw')]);
  anna = await env.login({ sub: 'sub-anna', email: 'anna@friend.example.com', name: 'Anna Beispiel', groups: [] });
  env.ctx.cfg = { ...env.ctx.cfg, PREVIEW_DIR: mkdtempSync(join(tmpdir(), 'ff-guidefiles-')) };
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query(`delete from livetv_programmes; delete from livetv_programmes_stage; delete from livetv_epg_channels; delete from livetv_channels;
    delete from livetv_sources; delete from audit_log`);
  for (const k of await env.kv.keys('ltv')) await env.kv.del(k);
  files.clear();
  files.set(sha(FILE_A), { guide: guide([['sternwarte.int', 'Sternwarte 24']]) });
  files.set(sha(FILE_B), { guide: guide([['sternwarte.int', 'Sternwarte 24'], ['hafen.int', 'Hafenkanal']]) });
  parsed.length = 0;
  gate = null;
  const base = fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '1.0.0', bootId: '0123456789abcdef' } }),
    'POST /v1/fetch/logo': () => ({ status: 404, json: { error: 'not_found' } }),
  });
  env.ctx.fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (new URL(String(input)).pathname === '/v1/parse/xmltv') return parseAnswer(init);
    return base(input, init);
  }) as typeof fetch;
  await detectLivetv(env.ctx, 0);
});

describe('uploaded guide files (Task 5)', () => {
  it('creates a file guide: no link, refresh manual, no file yet; link fields are refused', async () => {
    const r = await createFileGuide({ epgShiftMin: 60 });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'guide', guideProvider: 'xmltv_file', refresh: 'manual', epgHint: null, epgShiftMin: 60, fileName: null, fileBytes: null });
    expect(await row(r.json().id)).toMatchObject({ epg_url_enc: null, guide_file: null, guide_provider: 'xmltv_file' });
    // a link guide is still the default; lists carry the new fields as null
    const link = await call('POST', '/api/admin/livetv/sources', { kind: 'guide', name: 'Link', epgUrl: 'https://iptv.example.com/guide.xml', guideScope: null });
    expect(link.json()).toMatchObject({ guideProvider: 'xmltv_url', fileName: null, fileBytes: null });
    for (const [b, field] of [[{ epgUrl: 'https://iptv.example.com/guide.xml' }, 'epgUrl'], [{ refresh: '24h' }, 'refresh'], [{ allowLan: true }, 'allowLan'], [{ guideProvider: 'api' }, 'guideProvider']] as const) {
      expect((await createFileGuide(b)).json()).toEqual({ error: 'invalid', field });
    }
    const id = r.json().id as string;
    for (const [b, field] of [[{ epgUrl: 'https://iptv.example.com/guide.xml' }, 'epgUrl'], [{ refresh: '6h' }, 'refresh'], [{ userAgent: 'Box' }, 'userAgent']] as const) {
      expect((await call('PATCH', `/api/admin/livetv/sources/${id}`, b)).json()).toEqual({ error: 'invalid', field });
    }
    expect((await call('PATCH', `/api/admin/livetv/sources/${id}`, { name: 'Neu', refresh: 'manual' })).json()).toMatchObject({ name: 'Neu', refresh: 'manual' });
    // nothing to refresh before a file came
    expect((await call('POST', `/api/admin/livetv/sources/${id}/refresh`)).json()).toEqual({ error: 'no_file' });
  });

  it('an upload is streamed to the pending file and imported; success makes it the guide file with its name and size', async () => {
    const list = await addList();
    const ch = await addChannel(list, 'Sternwarte 24');
    const id = (await createFileGuide()).json().id as string;
    const r = await upload(id, FILE_A, { name: 'C:\\Downloads\\international\u0007.xml.gz' });
    expect([r.statusCode, r.json()]).toEqual([202, { started: true }]);
    await settle(id);
    // index run, then the programme run filtered to what a channel can use; both posted the same file
    expect(parsed.map((p) => [p.file, p.head.to === 1, p.head.channels])).toEqual([[sha(FILE_A), true, undefined], [sha(FILE_A), false, ['sternwarte.int']]]);
    expect(dirFiles(id)).toEqual([`${id}.xml.gz`]);
    expect(readFileSync(join(guideDir(env.ctx), `${id}.xml.gz`))).toEqual(FILE_A);
    expect(await view(id)).toMatchObject({ fileName: 'international.xml.gz', fileBytes: FILE_A.length, servedChannels: 1, state: { epg: { lastError: null, programmes: 1 } } });
    expect(await row(id)).toMatchObject({ guide_file: `${id}.xml.gz`, epg_last_error: null });
    expect((await env.pool.query('select epg_source_id, epg_channel_id from livetv_channels where id = $1', [ch])).rows[0]).toEqual({ epg_source_id: id, epg_channel_id: 'sternwarte.int' });
    expect((await nowNext(env.ctx, [ch])).get(ch)?.now?.title).toBe('Jetzt auf Sternwarte 24');
    expect((await env.pool.query("select meta from audit_log where action = 'livetv.source.file' and target = $1", [id])).rows).toEqual([{ meta: { fields: ['file'] } }]);
    // a plain file replaces the gzip one (the other kind goes)
    await upload(id, FILE_B, { type: 'text/xml' });
    await settle(id);
    expect(dirFiles(id)).toEqual([`${id}.xml`]);
    expect(await view(id)).toMatchObject({ fileName: 'guide.xml', fileBytes: FILE_B.length });
  });

  it('limits: over 300 MB is 413, a running import 409, a list, a link guide or another type 400', async () => {
    const id = (await createFileGuide()).json().id as string;
    const big = await upload(id, FILE_A, { headers: { 'content-length': String(300 * 1024 * 1024 + 1) } });
    expect([big.statusCode, big.json()]).toEqual([413, { error: 'too_large' }]);
    // counted while streaming (no declared length), with a small cap: nothing stays behind
    const counted = await uploadGuideFile(env.ctx, id, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { max: 1000, log: { warn: () => undefined } });
    expect(counted).toEqual({ error: 'too_large' });
    expect(dirFiles(id)).toEqual([]);
    // a second upload while the first one's import runs
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    expect((await upload(id, FILE_A)).statusCode).toBe(202);
    const second = await upload(id, FILE_B);
    expect([second.statusCode, second.json()]).toEqual([409, { error: 'import_running' }]);
    expect((await call('POST', `/api/admin/livetv/sources/${id}/refresh`)).json()).toEqual({ started: false });
    open();
    await settle(id);
    expect(await view(id)).toMatchObject({ fileBytes: FILE_A.length });
    // not an uploaded guide, or not a file
    const list = await addList();
    const link = (await call('POST', '/api/admin/livetv/sources', { kind: 'guide', name: 'Link', epgUrl: 'https://iptv.example.com/guide.xml', guideScope: null })).json().id;
    for (const target of [list, link]) expect((await upload(target, FILE_A)).json()).toEqual({ error: 'invalid', field: 'file' });
    expect((await upload(id, FILE_A, { type: 'image/png' })).json()).toEqual({ error: 'invalid', field: 'file' });
    expect((await upload(id, Buffer.from('{"a":1}'), { type: 'application/json' })).json()).toEqual({ error: 'invalid', field: 'file' });
    expect((await upload(id, Buffer.alloc(0))).json()).toEqual({ error: 'invalid', field: 'file' });
    expect((await upload(randomUUID(), FILE_A)).statusCode).toBe(404);
    // admin and CSRF
    const noAdmin = await env.app.inject({ method: 'PUT', url: `/api/admin/livetv/sources/${id}/file`, payload: FILE_A, cookies: anna.cookies, headers: { 'x-csrf-token': anna.csrf, 'content-type': 'application/gzip' } });
    expect(noAdmin.statusCode).toBe(403);
    const noCsrf = await env.app.inject({ method: 'PUT', url: `/api/admin/livetv/sources/${id}/file`, payload: FILE_A, cookies: admin.cookies, headers: { 'content-type': 'application/gzip' } });
    expect([noCsrf.statusCode, noCsrf.json()]).toEqual([403, { error: 'csrf' }]);
    expect(parsed.filter((p) => p.file === sha(FILE_B))).toEqual([]);
  });

  it('a failed import keeps the old file, its programmes and its index, and records the error', async () => {
    const list = await addList();
    const ch = await addChannel(list, 'Sternwarte 24');
    await addChannel(list, 'Hafenkanal');
    const id = (await createFileGuide()).json().id as string;
    await upload(id, FILE_A, { name: 'a.xml.gz' });
    await settle(id);
    const index = async () => (await env.pool.query('select xml_id from livetv_epg_channels where source_id = $1 order by xml_id', [id])).rows.map((r) => r.xml_id);
    expect(await index()).toEqual(['sternwarte.int']);
    // B's index run succeeds, its programme run fails: B's channels never reach the stored index
    files.set(sha(FILE_B), { ...files.get(sha(FILE_B))!, fail: 'programmes' });
    expect((await upload(id, FILE_B, { type: 'application/octet-stream', name: 'b.xml' })).statusCode).toBe(202);
    await settle(id);
    expect(indexRuns().map((p) => p.file)).toEqual([sha(FILE_A), sha(FILE_B)]);
    expect(dirFiles(id)).toEqual([`${id}.xml.gz`]);
    expect(readFileSync(join(guideDir(env.ctx), `${id}.xml.gz`))).toEqual(FILE_A);
    expect(await index()).toEqual(['sternwarte.int']);
    expect(await view(id)).toMatchObject({ fileName: 'a.xml.gz', fileBytes: FILE_A.length, state: { epg: { lastError: 'invalid', programmes: 1 } } });
    expect((await nowNext(env.ctx, [ch])).get(ch)?.now?.title).toBe('Jetzt auf Sternwarte 24');
    // a file that fails at once: the same
    const broken = Buffer.from('<tv><kaputt');
    await upload(id, broken, { type: 'text/xml' });
    await settle(id);
    expect(dirFiles(id)).toEqual([`${id}.xml.gz`]);
    expect(await row(id)).toMatchObject({ guide_file: `${id}.xml.gz`, guide_file_name: 'a.xml.gz', epg_last_error: 'invalid' });
  });

  it("the index runs again only when the stored file's SHA-256 changes", async () => {
    const list = await addList();
    await addChannel(list, 'Sternwarte 24');
    await addChannel(list, 'Hafenkanal');
    const id = (await createFileGuide()).json().id as string;
    await upload(id, FILE_A);
    await settle(id);
    await upload(id, FILE_A); // the same bytes again: programmes only
    await settle(id);
    expect(indexRuns().map((p) => p.file)).toEqual([sha(FILE_A)]);
    expect(parsed).toHaveLength(3);
    await upload(id, FILE_B, { type: 'text/xml' });
    await settle(id);
    expect(indexRuns().map((p) => p.file)).toEqual([sha(FILE_A), sha(FILE_B)]);
    expect(parsed.at(-1)!.head.channels?.sort()).toEqual(['hafen.int', 'sternwarte.int']);
    expect(await view(id)).toMatchObject({ servedChannels: 2 });
  });

  it('the refresh tick skips file guides; Jetzt aktualisieren re-imports the stored file; an edit that widens it imports once', async () => {
    const list = await addList();
    const other = await addList('Hafen Paket');
    await addChannel(list, 'Sternwarte 24');
    const hafen = await addChannel(other, 'Hafenkanal');
    const id = (await createFileGuide({ guideScope: [list] })).json().id as string;
    // a guide without a file is not refreshed by the tick either
    await livetvRefreshTick(env.ctx);
    expect(parsed).toEqual([]);
    await upload(id, FILE_B, { type: 'text/xml' });
    await settle(id);
    parsed.length = 0;
    // long overdue for any interval: still not refreshed on a schedule
    await env.pool.query("update livetv_sources set epg_last_refresh_at = now() - interval '9 days' where id = $1", [id]);
    await livetvRefreshTick(env.ctx);
    expect(parsed).toEqual([]);
    // Jetzt aktualisieren: the stored file again
    const r = await call('POST', `/api/admin/livetv/sources/${id}/refresh`);
    expect([r.statusCode, r.json()]).toEqual([202, { started: true }]);
    await settle(id);
    expect(parsed.map((p) => [p.file, p.head.channels])).toEqual([[sha(FILE_B), ['sternwarte.int']]]);
    expect((await row(id)).epg_last_refresh_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // the scope now also covers the other list: the tick imports the stored file once, with the new channel in the filter
    parsed.length = 0;
    await call('PATCH', `/api/admin/livetv/sources/${id}`, { guideScope: [list, other] });
    await livetvRefreshTick(env.ctx);
    expect(parsed.map((p) => p.head.channels?.sort())).toEqual([['hafen.int', 'sternwarte.int']]);
    expect((await nowNext(env.ctx, [hafen])).get(hafen)?.now?.title).toBe('Jetzt auf Hafenkanal');
    await livetvRefreshTick(env.ctx);
    expect(parsed).toHaveLength(1);
    // the stored file is gone (a wiped volume): the refresh records it
    for (const f of dirFiles(id)) rmSync(join(guideDir(env.ctx), f));
    await call('POST', `/api/admin/livetv/sources/${id}/refresh`);
    await settle(id);
    expect(await row(id)).toMatchObject({ epg_last_error: 'no_file' });
  });

  it('deleting a guide removes its files', async () => {
    const id = (await createFileGuide()).json().id as string;
    await upload(id, FILE_A);
    await settle(id);
    expect(dirFiles(id)).toEqual([`${id}.xml.gz`]);
    expect((await call('DELETE', `/api/admin/livetv/sources/${id}`)).statusCode).toBe(200);
    expect(dirFiles(id)).toEqual([]);
    // an upload whose guide is deleted while it is imported leaves nothing either
    const id2 = (await createFileGuide()).json().id as string;
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    expect((await upload(id2, FILE_A)).statusCode).toBe(202);
    expect((await call('DELETE', `/api/admin/livetv/sources/${id2}`)).statusCode).toBe(200);
    open();
    await settle(id2);
    expect(dirFiles(id2)).toEqual([]);
  });
});
