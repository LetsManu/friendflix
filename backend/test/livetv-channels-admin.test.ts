// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 19: the channel administration API (spec §9.2, §10): the list with filters and paging, overrides and back to
 * the import, the EPG offset, duplicate numbers, bulk actions, the order save, the stream test (ruling 15, F10), own logos (ruling 32)
 * and the logo route. No answer ever carries a stream URL (F13).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { INGEST_DIRTY_KEY, forgetSrtPorts, syncIngest } from '../src/livetv/ownfeeds.js';
import { channelSet, invalidateLivetvRights } from '../src/livetv/rights.js';
import { invalidateLiveConversions } from '../src/livetv/streams.js';
import { ADMIN, cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
let env: TestEnv;
let admin: Sess;
let adminId = '';
const key = keyFromBase64(ENC_KEY);
const logs: string[] = [];
/** every answer body of this file: none may carry a stream URL */
const answers: string[] = [];

const STREAM_URL = 'https://anna:geheim@iptv.example.com/live/anna/geheim/101.ts';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

let addr = 0;
async function call(method: Method, url: string, payload?: unknown, s: Sess = admin) {
  const r = await env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}`, ...(payload === undefined ? {} : { payload: payload as object }) });
  answers.push(r.body);
  return r;
}
async function upload(id: string, type: string, body: Buffer, s: Sess = admin) {
  const r = await env.app.inject({ method: 'PUT', url: `/api/admin/livetv/channels/${id}/logo`, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'content-type': type }, payload: body });
  answers.push(r.body);
  return r;
}
const list = async (qs = '') => {
  const r = await call('GET', `/api/admin/livetv/channels${qs ? `?${qs}` : ''}`);
  expect(r.statusCode).toBe(200);
  return r.json() as { channels: Array<Record<string, any>>; total: number };
};
const one = async (id: string) => (await call('GET', `/api/admin/livetv/channels/${id}`)).json();

// ---- the fake livetv ----
const calls: Call[] = [];
let probe: Handler;
let ports: number[];
const probeBodies = () => calls.filter((c) => c.path === '/v1/probe').map((c) => c.body);
const ingestBodies = () => calls.filter((c) => c.method === 'PUT' && c.path === '/v1/ingest').map((c) => c.body as { feeds: Array<{ channelId: string }> });
let encoders: string[];
const system = () => ({
  cpu: { model: 'Testprozessor', cores: 4, loadPct: 3 }, gpu: { devices: [], driver: null, readable: false, busyPct: null }, encoders,
  cache: { usedBytes: 0, maxBytes: 1 }, recordings: null, srt: { ports },
});
const FACTS = { ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux' };

// ---- rows ----
let n = 0;
async function addSource(o: { name?: string; enabled?: boolean; shift?: number; userAgent?: string | null; position?: number; epg?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, epg_url_enc, epg_hint, enabled, epg_shift_min, user_agent, position)
     values ($1, 'm3u', $2, $3, 'https://iptv.example.com/…', $4, $5, $6, $7, $8, $9)`,
    [id, o.name ?? 'Anbieter', encrypt(key, 'https://iptv.example.com/get.php?username=anna&password=geheim'),
      o.epg ? encrypt(key, 'https://iptv.example.com/xmltv.php?username=anna&password=geheim') : null, o.epg ? 'https://iptv.example.com/…' : null,
      o.enabled ?? true, o.shift ?? 0, o.userAgent ?? null, o.position ?? 0]);
  return id;
}
async function addGroup(name: string, released = true): Promise<string> {
  const id = (await env.pool.query<{ id: string }>(
    `insert into livetv_groups(id, name, released, position) values (gen_random_uuid(), $1, $2, (select coalesce(max(position) + 1, 0) from livetv_groups)) returning id`,
    [name, released])).rows[0]!.id;
  invalidateLivetvRights();
  return id;
}
const mapGroup = (source: string, provider: string, group: string) =>
  env.pool.query('insert into livetv_group_map(source_id, provider_group, group_id) values ($1, $2, $3)', [source, provider, group]);
