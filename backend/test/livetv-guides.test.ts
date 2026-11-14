// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV extra guides, Stage 1 (docs/superpowers/specs/2026-11-14-livetv-extra-guides-design.md): guide sources (kind 'guide', an
 * XMLTV link stored encrypted) with a "Gilt für" scope, refreshed by the tick like a list's guide, and the fill-only matching pass.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { livetvRefreshTick } from '../src/livetv/refresh.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);

const GUIDE_URL = 'https://anna:geheim@iptv.example.com/guide/international.xml.gz?token=geheim';
const GUIDE_URL_2 = 'https://iptv.example.com/guide/zweiter.xml';
const LIST_EPG = 'https://iptv.example.com/xmltv.php?username=anna&password=geheim';
const HINT = 'https://iptv.example.com/…';

// ---- the fake livetv: XMLTV guides by URL, filtered like livetv does (channels, time window) ----
type Guide = { channels: Array<{ id: string; names: string[] }>; progs: Array<{ ch: string; start: number; end: number; title: string }> };
const guides = new Map<string, Guide>();
const calls: Call[] = [];
const xmltvCalls = () => calls.filter((c) => c.path === '/v1/fetch/xmltv');
function xmltvAnswer(body: { url: string; channels?: string[]; from: number; to: number }) {
  const g = guides.get(body.url);
  if (!g) return { status: 400, json: { error: 'invalid', field: 'url' } };
  const want = (id: string) => !body.channels || body.channels.includes(id);
  const lines: unknown[] = [];
  for (const c of g.channels) if (want(c.id)) lines.push({ t: 'channel', ...c });
  let programmes = 0;
  for (const p of g.progs) {
    if (!want(p.ch) || p.end < body.from || p.start > body.to) continue;
    lines.push({ t: 'prog', ...p });
    programmes++;
  }
  lines.push({ t: 'end', programmes, channels: lines.length - programmes });
  return { raw: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', type: 'application/x-ndjson' };
}
const now = Date.now();
/** a guide knowing the given channels, one programme running now on each */
const guide = (chs: Array<[string, string]>): Guide => ({
  channels: chs.map(([id, name]) => ({ id, names: [name] })),
  progs: chs.map(([id, name]) => ({ ch: id, start: now - 30 * 60_000, end: now + 30 * 60_000, title: `Jetzt auf ${name}` })),
});

let addr = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
const row = async (id: string) => (await env.pool.query('select * from livetv_sources where id = $1', [id])).rows[0];
const chan = async (id: string) => (await env.pool.query('select * from livetv_channels where id = $1', [id])).rows[0];

/** a provider list (row only, no refresh) */
async function addList(name = 'Nordlicht Paket', o: { epg?: string; position?: number } = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, epg_url_enc, epg_hint, position, last_refresh_at)
     values ($1, 'm3u', $2, $3, $4, $5, $6, $7, now())`,
    [id, name, encrypt(key, 'https://iptv.example.com/get.php?u=anna&p=geheim'), HINT, o.epg ? encrypt(key, o.epg) : null, o.epg ? HINT : null, o.position ?? 0]);
  return id;
}
async function addFeeds(): Promise<string> {
  const id = randomUUID();
  await env.pool.query("insert into livetv_sources(id, kind, name, position) values ($1, 'manual', 'Eigene Streams', 50)", [id]);
  return id;
}
async function addChannel(sourceId: string, name: string, o: { tvgId?: string; match?: 'auto' | 'manual' | 'none'; map?: [string, string] } = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, tvg_id, epg_match, epg_source_id, epg_channel_id)
     values ($1, $2, $3, $4, 'ts', $5, $6, $7, $8, $9)`,
    [id, sourceId, `k-${id}`, encrypt(key, 'https://iptv.example.com/live/1.ts'), name, o.tvgId ?? null, o.match ?? (o.map ? 'manual' : 'auto'), o.map?.[0] ?? null, o.map?.[1] ?? null]);
  return id;
}
const createGuide = (b: Record<string, unknown> = {}) =>
  call('POST', '/api/admin/livetv/sources', { kind: 'guide', name: 'Sternwarte Guide', epgUrl: GUIDE_URL, guideScope: null, ...b });

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query(`delete from livetv_programmes; delete from livetv_programmes_stage; delete from livetv_epg_channels; delete from livetv_channels;
    delete from livetv_group_map; delete from livetv_groups; delete from livetv_logos; delete from livetv_sources; delete from audit_log`);
  for (const k of await env.kv.keys('ltv')) await env.kv.del(k);
  calls.length = 0;
  guides.clear();
  env.ctx.fetchImpl = fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '1.0.0', bootId: '0123456789abcdef' } }),
    'POST /v1/fetch/m3u': () => ({ json: { entries: [], groups: [], listed: 0, skipped: { vod: 0, invalid: 0, overLimit: 0, groups: 0 } } }),
    'POST /v1/fetch/xmltv': (_u, _i, body) => xmltvAnswer(body),
    'POST /v1/fetch/logo': () => ({ status: 404, json: { error: 'not_found' } }),
  }, calls);
  await detectLivetv(env.ctx, 0);
  calls.length = 0;
});

