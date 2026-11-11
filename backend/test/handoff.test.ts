// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteHandoff } from '../src/handoff.js';
import { jfUserFor } from '../src/profiles.js';
import { playbackReport } from '../src/routes/media.js';
import type { ProfileRow } from '../src/types.js';
import { getUserById } from '../src/users.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Dunmoor S1 E4 "The Lantern Road" and S1 E5 "Wrenfield Pier" (fictional)
const SER = 'd'.repeat(32);
const EP4 = '4'.repeat(32);
const EP5 = '5'.repeat(32);
const MS = 'b'.repeat(32);
const ITEMS: Record<string, Record<string, unknown>> = {
  [EP4]: { Id: EP4, Name: 'The Lantern Road', Type: 'Episode', SeriesId: SER, SeriesName: 'Dunmoor', ParentIndexNumber: 1, IndexNumber: 4, RunTimeTicks: 30_000_000_000 },
  [EP5]: { Id: EP5, Name: 'Wrenfield Pier', Type: 'Episode', SeriesId: SER, SeriesName: 'Dunmoor', ParentIndexNumber: 1, IndexNumber: 5, RunTimeTicks: 31_000_000_000 },
};
const TV = '198.51.100.1';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let s: Sess;
let uid = '';
let dev = '';
let pid = '';
let n = 0;

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
      json: { PlaySessionId: 'ps-cast0001', MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 30_000_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] },
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
