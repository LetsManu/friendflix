// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV Phase 1, Task 16: the import merge of a provider list (spec §10, §19; rulings 18, 19, 39-41), the refresh with its failure
 * handling and the refresh tick (F16), and logos (ruling 28). Provider URLs never leave the backend (F13).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt, keyFromBase64 } from '../src/crypto.js';
import { detectLivetv } from '../src/livetv/detect.js';
import { listEvents } from '../src/livetv/events.js';
import { importNumber, mergeImport } from '../src/livetv/import.js';
import { livetvRefreshTick, refreshSource } from '../src/livetv/refresh.js';
import type { SourceRow } from '../src/livetv/sources.js';
import type { FetchM3uAnswer, M3uEntry } from '../src/livetv/wire.js';
import { ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const key = keyFromBase64(ENC_KEY);
const logs: string[] = [];

const SECRET_URL = 'https://anna:geheim@iptv.example.com/get.php?username=anna&password=geheim&type=m3u_plus';
const LEAKS = ['iptv.example.com', 'geheim'];
// a 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

// ---- the fake livetv: drops skipped groups like livetv does (listed counts them, ruling 41) ----
const calls: Call[] = [];
let list: M3uEntry[] = [];
let m3u: Handler;
let logo: Handler;
/** livetv is installed (detection: healthz api 1) unless a test turns it off */
let up = true;
const HEALTH = { ok: true, api: 1, version: '1.0.0', bootId: '0123456789abcdef' };
const livetvFake = () => fakeHttp({
  'GET /healthz': () => (up ? { json: HEALTH } : { status: 503 }),
  'POST /v1/fetch/m3u': (...a) => m3u(...a),
  'POST /v1/fetch/logo': (...a) => logo(...a),
}, calls);
const setUp = async (v: boolean) => { up = v; await detectLivetv(env.ctx, 0); };
const m3uAnswer = (all: M3uEntry[], skip: readonly string[]): FetchM3uAnswer => {
  const groups: Array<{ name: string; channels: number }> = [];
  for (const e of all) {
    const g = groups.find((x) => x.name === e.group);
    if (g) g.channels++;
    else if (e.group) groups.push({ name: e.group, channels: 1 });
  }
  const entries = all.filter((e) => !e.group || !skip.includes(e.group));
  return { entries, groups, listed: all.length, skipped: { vod: 0, invalid: 0, overLimit: 0, groups: all.length - entries.length } };
};

/** an entry at list position `pos`; the key stands for livetv's (tvg-id, else name + host + stream id: no credentials, ruling 18) */
const entry = (name: string, group: string | undefined, pos: number, o: Partial<M3uEntry> = {}): M3uEntry =>
  ({ key: `k${pos}`, name, ...(group ? { group } : {}), pos, url: `https://iptv.example.com/live/anna/geheim/${pos}.ts`, kind: 'ts', ...o });
/** "DE | Sport" 3, "Kinder" 2, "Nachrichten" 1 */
const six = (): M3uEntry[] => [
  entry('Bergblick Sport', 'DE | Sport', 0), entry('Bergblick Sport 2', 'DE | Sport', 1), entry('Hafenkanal Sport', 'DE | Sport', 2),
  entry('Kinderinsel', 'Kinder', 3), entry('Kinderinsel Plus', 'Kinder', 4),
  entry('Nordlicht TV', 'Nachrichten', 5),
];
/** `n` entries in groups of 10 ("Gruppe 0" … ) */
const many = (n: number): M3uEntry[] => Array.from({ length: n }, (_, i) => entry(`Sternwarte ${i}`, `Gruppe ${Math.floor(i / 10)}`, i));

async function addSource(o: Partial<Record<keyof SourceRow, unknown>> = {}): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into livetv_sources(id, kind, name, url_enc, url_hint, skip_groups, numbering, number_base, refresh, last_refresh_at, position)
     values ($1, 'm3u', $2, $3, 'https://iptv.example.com/…', $4, $5, $6, $7, $8, 0)`,
    [id, o.name ?? 'Anbieter', encrypt(key, SECRET_URL), o.skip_groups ?? [], o.numbering ?? 'chno', o.number_base ?? 1, o.refresh ?? '24h', o.last_refresh_at ?? null]);
  return id;
}
const src = async (id: string) => (await env.pool.query<SourceRow>('select * from livetv_sources where id = $1', [id])).rows[0]!;
const setSource = (id: string, sql: string, vals: unknown[] = []) => env.pool.query(`update livetv_sources set ${sql} where id = $1`, [id, ...vals]);
const channels = async (id: string) => (await env.pool.query(
  `select c.*, (select m.group_id from livetv_group_map m where m.source_id = c.source_id and m.provider_group = c.import_group) as map_group
     from livetv_channels c where source_id = $1 order by source_key`, [id])).rows;
const byKey = async (id: string) => new Map((await channels(id)).map((c) => [c.source_key as string, c]));
const groups = async () => (await env.pool.query('select g.*, (select count(*)::int from livetv_group_roles r where r.group_id = g.id) as roles from livetv_groups g order by name')).rows;
const refresh = (id: string) => refreshSource(env.ctx, id, 'admin');
const m3uCalls = () => calls.filter((c) => c.path === '/v1/fetch/m3u');
const logoCalls = () => calls.filter((c) => c.path === '/v1/fetch/logo');
let addr = 0;
const call = (method: 'GET' | 'POST', url: string, s: Sess = admin) =>
  env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, remoteAddress: `192.0.2.${++addr % 200 + 1}` });

beforeAll(async () => {
  env = await makeEnv({}, { logger: { stream: { write: (l: string) => { logs.push(l); } }, level: 'trace' } });
  admin = await env.login();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query(`delete from livetv_recent; delete from livetv_favourites; delete from livetv_channels; delete from livetv_group_map;
    delete from livetv_group_roles; delete from livetv_groups; delete from livetv_logos; delete from livetv_sources; delete from audit_log;
    delete from notifications`);
  for (const k of [...await env.kv.keys('ltv:'), ...await env.kv.keys('ltvlogo:')]) await env.kv.del(k);
  calls.length = 0;
  logs.length = 0;
  list = six();
  m3u = (_u, _i, body: { skipGroups?: string[] }) => ({ json: m3uAnswer(list, body?.skipGroups ?? []) });
  logo = () => ({ raw: PNG, type: 'image/png' });
  env.ctx.fetchImpl = livetvFake();
  await setUp(true);
  calls.length = 0;
  vi.restoreAllMocks();
});

describe('import merge (spec §10)', () => {
  it('first import creates channels and unreleased groups', async () => {
    const id = await addSource();
    await refresh(id);
    const s = await src(id);
    expect(s.last_error).toBeNull();
    expect(s.last_ok_at).not.toBeNull();
    expect(s.last_counts).toMatchObject({ channels: 6, added: 6, removed: 0, listed: 6, newGroups: 3 });
    const gs = await groups();
    expect(gs.map((g) => g.name)).toEqual(['DE | Sport', 'Kinder', 'Nachrichten']);
    for (const g of gs) expect(g).toMatchObject({ released: false, kid_friendly: false, roles: 0 });
    const ch = await channels(id);
    expect(ch).toHaveLength(6);
    const sport = gs.find((g) => g.name === 'DE | Sport').id;
    expect(ch.filter((c) => c.map_group === sport)).toHaveLength(3);
    expect(ch.every((c) => c.missing_since === null && c.ingest === 'pull' && c.stream_kind === 'ts')).toBe(true);
    expect(decrypt(key, ch[0].stream_url_enc)).toBe('https://iptv.example.com/live/anna/geheim/0.ts');
  });

  it('skipped groups are not imported and their channels go missing', async () => {
    const id = await addSource({ skip_groups: ['Kinder'] });
    await refresh(id);
    expect(m3uCalls()[0]!.body.skipGroups).toEqual(['Kinder']);
    expect((await channels(id)).map((c) => c.import_name)).toEqual(['Bergblick Sport', 'Bergblick Sport 2', 'Hafenkanal Sport', 'Nordlicht TV']);
    // ticked again: its two channels arrive
    await setSource(id, 'skip_groups = $2', [[]]);
    await refresh(id);
    let ch = await byKey(id);
    expect(ch.size).toBe(6);
    expect(ch.get('k3')!.missing_since).toBeNull();
    await env.pool.query("update livetv_channels set name_override = 'Kinderinsel Eins', hidden = true where source_id = $1 and source_key = 'k3'", [id]);
    // skipped again: missing, overrides kept
    await setSource(id, 'skip_groups = $2', [['Kinder']]);
    await refresh(id);
    ch = await byKey(id);
    expect(ch.get('k3')!.missing_since).not.toBeNull();
    expect(ch.get('k4')!.missing_since).not.toBeNull();
    expect(ch.get('k3')).toMatchObject({ name_override: 'Kinderinsel Eins', hidden: true });
    expect([...ch.values()].filter((c) => c.missing_since === null)).toHaveLength(4);
    expect((await src(id)).last_counts).toMatchObject({ channels: 4, removed: 2, listed: 6 });
  });

  it('an entry of a skipped group is never imported, even if livetv sends it', async () => {
    const id = await addSource({ skip_groups: ['Kinder'] });
    const r = await mergeImport(env.ctx, await src(id), { entries: six(), listed: 6 });
    expect(r).toMatchObject({ added: 4, total: 4, listed: 6 });
    expect((await channels(id)).some((c) => c.import_group === 'Kinder')).toBe(false);
  });

  it('unticking most groups does not trip the shrink guard', async () => {
    list = many(100);
    const id = await addSource();
    await refresh(id);
    const before = await byKey(id);
    expect(before.size).toBe(100);
    // 9 of 10 groups unticked: 90 of 100 listed entries skipped
    await setSource(id, 'skip_groups = $2', [Array.from({ length: 9 }, (_, i) => `Gruppe ${i + 1}`)]);
    await refresh(id);
    const s = await src(id);
    expect(s.last_error).toBeNull();
    expect(s.last_counts).toMatchObject({ channels: 10, removed: 90, listed: 100 });
    const after = await byKey(id);
    expect([...after.values()].filter((c) => c.missing_since !== null)).toHaveLength(90);
    for (let i = 0; i < 10; i++) {
      const c = after.get(`k${i}`)!;
      expect(c.missing_since).toBeNull();
      expect(c.import_number).toBe(before.get(`k${i}`)!.import_number);
      expect(c.import_number).toBe(i + 1);
    }
  });

  it('numbering policies', async () => {
    expect(importNumber({ chno: 7, pos: 0 }, { numbering: 'chno', number_base: 100 })).toBe(7);
    expect(importNumber({ pos: 3 }, { numbering: 'chno', number_base: 100 })).toBe(103);
    expect(importNumber({ chno: 7, pos: 3 }, { numbering: 'order', number_base: 1 })).toBe(4);
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { chno: 7 }), entry('Hafenkanal', 'Nachrichten', 1), entry('Kanal Wolkenlos', 'Nachrichten', 2),
      entry('Sternwarte 24', 'Nachrichten', 3)];
    const id = await addSource({ numbering: 'chno', number_base: 100 });
    await refresh(id);
    let ch = await byKey(id);
    expect(ch.get('k0')!.import_number).toBe(7);
    expect(ch.get('k3')!.import_number).toBe(103);
    await env.pool.query("update livetv_channels set number_override = 42 where source_id = $1 and source_key = 'k3'", [id]);
    // order, base 1: position + 1, even with tvg-chno; the admin's number stays
    await setSource(id, "numbering = 'order', number_base = 1");
    await refresh(id);
    ch = await byKey(id);
    expect(['k0', 'k1', 'k2', 'k3'].map((k) => ch.get(k)!.import_number)).toEqual([1, 2, 3, 4]);
    expect(ch.get('k3')!.number_override).toBe(42);
  });

  it('tvg-shift is stored per channel', async () => {
    // header +60 (livetv puts it on every entry without its own), one entry -90
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { shiftMin: 60 }), entry('Hafenkanal', 'Nachrichten', 1, { shiftMin: -90 })];
    const id = await addSource();
    await refresh(id);
    let ch = await byKey(id);
    expect(ch.get('k0')!.import_epg_shift_min).toBe(60);
    expect(ch.get('k1')!.import_epg_shift_min).toBe(-90);
    list = [entry('Nordlicht TV', 'Nachrichten', 0), entry('Hafenkanal', 'Nachrichten', 1)];
    await refresh(id);
    ch = await byKey(id);
    expect(ch.get('k0')!.import_epg_shift_min).toBeNull();
    expect(ch.get('k1')!.import_epg_shift_min).toBeNull();
  });

  it('a group the provider adds later arrives unreleased', async () => {
    const sport = randomUUID();
    await env.pool.query("insert into livetv_groups(id, name, released) values ($1, 'Sport', true)", [sport]);
    await env.pool.query("insert into livetv_group_roles(group_id, role) values ($1, 'friend')", [sport]);
    list = [entry('Bergblick Sport', 'Sport', 0), entry('Nordlicht TV', 'Nachrichten', 1)];
    const id = await addSource();
    await refresh(id);
    expect((await src(id)).last_counts).toMatchObject({ newGroups: 1 });
    list = [...list, entry('Sternwarte Nacht', 'Erwachsene', 2)];
    await refresh(id);
    expect((await src(id)).last_counts).toMatchObject({ newGroups: 1, added: 1 });
    const gs = await groups();
    expect(gs.find((g) => g.name === 'Erwachsene')).toMatchObject({ released: false, kid_friendly: false, roles: 0 });
    expect(gs.find((g) => g.name === 'Sport')).toMatchObject({ id: sport, released: true, roles: 1 });
    const ch = await byKey(id);
    expect(ch.get('k0')!.map_group).toBe(sport);
    expect(ch.get('k2')!.map_group).toBe(gs.find((g) => g.name === 'Erwachsene').id);
  });

  it('overrides survive a re-import', async () => {
    const id = await addSource();
    await refresh(id);
    const own = randomUUID();
    await env.pool.query("insert into livetv_groups(id, name) values ($1, 'Lieblinge')", [own]);
    await env.pool.query(`update livetv_channels set name_override = 'Nordlicht', number_override = 1, group_override = $2, hidden = true
                           where source_id = $1 and source_key = 'k5'`, [id, own]);
    list = list.map((e) => (e.key === 'k5' ? { ...e, name: 'Nordlicht TV HD' } : e));
    await refresh(id);
    const c = (await byKey(id)).get('k5')!;
    expect(c).toMatchObject({ import_name: 'Nordlicht TV HD', name_override: 'Nordlicht', number_override: 1, group_override: own, hidden: true });
    expect((await src(id)).last_counts).toMatchObject({ added: 0, updated: 1 });
  });

  it('missing and return', async () => {
    const id = await addSource();
    await refresh(id);
    const before = (await byKey(id)).get('k5')!;
    const full = list;
    list = full.filter((e) => e.key !== 'k5');
    await refresh(id);
    expect((await byKey(id)).get('k5')!.missing_since).not.toBeNull();
    list = full;
    await refresh(id);
    const after = (await byKey(id)).get('k5')!;
    expect(after.missing_since).toBeNull();
    expect(after.id).toBe(before.id);
    expect((await src(id)).last_counts).toMatchObject({ added: 0, returned: 1, channels: 6 });
  });

  it('shrink guard', async () => {
    list = many(100);
    const id = await addSource();
    await refresh(id);
    const okAt = (await src(id)).last_ok_at;
    list = many(15);
    await refresh(id);
    let s = await src(id);
    expect(s.last_error).toBe('empty');
    expect(s.last_ok_at).toEqual(okAt);
    expect(s.last_counts).toMatchObject({ channels: 100, listed: 100 });
    expect((await channels(id)).filter((c) => c.missing_since !== null)).toHaveLength(0);
    // an empty list as well
    list = [];
    await refresh(id);
    s = await src(id);
    expect(s.last_error).toBe('empty');
    expect((await channels(id)).filter((c) => c.missing_since !== null)).toHaveLength(0);
    // mergeImport itself answers the error and changes nothing
    expect(await mergeImport(env.ctx, s, { entries: [], listed: 0 })).toEqual({ error: 'empty' });
    // 20 % is enough
    list = many(20);
    await refresh(id);
    expect((await src(id)).last_error).toBeNull();
  });

  it('a provider password change keeps channel identity', async () => {
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { key: 'nordlicht-101', url: 'http://iptv.example.com:8080/live/anna/alt/101.ts' })];
    const id = await addSource();
    await refresh(id);
    const ch = (await channels(id))[0];
    const adminId = (await env.pool.query("select id from users where role = 'admin' limit 1")).rows[0].id;
    const profile = randomUUID();
    await env.pool.query("insert into profiles(id, user_id, name, is_owner, jellyfin_user_id) values ($1, $2, 'Anna Beispiel', false, $3)", [profile, adminId, 'a'.repeat(32)]);
    await env.pool.query('insert into livetv_favourites(profile_id, channel_id) values ($1, $2)', [profile, ch.id]);
    await env.pool.query('insert into livetv_recent(profile_id, channel_id) values ($1, $2)', [profile, ch.id]);
    // the password in the path changes; livetv's key does not (ruling 18)
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { key: 'nordlicht-101', url: 'http://iptv.example.com:8080/live/anna/neu/101.ts' })];
    await refresh(id);
    const after = await channels(id);
    expect(after.map((c) => c.id)).toEqual([ch.id]);
    expect(decrypt(key, after[0].stream_url_enc)).toBe('http://iptv.example.com:8080/live/anna/neu/101.ts');
    expect((await env.pool.query('select 1 from livetv_favourites where profile_id = $1 and channel_id = $2', [profile, ch.id])).rowCount).toBe(1);
    expect((await env.pool.query('select 1 from livetv_recent where profile_id = $1 and channel_id = $2', [profile, ch.id])).rowCount).toBe(1);
    await env.pool.query('delete from profiles where id = $1', [profile]);
  });

  it('an existing group of the same name is reused', async () => {
    const sport = randomUUID();
    await env.pool.query("insert into livetv_groups(id, name, released) values ($1, 'Sport', true)", [sport]);
    list = [entry('Bergblick Sport', 'sport', 0)];
    const id = await addSource();
    await refresh(id);
    expect((await groups()).map((g) => g.id)).toEqual([sport]);
    expect((await channels(id))[0].map_group).toBe(sport);
    expect((await src(id)).last_counts).toMatchObject({ newGroups: 0 });
  });

  it('a long provider group name is cut to 40 characters', async () => {
    const long = 'Bergblick Sport Extra Spezial Programm Nummer Eins';
    list = [entry('Bergblick Sport', long, 0)];
    const id = await addSource();
    await refresh(id);
    expect((await groups()).map((g) => g.name)).toEqual([long.slice(0, 40).trim()]);
    expect((await channels(id))[0].import_group).toBe(long);
  });
});

describe('refresh failures (spec §19)', () => {
  it('three failures notify the admins once', async () => {
    m3u = () => ({ status: 502 });
    const id = await addSource({ name: 'Hafenkanal Anbieter' });
    await refresh(id);
    await refresh(id);
    const notes = () => env.pool.query("select * from notifications where kind = 'livetv.source.failed'").then((r) => r.rows);
    expect(await notes()).toHaveLength(0);
    await refresh(id);
    await refresh(id); // the same day: no second notice
    const n = await notes();
    expect(n).toHaveLength(1);
    expect(`${n[0].title} ${n[0].body}`).toContain('Hafenkanal Anbieter');
    for (const l of LEAKS) expect(JSON.stringify(n)).not.toContain(l);
    expect((await src(id)).last_error).toBe('livetv_error');
    // a success resets the count
    m3u = (_u, _i, body: { skipGroups?: string[] }) => ({ json: m3uAnswer(list, body?.skipGroups ?? []) });
    await refresh(id);
    expect(await env.kv.get(`ltv:fails:${id}`)).toBeNull();
    expect((await src(id)).last_error).toBeNull();
  });

  it('a failing refresh leaks no URL', async () => {
    m3u = () => ({ status: 422, json: { error: 'http://anna:geheim@iptv.example.com/get.php?password=geheim' } });
    const id = await addSource();
    for (let i = 0; i < 3; i++) {
      const before = (await src(id)).last_refresh_at?.getTime() ?? 0;
      const r = await call('POST', `/api/admin/livetv/sources/${id}/refresh`);
      expect(r.statusCode).toBe(202);
      await expect.poll(async () => (await src(id)).last_refresh_at?.getTime() ?? 0).toBeGreaterThan(before);
      await expect.poll(() => env.kv.get(`ltv:refresh:${id}`)).toBeNull(); // finished: the lock is released last
      await new Promise((res) => setTimeout(res, 5)); // the next refresh gets a later time stamp
    }
    expect((await src(id)).last_error).toBe('livetv_error');
    const events = await listEvents(env.ctx);
    expect(events).toHaveLength(3);
    const notes = (await env.pool.query('select * from notifications')).rows;
    expect(notes).toHaveLength(1);
    const audit = (await env.pool.query('select * from audit_log')).rows;
    expect(audit.map((a) => a.action)).toEqual(['livetv.source.refresh', 'livetv.source.refresh', 'livetv.source.refresh']);
    for (const text of [logs.join('\n'), JSON.stringify(events), JSON.stringify(notes), JSON.stringify(audit)]) {
      for (const l of LEAKS) expect(text).not.toContain(l);
    }
    // the admin view has the masked hint only (F13)
    const view = (await call('GET', '/api/admin/livetv/sources')).body;
    expect(view).not.toContain('geheim');
    expect(view).toContain('"lastError":"livetv_error"');
  });

  it('the refresh route answers 404 for an unknown source and 409 for the own-feeds source', async () => {
    expect((await call('POST', `/api/admin/livetv/sources/${randomUUID()}/refresh`)).statusCode).toBe(404);
    const own = randomUUID();
    await env.pool.query("insert into livetv_sources(id, kind, name) values ($1, 'manual', 'Eigene Streams')", [own]);
    const r = await call('POST', `/api/admin/livetv/sources/${own}/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'no_list' });
    expect(m3uCalls()).toHaveLength(0);
  });

  it('livetv not reached is recorded but not counted towards the notice', async () => {
    m3u = () => { throw new TypeError('fetch failed'); };
    const id = await addSource();
    for (let i = 0; i < 3; i++) await refresh(id);
    expect((await src(id)).last_error).toBe('livetv_unreachable');
    expect(await listEvents(env.ctx)).toHaveLength(3);
    expect(await env.kv.get(`ltv:fails:${id}`)).toBeNull();
    expect((await env.pool.query("select 1 from notifications where kind = 'livetv.source.failed'")).rowCount).toBe(0);
  });

  it('a stored URL that cannot be read is recorded as internal', async () => {
    const id = await addSource();
    await setSource(id, 'url_enc = $2', [encrypt(Buffer.alloc(32, 9), SECRET_URL)]); // another key
    await expect(refresh(id)).rejects.toThrow();
    expect((await src(id)).last_error).toBe('internal');
    expect(m3uCalls()).toHaveLength(0);
  });

  it('a new URL resets the shrink guard', async () => {
    list = many(100);
    const id = await addSource();
    await refresh(id);
    expect((await src(id)).last_counts).toMatchObject({ listed: 100 });
    const r = await env.app.inject({ method: 'PATCH', url: `/api/admin/livetv/sources/${id}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf },
      payload: { url: 'https://anna:neu@iptv.example.com/get.php?username=anna&password=neu' } });
    expect(r.statusCode).toBe(200);
    const s = await src(id);
    expect(s.last_counts).not.toHaveProperty('listed');
    expect(s.last_counts).toMatchObject({ channels: 100 });
    list = many(10); // a smaller list from the new provider is no shrunk list
    await refresh(id);
    expect((await src(id)).last_error).toBeNull();
    expect((await src(id)).last_counts).toMatchObject({ channels: 10, listed: 10, removed: 90 });
    // other edits keep the reference
    await env.app.inject({ method: 'PATCH', url: `/api/admin/livetv/sources/${id}`, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { name: 'Hafenkanal' } });
    expect((await src(id)).last_counts).toMatchObject({ listed: 10 });
  });

  it('the refresh route says when a refresh is already running', async () => {
    const id = await addSource();
    await env.kv.set(`ltv:refresh:${id}`, 'other', 60);
    const r = await call('POST', `/api/admin/livetv/sources/${id}/refresh`);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ started: false });
    expect(m3uCalls()).toHaveLength(0);
  });

  it('a refresh that is already running is not started again', async () => {
    const id = await addSource();
    await env.kv.set(`ltv:refresh:${id}`, 'other', 60);
    await refresh(id);
    expect(m3uCalls()).toHaveLength(0);
    await env.kv.del(`ltv:refresh:${id}`);
    await refresh(id);
    expect(m3uCalls()).toHaveLength(1);
  });
});

describe('logos (ruling 28)', () => {
  it('livetv failing itself is not remembered as a refused logo', async () => {
    logo = () => ({ status: 503, json: { error: 'busy' } });
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { logo: 'https://iptv.example.com/logos/nordlicht.png' })];
    const id = await addSource();
    await refresh(id);
    await refresh(id);
    expect(logoCalls()).toHaveLength(2);
  });

  it('a logo over 512 KB is not stored', async () => {
    logo = () => ({ raw: Buffer.concat([PNG, Buffer.alloc(512 * 1024)]), type: 'image/png' });
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { logo: 'https://iptv.example.com/logos/riesig.png' })];
    const id = await addSource();
    await refresh(id);
    expect((await env.pool.query('select 1 from livetv_logos')).rowCount).toBe(0);
    expect((await channels(id))[0].import_logo_hash).toBeNull();
  });

  it('a failing logo step does not fail the refresh', async () => {
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { logo: 'https://iptv.example.com/logos/nordlicht.png' })];
    vi.spyOn(env.kv, 'mget').mockRejectedValue(new Error('kv down'));
    const id = await addSource();
    await refresh(id);
    const s = await src(id);
    expect(s.last_error).toBeNull();
    expect(s.last_counts).toMatchObject({ channels: 1, added: 1 });
  });

  it('logos fetched once per URL', async () => {
    const logo = 'https://iptv.example.com/logos/nordlicht.png?token=geheim';
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { logo }), entry('Nordlicht TV 2', 'Nachrichten', 1, { logo }), entry('Hafenkanal', 'Nachrichten', 2)];
    const id = await addSource();
    await refresh(id);
    await refresh(id);
    expect(logoCalls()).toHaveLength(1);
    expect(logoCalls()[0]!.body).toEqual({ url: logo, allowLan: false });
    const ch = await byKey(id);
    const hash = ch.get('k0')!.import_logo_hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.get('k1')!.import_logo_hash).toBe(hash);
    expect(ch.get('k2')!.import_logo_hash).toBeNull();
    const stored = (await env.pool.query('select mime, bytes from livetv_logos')).rows;
    expect(stored).toEqual([{ mime: 'image/png', bytes: PNG }]);
    // a pruned logo is fetched again
    await env.pool.query('delete from livetv_logos');
    await refresh(id);
    expect(logoCalls()).toHaveLength(2);
  });

  it('a logo the provider refuses is not asked for again on the next refresh', async () => {
    logo = () => ({ status: 422, json: { error: 'not_image' } });
    list = [entry('Nordlicht TV', 'Nachrichten', 0, { logo: 'https://iptv.example.com/logos/kaputt.png' })];
    const id = await addSource();
    await refresh(id);
    await refresh(id);
    expect(logoCalls()).toHaveLength(1);
    expect((await src(id)).last_error).toBeNull();
    expect((await channels(id))[0].import_logo_hash).toBeNull();
  });
});

describe('summary and tick', () => {
  it('summary counts failing sources', async () => {
    const ok = await addSource({ name: 'Nordlicht Anbieter' });
    const bad = await addSource({ name: 'Hafenkanal Anbieter' });
    await env.pool.query("insert into livetv_sources(id, kind, name) values ($1, 'manual', 'Eigene Streams')", [randomUUID()]);
    await refresh(ok);
    m3u = () => ({ status: 422, json: { error: 'unreachable' } });
    await refresh(bad);
    const j = (await call('GET', '/api/admin/summary')).json();
    expect(j.livetv.failedSources).toBe(1);
  });

  it('the refresh tick skips the own-feeds source', async () => {
    const own = randomUUID();
    await env.pool.query("insert into livetv_sources(id, kind, name, position) values ($1, 'manual', 'Eigene Streams', 0)", [own]);
    const due = await addSource();
    const setnx = vi.spyOn(env.kv, 'setnx');
    await livetvRefreshTick(env.ctx);
    expect(m3uCalls()).toHaveLength(1);
    // skipped by the tick itself, before the due check: not even the source's refresh lock is tried
    const locks = setnx.mock.calls.map((c) => c[0]).filter((k) => k.startsWith('ltv:refresh:'));
    expect(locks).toEqual([`ltv:refresh:${due}`]);
    const o = await src(own);
    expect(o).toMatchObject({ last_error: null, last_refresh_at: null, last_counts: null });
    expect((await listEvents(env.ctx)).filter((e) => e.sourceId === own)).toHaveLength(0);
    expect((await src(due)).last_ok_at).not.toBeNull();
  });

  it('the refresh tick takes due, enabled, automatic sources only', async () => {
    const hour = 3600_000;
    const fresh = await addSource({ refresh: '6h', last_refresh_at: new Date(Date.now() - hour) });
    const stale = await addSource({ refresh: '6h', last_refresh_at: new Date(Date.now() - 7 * hour) });
    const marked = await addSource({ refresh: 'weekly', last_refresh_at: null }); // an edit marked it due (Task 15)
    const manual = await addSource({ refresh: 'manual', last_refresh_at: null });
    const off = await addSource({ refresh: '6h', last_refresh_at: null });
    await setSource(off, 'enabled = false');
    await livetvRefreshTick(env.ctx);
    expect(m3uCalls()).toHaveLength(2);
    expect((await src(stale)).last_ok_at).not.toBeNull();
    expect((await src(marked)).last_ok_at).not.toBeNull();
    for (const id of [fresh, manual, off]) expect((await src(id)).last_ok_at).toBeNull();
    // one tick at a time
    await env.kv.set('ltv:refresh-tick', 'other', 60);
    await setSource(fresh, 'last_refresh_at = null');
    await livetvRefreshTick(env.ctx);
    expect(m3uCalls()).toHaveLength(2);
  });

  it('a failed source is due again after an hour', async () => {
    const min = 60_000;
    const late = await addSource({ refresh: '24h', last_refresh_at: new Date(Date.now() - 61 * min) });
    const early = await addSource({ refresh: '24h', last_refresh_at: new Date(Date.now() - 59 * min) });
    const fine = await addSource({ refresh: '24h', last_refresh_at: new Date(Date.now() - 61 * min) });
    await setSource(late, "last_error = 'livetv_error'");
    await setSource(early, "last_error = 'livetv_error'");
    await livetvRefreshTick(env.ctx);
    expect(m3uCalls()).toHaveLength(1);
    expect((await src(late)).last_error).toBeNull();
    expect((await src(late)).last_ok_at).not.toBeNull();
    expect((await src(early)).last_error).toBe('livetv_error');
    expect((await src(fine)).last_ok_at).toBeNull(); // no error: its 24 h interval
  });

  it('nothing is refreshed while livetv is not installed', async () => {
    await setUp(false);
    const id = await addSource();
    await livetvRefreshTick(env.ctx);
    expect(m3uCalls()).toHaveLength(0);
    const r = await call('POST', `/api/admin/livetv/sources/${id}/refresh`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'livetv_off' });
    expect(m3uCalls()).toHaveLength(0);
    expect(await src(id)).toMatchObject({ last_error: null, last_refresh_at: null });
    expect((await env.pool.query('select 1 from audit_log')).rowCount).toBe(0);
    await setUp(true);
    await livetvRefreshTick(env.ctx);
    expect(m3uCalls()).toHaveLength(1);
  });
});