describe('guide sources (Task 1)', () => {
  it('creates a link guide and lists it with kind guide and its scope', async () => {
    const list = await addList();
    const feeds = await addFeeds();
    const r = await createGuide({ guideScope: [list, feeds], epgShiftMin: 60, refresh: '12h' });
    expect(r.statusCode).toBe(201);
    const g = r.json();
    expect(g).toMatchObject({
      kind: 'guide', name: 'Sternwarte Guide', guideProvider: 'xmltv_url', guideScope: [list, feeds], servedChannels: 0, urlHint: null,
      epgHint: HINT, epgShiftMin: 60, refresh: '12h', enabled: true, channelCount: 0,
    });
    expect(r.body).not.toContain('geheim');
    const stored = await row(g.id);
    expect(stored).toMatchObject({ kind: 'guide', url_enc: null, guide_provider: 'xmltv_url', guide_scope: [list, feeds], guide_file: null });
    expect(decrypt(key, stored.epg_url_enc)).toBe(GUIDE_URL);
    const all = (await call('GET', '/api/admin/livetv/sources')).json() as Array<{ id: string; kind: string; guideScope: unknown; guideProvider: unknown; servedChannels: number }>;
    expect(all.find((s) => s.id === g.id)).toMatchObject({ kind: 'guide', guideScope: [list, feeds] });
    // lists carry the new fields too, with their list values
    expect(all.find((s) => s.id === list)).toMatchObject({ kind: 'm3u', guideProvider: null, guideScope: null, servedChannels: 0 });
    expect(all.find((s) => s.id === feeds)).toMatchObject({ kind: 'feeds', guideProvider: null, guideScope: null });
    // null = all channels; a patch changes the scope and the name
    const all2 = await createGuide({ name: 'Hafenkanal Guide' });
    expect(all2.json()).toMatchObject({ guideScope: null });
    const p = await call('PATCH', `/api/admin/livetv/sources/${all2.json().id}`, { guideScope: [list], name: 'Hafen' });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ guideScope: [list], name: 'Hafen' });
    // list-only fields are refused for a guide, guide fields for a list
    expect((await call('PATCH', `/api/admin/livetv/sources/${g.id}`, { skipGroups: ['x'] })).json()).toEqual({ error: 'invalid', field: 'skipGroups' });
    expect((await call('PATCH', `/api/admin/livetv/sources/${g.id}`, { epgUrl: null })).json()).toEqual({ error: 'invalid', field: 'epgUrl' });
    expect((await call('PATCH', `/api/admin/livetv/sources/${list}`, { guideScope: null })).json()).toEqual({ error: 'invalid', field: 'guideScope' });
    // a guide needs its link
    expect((await createGuide({ epgUrl: undefined })).json()).toEqual({ error: 'invalid', field: 'epgUrl' });
    // a list body without kind is still a list
    const l2 = await call('POST', '/api/admin/livetv/sources', { name: 'Liste', url: 'https://iptv.example.com/get.php' });
    expect(l2.json()).toMatchObject({ kind: 'm3u', guideProvider: null, guideScope: null });
  });

  it('refuses an empty guideScope', async () => {
    const r = await createGuide({ guideScope: [] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid', field: 'guideScope' });
    const id = (await createGuide()).json().id;
    const p = await call('PATCH', `/api/admin/livetv/sources/${id}`, { guideScope: [] });
    expect(p.statusCode).toBe(400);
    expect(p.json()).toEqual({ error: 'invalid', field: 'guideScope' });
  });

  it('refuses a scope id of a guide', async () => {
    const other = (await createGuide({ name: 'Anderer Guide' })).json().id;
    const r = await createGuide({ guideScope: [other] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid', field: 'guideScope' });
    // an unknown id too
    expect((await createGuide({ guideScope: [randomUUID()] })).json()).toEqual({ error: 'invalid', field: 'guideScope' });
    const p = await call('PATCH', `/api/admin/livetv/sources/${other}`, { guideScope: [other] });
    expect(p.json()).toEqual({ error: 'invalid', field: 'guideScope' });
    expect((await env.pool.query("select count(*)::int n from livetv_sources where kind = 'guide'")).rows[0].n).toBe(1);
  });

  it('deleting a scoped list shrinks the scope; an empty scope disables the guide', async () => {
    const a = await addList('Nordlicht Paket');
    const b = await addList('Hafen Paket');
    const g1 = (await createGuide({ guideScope: [a, b] })).json().id;
    const g2 = (await createGuide({ name: 'Nur A', guideScope: [a] })).json().id;
    const g3 = (await createGuide({ name: 'Alle' })).json().id;
    expect((await call('DELETE', `/api/admin/livetv/sources/${a}`)).statusCode).toBe(200);
    expect(await row(g1)).toMatchObject({ guide_scope: [b], enabled: true });
    expect(await row(g2)).toMatchObject({ guide_scope: [], enabled: false });
    expect(await row(g3)).toMatchObject({ guide_scope: null, enabled: true });
    const v = ((await call('GET', '/api/admin/livetv/sources')).json() as Array<{ id: string }>).find((s) => s.id === g2);
    expect(v).toMatchObject({ guideScope: [], enabled: false });
  });

  it('deleting a guide resets its channels to auto', async () => {
    const list = await addList();
    const g = (await createGuide()).json().id;
    const auto = await addChannel(list, 'Sternwarte 24', { match: 'auto', map: [g, 'sternwarte.int'] });
    const pinned = await addChannel(list, 'Hafenkanal', { map: [g, 'hafen.int'] });
    const other = await addChannel(list, 'Nordlicht TV', { map: [list, 'nordlicht.de'] });
    expect((await call('DELETE', `/api/admin/livetv/sources/${g}`)).statusCode).toBe(200);
    for (const id of [auto, pinned]) expect(await chan(id)).toMatchObject({ epg_match: 'auto', epg_source_id: null, epg_channel_id: null });
    expect(await chan(other)).toMatchObject({ epg_match: 'manual', epg_source_id: list, epg_channel_id: 'nordlicht.de' });
  });

  it("the refresh tick imports a due link guide's XMLTV (fakeHttp xmltv) and never runs the list import for it", async () => {
    guides.set(GUIDE_URL, guide([['sternwarte.int', 'Sternwarte 24']]));
    const list = await addList();
    const ch = await addChannel(list, 'Sternwarte 24');
    const g = (await createGuide()).json().id;
    await livetvRefreshTick(env.ctx);
    expect(calls.filter((c) => c.path === '/v1/fetch/m3u')).toHaveLength(0);
    expect(xmltvCalls().length).toBeGreaterThan(0);
    expect(xmltvCalls().every((c) => c.body.url === GUIDE_URL)).toBe(true);
    const s = await row(g);
    expect(s).toMatchObject({ epg_last_error: null, last_refresh_at: null, last_error: null });
    expect(s.epg_last_ok_at).not.toBeNull();
    expect((await env.pool.query('select count(*)::int n from livetv_programmes where source_id = $1', [g])).rows[0].n).toBe(1);
    expect(await chan(ch)).toMatchObject({ epg_source_id: g, epg_channel_id: 'sternwarte.int' });
    const v = ((await call('GET', '/api/admin/livetv/sources')).json() as Array<{ id: string }>).find((x) => x.id === g);
    expect(v).toMatchObject({ servedChannels: 1, state: { epg: { programmes: 1, lastError: null } } });
    // refreshed just now: not due again
    calls.length = 0;
    await livetvRefreshTick(env.ctx);
    expect(xmltvCalls()).toHaveLength(0);
    // *Aktualisieren* on a guide runs its import, never a list fetch
    const r = await call('POST', `/api/admin/livetv/sources/${g}/refresh`);
    expect(r.statusCode).toBe(202);
    for (let i = 0; i < 50 && xmltvCalls().length === 0; i++) await new Promise((res) => setTimeout(res, 20));
    for (let i = 0; i < 50 && (await env.kv.get(`ltv:refresh:${g}`)) !== null; i++) await new Promise((res) => setTimeout(res, 20));
    expect(xmltvCalls().length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.path === '/v1/fetch/m3u')).toHaveLength(0);
  });

  it('a disabled guide is skipped by the tick', async () => {
    guides.set(GUIDE_URL, guide([['sternwarte.int', 'Sternwarte 24']]));
    const list = await addList();
    await addChannel(list, 'Sternwarte 24');
    await createGuide({ enabled: false });
    await livetvRefreshTick(env.ctx);
    expect(xmltvCalls()).toHaveLength(0);
  });

  it('Prüfen on a guide link counts its channels and names a few', async () => {
    guides.set(GUIDE_URL, guide(Array.from({ length: 12 }, (_, i) => [`k${i}.int`, `Kanal ${i}`] as [string, string])));
    const r = await call('POST', '/api/admin/livetv/sources/test', { kind: 'guide', epgUrl: GUIDE_URL, allowLan: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ epgChannels: 12, samples: Array.from({ length: 8 }, (_, i) => `Kanal ${i}`) });
    expect(calls.filter((c) => c.path === '/v1/fetch/m3u')).toHaveLength(0);
    // an unreadable guide is the provider's failure
    const bad = await call('POST', '/api/admin/livetv/sources/test', { kind: 'guide', epgUrl: GUIDE_URL_2, allowLan: false });
    expect(bad.statusCode).toBe(422);
  });

  it('a list deleted while a guide serves its channels leaves the guide alone; served channels are counted', async () => {
    const list = await addList('Nordlicht Paket', { epg: LIST_EPG });
    const g = (await createGuide()).json().id;
    await addChannel(list, 'Sternwarte 24', { match: 'auto', map: [g, 'sternwarte.int'] });
    await addChannel(list, 'Sternwarte 25', { match: 'auto', map: [g, 'sternwarte25.int'] });
    const v = ((await call('GET', '/api/admin/livetv/sources')).json() as Array<{ id: string }>).find((x) => x.id === g);
    expect(v).toMatchObject({ servedChannels: 2 });
    await call('DELETE', `/api/admin/livetv/sources/${list}`);
    expect(await row(g)).toMatchObject({ enabled: true, guide_scope: null });
  });
});
