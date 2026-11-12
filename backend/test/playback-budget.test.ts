// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/cast.js';
import { __resetConvMemo } from '../src/convbudget.js';
import { fingerprint } from '../src/hevcenc.js';
import { setLive } from '../src/live.js';
import type { EncoderSettings, ServerSession } from '../src/media/types.js';
import { writeRole } from '../src/roleWrite.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Live TV Phase 1, Task 2: film playback and casting are admitted by the shared conversion budget (spec §5.5, rulings 6 and 7).
// A copy needs no slot; a conversion takes one; a full (or unreadable) budget falls back to a copy, and only a title that truly needs a
// conversion gets `503 server_busy`. Running conversions are never stopped.

const ID = 'a'.repeat(32);
type Sess = { cookies: Record<string, string>; csrf: string };
const E: EncoderSettings = { hwAccel: 'qsv', tonemap: true, throttle: true, keyframeMkv: true, hevcEncode: true, hwEncode: true, lowPowerHevc: true, downmix: 'dave750' };

interface Source { container: string; bitrate: number; video: Record<string, unknown> }
/** H.264 8 Mbit/s 1080p in Matroska: a browser cannot direct-play it, but HLS can copy it at a cap of 8.2 Mbit/s or more */
const H264_8M: Source = { container: 'mkv', bitrate: 8_200_000, video: { Codec: 'h264', BitRate: 8_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
/** 1080p at 3 Mbit/s: a 4 Mbit/s pick (720p box) converts it, the ceiling's 1080p box copies it at its own 3.2 Mbit/s (at or below the pick) */
const SMALL_1080: Source = { container: 'mkv', bitrate: 3_200_000, video: { Codec: 'h264', BitRate: 3_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
/** above the friend's 20 Mbit/s: converted */
const H264_25M: Source = { container: 'mkv', bitrate: 25_200_000, video: { Codec: 'h264', BitRate: 25_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
/** HEVC for a browser without HEVC: never copyable */
const HEVC_SRC: Source = { container: 'mkv', bitrate: 6_200_000, video: { Codec: 'hevc', Profile: 'Main', BitRate: 6_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
/** an mp4 a browser plays directly */
const DIRECT: Source = { container: 'mp4', bitrate: 4_000_000, video: { Codec: 'h264', BitRate: 3_800_000, Width: 1280, Height: 720, VideoRangeType: 'SDR' } };

let env: TestEnv;
let admin: Sess, friend: Sess;
let friendId = '', friendDevice = '';
let src: Source = H264_8M;
let n = 0;
let pb: Array<{ max: number }> = [];
let lastPs = '';
/** the series name the fake's /Items lookup reports (episodes) */
let seriesName: string | undefined;
let sessions: () => Promise<ServerSession[]> = async () => [];
let sessionReads = 0;

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': () => ({ json: { Items: [{ Id: ID, Name: seriesName ? 'Episode 1' : 'Dunmoor', Type: seriesName ? 'Episode' : 'Movie', ...(seriesName ? { SeriesName: seriesName } : {}), UserData: { PlaybackPositionTicks: 0 } }], TotalRecordCount: 1 } }),
    'POST /Sessions/Playing': () => ({ status: 204 }),
    'POST /Sessions/Playing/Stopped': () => ({ status: 204 }),
    'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Dunmoor', Type: 'Movie', ImageTags: { Primary: 'x' }, UserData: { PlaybackPositionTicks: 0 } } }),
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
    'POST /Items/[^/]+/PlaybackInfo': (u) => {
      pb.push({ max: Number(u.searchParams.get('MaxStreamingBitrate')) });
      return {
        json: {
          PlaySessionId: (lastPs = `ps-budget-${String(++n).padStart(4, '0')}`),
          MediaSources: [{
            Id: 'ms1', Container: src.container, SupportsDirectPlay: true, Bitrate: src.bitrate, RunTimeTicks: 36_000_000_000,
            MediaStreams: [{ Index: 0, Type: 'Video', ...src.video }, { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, BitRate: 128_000, IsDefault: true }],
          }],
        },
      };
    },
  });
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  const token = inv.json().link.split('/').pop();
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Ben Muster', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${token}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
  friendId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-friend'")).rows[0]!.id;
  friendDevice = (await env.pool.query<{ device_id: string }>('select device_id from devices where user_id=$1', [friendId])).rows[0]!.device_id;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 2 };
  __resetConvMemo();
  src = H264_8M;
  seriesName = undefined;
  pb = [];
  sessions = async () => [];
  sessionReads = 0;
  env.ctx.jf.admin.transcodeSessions = () => { sessionReads++; return sessions(); };
  env.ctx.jf.admin.encoderSettings = async () => E;
  for (const p of ['conv:', 'hevcgrant:', 'hevcenc:', 'play:', 'pbinfo:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const foreign = (ps: string, o: Partial<ServerSession> = {}): ServerSession => ({
  sessionId: `s-${ps}`, serverUserId: 'jf-other', item: { id: 'b'.repeat(32), name: 'Saltwater Almanac' }, playSessionId: ps, playMethod: 'Transcode', reasons: [], paused: false, videoDirect: false, ...o,
});
const info = (s: Sess, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, ...headers }, payload: { itemId: ID, ...body } });
const REMOTE = { 'x-real-ip': '203.0.113.9' };
const grants = async () => (await env.kv.keys('conv:grant:')).sort();
const pbinfo = async (userId: string, ps: string) => JSON.parse((await env.kv.get(`pbinfo:${userId}:${ps}`)) ?? 'null') as Record<string, unknown> | null;
const stops = () => env.jfCalls.filter((c) => c.method === 'DELETE' && c.path.includes('ActiveEncodings')).length;
/** an HEVC-capable browser (stream plan: HEVC conversion for remote viewers whose cap lies below the source) */
const hevcCaps = {
  client: 'web', appVersion: '3.3.0', containers: ['mp4'], video: [{ codec: 'h264' }, { codec: 'hevc', profiles: ['main'], tags: ['hvc1'] }], audio: ['aac', 'mp3'], subtitles: ['vtt'],
  ranges: ['sdr'], hls: { video: ['h264', 'hevc'], audio: ['aac'], surround: [] },
};
const hevcReady = () => env.kv.set('hevcenc:probe', JSON.stringify({ ok: true, speed: 3.2, fingerprint: fingerprint(E), at: Date.now() - 1000 }), 3600);