async function addChannel(source: string, name: string, o: {
  number?: number | null; tvgId?: string; group?: string; kind?: 'hls' | 'ts'; url?: string; hidden?: boolean; missing?: boolean;
  importShift?: number; map?: [string, string]; probe?: object; logo?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_channels(id, source_id, source_key, stream_url_enc, stream_kind, import_name, import_number, import_group, tvg_id, hidden,
       missing_since, import_epg_shift_min, epg_source_id, epg_channel_id, probe, import_logo_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [id, source, `k${++n}`, encrypt(key, o.url ?? `https://iptv.example.com/live/anna/geheim/${n}.m3u8`), o.kind ?? 'hls', name, o.number ?? null,
      o.group ?? null, o.tvgId ?? null, o.hidden ?? false, o.missing ? new Date() : null, o.importShift ?? null, o.map?.[0] ?? null, o.map?.[1] ?? null,
      o.probe ? JSON.stringify(o.probe) : null, o.logo ?? null]);
  invalidateLivetvRights();
  return id;
}
const audits = async (action: string) => (await env.pool.query<{ target: string | null; meta: Record<string, unknown> }>(
  'select target, meta from audit_log where action = $1 order by id', [action])).rows;

beforeAll(async () => {
  env = await makeEnv({}, { logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' } });
  admin = await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub = 'sub-admin'")).rows[0]!.id;
});
afterAll(async () => {
  // F13: across every test of this file, no answer and no log line carried a stream or provider URL or its credentials
  const hay = answers.join('\n') + logs.join('\n');
  expect(hay).not.toContain('iptv.example.com/live');
  expect(hay).not.toContain('geheim');
  await env.close();
});
beforeEach(async () => {
  await env.pool.query('delete from livetv_programmes; delete from livetv_epg_channels; delete from livetv_channels; delete from livetv_group_map; delete from livetv_groups; delete from livetv_sources; delete from livetv_logos; delete from audit_log');
  invalidateLivetvRights();
  calls.length = 0;
  ports = [9000, 9001];
  encoders = ['libx264'];
  probe = () => ({ json: FACTS });
  forgetSrtPorts(env.ctx);
  await env.kv.del(`ltv:chtest:${adminId}`);
  env.ctx.fetchImpl = fakeHttp({
    'GET /v1/system': () => ({ json: system() }), 'PUT /v1/ingest': () => ({ json: { ok: true } }), 'POST /v1/probe': (...a) => probe(...a),
  }, calls);
});
afterEach(() => { vi.useRealTimers(); });

describe('the list (spec §9.2)', () => {
  it('filters and paging', async () => {
    const src = await addSource();
    const other = await addSource({ name: 'Zweiter Anbieter', position: 1 });
    const g = await addGroup('Nachrichten');
    await mapGroup(src, 'DE | Nachrichten', g);
    const ids: string[] = [];
    for (let i = 1; i <= 25; i++) {
      ids.push(await addChannel(i > 20 ? other : src, `Kanal ${String(i).padStart(2, '0')}`, {
        number: i, tvgId: i === 7 ? 'nordlicht.de' : undefined, group: i <= 5 ? 'DE | Nachrichten' : undefined,
        hidden: i === 3, missing: i === 4, map: i === 6 ? [src, 'nordlicht.de'] : undefined,
        probe: i === 8 ? { at: '2026-11-12T10:00:00.000Z', ok: false, needs: null, error: 'timeout' } : undefined,
      }));
    }
    const page = await list('limit=10&offset=10');
    expect(page.total).toBe(25);
    expect(page.channels.map((c) => c.number)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(page.channels[0]).toEqual({
      id: ids[10], number: 11, name: 'Kanal 11', groupId: null, sourceId: src, streamKind: 'hls', ingest: 'pull', logoHash: null, hidden: false,
      missing: false, epg: false, epgMatch: 'auto', epgPin: null, now: null, mode: null, probeError: null, overridden: {}, dupNumber: false, epgShift: { min: 0, from: 'none' },
    });
    expect((await list()).channels).toHaveLength(25); // default page of 100
    expect((await list('limit=10&offset=20')).channels.map((c) => c.number)).toEqual([21, 22, 23, 24, 25]);

    // q matches tvg-id, name and number
    const byTvg = await list('q=nordlicht.de');
    expect([byTvg.total, byTvg.channels.map((c) => c.id)]).toEqual([1, [ids[6]]]);
    expect((await list('q=kanal%2012')).channels.map((c) => c.number)).toEqual([12]);
    expect((await list('q=19')).channels.map((c) => c.number)).toEqual([19]);
    expect((await list('q=100%25')).total).toBe(0); // % is a character, not a wildcard

    expect((await list(`source=${other}`)).channels.map((c) => c.number)).toEqual([21, 22, 23, 24, 25]);
    expect((await list(`group=${g}`)).channels.map((c) => c.number)).toEqual([1, 2, 3, 4, 5]);
    expect((await list('group=none')).total).toBe(20);
    expect((await list('state=hidden')).channels.map((c) => c.number)).toEqual([3]);
    expect((await list('state=missing')).channels.map((c) => [c.number, c.missing])).toEqual([[4, true]]);
    expect((await list('state=visible')).total).toBe(23);
    expect((await list('epg=yes')).channels.map((c) => [c.number, c.epg])).toEqual([[6, true]]);
    expect((await list('epg=no')).total).toBe(24);
    expect((await list('error=1')).channels.map((c) => [c.number, c.probeError])).toEqual([[8, 'timeout']]);
    expect((await list('sort=name&dir=desc&limit=2')).channels.map((c) => c.name)).toEqual(['Kanal 25', 'Kanal 24']);
    expect((await list('sort=source&dir=desc&limit=2')).channels.map((c) => c.number)).toEqual([21, 22]);
    expect((await list('dir=desc&limit=1')).channels.map((c) => c.number)).toEqual([25]);

    for (const bad of ['limit=0', 'limit=501', 'offset=-1', 'state=gone', 'sort=group', 'source=nope', 'epg=1']) {
      const r = await call('GET', `/api/admin/livetv/channels?${bad}`);
      expect([bad, r.statusCode, r.json().error]).toEqual([bad, 400, 'invalid']);
      expect(r.json().field).toBe(bad.split('=')[0]);
    }
  });

  it('duplicate numbers are flagged', async () => {
    const src = await addSource();
    const a = await addChannel(src, 'Nordlicht TV', { number: 5 });
    const b = await addChannel(src, 'Hafenkanal', { number: 5 });
    const c = await addChannel(src, 'Bergblick Sport', { number: 6 });
    const gone = await addChannel(src, 'Sternwarte 24', { number: 6, missing: true });
    const d = await addChannel(src, 'Kinderinsel', { number: null });
    const e = await addChannel(src, 'Kanal Wolkenlos', { number: null });
    const dup = new Map((await list()).channels.map((x) => [x.id, x.dupNumber]));
    expect(Object.fromEntries([a, b, c, gone, d, e].map((id) => [id, dup.get(id)]))).toEqual({ [a]: true, [b]: true, [c]: false, [gone]: false, [d]: false, [e]: false });
    // a duplicate on another page counts too
    expect((await list('limit=1')).channels[0]).toMatchObject({ id: b, dupNumber: true }); // 5 Hafenkanal before 5 Nordlicht TV
    // the same on the single-channel path and in a page sorted by name (Nordlicht TV is the fifth by name, its twin on the first page)
    expect((await one(a)).dupNumber).toBe(true);
    expect((await one(gone)).dupNumber).toBe(false);
    expect((await list('sort=name&limit=2&offset=4')).channels.map((x) => [x.id, x.dupNumber])).toEqual([[a, true], [gone, false]]);
    // an override resolves it
    await call('PATCH', `/api/admin/livetv/channels/${b}`, { number: 7 });
    expect((await one(a)).dupNumber).toBe(false);
  });
});

describe('PATCH /channels/:id', () => {
  it('override and back to import', async () => {
    const src = await addSource();
    const news = await addGroup('Nachrichten');
    const sport = await addGroup('Sport');
    await mapGroup(src, 'DE | Nachrichten', news);
    const id = await addChannel(src, 'Hafenkanal', { number: 7, group: 'DE | Nachrichten' });

    const r = await call('PATCH', `/api/admin/livetv/channels/${id}`, { name: 'Hafenkanal HD', number: 42, groupId: sport });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ id, name: 'Hafenkanal HD', number: 42, groupId: sport, overridden: { name: 'Hafenkanal', number: 7, group: news } });
    expect((await list()).channels[0]).toEqual(r.json());

    const back = await call('PATCH', `/api/admin/livetv/channels/${id}`, { name: null, number: null, groupId: null });
    expect(back.json()).toMatchObject({ name: 'Hafenkanal', number: 7, groupId: news, overridden: {} });

    // hidden, then visible again
    expect((await call('PATCH', `/api/admin/livetv/channels/${id}`, { hidden: true })).json().hidden).toBe(true);
    expect((await call('PATCH', `/api/admin/livetv/channels/${id}`, { hidden: false })).json().hidden).toBe(false);

    // audited with the field names only
    expect((await audits('livetv.channel.update')).map((a) => [a.target, a.meta])).toEqual([
      [id, { fields: ['name', 'number', 'groupId'] }], [id, { fields: ['name', 'number', 'groupId'] }], [id, { fields: ['hidden'] }], [id, { fields: ['hidden'] }],
    ]);

    // refusals: fixed codes with the field, nothing stored
    for (const [body, field] of [
      [{ groupId: randomUUID() }, 'groupId'], [{ name: '' }, 'name'], [{ name: 'x'.repeat(61) }, 'name'], [{ number: 0 }, 'number'],
      [{ number: 100_000 }, 'number'], [{ hidden: 'yes' }, 'hidden'], [{ url: 'https://iptv.example.com/x' }, 'body'],
    ] as const) {
      const bad = await call('PATCH', `/api/admin/livetv/channels/${id}`, body);
      expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'invalid', field }]);
    }
    expect((await call('PATCH', `/api/admin/livetv/channels/${randomUUID()}`, { hidden: true })).statusCode).toBe(404);
    expect((await call('PATCH', '/api/admin/livetv/channels/nope', { hidden: true })).statusCode).toBe(404);
    expect((await one(id)).name).toBe('Hafenkanal');
  });

  it('EPG offset override and back to inherited', async () => {
    const src = await addSource({ shift: 30 });
    const id = await addChannel(src, 'Nordlicht TV', { importShift: 120 });
    const plain = await addChannel(src, 'Hafenkanal');
    expect((await one(id)).epgShift).toEqual({ min: 120, from: 'list' });
    expect((await one(plain)).epgShift).toEqual({ min: 30, from: 'source' });

    expect((await call('PATCH', `/api/admin/livetv/channels/${id}`, { epgShiftMin: 60 })).json().epgShift).toEqual({ min: 60, from: 'channel' });
    expect((await call('PATCH', `/api/admin/livetv/channels/${id}`, { epgShiftMin: -720 })).json().epgShift).toEqual({ min: -720, from: 'channel' });
    expect((await call('PATCH', `/api/admin/livetv/channels/${id}`, { epgShiftMin: null })).json().epgShift).toEqual({ min: 120, from: 'list' });
    for (const v of [45, 870, -750, 1.5]) {
      const bad = await call('PATCH', `/api/admin/livetv/channels/${id}`, { epgShiftMin: v });
      expect([v, bad.statusCode, bad.json()]).toEqual([v, 400, { error: 'invalid', field: 'epgShiftMin' }]);
    }
    expect((await env.pool.query('select epg_shift_override_min from livetv_channels where id = $1', [id])).rows[0].epg_shift_override_min).toBeNull();
  });

  it('the PATCH answer is the updated channel with the shifted now line', async () => {
    const src = await addSource({ epg: true });
    const id = await addChannel(src, 'Nordlicht TV', { map: [src, 'nordlicht.de'] });
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000);
    await env.pool.query(
      `insert into livetv_programmes(source_id, xml_channel, start_at, end_at, title) values ($1, 'nordlicht.de', $2, $3, 'Die Leuchtturmwärter')`,
      [src, at(19, 15), at(20)]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(20, 30));
    const s = await env.login(); // a session of the faked clock (the test sessions live 10 minutes)

    const row = (await call('GET', '/api/admin/livetv/channels', undefined, s)).json().channels[0];
    expect(row).toMatchObject({ id, epg: true, now: null, epgShift: { min: 0, from: 'none' } });

    const r = await call('PATCH', `/api/admin/livetv/channels/${id}`, { epgShiftMin: 60 }, s);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      ...row, epgShift: { min: 60, from: 'channel' },
      now: { title: 'Die Leuchtturmwärter', start: at(20, 15).toISOString(), end: at(21).toISOString() },
    });
    expect(r.json().now.start).toMatch(/T20:15:00\.000Z$/);
    expect(r.json().now.end).toMatch(/T21:00:00\.000Z$/);
  });

  it('epg false drops the mapping, null matches again', async () => {
    const src = await addSource({ epg: true });
    await env.pool.query("insert into livetv_epg_channels(source_id, xml_id, names) values ($1, 'nordlicht.de', '{Nordlicht TV}')", [src]);
    const id = await addChannel(src, 'Nordlicht TV', { tvgId: 'nordlicht.de', map: [src, 'nordlicht.de'] });
    const off = await call('PATCH', `/api/admin/livetv/channels/${id}`, { epg: false });
    expect(off.json().epg).toBe(false);
    expect((await env.pool.query('select epg_match, epg_source_id, epg_channel_id from livetv_channels where id = $1', [id])).rows[0]).toEqual({ epg_match: 'none', epg_source_id: null, epg_channel_id: null });
    const on = await call('PATCH', `/api/admin/livetv/channels/${id}`, { epg: null });
    expect(on.json().epg).toBe(true);
    expect((await env.pool.query('select epg_match, epg_source_id, epg_channel_id from livetv_channels where id = $1', [id])).rows[0]).toEqual({ epg_match: 'auto', epg_source_id: src, epg_channel_id: 'nordlicht.de' });
  });

  it('every channel write drops the cached channel sets', async () => {
    const src = await addSource();
    const id = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const me = { user: { id: adminId, role: 'admin' }, profile: { id: adminId, kids: false } };
    expect((await channelSet(env.ctx, me.user, me.profile)).has(id)).toBe(true);
    await call('PATCH', `/api/admin/livetv/channels/${id}`, { hidden: true });
    expect((await channelSet(env.ctx, me.user, me.profile)).has(id)).toBe(false);
    await call('POST', '/api/admin/livetv/channels/bulk', { ids: [id], action: 'show' });
    expect((await channelSet(env.ctx, me.user, me.profile)).has(id)).toBe(true);
  });
});

