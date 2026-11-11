// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteHandoff, selectHandoff } from '../src/handoff.js';
import { encrypt } from '../src/crypto.js';
import { jfUserFor } from '../src/profiles.js';
import { getLive } from '../src/live.js';
import { playbackReport } from '../src/routes/media.js';
import type { ProfileRow } from '../src/types.js';
import { getUserById } from '../src/users.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Dunmoor S1 E4 "The Lantern Road" and S1 E5 "Wrenfield Pier" (fictional)
const SER = 'd'.repeat(32);
const EP4 = '4'.repeat(32);
const EP5 = '5'.repeat(32);
const MS = 'b'.repeat(32);
const FILM = 'f1'.repeat(16);
const GONE = '9'.repeat(32);
const DEV_B = 'dev-handoff-lg-0000000001';
const ITEMS: Record<string, Record<string, unknown>> = {
  [EP4]: { Id: EP4, Name: 'The Lantern Road', Type: 'Episode', SeriesId: SER, SeriesName: 'Dunmoor', ParentIndexNumber: 1, IndexNumber: 4, RunTimeTicks: 30_000_000_000 },
  [FILM]: { Id: FILM, Name: 'Saltmarsh Light', Type: 'Movie', ProductionYear: 2019, RunTimeTicks: 28_320_000_000, ImageTags: { Primary: 'p1' } },
  [EP5]: { Id: EP5, Name: 'Wrenfield Pier', Type: 'Episode', SeriesId: SER, SeriesName: 'Dunmoor', ParentIndexNumber: 1, IndexNumber: 5, RunTimeTicks: 31_000_000_000 },
};
const TV = '198.51.100.1';
// the media service memoizes item lookups for a few seconds; a test that changes an item forgets them
const forget = () => (env.ctx.jf as unknown as { itemMemo: Map<string, unknown> }).itemMemo.clear();

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let s: Sess;
let uid = '';
let dev = '';
let pid = '';
let n = 0;
let psN = 0;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Users/[^/]+/Items/[^/]+': (u) => {
      const it = ITEMS[u.pathname.split('/').pop()!];
      return it ? { json: it } : { status: 404 };
    },
    'POST /Sessions/Playing': () => ({ status: 204 }),
    'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
    'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
    'POST /Items/[^/]+/PlaybackInfo': () => ({
      json: { PlaySessionId: `ps-cast-${String(++psN).padStart(4, '0')}`, MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 30_000_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] },
    }),
  });
  s = await env.login();
  const sess = JSON.parse((await env.kv.get(`sess:${s.cookies.ff_sid}`))!) as { userId: string; deviceId: string };
  uid = sess.userId;
  dev = sess.deviceId;
  pid = (await env.pool.query<{ id: string }>('select id from profiles where user_id = $1 and is_owner', [uid])).rows[0]!.id;
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.pool.query('delete from handoff');
  for (const k of [...await env.kv.keys(`play:${uid}:`), ...await env.kv.keys(`pstop:${uid}:`)]) await env.kv.del(k);
});
afterEach(() => { vi.restoreAllMocks(); });