describe('POST /api/playback/info admits conversions against the budget', () => {
  it('copy plays without a slot', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    const r = await info(friend);
    expect(r.statusCode).toBe(200);
    expect(r.json().delivery.video).toBe('copy');
    expect(r.json().transcodeReason).not.toBe('serverBusy');
    expect(await grants()).toEqual([]);
    expect(sessionReads).toBe(0); // a copy is never gated
    expect(await pbinfo(friendId, r.json().playSessionId)).not.toHaveProperty('conv');
  });

  it('a conversion takes a slot and binds it', async () => {
    src = H264_25M;
    sessions = async () => [foreign('ps-foreign-1')];
    const r = await info(friend);
    expect(r.statusCode).toBe(200);
    const ps = r.json().playSessionId as string;
    expect(r.json().delivery.video).toBe('h264');
    expect(await grants()).toEqual([`conv:grant:${ps}`]); // the hint key is gone, the grant lives on the play session
    expect(JSON.parse((await env.kv.get(`conv:grant:${ps}`))!)).toMatchObject({ kind: 'film', user: friendId, device: friendDevice, ps, label: 'Dunmoor' });
    expect(await pbinfo(friendId, ps)).toMatchObject({ video: 'h264', conv: true }); // ruling 6: the record says it really converts
    // an episode is labelled by its series (the title comes with the resume lookup, no extra request)
    seriesName = 'Saltwater Almanac';
    const ep = await info(friend);
    expect(JSON.parse((await env.kv.get(`conv:grant:${ep.json().playSessionId}`))!)).toMatchObject({ label: 'Saltwater Almanac' });
  });

  it('a 502 resume_unknown after admission leaves no grant', async () => {
    src = H264_25M;
    vi.spyOn(env.ctx.jf, 'playMeta').mockResolvedValue(null);
    vi.spyOn(env.ctx.jf, 'item').mockRejectedValue(new Error('down'));
    const r = await info(friend);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'jellyfin', reason: 'resume_unknown' });
    expect(sessionReads).toBe(1); // it was admitted (the budget read the list) before the lookup failed
    expect(await grants()).toEqual([]);
  });

  it('a stream stopped within its grant gives the slot back (warm-up stop and the stop report)', async () => {
    src = H264_25M;
    const report = (s: Sess, ps: string) => env.app.inject({ method: 'POST', url: '/api/playback/stop', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: ID, playSessionId: ps, mediaSourceId: 'ms1', positionTicks: 0 } });
    const warm = (await info(friend)).json().playSessionId as string;
    expect(await grants()).toEqual([`conv:grant:${warm}`]);
    const st = await env.app.inject({ method: 'POST', url: '/api/playback/warm/stop', cookies: friend.cookies, headers: { 'x-csrf-token': friend.csrf }, payload: { playSessionId: warm } });
    expect(st.json()).toEqual({ ok: true, stopped: true });
    expect(await grants()).toEqual([]);
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);

    const played = (await info(friend)).json().playSessionId as string;
    expect(await grants()).toEqual([`conv:grant:${played}`]);
    // another account's stop report for this play session does not touch the grant
    expect((await report(admin, played)).statusCode).toBe(200);
    expect(await grants()).toEqual([`conv:grant:${played}`]);
    expect((await report(friend, played)).statusCode).toBe(200);
    expect(await grants()).toEqual([]);
  });

  it('full budget falls back to copy', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = SMALL_1080; // the viewer's 4 Mbit/s lies above the source: only the 720p box made it a conversion
    const before = stops();
    const r = await info(friend, { maxBitrate: 4_000_000, reasonHint: 'manual' });
    expect(r.statusCode).toBe(200);
    expect(pb.map((p) => p.max)).toEqual([4_000_000, 20_000_000]); // the copy is asked at the role ceiling (its bitrate is the source's)
    expect(r.json()).toMatchObject({ delivery: { video: 'copy' }, transcodeReason: 'serverBusy', maxBitrate: 20_000_000, roleMaxBitrate: 20_000_000 });
    expect(await grants()).toEqual([]);
    expect(await pbinfo(friendId, r.json().playSessionId)).toMatchObject({ reason: 'serverBusy', video: 'copy' });
    expect(await pbinfo(friendId, r.json().playSessionId)).not.toHaveProperty('conv');
    expect(stops()).toBe(before); // the foreign conversion is never stopped
  });

  it('owner ruling: a viewer who asked below the source gets 503, not the original\'s bitrate as a copy', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = H264_8M; // copyable at the ceiling, but 8.2 Mbit/s is above what the viewer asked for
    const before = stops();
    for (const reasonHint of ['manual', 'network'] as const) { // data saver / a lower pick, and ABR on a slow line
      pb = [];
      const r = await info(friend, { maxBitrate: 4_000_000, reasonHint });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: 'server_busy' });
      expect(pb.map((p) => p.max)).toEqual([4_000_000]); // no copy request above the viewer's own cap
    }
    expect(await grants()).toEqual([]);
    expect(stops()).toBe(before);
    // at or above the source, the same viewer still gets the copy
    pb = [];
    const ok = await info(friend, { maxBitrate: 8_500_000, reasonHint: 'manual' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ delivery: { video: 'copy' } });
    expect(ok.json()).not.toHaveProperty('sourceBitrate'); // server-side only
  });

  it('no copy possible -> 503 server_busy', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = HEVC_SRC;
    const before = stops();
    const r = await info(friend);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'server_busy' });
    expect(pb).toHaveLength(1); // already at the ceiling: the copy request would plan the same answer, so none is made
    expect(await grants()).toEqual([]);
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);
    expect(stops()).toBe(before); // no stream was fetched, nothing is stopped
  });

  it('role cap below the source -> 503', async () => {
    await writeRole(env.ctx, null, 'friend', { maxBitrate: 4_000_000 });
    try {
      env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
      sessions = async () => [foreign('ps-foreign-1')];
      const r = await info(friend);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: 'server_busy' });
      expect(pb.map((p) => p.max)).toEqual([4_000_000]); // at the role's own cap already: no copy request above it, none at all
    } finally { await writeRole(env.ctx, null, 'friend', { maxBitrate: null }); }
  });

  it('HEVC needs both slots', async () => {
    await hevcReady();
    src = { container: 'mkv', bitrate: 15_200_000, video: { Codec: 'h264', BitRate: 15_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
    // L = 2, one used: an HEVC slot and a budget slot
    sessions = async () => [foreign('ps-foreign-1')];
    const ok = await info(friend, { caps: hevcCaps }, REMOTE);
    expect(ok.statusCode).toBe(200);
    const ps = ok.json().playSessionId as string;
    expect(ok.json().delivery.video).toBe('hevc');
    expect(await env.kv.keys('hevcgrant:')).toEqual([`hevcgrant:${ps}`]);
    expect(await grants()).toEqual([`conv:grant:${ps}`]);
    expect(JSON.parse((await env.kv.get(`conv:grant:${ps}`))!)).toMatchObject({ kind: 'film', hevc: true, ps });
    for (const p of ['hevcgrant:', 'conv:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);

    // L = 1, one used: the budget refuses, so no HEVC grant is left; a source above the remote ceiling cannot be copied
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const busy = await info(friend, { caps: hevcCaps }, REMOTE);
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ error: 'server_busy' });
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);
    expect(await grants()).toEqual([]);

    // a source that fits the remote ceiling (8 Mbit/s) but lies above the viewer's lower pick (which wanted an HEVC conversion): no copy
    // above the pick (owner ruling), 503 without a second request
    src = { container: 'mkv', bitrate: 6_200_000, video: { Codec: 'h264', BitRate: 6_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
    pb = [];
    const below = await info(friend, { caps: hevcCaps, maxBitrate: 4_000_000 }, REMOTE);
    expect(below.statusCode).toBe(503);
    expect(pb.map((p) => p.max)).toEqual([4_000_000]);
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);
    expect(await grants()).toEqual([]);
  });

  it('a quality switch of the same device is not counted', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    src = H264_25M;
    sessions = async () => [foreign('ps-own-0001', { serverUserId: 'jf-friend' })];
    await setLive(env.ctx, { userId: friendId, userName: 'Ben Muster', itemId: ID, title: 'Dunmoor', positionTicks: 0, isPaused: false, playSessionId: 'ps-own-0001', updatedAt: Date.now(), source: 'portal', deviceId: friendDevice });
    const r = await info(friend, { maxBitrate: 8_000_000, reasonHint: 'manual' });
    expect(r.statusCode).toBe(200);
    expect(r.json().delivery.video).toBe('h264');
    expect(r.json().transcodeReason).not.toBe('serverBusy');
    // another person's device is not replaced: the slot stays taken
    src = HEVC_SRC;
    expect((await info(admin)).statusCode).toBe(503);
  });

  it('slow session list falls back to copy, not a hard error', async () => {
    sessions = () => new Promise<ServerSession[]>(() => undefined);
    src = SMALL_1080;
    // a title that can be copied still plays
    let t0 = performance.now();
    const copy = await info(friend, { maxBitrate: 4_000_000 });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({ delivery: { video: 'copy' }, transcodeReason: 'serverBusy' });
    expect(performance.now() - t0).toBeLessThan(2000);
    // only a title that truly needs a conversion gets the busy answer, within 2 s
    src = HEVC_SRC;
    t0 = performance.now();
    const busy = await info(friend);
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ error: 'server_busy' });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(await grants()).toEqual([]);
  });

  it('slow session list with HEVC ready: one shared read for both gates, still within 2 s', async () => {
    await hevcReady();
    sessions = () => new Promise<ServerSession[]>(() => undefined);
    src = { container: 'mkv', bitrate: 15_200_000, video: { Codec: 'h264', BitRate: 15_000_000, Width: 1920, Height: 1080, VideoRangeType: 'SDR' } };
    const t0 = performance.now();
    const r = await info(friend, { caps: hevcCaps }, REMOTE);
    expect(r.statusCode).toBe(503);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(sessionReads).toBe(1); // the HEVC gate and the budget share the one session-list read of this request
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);
    expect(await grants()).toEqual([]);
  });

  it('direct play answers are not gated', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = DIRECT;
    const r = await info(friend);
    expect(r.statusCode).toBe(200);
    expect(r.json().directUrl).toMatch(/^\/media\/Videos\//);
    expect(sessionReads).toBe(0);
    expect(await grants()).toEqual([]);
    expect(await pbinfo(friendId, r.json().playSessionId)).not.toHaveProperty('conv');
  });
});