describe('bulk and order', () => {
  it('bulk renumber from 100', async () => {
    const src = await addSource();
    const c = await addChannel(src, 'Bergblick Sport', { number: 3 });
    const a = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const b = await addChannel(src, 'Hafenkanal', { number: 2 });
    const untouched = await addChannel(src, 'Kinderinsel', { number: 4 });
    const r = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [c, a, b], action: 'renumber', from: 100 });
    expect([r.statusCode, r.json()]).toEqual([200, { changed: 3 }]);
    const rows = new Map((await list()).channels.map((x) => [x.id, x]));
    expect([a, b, c, untouched].map((id) => rows.get(id)!.number)).toEqual([100, 101, 102, 4]);
    expect(rows.get(a)!.overridden).toEqual({ number: 1 });
    expect(await audits('livetv.channel.bulk')).toEqual([{ target: null, meta: { action: 'renumber', count: 3 } }]);

    const noFrom = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a], action: 'renumber' });
    expect([noFrom.statusCode, noFrom.json()]).toEqual([400, { error: 'invalid', field: 'from' }]);
    const tooHigh = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a, b], action: 'renumber', from: 99_999 });
    expect([tooHigh.statusCode, tooHigh.json()]).toEqual([400, { error: 'invalid', field: 'from' }]);
    expect((await one(a)).number).toBe(100);
  });

  it('hide, show, group and reset in bulk', async () => {
    const src = await addSource();
    const g = await addGroup('Sport');
    const a = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const b = await addChannel(src, 'Hafenkanal', { number: 2 });
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a, b, randomUUID()], action: 'hide' })).json()).toEqual({ changed: 2 });
    expect((await list('state=hidden')).total).toBe(2);
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a], action: 'show' })).json()).toEqual({ changed: 1 });
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a, b], action: 'group', groupId: g })).json()).toEqual({ changed: 2 });
    expect((await one(b)).groupId).toBe(g);
    const noGroup = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a], action: 'group' });
    expect([noGroup.statusCode, noGroup.json()]).toEqual([400, { error: 'invalid', field: 'groupId' }]);
    const unknownGroup = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a], action: 'group', groupId: randomUUID() });
    expect([unknownGroup.statusCode, unknownGroup.json()]).toEqual([400, { error: 'invalid', field: 'groupId' }]);

    await call('PATCH', `/api/admin/livetv/channels/${a}`, { name: 'Nordlicht HD', number: 9, epgShiftMin: 60, epg: false });
    await upload(a, 'image/png', PNG);
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a, b], action: 'reset' })).json()).toEqual({ changed: 2 });
    expect(await one(a)).toMatchObject({ name: 'Nordlicht TV', number: 1, groupId: null, logoHash: null, overridden: {}, epgShift: { min: 0, from: 'none' }, hidden: false });
    expect((await env.pool.query('select epg_match from livetv_channels where id = $1', [a])).rows[0].epg_match).toBe('auto');
    expect((await one(b)).hidden).toBe(true); // visibility is not an override

    const tooMany = await call('POST', '/api/admin/livetv/channels/bulk', { ids: Array.from({ length: 20_001 }, () => randomUUID()), action: 'hide' });
    expect([tooMany.statusCode, tooMany.json()]).toEqual([400, { error: 'invalid', field: 'ids' }]);
    const most = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [...Array.from({ length: 19_999 }, () => randomUUID()), a], action: 'hide' });
    expect([most.statusCode, most.json()]).toEqual([200, { changed: 1 }]);
    const badAction = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a], action: 'delete' });
    expect([badAction.statusCode, badAction.json()]).toEqual([400, { error: 'invalid', field: 'action' }]);
  });

  it('order renumbers from the smallest number', async () => {
    const src = await addSource();
    const ten = await addChannel(src, 'Nordlicht TV', { number: 10 });
    const twenty = await addChannel(src, 'Hafenkanal', { number: 20 });
    const thirty = await addChannel(src, 'Bergblick Sport', { number: 30 });
    const none = await addChannel(src, 'Kinderinsel', { number: null });
    const r = await call('PUT', '/api/admin/livetv/channels/order', { ids: [thirty, none, ten, twenty] });
    expect([r.statusCode, r.json()]).toEqual([200, { from: 10 }]);
    const rows = new Map((await list()).channels.map((x) => [x.id, x.number]));
    expect([thirty, none, ten, twenty].map((id) => rows.get(id))).toEqual([10, 11, 12, 13]);
    expect(await audits('livetv.channel.order')).toEqual([{ target: null, meta: { count: 4 } }]);

    for (const ids of [[ten, ten], [ten, randomUUID()], []]) {
      const bad = await call('PUT', '/api/admin/livetv/channels/order', { ids });
      expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'invalid', field: 'ids' }]);
    }
    // a set without numbers starts at 1
    const a = await addChannel(src, 'Sternwarte 24');
    const b = await addChannel(src, 'Kanal Wolkenlos');
    expect((await call('PUT', '/api/admin/livetv/channels/order', { ids: [b, a] })).json()).toEqual({ from: 1 });
    expect([(await one(b)).number, (await one(a)).number]).toEqual([1, 2]);
  });

  it('hiding a push feed withdraws it from livetv, showing it adds it back', async () => {
    const feed = (await call('POST', '/api/admin/livetv/channels', { ingest: 'push', name: 'Hafenkanal Live' })).json().channel;
    expect(ingestBodies().at(-1)!.feeds.map((f) => f.channelId)).toEqual([feed.id]);
    const hidden = await call('PATCH', `/api/admin/livetv/channels/${feed.id}`, { hidden: true });
    expect(hidden.json()).toMatchObject({ hidden: true, push: { port: 9000, portInRange: true } });
    expect(ingestBodies().at(-1)).toEqual({ feeds: [] });
    const sent = ingestBodies().length;
    await call('PATCH', `/api/admin/livetv/channels/${feed.id}`, { name: 'Hafenkanal Kamera' }); // no visibility change: no sync
    expect(ingestBodies()).toHaveLength(sent);
    await call('POST', '/api/admin/livetv/channels/bulk', { ids: [feed.id], action: 'show' });
    expect(ingestBodies().at(-1)!.feeds.map((f) => f.channelId)).toEqual([feed.id]);
    await call('POST', '/api/admin/livetv/channels/bulk', { ids: [feed.id], action: 'hide' });
    expect(ingestBodies().at(-1)).toEqual({ feeds: [] });
    // the list row carries the push facts, never the credentials
    const row = (await list()).channels[0]!;
    expect(row.push).toEqual({ port: 9000, hint: expect.stringMatching(/^ff-[A-Z2-7]{6}$/), portInRange: true });
  });
});