// a fresh client address per request keeps route limits out of the way
const call = (method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'POST', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-forwarded-for': `10.2.${Math.floor(++n / 250)}.${n % 250}` }, payload: body as object });
const report = (kind: 'start' | 'progress' | 'stop', b: Record<string, unknown> = {}) =>
  call('POST', `/api/playback/${kind}`, { itemId: EP4, playSessionId: 'ps-handoff1', mediaSourceId: MS, positionTicks: 1_000_000_000, isPaused: false, ...b });
const rows = async (profileId = pid) =>
  (await env.pool.query('select * from handoff where profile_id = $1 order by device_id', [profileId])).rows;
const row = async () => (await env.pool.query('select * from handoff where profile_id = $1 and device_id = $2', [pid, dev])).rows[0];
const backdate = (interval: string) => env.pool.query(`update handoff set started_at = now() - interval '${interval}', updated_at = now() - interval '${interval}'`);
const who = async (over: { deviceId?: string; profile?: ProfileRow | undefined } = {}) => {
  const user = (await getUserById(env.ctx, uid))!;
  const profile = (await env.pool.query<ProfileRow>('select * from profiles where id = $1', [pid])).rows[0]!;
  return { user, jfUser: jfUserFor(user, profile), profile, deviceId: dev, ...over };
};
const body = (b: Record<string, unknown> = {}) => ({ itemId: EP4, playSessionId: 'ps-handoff2', mediaSourceId: MS, positionTicks: 2_000_000_000, isPaused: false, ...b });

describe('write', () => {
  it('start writes the row', async () => {
    expect((await report('start')).statusCode).toBe(200);
    const r = await row();
    expect(r).toMatchObject({ user_id: uid, item_id: EP4, series_id: SER, runtime_ticks: '30000000000', via: null, position_ticks: '1000000000' });
    expect(r.started_at).toBeInstanceOf(Date);
    expect(r.updated_at).toBeInstanceOf(Date);
    expect(await rows()).toHaveLength(1);
  });

  it('progress keeps started_at, start or a new item resets it', async () => {
    await report('start');
    await backdate('1 hour');
    const before = (await row()).started_at as Date;
    expect((await report('progress', { positionTicks: 3_000_000_000 })).statusCode).toBe(200);
    let r = await row();
    expect(r.started_at).toEqual(before);
    expect(r.position_ticks).toBe('3000000000');
    expect((r.updated_at as Date).getTime()).toBeGreaterThan(before.getTime() + 30 * 60_000);
    // a stop is a report too: position moves, started_at stays
    expect((await report('stop', { positionTicks: 3_500_000_000 })).statusCode).toBe(200);
    r = await row();
    expect(r).toMatchObject({ position_ticks: '3500000000', started_at: before });
    // start again (same item): started_at resets
    await report('start', { playSessionId: 'ps-handoff3', positionTicks: 3_500_000_000 });
    expect((((await row()).started_at) as Date).getTime()).toBeGreaterThan(before.getTime() + 30 * 60_000);
    // another item on progress (its own play session, live record rebuilt): started_at resets, series and runtime of the new item
    await backdate('1 hour');
    const b2 = (await row()).started_at as Date;
    await report('progress', { itemId: EP5, playSessionId: 'ps-handoff4', positionTicks: 50_000_000 });
    r = await row();
    expect((r.started_at as Date).getTime()).toBeGreaterThan(b2.getTime() + 30 * 60_000);
    expect(r).toMatchObject({ item_id: EP5, series_id: SER, runtime_ticks: '31000000000', position_ticks: '50000000' });
    // same item without series / runtime: the stored ones are kept; another item without them: replaced (null)
    await noteHandoff(env.ctx, { userId: uid, profileId: pid, deviceId: dev, itemId: EP5, positionTicks: 60_000_000, via: null, start: false });
    expect(await row()).toMatchObject({ item_id: EP5, series_id: SER, runtime_ticks: '31000000000', position_ticks: '60000000' });
    await noteHandoff(env.ctx, { userId: uid, profileId: pid, deviceId: dev, itemId: EP4, positionTicks: 70_000_000, via: null, start: false });
    expect(await row()).toMatchObject({ item_id: EP4, series_id: null, runtime_ticks: null, position_ticks: '70000000' });
  });

  it('via from the body', async () => {
    expect((await report('start', { via: 'airplay' })).statusCode).toBe(200);
    expect((await row()).via).toBe('airplay');
    const bad = await report('progress', { via: 'x', positionTicks: 9_000_000_000 });
    expect(bad.statusCode).toBe(400);
    expect(await row()).toMatchObject({ via: 'airplay', position_ticks: '1000000000' });
    expect((await report('progress', { via: 'chromecast' })).statusCode).toBe(200);
    expect((await row()).via).toBe('chromecast');
    expect((await report('progress')).statusCode).toBe(200); // played on the device itself
    expect((await row()).via).toBeNull();
  });

  it('/api/cast/report writes via chromecast', async () => {
    const was = env.ctx.cfg.CAST_RECEIVER_APP_ID;
    env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: 'A1B2C3D4' };
    try {
      const c = await call('POST', '/api/cast/session', { itemId: EP4, receiver: true });
      expect(c.statusCode).toBe(200);
      const j = c.json();
      const ct = /\/media\/c\/([\w-]{43})\//.exec(j.contentUrl)![1]!;
      const pin = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { ct, client: TV } });
      expect(pin.statusCode).toBe(200);
      const rep = await env.app.inject({ method: 'POST', url: '/api/cast/report', headers: { 'x-real-ip': TV }, payload: { rt: j.report, event: 'start', positionTicks: 4_000_000_000, isPaused: false } });
      expect(rep.statusCode).toBe(200);
      expect(await rows()).toEqual([expect.objectContaining({ device_id: dev, item_id: EP4, series_id: SER, via: 'chromecast', position_ticks: '4000000000' })]);
      await call('DELETE', `/api/cast/session/${j.castId}`);
    } finally { env.ctx.cfg = { ...env.ctx.cfg, CAST_RECEIVER_APP_ID: was }; }
  });

  it('a Chromecast autoplay of the next episode keeps series and runtime (live record made by the token touch)', async () => {
    const token = async (itemId: string) => {
      const c = await call('POST', '/api/cast/session', { itemId });
      expect(c.statusCode).toBe(200);
      const j = c.json();
      return { j, ct: /\/media\/c\/([\w-]{43})\//.exec(j.contentUrl)![1]! };
    };
    const authz = (ct: string) => env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { ct, client: TV } });
    const cast = (b: Record<string, unknown>) => report('start', { mediaSourceId: MS, via: 'chromecast', ...b });
    const a = await token(EP4);
    expect((await authz(a.ct)).statusCode).toBe(200);
    expect((await cast({ itemId: EP4, playSessionId: a.j.playSessionId })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ item_id: EP4, series_id: SER, runtime_ticks: '30000000000', via: 'chromecast' });
    // the TV moves on to the next episode: its token is fetched again after the touch window, before any report for it
    const b = await token(EP5);
    expect((await authz(b.ct)).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 25_000);
      expect((await authz(b.ct)).statusCode).toBe(200);
      const touched = await getLive(env.ctx, uid, b.j.playSessionId);
      expect(touched).toMatchObject({ itemId: EP5 });
      expect(touched!.type).toBeUndefined(); // the touch knows the item id and title only
      expect((await cast({ itemId: EP5, playSessionId: b.j.playSessionId, positionTicks: 10_000_000 })).statusCode).toBe(200);
    } finally { vi.useRealTimers(); }
    expect(await row()).toMatchObject({ item_id: EP5, series_id: SER, runtime_ticks: '31000000000', via: 'chromecast', position_ticks: '10000000' });
    expect(await getLive(env.ctx, uid, b.j.playSessionId)).toMatchObject({ type: 'Episode', seriesId: SER, seriesName: 'Dunmoor', runtimeTicks: 31_000_000_000, title: 'Wrenfield Pier' });
    for (const x of [a, b]) await call('DELETE', `/api/cast/session/${x.j.castId}`);
  });

  it('a TV probe report writes no row', async () => {
    const before = env.jfCalls.length;
    expect((await report('stop', { probe: true })).statusCode).toBe(200);
    expect(env.jfCalls.slice(before).map((c) => c.path)).toContain('/Sessions/Playing/Stopped'); // the media server still gets it
    expect(await rows()).toEqual([]);
    expect((await report('stop', { probe: 'yes' })).statusCode).toBe(400);
  });

  it('no row without a device', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await playbackReport(env.ctx, 'Playing', body(), await who({ deviceId: undefined }))).toEqual({ ok: true });
    expect(await playbackReport(env.ctx, 'Playing/Progress', body({ playSessionId: 'ps-handoff5' }), await who({ profile: undefined }))).toEqual({ ok: true });
    expect((await env.pool.query('select count(*)::int c from handoff')).rows[0].c).toBe(0);
    expect(warn.mock.calls.filter((a) => a[0] === 'handoff write failed')).toEqual([]); // skipped, not a failed write
  });

  it('a failing write never fails the report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gone = 'dev-handoff-missing-000001';
    expect(await playbackReport(env.ctx, 'Playing', body(), await who({ deviceId: gone }))).toEqual({ ok: true });
    expect((await env.pool.query('select count(*)::int c from handoff')).rows[0].c).toBe(0);
    const calls = warn.mock.calls.filter((a) => a[0] === 'handoff write failed');
    expect(calls).toHaveLength(1);
    const text = JSON.stringify(warn.mock.calls);
    for (const secret of [gone, EP4, pid, uid, 'ps-handoff2']) expect(text).not.toContain(secret);
    // the session's own device row gone (the session lives on until it is next checked): the route answers 200 as well
    const saved = (await env.pool.query('select * from devices where user_id = $1 and device_id = $2', [uid, dev])).rows[0];
    await env.pool.query('delete from devices where user_id = $1 and device_id = $2', [uid, dev]);
    try {
      expect((await report('start')).statusCode).toBe(200);
      expect(await rows()).toEqual([]);
      expect(warn.mock.calls.filter((a) => a[0] === 'handoff write failed')).toHaveLength(2);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(dev);
    } finally {
      const cols = Object.keys(saved);
      await env.pool.query(`insert into devices (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((k) => saved[k]));
    }
  });

  it('rows older than 24 h go on write', async () => {
    const other = (await env.pool.query<{ id: string }>("insert into profiles (id, user_id, name, is_owner, kids, jellyfin_user_id) values (gen_random_uuid(), $1, 'Gast', false, false, $2) returning id", [uid, 'e'.repeat(32)])).rows[0]!.id;
    for (const d of ['dev-handoff-old-0000000001', 'dev-handoff-old-0000000002']) {
      await env.pool.query("insert into devices (user_id, device_id, label, approved) values ($1, $2, 'Safari auf iPhone', true)", [uid, d]);
    }
    const put = (profileId: string, deviceId: string, age: string) => env.pool.query(
      `insert into handoff (profile_id, user_id, device_id, item_id, position_ticks, started_at, updated_at) values ($1, $2, $3, $4, 1, now() - interval '${age}', now() - interval '${age}')`,
      [profileId, uid, deviceId, EP5]);
    await put(pid, 'dev-handoff-old-0000000001', '25 hours'); // this profile, stale: goes
    await put(pid, 'dev-handoff-old-0000000002', '23 hours'); // this profile, within the day: stays
    await put(other, 'dev-handoff-old-0000000001', '25 hours'); // another profile: untouched by this profile's write
    expect((await report('start')).statusCode).toBe(200);
    expect((await rows()).map((r) => r.device_id).sort()).toEqual([dev, 'dev-handoff-old-0000000002'].sort());
    expect((await rows(other)).map((r) => r.device_id)).toEqual(['dev-handoff-old-0000000001']);
  });
});

describe('read', () => {
  const T = (s: number) => s * 10_000_000;
  const GENERIC = { ...ITEMS[EP4]! };
  let kidsPid = '';
  beforeAll(async () => {
    await env.pool.query("insert into devices (user_id, device_id, label, approved, client) values ($1, $2, 'LG webOS TV', true, 'webos')", [uid, DEV_B]);
  });
  beforeEach(async () => {
    ITEMS[EP4] = { ...GENERIC };
    forget();
    delete ITEMS[GONE];
    await env.pool.query('update devices set name = null, label = $3 where user_id = $1 and device_id = $2', [uid, DEV_B, 'LG webOS TV']);
    await env.pool.query('delete from resume_hidden');
    await env.pool.query('delete from dropped');
  });
  const put = (o: { profile?: string; device?: string; item?: string; series?: string | null; pos?: number; runtime?: number | null; age?: string; via?: string | null } = {}) =>
    env.pool.query(
      `insert into handoff (profile_id, user_id, device_id, item_id, series_id, position_ticks, runtime_ticks, via, started_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() - $9::interval, now() - $9::interval)
       on conflict (profile_id, device_id) do update set item_id = excluded.item_id, series_id = excluded.series_id, position_ticks = excluded.position_ticks,
         runtime_ticks = excluded.runtime_ticks, via = excluded.via, started_at = excluded.started_at, updated_at = excluded.updated_at`,
      [o.profile ?? pid, uid, o.device ?? DEV_B, o.item ?? EP4, o.series === undefined ? ((o.item ?? EP4) === FILM ? null : SER) : o.series, o.pos ?? T(1390), o.runtime === undefined ? 30_000_000_000 : o.runtime, o.via ?? null, o.age ?? '12 minutes']);
  const get = async (q = '') => {
    const r = await call('GET', `/api/handoff${q}`);
    expect(r.statusCode).toBe(200);
    return { r, h: r.json().handoff as Record<string, any> | null };
  };

  it("offers the other device's newest playback", async () => {
    await put();
    const { r, h } = await get();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(h).toMatchObject({ itemId: EP4, type: 'Episode', title: 'The Lantern Road', seriesName: 'Dunmoor', season: 1, episode: 4, positionTicks: 13_900_000_000, runtimeTicks: 30_000_000_000, device: { kind: 'webos' } });
    expect(h!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(Math.abs(h!.ageSec - 720)).toBeLessThanOrEqual(5);
    expect(h!.device).not.toHaveProperty('name');
    expect(h!.imageId).toBe(SER); // the episode has no image of its own
    ITEMS[EP4] = { ...GENERIC, ImageTags: { Primary: 'e4' } };
    forget();
    expect((await get()).h!.imageId).toBe(EP4);
    await put({ item: FILM, pos: T(600), runtime: 28_320_000_000 });
    expect((await get()).h).toMatchObject({ itemId: FILM, type: 'Movie', title: 'Saltmarsh Light', year: 2019, imageId: FILM });
  });

  it('id is stable while the device plays that title and changes with a new start', async () => {
    await put();
    const a = (await get()).h!.id;
    const started = (await env.pool.query<{ s: Date }>('select started_at s from handoff where device_id = $1', [DEV_B])).rows[0]!.s;
    await env.pool.query("update handoff set position_ticks = $2, updated_at = now() where device_id = $1", [DEV_B, T(1500)]); // progress
    expect((await get()).h!.id).toBe(a);
    await env.pool.query("update handoff set started_at = started_at - interval '1 minute' where device_id = $1", [DEV_B]);
    expect((await get()).h!.id).not.toBe(a);
    expect(started).toBeInstanceOf(Date);
  });

  it('nothing when the newest row is this device', async () => {
    await put({ device: dev, age: '1 minute' });
    await put({ age: '5 minutes' });
    expect((await get()).h).toBeNull();
  });

  it('nothing after 6 h, offered just inside', async () => {
    await put({ age: '6 hours 1 minute' });
    expect((await get()).h).toBeNull();
    await put({ age: '5 hours 59 minutes' });
    expect((await get()).h).toMatchObject({ itemId: EP4 });
  });

  it('nothing under 60 s', async () => {
    await put({ pos: T(59) });
    expect((await get()).h).toBeNull();
    await put({ pos: T(60) });
    expect((await get()).h).toMatchObject({ itemId: EP4 });
  });

  it('nothing from 90 %', async () => {
    await put({ item: FILM, pos: T(2549), runtime: 28_320_000_000 });
    expect((await get()).h).toBeNull();
    await put({ item: FILM, pos: T(2548), runtime: 28_320_000_000 });
    expect((await get()).h).toMatchObject({ itemId: FILM });
  });

  it('no runtime known: offered from 60 s', async () => {
    await put({ pos: T(1000), runtime: null });
    const { h } = await get();
    expect(h).toMatchObject({ itemId: EP4, positionTicks: T(1000), runtimeTicks: 30_000_000_000 }); // the media server knows it
  });

  it('no runtime in the row: 90 % of the item runtime still ends the offer', async () => {
    await put({ pos: T(2850), runtime: null }); // 95 % of 3000 s
    expect((await get()).h).toBeNull();
    await put({ pos: T(2690), runtime: null }); // just under 90 %
    expect((await get()).h).toMatchObject({ itemId: EP4 });
  });

  it('season and episode only for an episode, year only for a film', async () => {
    ITEMS[EP4] = { ...GENERIC, ProductionYear: 2021 };
    forget();
    await put();
    const ep = (await get()).h!;
    expect(ep).not.toHaveProperty('year');
    expect(ep).toMatchObject({ season: 1, episode: 4 });
    ITEMS[FILM] = { ...ITEMS[FILM]!, ParentIndexNumber: 1, IndexNumber: 2 };
    forget();
    await put({ item: FILM, pos: T(600), runtime: 28_320_000_000 });
    const film = (await get()).h!;
    expect(film).toMatchObject({ year: 2019 });
    expect(film).not.toHaveProperty('season');
    expect(film).not.toHaveProperty('episode');
    delete ITEMS[FILM]!.ParentIndexNumber;
    delete ITEMS[FILM]!.IndexNumber;
    forget();
  });

  it('played -> null', async () => {
    ITEMS[EP4] = { ...GENERIC, UserData: { Played: true } };
    forget();
    await put();
    expect((await get()).h).toBeNull();
  });

  it('hidden after the playback -> null, hidden before -> offered', async () => {
    await put();
    await env.pool.query("insert into resume_hidden (profile_id, item_id, hidden_at) values ($1, $2, now() - interval '1 minute')", [pid, SER]);
    expect((await get()).h).toBeNull();
    await env.pool.query("update resume_hidden set hidden_at = now() - interval '20 minutes'");
    expect((await get()).h).toMatchObject({ itemId: EP4 });
    await env.pool.query('delete from resume_hidden');
    await env.pool.query("insert into resume_hidden (profile_id, item_id, hidden_at) values ($1, $2, now())", [pid, EP4]);
    expect((await get()).h).toBeNull();
  });

  it('dropped series or item -> null', async () => {
    await put();
    await env.pool.query('insert into dropped (profile_id, item_id) values ($1, $2)', [pid, SER]);
    expect((await get()).h).toBeNull();
    await env.pool.query('delete from dropped');
    await env.pool.query('insert into dropped (profile_id, item_id) values ($1, $2)', [pid, EP4]);
    expect((await get()).h).toBeNull();
  });

  it('?item= matches the episode or its series', async () => {
    await put({ age: '20 minutes' });
    await env.pool.query("insert into devices (user_id, device_id, label, approved, client) values ($1, 'dev-handoff-fire-000000001', 'Fire TV', true, 'firetv') on conflict do nothing", [uid]);
    await put({ device: 'dev-handoff-fire-000000001', item: FILM, pos: T(600), runtime: 28_320_000_000, age: '3 minutes' });
    expect((await get()).h).toMatchObject({ itemId: FILM, device: { kind: 'firetv' } });
    expect((await get(`?item=${SER}`)).h).toMatchObject({ itemId: EP4, device: { kind: 'webos' } });
    expect((await get(`?item=${EP4}`)).h).toMatchObject({ itemId: EP4 });
    expect((await get(`?item=${'c'.repeat(32)}`)).h).toBeNull();
    expect((await call('GET', '/api/handoff?item=nope')).statusCode).toBe(400);
  });

  it('a title gone deletes the row', async () => {
    await put({ item: GONE });
    expect((await get()).h).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it('kids profile: own rows, looked up as its own Jellyfin user', async () => {
    kidsPid = (await env.pool.query<{ id: string }>(
      "insert into profiles (id, user_id, name, is_owner, kids, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), $1, 'Kind', false, true, $2, 'kind', $3) returning id", [uid, 'a1'.repeat(16), encrypt(env.ctx.encKey, 'pw')])).rows[0]!.id;
    await put({ profile: kidsPid, item: EP5, runtime: 31_000_000_000 });
    await put(); // the owner's own row: must not answer the kids profile
    const user = (await getUserById(env.ctx, uid))!;
    const profile = (await env.pool.query<ProfileRow>('select * from profiles where id = $1', [kidsPid])).rows[0]!;
    const before = env.jfCalls.length;
    const a = await selectHandoff(env.ctx, { userId: uid, profileId: kidsPid, deviceId: dev, jfUser: jfUserFor(user, profile) });
    expect(a).toMatchObject({ itemId: EP5 });
    expect(env.jfCalls.slice(before).map((c) => c.path).some((p) => p.includes(`/Users/${'a1'.repeat(16)}/Items/${EP5}`))).toBe(true);
    expect(env.jfCalls.slice(before).map((c) => c.path).some((p) => p.includes(`/Items/${EP4}`))).toBe(false);
  });

  it('profiles are isolated', async () => {
    const other = (await env.pool.query<{ id: string }>("insert into profiles (id, user_id, name, is_owner, kids, jellyfin_user_id) values (gen_random_uuid(), $1, 'Gast2', false, false, $2) returning id", [uid, 'e2'.repeat(16)])).rows[0]!.id;
    await put({ profile: other });
    expect((await get()).h).toBeNull();
    expect(await rows(other)).toHaveLength(1);
  });

  it('custom name and via', async () => {
    await put({ via: 'airplay' });
    expect((await get()).h).toMatchObject({ device: { kind: 'webos', via: 'airplay' } });
    await env.pool.query('update devices set name = $3 where user_id = $1 and device_id = $2', [uid, DEV_B, 'Wohnzimmer']);
    expect((await get()).h).toMatchObject({ device: { kind: 'webos', name: 'Wohnzimmer', via: 'airplay' } });
    await env.pool.query("update devices set name = null, client = 'web', label = 'Safari auf iPhone' where device_id = $1", [DEV_B]);
    await put({ via: 'chromecast' });
    expect((await get()).h).toMatchObject({ device: { kind: 'web', name: 'Safari auf iPhone', via: 'chromecast' } });
    await env.pool.query("update devices set client = null where device_id = $1", [DEV_B]);
    expect((await get()).h).toMatchObject({ device: { kind: 'web', name: 'Safari auf iPhone' } });
    await env.pool.query("update devices set client = 'webos' where device_id = $1", [DEV_B]);
  });

  it('the answer carries no device id, play session id or URL', async () => {
    await put();
    await env.pool.query("update handoff set via = 'airplay'");
    const { r } = await get();
    const text = r.body;
    for (const bad of [DEV_B, dev, '/media', 'http', 'ps-']) expect(text).not.toContain(bad);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('24 h cleanup on read', async () => {
    await put({ device: dev, age: '25 hours' });
    await put({ age: '2 minutes' });
    await get();
    expect((await rows()).map((x) => x.device_id)).toEqual([DEV_B]);
  });

  it('needs a signed-in user', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/handoff' })).statusCode).toBe(401);
  });
});

describe('unknown item type', () => {
  it('a report whose item lookup has no type stores a fallback, so the lookup is not repeated', async () => {
    const hold = ITEMS[EP4]!;
    ITEMS[EP4] = { ...hold, Type: undefined };
    forget();
    try {
      expect((await report('start', { playSessionId: 'ps-notype-1' })).statusCode).toBe(200);
      const lookups = () => env.jfCalls.filter((c) => c.method === 'GET' && c.path.includes(`/Items/${EP4}`)).length;
      expect((await getLive(env.ctx, uid, 'ps-notype-1'))!.type).toBe('Unknown');
      const n0 = lookups();
      expect((await report('progress', { playSessionId: 'ps-notype-1' })).statusCode).toBe(200);
      expect(lookups()).toBe(n0);
    } finally { ITEMS[EP4] = hold; forget(); }
  });
});
