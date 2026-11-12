// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { healthTick } from '../src/health.js';
import { pruneTimings, timingBody } from '../src/playtiming.js';
import { resetStreamsMemoForTests } from '../src/playstats.js';
import { makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, friend: Sess;

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Fred', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());
beforeEach(async () => { await env.pool.query('delete from playback_timings'); await env.kv.del(`ptiming:h:${(await me(friend)).id}`); });

const me = async (s: Sess) => (await env.app.inject({ url: '/api/me', cookies: s.cookies })).json() as { id: string };
const base = { device: 'phone', mode: 'hls', bitrate: 8_000_000, targetDuration: 6, infoMs: 300, manifestMs: 700, firstFragMs: 2500, firstFragBytes: 4_000_000, firstFragDlMs: 1500, firstFrameMs: 3000, seeks: 2, seekMedianMs: 900, seekMaxMs: 1500, stalls: 1, stallMs: 2000, effectiveType: '4g' };
const post = (s: Sess, payload: unknown, headers: Record<string, string> = {}, csrf = true) =>
  env.app.inject({ method: 'POST', url: '/api/playback/timing', cookies: s.cookies, headers: { ...(csrf ? { 'x-csrf-token': s.csrf } : {}), ...headers }, payload: payload as object });
const rows = async () => (await env.pool.query('select * from playback_timings order by id')).rows;

describe('POST /api/playback/timing', () => {
  it('stores one anonymous row; home comes from the server (remote address = false, home address = true)', async () => {
    expect((await post(friend, base, { 'x-real-ip': '203.0.113.9' })).statusCode).toBe(204);
    expect((await post(friend, { ...base, device: 'pc' }, { 'x-real-ip': '192.168.1.10' })).statusCode).toBe(204);
    const r = await rows();
    expect(r.map((x) => [x.home, x.device])).toEqual([[false, 'phone'], [true, 'pc']]);
    expect(r[0]).toMatchObject({ mode: 'hls', bitrate: 8_000_000, target_duration: 6, info_ms: 300, manifest_ms: 700, first_frag_ms: 2500, first_frag_bytes: 4_000_000, first_frag_dl_ms: 1500, first_frame_ms: 3000, seeks: 2, seek_median_ms: 900, seek_max_ms: 1500, stalls: 1, stall_ms: 2000, effective_type: '4g', quality_switch: false });
  });

  it('never stores personal fields: no user, profile, item, address or user agent column, extra fields are dropped', async () => {
    const id = (await me(friend)).id;
    expect((await post(friend, { ...base, userId: id, profileId: id, itemId: 'a'.repeat(32), ip: '203.0.113.9', userAgent: 'UA', home: true }, { 'x-real-ip': '203.0.113.9', 'user-agent': 'Secret-UA' })).statusCode).toBe(204);
    const cols = (await env.pool.query("select column_name from information_schema.columns where table_name = 'playback_timings'")).rows.map((x) => x.column_name);
    for (const c of cols) expect(c).not.toMatch(/user|profile|item|ip|agent|addr|session/);
    const r = await rows();
    expect(r[0].home).toBe(false); // the client's "home: true" is ignored
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${id}|aaaaaaaa|Secret-UA|203\\.0\\.113`));
  });

  it('validates with zod and clamps the numbers', async () => {
    expect((await post(friend, { ...base, device: 'watch' })).statusCode).toBe(400);
    expect((await post(friend, { ...base, mode: 'dash' })).statusCode).toBe(400);
    expect((await post(friend, { ...base, infoMs: 'slow' })).statusCode).toBe(400);
    expect((await post(friend, { ...base, firstFrameMs: 1e12, infoMs: -50, targetDuration: 6.04, stallMs: 1e15, seeks: 99_999, effectiveType: 'wifi', bitrate: null })).statusCode).toBe(204);
    expect((await rows())[0]).toMatchObject({ first_frame_ms: 600_000, info_ms: 0, stall_ms: 86_400_000, seeks: 10_000, effective_type: null, bitrate: null });
    expect((await rows())[0].target_duration).toBeCloseTo(6, 3);
    expect(timingBody.parse({ device: 'tv', mode: 'direct' })).toMatchObject({ qualitySwitch: false });
  });

  it('needs a session and the csrf header; per-user hourly limit', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/playback/timing', payload: base })).statusCode).toBe(401);
    expect((await post(friend, base, {}, false)).statusCode).toBe(403);
    await env.kv.incr(`ptiming:h:${(await me(friend)).id}`, 3600);
    for (let i = 0; i < 119; i++) await env.kv.incr(`ptiming:h:${(await me(friend)).id}`, 3600);
    expect((await post(friend, base)).statusCode).toBe(429);
    expect(await rows()).toHaveLength(0);
  });
});

describe('A/V-sync facts', () => {
  const sync = { delivery: 'remux', videoCopy: true, soundMode: 'night', audioRouted: true, droppedFrames: 12, totalFrames: 14_400, trackSwitch: true, reconnects: 1, avEvents: 4 };

  it('stores delivery, video copy, sound mode, frames and the A/V events; an older player without them still works', async () => {
    expect((await post(friend, { ...base, ...sync })).statusCode).toBe(204);
    expect((await post(friend, base)).statusCode).toBe(204);
    const [a, b] = await rows();
    expect(a).toMatchObject({ delivery: 'remux', video_copy: true, sound_mode: 'night', audio_routed: true, dropped_frames: 12, total_frames: 14_400, track_switch: true, reconnects: 1, av_events: 4 });
    expect(b).toMatchObject({ delivery: null, video_copy: null, sound_mode: null, audio_routed: null, dropped_frames: null, total_frames: null, track_switch: false, reconnects: 0, av_events: 0 });
  });

  it('drops unknown values instead of failing, clamps the counts, and drops a frame reading with more dropped than total', async () => {
    expect((await post(friend, { ...base, ...sync, delivery: 'magic', soundMode: 'loud', videoCopy: 'yes', avEvents: 1e9, reconnects: -3 })).statusCode).toBe(204);
    expect((await post(friend, { ...base, droppedFrames: 50, totalFrames: 10 })).statusCode).toBe(204);
    const [a, b] = await rows();
    expect(a).toMatchObject({ delivery: null, sound_mode: null, video_copy: null, av_events: 100_000, reconnects: 0 });
    expect(b).toMatchObject({ dropped_frames: null, total_frames: null });
  });

  it('stores whether the start used the prepared next-episode info (older players: false, junk: false)', async () => {
    expect((await post(friend, { ...base, fromNext: true })).statusCode).toBe(204);
    expect((await post(friend, { ...base, fromNext: 'yes' })).statusCode).toBe(204);
    const [a, b] = await rows();
    expect(a).toMatchObject({ from_next: true });
    expect(b).toMatchObject({ from_next: false });
    const v = (await env.app.inject({ url: '/api/admin/playback/timing', cookies: admin.cookies })).json();
    expect(v.recent.map((r: { fromNext: boolean }) => r.fromNext)).toEqual([false, true]);
  });

  it('the admin view lists them in the recent rows', async () => {
    await post(friend, { ...base, ...sync });
    const v = (await env.app.inject({ url: '/api/admin/playback/timing', cookies: admin.cookies })).json();
    expect(v.recent[0]).toMatchObject({ delivery: 'remux', videoCopy: true, soundMode: 'night', audioRouted: true, droppedFrames: 12, totalFrames: 14_400, trackSwitch: true, reconnects: 1, avEvents: 4 });
  });
});

describe('GET /api/playback/stream (video copied?)', () => {
  const session = (ps: string, serverUserId: string, videoDirect?: boolean) => ({
    sessionId: `s-${ps}`, serverUserId, item: { id: 'a'.repeat(32), name: 'x' }, playSessionId: ps, playMethod: 'Transcode' as const, reasons: [], paused: false,
    ...(videoDirect === undefined ? {} : { videoDirect }),
  });
  const ask = (s: Sess | null, ps: string) => env.app.inject({ url: `/api/playback/stream?ps=${encodeURIComponent(ps)}`, cookies: s?.cookies ?? {} });

  it("answers only for the caller's own play session; never stores anything", async () => {
    const mine = (await env.pool.query('select jellyfin_user_id from users where id = $1', [(await me(admin)).id])).rows[0].jellyfin_user_id as string;
    expect(mine).toBeTruthy();
    const orig = env.ctx.jf.admin.transcodeSessions;
    env.ctx.jf.admin.transcodeSessions = async () => [session('ps-mine', mine.toUpperCase(), true), session('ps-other', 'someone-else', false), session('ps-unknown', mine)];
    resetStreamsMemoForTests();
    try {
      expect((await ask(admin, 'ps-mine')).json()).toEqual({ videoDirect: true });
      expect((await ask(admin, 'ps-other')).json()).toEqual({ videoDirect: null }); // not mine
      expect((await ask(admin, 'ps-unknown')).json()).toEqual({ videoDirect: null }); // not reported
      expect((await ask(admin, 'ps-gone')).json()).toEqual({ videoDirect: null });
      expect((await ask(friend, 'bad id!')).statusCode).toBe(400);
      expect((await ask(null, 'ps-mine')).statusCode).toBe(401);
      expect(await rows()).toHaveLength(0);
    } finally {
      env.ctx.jf.admin.transcodeSessions = orig;
      resetStreamsMemoForTests();
    }
  });
});

describe('GET /api/admin/playback/timing', () => {
  it('is for admins only', async () => {
    expect((await env.app.inject({ url: '/api/admin/playback/timing', cookies: friend.cookies })).statusCode).toBe(403);
  });

  it('medians / p90 of each step per side and device, quality switches not counted as starts; the last 30 rows', async () => {
    const remote = { 'x-real-ip': '203.0.113.9' };
    for (const f of [1000, 2000, 3000, 4000, 5000]) await post(friend, { ...base, firstFrameMs: f + 2500 }, remote);
    await post(friend, { ...base, qualitySwitch: true, firstFrameMs: 60_000 }, remote);
    await post(friend, { device: 'pc', mode: 'direct', infoMs: 200, firstFrameMs: 900 }, { 'x-real-ip': '192.168.1.10' });
    await env.pool.query("insert into playback_timings(home, device, mode, first_frame_ms, created_at) values (false, 'phone', 'hls', 99999, now() - interval '3 days')");
    const r = await env.app.inject({ url: '/api/admin/playback/timing', cookies: admin.cookies });
    expect(r.statusCode).toBe(200);
    const v = r.json();
    const dayPhone = v.day.find((g: any) => !g.home && g.device === 'phone');
    expect(dayPhone).toMatchObject({ n: 5, switches: 1, targetDuration: 6 });
    expect(dayPhone.total).toEqual({ p50: 5500, p90: 7100 });
    expect(dayPhone.phases.info).toEqual({ p50: 300, p90: 300 });
    expect(dayPhone.phases.manifest).toEqual({ p50: 400, p90: 400 });
    expect(dayPhone.phases.firstFrag).toEqual({ p50: 1800, p90: 1800 });
    expect(dayPhone.phases.firstFrame).toEqual({ p50: 3000, p90: 4600 });
    expect(dayPhone.stallsPerSession).toBe(1);
    // direct play: no playlist / fragment, the frame step counts from the info answer
    const home = v.day.find((g: any) => g.home && g.device === 'pc');
    expect(home.phases).toMatchObject({ manifest: { p50: null }, firstFrag: { p50: null }, firstFrame: { p50: 700 } });
    // grouping set: every device of one side
    expect(v.day.find((g: any) => !g.home && g.device === null).n).toBe(5);
    expect(v.week.find((g: any) => !g.home && g.device === 'phone').n).toBe(6);
    expect(v.recent).toHaveLength(8);
    expect(v.recent[0]).toMatchObject({ device: 'pc', mode: 'direct', home: true, firstFrameMs: 900, qualitySwitch: false });
    expect(Object.keys(v.recent[0])).not.toContain('userId');
  });
});

describe('picture and sound out (video_out / audio_out)', () => {
  // the per-IP limit (30/min) is already used up by the tests above: every post here comes from its own address
  let n = 0;
  const post = (s: Sess, payload: unknown) =>
    env.app.inject({ method: 'POST', url: '/api/playback/timing', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object, remoteAddress: `198.51.100.${++n}` });
  it('round trip of the allowlisted codes; an older player without them stores null', async () => {
    expect((await post(friend, { ...base, videoOut: 'copy_hevc', audioOut: 'surround' })).statusCode).toBe(204);
    expect((await post(friend, { ...base, videoOut: 'direct', audioOut: 'direct' })).statusCode).toBe(204);
    expect((await post(friend, base)).statusCode).toBe(204);
    const [a, b, c] = await rows();
    expect(a).toMatchObject({ video_out: 'copy_hevc', audio_out: 'surround' });
    expect(b).toMatchObject({ video_out: 'direct', audio_out: 'direct' });
    expect(c).toMatchObject({ video_out: null, audio_out: null });
  });
  it('every allowed value is stored, anything else (also a URL or a title) is stored as null and never fails the report', async () => {
    for (const v of ['direct', 'copy_h264', 'copy_hevc', 'h264', 'hevc']) await post(friend, { ...base, videoOut: v });
    for (const a of ['direct', 'copy', 'stereo', 'surround']) await post(friend, { ...base, audioOut: a });
    expect((await rows()).map((x) => [x.video_out, x.audio_out])).toEqual([...['direct', 'copy_h264', 'copy_hevc', 'h264', 'hevc'].map((v) => [v, null]), ...['direct', 'copy', 'stereo', 'surround'].map((a) => [null, a])]);
    await env.pool.query('delete from playback_timings');
    expect((await post(friend, { ...base, videoOut: 'copy', audioOut: 'eac3', why: ['hevc_device'] })).statusCode).toBe(204);
    expect((await post(friend, { ...base, videoOut: '/media/hls/Dunmoor/master.m3u8', audioOut: { a: 1 } })).statusCode).toBe(204);
    expect((await post(friend, { ...base, videoOut: 'HEVC' })).statusCode).toBe(204);
    expect((await rows()).map((x) => [x.video_out, x.audio_out])).toEqual([[null, null], [null, null], [null, null]]);
    expect(timingBody.parse({ ...base, videoOut: 7 }).videoOut).toBeNull();
  });
  it('the migration can be re-run and the admin view lists the codes', async () => {
    const { migrate } = await import('../src/db.js');
    await env.pool.query('delete from schema_migrations where version >= 45');
    await migrate(env.pool);
    await migrate(env.pool);
    await post(friend, { ...base, videoOut: 'hevc', audioOut: 'stereo' });
    const v = (await env.app.inject({ url: '/api/admin/playback/timing', cookies: admin.cookies })).json();
    expect(v.recent[0]).toMatchObject({ videoOut: 'hevc', audioOut: 'stereo' });
  });
});

describe('live starts (mode live, Task 39)', () => {
  // the per-IP limit (30/min) is already used up by the tests above: every post here comes from its own address
  let n = 0;
  const post = (s: Sess, payload: unknown) =>
    env.app.inject({ method: 'POST', url: '/api/playback/timing', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object, remoteAddress: `198.51.100.${100 + ++n}` });
  const extra = { delivery: 'remux', videoCopy: true, soundMode: 'night', audioRouted: true, droppedFrames: 12, totalFrames: 14_400, trackSwitch: true, reconnects: 2, avEvents: 3, fromNext: true, qualitySwitch: true, videoOut: 'h264', audioOut: 'copy' };

  it('stores a live start with its first-frame time only; every other measurement is dropped', async () => {
    expect((await post(friend, { ...base, ...extra, device: 'tv', mode: 'live', firstFrameMs: 1800 })).statusCode).toBe(204);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      device: 'tv', mode: 'live', first_frame_ms: 1800, quality_switch: false, bitrate: null, target_duration: null, info_ms: null, manifest_ms: null,
      first_frag_ms: null, first_frag_bytes: null, first_frag_dl_ms: null, seeks: 0, seek_median_ms: null, seek_max_ms: null, stalls: 0, stall_ms: 0,
      effective_type: null, delivery: null, video_copy: null, sound_mode: null, audio_routed: null, dropped_frames: null, total_frames: null,
      track_switch: false, reconnects: 0, av_events: 0, from_next: false, video_out: null, audio_out: null,
    });
  });

  it('a bare live report is accepted; film modes keep every field; other modes stay refused', async () => {
    expect((await post(friend, { device: 'phone', mode: 'live', firstFrameMs: 2400 })).statusCode).toBe(204);
    expect((await post(friend, { ...base, mode: 'hls' })).statusCode).toBe(204);
    expect((await post(friend, { ...base, mode: 'dash' })).statusCode).toBe(400);
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ device: 'phone', mode: 'live', first_frame_ms: 2400 });
    expect(r[1]).toMatchObject({ mode: 'hls', info_ms: 300, first_frame_ms: 3000, seeks: 2 });
  });
});

describe('cleanup', () => {
  it('pruneTimings / healthTick delete rows older than 14 days', async () => {
    await env.pool.query("insert into playback_timings(home, device, mode, created_at) values (true, 'pc', 'hls', now() - interval '15 days'), (true, 'pc', 'hls', now() - interval '13 days')");
    expect(await pruneTimings(env.ctx)).toBe(1);
    await env.pool.query("insert into playback_timings(home, device, mode, created_at) values (true, 'tv', 'hls', now() - interval '20 days')");
    await env.kv.del('health:prune');
    await healthTick(env.ctx, { fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch, timeoutMs: 50 });
    expect((await rows()).map((x) => x.device)).toEqual(['pc']);
  });
});