describe('synced: an own feed change is applied in livetv', () => {
  const failing = () => fakeHttp({ 'GET /v1/system': () => ({ json: system() }), 'PUT /v1/ingest': () => ({ status: 502, json: { error: 'down' } }) }, calls);
  afterEach(async () => { await env.kv.del(INGEST_DIRTY_KEY); });

  it('PATCH answers synced for a push feed: true once livetv took the set, false while it is not applied', async () => {
    const feed = (await call('POST', '/api/admin/livetv/channels', { ingest: 'push', name: 'Hafenkanal Live' })).json().channel;
    const ok = await call('PATCH', `/api/admin/livetv/channels/${feed.id}`, { hidden: true });
    expect(ok.json()).toMatchObject({ hidden: true, synced: true });
    env.ctx.fetchImpl = failing();
    const bad = await call('PATCH', `/api/admin/livetv/channels/${feed.id}`, { hidden: false });
    expect(bad.json()).toMatchObject({ hidden: false, synced: false });
    // a change that needs no sync still reports that the last one is not applied yet; the list says so too
    expect((await call('PATCH', `/api/admin/livetv/channels/${feed.id}`, { name: 'Hafenkanal Kamera' })).json().synced).toBe(false);
    expect((await list()).channels[0]!.synced).toBe(false);
    // livetv is back: the minute tick sends the set, the next list is synced
    env.ctx.fetchImpl = fakeHttp({ 'GET /v1/system': () => ({ json: system() }), 'PUT /v1/ingest': () => ({ json: { ok: true } }) }, calls);
    await syncIngest(env.ctx);
    expect((await list()).channels[0]!.synced).toBe(true);
  });

  it('bulk hide / show answers synced when it touches a push feed; no key for a pulled channel', async () => {
    const src = await addSource();
    const pulled = await addChannel(src, 'Nordlicht TV', { number: 1 });
    expect((await call('PATCH', `/api/admin/livetv/channels/${pulled}`, { hidden: true })).json()).not.toHaveProperty('synced');
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [pulled], action: 'show' })).json()).toEqual({ changed: 1 });
    const feed = (await call('POST', '/api/admin/livetv/channels', { ingest: 'push', name: 'Hafenkanal Live' })).json().channel;
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [feed.id, pulled], action: 'hide' })).json()).toEqual({ changed: 2, synced: true });
    env.ctx.fetchImpl = failing();
    expect((await call('POST', '/api/admin/livetv/channels/bulk', { ids: [feed.id, pulled], action: 'show' })).json()).toEqual({ changed: 2, synced: false });
  });
});