describe('POST /api/cast/session admits conversions against the budget', () => {
  let k = 0;
  const cast = (s: Sess, body: Record<string, unknown> = {}) =>
    env.app.inject({ method: 'POST', url: '/api/cast/session', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-forwarded-for': `10.9.0.${++k}` }, payload: { itemId: ID, ...body } });

  it('cast uses the same gate', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = HEVC_SRC;
    const before = stops();
    const r = await cast(admin);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'server_busy' });
    expect(await grants()).toEqual([]);
    expect(await env.kv.keys('cast:')).toEqual([]); // nothing minted
    expect(stops()).toBe(before);
  });

  it('a full budget casts a copy at the cast ceiling', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = SMALL_1080;
    const r = await cast(admin, { maxBitrate: 4_000_000 });
    expect(r.statusCode).toBe(200);
    expect(pb.map((p) => p.max)).toEqual([4_000_000, 20_000_000]);
    expect(r.json().contentUrl).toContain('MaxStreamingBitrate=20000000');
    expect(await grants()).toEqual([]);
  });

  it('owner ruling: a cast pick below the source gets 503, not the original as a copy', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    sessions = async () => [foreign('ps-foreign-1')];
    src = H264_8M;
    const minted = (await env.kv.keys('cast:')).length;
    const r = await cast(admin, { maxBitrate: 4_000_000 });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'server_busy' });
    expect(pb.map((p) => p.max)).toEqual([4_000_000]);
    expect(await env.kv.keys('cast:')).toHaveLength(minted); // nothing minted
  });

  it('a cast conversion with a free slot takes it and binds it', async () => {
    src = HEVC_SRC;
    const r = await cast(admin);
    expect(r.statusCode).toBe(200);
    const ps = r.json().playSessionId as string;
    expect(await grants()).toEqual([`conv:grant:${ps}`]);
    expect(JSON.parse((await env.kv.get(`conv:grant:${ps}`))!)).toMatchObject({ kind: 'film', label: 'Dunmoor', ps });
    const uid = (await env.app.inject({ url: '/api/me', cookies: admin.cookies })).json().id as string;
    expect(await pbinfo(uid, ps)).toMatchObject({ video: 'h264', conv: true });
  });

  it('a queued cast whose predecessor lost its pin (409 cast_unpinned) leaves no grant', async () => {
    src = HEVC_SRC;
    const cur = await cast(admin);
    expect(cur.statusCode).toBe(200);
    const curPs = cur.json().playSessionId as string;
    const ct = /\/media\/c\/([\w-]{43})\//.exec(cur.json().contentUrl)![1]!;
    const pin = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { ct, client: '192.168.1.50' } });
    expect(pin.statusCode).toBe(200);
    // the pin vanishes while the queued episode's PlaybackInfo is in flight (after the route's own pin check, before the mint)
    const orig = env.ctx.jf.playbackInfo.bind(env.ctx.jf);
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockImplementation(async (...a) => { const r = await orig(...a); await env.kv.del(`castpin:${hashToken(ct)}`); return r; });
    const r = await cast(admin, { next: true, after: cur.json().castId });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'cast_unpinned' });
    expect(lastPs).not.toBe(curPs);
    expect(await grants()).toEqual([`conv:grant:${curPs}`]); // the running cast keeps its own; the refused one left none
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);
  });

  it('a mint that fails after admission leaves no grant', async () => {
    src = HEVC_SRC;
    const real = env.kv.set.bind(env.kv);
    vi.spyOn(env.kv, 'set').mockImplementation((k: string, v: string, ttl?: number) => (k.startsWith('cast:') ? Promise.reject(new Error('down')) : real(k, v, ttl)));
    const r = await cast(admin);
    expect(r.statusCode).toBe(500);
    expect(lastPs).toMatch(/^ps-budget-/);
    expect(await grants()).toEqual([]);
  });

  // last: it switches a session's profile
  it('a profile switch during the mint (409 profile_changed) leaves no grant', async () => {
    src = HEVC_SRC;
    const s2 = await env.login(ADMIN);
    const p = await env.app.inject({ method: 'POST', url: '/api/profiles', cookies: s2.cookies, headers: { 'x-csrf-token': s2.csrf }, payload: { name: 'Kinderinsel' } });
    expect(p.statusCode, p.body).toBe(201);
    const pid = p.json().profile.id as string;
    const orig = env.ctx.jf.playbackInfo.bind(env.ctx.jf);
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockImplementation(async (...a) => {
      const r = await orig(...a);
      await env.app.inject({ method: 'POST', url: `/api/profiles/${pid}/select`, cookies: s2.cookies, headers: { 'x-csrf-token': s2.csrf }, payload: {} });
      return r;
    });
    const before = stops();
    const r = await cast(s2);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'profile_changed' });
    expect(stops()).toBe(before + 1); // the route stops the stream it started, as before
    expect(await grants()).toEqual([]);
    expect(await env.kv.keys('hevcgrant:')).toEqual([]);
  });
});