describe('the stream test (ruling 15, F10)', () => {
  it('test stores the probe and answers no URL', async () => {
    const src = await addSource({ userAgent: 'Testgeraet/1.0' });
    const id = await addChannel(src, 'Nordlicht TV', { number: 1, kind: 'ts', url: STREAM_URL });
    const r = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, video: FACTS.video, audio: FACTS.audio, needs: 'remux' });
    expect(r.body).not.toContain('iptv.example.com');
    expect(r.headers['cache-control']).toBe('no-store');
    // livetv got the decrypted input; the source's user agent goes with it
    expect(probeBodies()).toEqual([{ input: { url: STREAM_URL, kind: 'ts', allowLan: false, userAgent: 'Testgeraet/1.0' } }]);
    const stored = (await env.pool.query('select probe from livetv_channels where id = $1', [id])).rows[0].probe;
    expect(stored).toEqual({ at: expect.any(String), ok: true, video: FACTS.video, audio: FACTS.audio, needs: 'remux' });
    expect(Date.now() - Date.parse(stored.at)).toBeLessThan(60_000);
    expect(await one(id)).toMatchObject({ mode: 'remux', probeError: null });
    expect(await audits('livetv.channel.test')).toEqual([{ target: id, meta: { fields: ['probe'] } }]);

    // a failed probe: no mode, the code
    probe = () => ({ json: { ok: false, needs: 'transcode', error: 'timeout' } });
    const failed = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    expect(failed.json()).toEqual({ ok: false, video: null, audio: null, needs: null, error: 'timeout' });
    expect(await one(id)).toMatchObject({ mode: null, probeError: 'timeout' });
    expect((await list('error=1')).total).toBe(1);

    // livetv not reached: nothing stored; an odd answer is not stored either
    probe = () => { throw new TypeError('fetch failed'); };
    env.ctx.fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const down = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    expect([down.statusCode, down.json()]).toEqual([503, { error: 'livetv_unreachable' }]);
    env.ctx.fetchImpl = fakeHttp({ 'POST /v1/probe': () => ({ json: { ok: true, needs: 'remux', video: { codec: 'h264', width: 'wide' } } }) }, calls);
    const odd = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    expect([odd.statusCode, odd.json()]).toEqual([502, { error: 'livetv_error' }]);
    expect(await one(id)).toMatchObject({ probeError: 'timeout' });

    // a disabled source is not tested; an unknown channel is a 404
    await env.pool.query('update livetv_sources set enabled = false where id = $1', [src]);
    const off = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    expect([off.statusCode, off.json()]).toEqual([409, { error: 'source_disabled' }]);
    expect((await call('POST', `/api/admin/livetv/channels/${randomUUID()}/test`)).statusCode).toBe(404);
  });

  it('a channel of an unreleased group can be tested', async () => {
    const src = await addSource();
    const g = await addGroup('DE | Neu', false); // an import created it: unreleased, granted to no role
    await mapGroup(src, 'DE | Neu', g);
    const id = await addChannel(src, 'Kanal Wolkenlos', { group: 'DE | Neu' });
    const r = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, video: FACTS.video, audio: FACTS.audio, needs: 'remux' }]);
    expect(await one(id)).toMatchObject({ groupId: g, mode: 'remux' });
  });

  it('a push feed is probed by its channel id; bulk tests run one after another', async () => {
    const feed = (await call('POST', '/api/admin/livetv/channels', { ingest: 'push', name: 'Hafenkanal Live' })).json().channel;
    const src = await addSource();
    const a = await addChannel(src, 'Nordlicht TV');
    calls.length = 0;
    probe = (_u, _i, body) => ({ json: 'push' in body.input ? { ok: false, needs: 'transcode', error: 'invalid' } : FACTS });
    const r = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [feed.id, a, randomUUID()], action: 'test' });
    expect(r.statusCode).toBe(200);
    expect(r.json().results).toEqual([
      { id: feed.id, ok: false, error: 'invalid' }, { id: a, ok: true, needs: 'remux' }, { id: expect.any(String), ok: false, error: 'not_found' },
    ]);
    expect(probeBodies()[0]).toEqual({ input: { push: feed.id } });
    const tooMany = await call('POST', '/api/admin/livetv/channels/bulk', { ids: Array.from({ length: 21 }, () => randomUUID()), action: 'test' });
    expect([tooMany.statusCode, tooMany.json()]).toEqual([400, { error: 'invalid', field: 'ids' }]);
    // once livetv is not reached, the rest are not tried
    env.ctx.fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const down = await call('POST', '/api/admin/livetv/channels/bulk', { ids: [a, feed.id], action: 'test' });
    expect(down.json().results).toEqual([{ id: a, ok: false, error: 'livetv_unreachable' }, { id: feed.id, ok: false, error: 'livetv_unreachable' }]);
  });

  it('one test per admin at a time', async () => {
    const src = await addSource();
    const a = await addChannel(src, 'Nordlicht TV');
    await env.kv.setnx(`ltv:chtest:${adminId}`, 'other', 60);
    const r = await call('POST', `/api/admin/livetv/channels/${a}/test`);
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'test_running' }]);
    expect(probeBodies()).toEqual([]);
  });
});

describe('the stream test preview (Task 42, F10)', () => {
  const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
  const streams = new Map<string, Record<string, unknown>>();
  let posts: Array<Record<string, unknown>> = [];
  let postStatus = 200;
  let onStart: (() => Promise<void>) | undefined;
  let deletes = false; // only the stop tests let livetv really end a stream
  const preview = (r: { json(): any }) => (r.json() as { preview?: { url: string; token: string } }).preview;
  const authz = (token: string) => env.app.inject({ method: 'POST', url: '/internal/authz/live', headers: H, payload: { token, ip: '192.0.2.250' } });
  const livetv = () => fakeHttp({
    'GET /healthz': () => ({ json: { ok: true, api: 1, version: '3.3.0', bootId: '0123456789abcdef' } }),
    'GET /v1/system': () => ({ json: system() }), 'PUT /v1/ingest': () => ({ json: { ok: true } }), 'POST /v1/probe': (...a) => probe(...a),
    'GET /v1/streams': () => ({ json: [...streams.values()] }),
    ...(deletes ? { 'DELETE /v1/streams/[\\w-]+': (u: URL) => (streams.delete(u.pathname.split('/').pop()!) ? { status: 204 } : { status: 404, json: { error: 'not_found' } }) } : {}),
    'POST /v1/streams': (_u, _i, b: Record<string, unknown>) => {
      posts.push(b);
      if (postStatus !== 200) return { status: postStatus, json: { error: 'start_failed' } };
      const sv = { channelId: b.channelId, streamKey: 'ab'.repeat(16), mode: b.mode, since: Date.now(), state: 'running', bitrate: 4_000_000, errors: [], lastSegmentAt: Date.now() };
      streams.set(String(b.channelId), sv);
      return { json: { streamKey: sv.streamKey, state: 'running' } };
    },
  }, calls);
  /** livetv, but a start first runs `onStart` (a request of the test lands while the start is in flight) */
  const livetvWithHook = () => {
    const inner = livetv();
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (onStart && (init?.method ?? 'GET') === 'POST' && new URL(String(input)).pathname === '/v1/streams') await onStart();
      return inner(input, init);
    }) as typeof fetch;
  };
  beforeEach(async () => {
    streams.clear(); posts = []; postStatus = 200; onStart = undefined; deletes = false;
    for (const k of await env.kv.keys('ltv')) { if (!k.startsWith('ltv:chtest:')) await env.kv.del(k); }
    env.ctx.fetchImpl = livetv();
    await detectLivetv(env.ctx, 0);
    invalidateLiveConversions();
  });

  it('test answers a preview token only when the channel can start', async () => {
    const src = await addSource();
    const a = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const r = await call('POST', `/api/admin/livetv/channels/${a}/test`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, needs: 'remux' });
    const p = preview(r)!;
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.url).toBe(`/media/l/${p.token}/index.m3u8`);
    expect(Object.keys(r.json().preview).sort()).toEqual(['token', 'url']);
    expect(posts.map((b) => b.channelId)).toEqual([a]);
    // the token is a test token of the admin's own device, and it plays
    const rec = JSON.parse((await env.kv.get(`ltv:${createHash('sha256').update(p.token).digest('hex')}`))!);
    expect(rec).toMatchObject({ userId: adminId, channelId: a, kind: 'live', via: 'local', test: true });
    expect((await authz(p.token)).statusCode).toBe(200);
    // a second test of the same channel joins the running stream (no second start) and replaces the earlier test token
    await env.kv.del(`ltv:chtest:${adminId}`);
    const again = preview(await call('POST', `/api/admin/livetv/channels/${a}/test`))!;
    expect(posts).toHaveLength(1);
    expect((await authz(p.token)).statusCode).toBe(410);
    expect((await authz(again.token)).statusCode).toBe(200);

    // a probe that failed: no start, no preview, facts only
    streams.clear(); posts = [];
    probe = () => ({ json: { ok: false, needs: 'transcode', error: 'timeout' } });
    const failed = await call('POST', `/api/admin/livetv/channels/${a}/test`);
    expect(failed.json()).toEqual({ ok: false, video: null, audio: null, needs: null, error: 'timeout' });
    expect(posts).toEqual([]);

    // the provider's connection limit refuses the start: facts only
    probe = () => ({ json: FACTS });
    await env.pool.query('update livetv_sources set max_streams = 1 where id = $1', [src]);
    const b = await addChannel(src, 'Hafenkanal', { number: 2 });
    streams.set(b, { channelId: b, streamKey: 'cd'.repeat(16), mode: 'remux', since: Date.now(), state: 'running', bitrate: null, errors: [], lastSegmentAt: Date.now() });
    invalidateLiveConversions();
    const full = await call('POST', `/api/admin/livetv/channels/${a}/test`);
    expect(full.statusCode).toBe(200);
    expect(full.json()).toEqual({ ok: true, video: FACTS.video, audio: FACTS.audio, needs: 'remux' });
    expect(posts).toEqual([]);

    // livetv refuses the start itself: facts only
    await env.pool.query('update livetv_sources set max_streams = null where id = $1', [src]);
    streams.clear(); invalidateLiveConversions();
    postStatus = 500;
    const broken = await call('POST', `/api/admin/livetv/channels/${a}/test`);
    expect([broken.statusCode, preview(broken)]).toEqual([200, undefined]);
    // a disabled source is still refused, preview or not
    await env.pool.query('update livetv_sources set enabled = false where id = $1', [src]);
    expect((await call('POST', `/api/admin/livetv/channels/${a}/test`)).statusCode).toBe(409);
  });

  it('Neu starten: a stop leaves the marker, the admin test start clears it and starts again (final review I1)', async () => {
    deletes = true;
    env.ctx.fetchImpl = livetv(); // with a DELETE that really ends a stream
    env.ctx.fetchImpl = livetv(); // with a DELETE that really ends a stream
    const src = await addSource();
    const a = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const first = preview(await call('POST', `/api/admin/livetv/channels/${a}/test`))!;
    expect((await authz(first.token)).statusCode).toBe(200);
    const stop = await call('POST', `/api/admin/livetv/streams/${a}/stop`);
    expect(stop.statusCode).toBe(200);
    expect(await env.kv.get(`ltv:adminstop:${a}`)).toBe('1');
    expect((await authz(first.token)).statusCode).toBe(410); // the stop revoked it, test tokens too
    await env.kv.del(`ltv:chtest:${adminId}`);
    const again = preview(await call('POST', `/api/admin/livetv/channels/${a}/test`))!;
    expect(again).toBeDefined();
    expect(await env.kv.get(`ltv:adminstop:${a}`)).toBeNull();
    expect(posts.map((b) => b.channelId)).toEqual([a, a]);
    expect((await authz(again.token)).statusCode).toBe(200);
  });

  it('a profile switch that lands during the test start takes the test token back (final review M6)', async () => {
    const src = await addSource();
    const a = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const s2 = await env.login(); // a session of its own: the switch must not change the shared admin session
    const h = { 'x-csrf-token': s2.csrf };
    const made = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: s2.cookies, headers: h, payload: { name: 'Kinderinsel' } });
    expect(made.statusCode, made.body).toBe(201);
    const pid = made.json().profile.id as string;
    env.ctx.fetchImpl = livetvWithHook();
    onStart = async () => { await env.app.inject({ method: 'POST', url: `/api/profiles/${pid}/select`, cookies: s2.cookies, headers: h, payload: {} }); };
    const r = await env.app.inject({ method: 'POST', url: `/api/admin/livetv/channels/${a}/test`, cookies: s2.cookies, headers: h, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
    expect(preview(r)).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(await env.kv.keys('ltv:view:')).toEqual([]); // no token of the old profile stays alive
  });

  it('a full conversion budget gives the facts only: no preview, no token', async () => {
    const src = await addSource();
    const running = await addChannel(src, 'Nordlicht TV', { number: 1 });
    const a = await addChannel(src, 'Hafenkanal', { number: 2, kind: 'ts' });
    // the running live transcode fills a budget of one; the tested channel would need a transcode slot too
    streams.set(running, { channelId: running, streamKey: 'cd'.repeat(16), mode: 'transcode', since: Date.now(), state: 'running', bitrate: null, errors: [], lastSegmentAt: Date.now() });
    invalidateLiveConversions();
    const was = env.ctx.cfg;
    env.ctx.cfg = { ...was, CONVERSION_SLOTS: 1 };
    probe = () => ({ json: { ...FACTS, needs: 'transcode' } });
    try {
      const r = await call('POST', `/api/admin/livetv/channels/${a}/test`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true, video: FACTS.video, audio: FACTS.audio, needs: 'transcode' });
      expect(posts).toEqual([]);
      expect(await env.kv.keys(`ltvidx:${adminId}`)).toEqual([]);
      expect(await env.kv.keys('ltv:view:')).toEqual([]);
    } finally { env.ctx.cfg = was; }
  });

  it('an admin previews a channel of an unreleased group', async () => {
    const src = await addSource();
    const g = await addGroup('DE | Neu', false);
    await mapGroup(src, 'DE | Neu', g);
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'family')", [g]);
    invalidateLivetvRights();
    const id = await addChannel(src, 'Kanal Wolkenlos', { group: 'DE | Neu' });
    const r = await call('POST', `/api/admin/livetv/channels/${id}/test`);
    const p = preview(r);
    expect(p).toBeDefined();
    const ok = await authz(p!.token);
    expect([ok.statusCode, ok.json()]).toEqual([200, expect.objectContaining({ streamKey: 'ab'.repeat(16) })]);
    // a family member watching the same channel is refused: the release still counts for everybody else
    const sub = 'anna-t42';
    const annaId = randomUUID();
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, 'Anna Beispiel', 'family', $4, $2, $5)`,
      [annaId, sub, `${sub}@friend.example.com`, annaId.replace(/-/g, '').slice(0, 32), encrypt(key, 'pw')]);
    const anna = await env.login({ sub, email: `${sub}@friend.example.com`, name: 'Anna Beispiel', groups: [] });
    await env.pool.query('update devices set approved = true where user_id = $1', [annaId]);
    const w = await call('POST', `/api/livetv/channels/${id}/watch`, {}, anna);
    expect(w.statusCode).toBe(403);
    await env.pool.query('delete from users where id = $1', [annaId]);
  });
});

describe('logos (ruling 32)', () => {
  it('logo upload refuses SVG (415) and 600 KB (413), stores a PNG', async () => {
    const src = await addSource();
    const id = await addChannel(src, 'Nordlicht TV');
    const svg = await upload(id, 'image/svg+xml', SVG);
    expect([svg.statusCode, svg.json()]).toEqual([415, { error: 'unsupported_type' }]);
    const big = await upload(id, 'image/png', Buffer.concat([PNG, Buffer.alloc(600 * 1024)]));
    expect([big.statusCode, big.json()]).toEqual([413, { error: 'too_large' }]);
    // the magic bytes decide, not the declared type
    const disguised = await upload(id, 'image/png', SVG);
    expect([disguised.statusCode, disguised.json()]).toEqual([415, { error: 'unsupported_type' }]);
    const mislabelled = await upload(id, 'image/jpeg', PNG);
    expect([mislabelled.statusCode, mislabelled.json()]).toEqual([415, { error: 'unsupported_type' }]);
    const json = await call('PUT', `/api/admin/livetv/channels/${id}/logo`, { logo: 'x' });
    expect([json.statusCode, json.json()]).toEqual([415, { error: 'unsupported_type' }]);
    expect((await env.pool.query('select count(*)::int as n from livetv_logos')).rows[0].n).toBe(0);

    const hash = createHash('sha256').update(PNG).digest('hex');
    const ok = await upload(id, 'image/png', PNG);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, logoHash: hash, overridden: { logo: true } });
    expect((await env.pool.query('select hash, mime, bytes from livetv_logos')).rows).toEqual([{ hash, mime: 'image/png', bytes: PNG }]);
    expect(await audits('livetv.channel.logo')).toEqual([{ target: id, meta: { fields: ['logo'] } }]);
    expect((await upload(randomUUID(), 'image/png', PNG)).statusCode).toBe(404);
    const noCsrf = await env.app.inject({ method: 'PUT', url: `/api/admin/livetv/channels/${id}/logo`, cookies: admin.cookies, headers: { 'content-type': 'image/png' }, payload: PNG });
    expect([noCsrf.statusCode, noCsrf.json()]).toEqual([403, { error: 'csrf' }]);

    // JPEG and WebP by their magic bytes
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect((await upload(id, 'image/jpeg', jpeg)).json().logoHash).toBe(createHash('sha256').update(jpeg).digest('hex'));
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
    expect((await upload(id, 'image/webp; charset=binary', webp)).statusCode).toBe(200);

    // back to the imported logo
    await env.pool.query('update livetv_channels set import_logo_hash = $2 where id = $1', [id, hash]);
    const del = await call('DELETE', `/api/admin/livetv/channels/${id}/logo`);
    expect(del.json()).toMatchObject({ logoHash: hash, overridden: {} });
    expect((await call('DELETE', `/api/admin/livetv/channels/${randomUUID()}/logo`)).statusCode).toBe(404);
  });

  it('logos route sends the cache header', async () => {
    const src = await addSource();
    const id = await addChannel(src, 'Nordlicht TV');
    const hash = (await upload(id, 'image/png', PNG)).json().logoHash as string;
    const r = await env.app.inject({ method: 'GET', url: `/api/livetv/logos/${hash}`, cookies: admin.cookies });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=604800, immutable');
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'");
    expect(r.rawPayload.equals(PNG)).toBe(true);
    for (const h of ['0'.repeat(64), 'nope', hash.toUpperCase()]) {
      const miss = await env.app.inject({ method: 'GET', url: `/api/livetv/logos/${h}`, cookies: admin.cookies });
      expect([h, miss.statusCode, miss.json()]).toEqual([h, 404, { error: 'not_found' }]);
    }
    expect((await env.app.inject({ method: 'GET', url: `/api/livetv/logos/${hash}` })).statusCode).toBe(401);
  });
});

describe('access and secrets', () => {
  it('no stream URL in any answer', async () => {
    const src = await addSource();
    const id = await addChannel(src, 'Nordlicht TV', { number: 1, url: STREAM_URL, kind: 'ts' });
    const before = answers.length;
    await list();
    await one(id);
    await call('PATCH', `/api/admin/livetv/channels/${id}`, { name: 'Nordlicht HD', epgShiftMin: 30 });
    await call('POST', '/api/admin/livetv/channels/bulk', { ids: [id], action: 'renumber', from: 5 });
    await call('PUT', '/api/admin/livetv/channels/order', { ids: [id] });
    await call('POST', `/api/admin/livetv/channels/${id}/test`);
    await call('POST', '/api/admin/livetv/channels/bulk', { ids: [id], action: 'test' });
    await upload(id, 'image/png', PNG);
    await call('DELETE', `/api/admin/livetv/channels/${id}/logo`);
    probe = () => ({ json: { ok: false, needs: 'transcode', error: 'unreachable' } });
    await call('POST', `/api/admin/livetv/channels/${id}/test`);
    const mine = answers.slice(before);
    expect(mine).toHaveLength(10);
    for (const a of mine) {
      expect(a).not.toContain('iptv.example.com');
      expect(a).not.toContain('geheim');
    }
    // the audit log holds field names and ids only
    const audit = JSON.stringify((await env.pool.query('select meta from audit_log')).rows);
    expect(audit).not.toContain('iptv.example.com');
    expect(audit).not.toContain('Nordlicht HD');
  });

  it('non-admin 403', async () => {
    const src = await addSource();
    const id = await addChannel(src, 'Nordlicht TV');
    await env.pool.query(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values (gen_random_uuid(), 'sub-ben', 'ben@friend.example.com', 'Ben Muster', 'family', $1, 'Ben', $2) on conflict do nothing`, ['2'.repeat(32), encrypt(key, 'pw')]);
    const ben = await env.login({ sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] });
    try {
      for (const [m, u, b] of [
        ['GET', '/api/admin/livetv/channels', undefined], ['GET', `/api/admin/livetv/channels/${id}`, undefined],
        ['PATCH', `/api/admin/livetv/channels/${id}`, { hidden: true }], ['POST', '/api/admin/livetv/channels/bulk', { ids: [id], action: 'hide' }],
        ['PUT', '/api/admin/livetv/channels/order', { ids: [id] }], ['POST', `/api/admin/livetv/channels/${id}/test`, undefined],
        ['DELETE', `/api/admin/livetv/channels/${id}/logo`, undefined],
      ] as const) {
        const r = await call(m, u, b, ben);
        expect([m, u, r.statusCode]).toEqual([m, u, 403]);
      }
      expect((await upload(id, 'image/png', PNG, ben)).statusCode).toBe(403);
      expect((await upload(id, 'image/svg+xml', SVG, ben)).statusCode).toBe(403); // refused before the body is looked at
      const anon = await env.app.inject({ method: 'PUT', url: `/api/admin/livetv/channels/${id}/logo`, headers: { 'content-type': 'image/png' }, payload: PNG });
      expect(anon.statusCode).toBe(401);
      expect(probeBodies()).toEqual([]);
      expect((await one(id)).hidden).toBe(false);
      // the logo route is for every signed-in person
      const hash = (await upload(id, 'image/png', PNG)).json().logoHash as string;
      expect((await env.app.inject({ method: 'GET', url: `/api/livetv/logos/${hash}`, cookies: ben.cookies })).statusCode).toBe(200);
    } finally {
      env.claims.current = ADMIN;
    }
  });
});

describe('wire.ts (F4)', () => {
  it('StreamInput, ProbeError and ProbeResult are the declarations of livetv/src/probe.ts, field for field', () => {
    const theirs = readFileSync(new URL('../../livetv/src/probe.ts', import.meta.url), 'utf8');
    const ours = readFileSync(new URL('../src/livetv/wire.ts', import.meta.url), 'utf8');
    const norm = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    const line = (src: string, from: string) => {
      const i = src.indexOf(from);
      expect(i).toBeGreaterThan(-1);
      return norm(src.slice(i, src.indexOf(';\n', i) + 1));
    };
    const body = (src: string, from: string) => {
      const i = src.indexOf(from);
      expect(i).toBeGreaterThan(-1);
      return norm(src.slice(src.indexOf('{', i), src.indexOf('\n}', i) + 2));
    };
    expect(line(ours, 'type StreamInput')).toBe(line(theirs, 'type StreamInput'));
    expect(line(ours, 'type ProbeError')).toBe(line(theirs, 'type ProbeError'));
    expect(body(ours, 'interface ProbeResult')).toBe(body(theirs, 'interface ProbeResult'));
  });
});
