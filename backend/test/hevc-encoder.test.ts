// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEVC_FAIL_COOLDOWN_MS, HEVC_GRANT_TTL_S, HEVC_SESSIONS_TIMEOUT_MS, effectiveLimit, fingerprint, hevcGate, hevcStateOf, hevcStatus, hevcTick, noteHevcFailure, probeHevcEncoder,
  type HevcProbeRecord,
} from '../src/hevcenc.js';
import { setLive } from '../src/live.js';
import type { EncoderSettings, ServerSession } from '../src/media/types.js';
import { previews } from '../src/previews.js';
import type { UserRow } from '../src/types.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Task 2 (HEVC & surround): the server's HEVC conversion: state, gate (limit), timed probe, tick, runtime failures.
const E: EncoderSettings = { hwAccel: 'qsv', tonemap: true, throttle: true, keyframeMkv: true, hevcEncode: true, hwEncode: true, lowPowerHevc: true, downmix: 'dave750' };
const FP = fingerprint(E);
const NOW = Date.parse('2026-11-10T12:00:00Z');
const probe = (o: Partial<HevcProbeRecord> = {}): HevcProbeRecord => ({ ok: true, speed: 3.2, fingerprint: FP, at: NOW - 1000, ...o });
const state = (o: Partial<Parameters<typeof hevcStateOf>[0]> = {}) => hevcStateOf({ streams: 2, kind: 'jellyfin', settings: E, probe: probe(), failures: [], now: NOW, ...o });

describe('hevcStateOf', () => {
  it('one case per state', () => {
    expect(state({ streams: 0 })).toBe('off');
    expect(state({ kind: 'plex' })).toBe('off');
    expect(state({ settings: { ...E, hevcEncode: false } })).toBe('server_off');
    expect(state({ settings: { ...E, hwAccel: 'none' } })).toBe('no_hw');
    expect(state({ settings: { ...E, hwEncode: false } })).toBe('no_hw');
    expect(state({ probe: null })).toBe('unproven');
    expect(state({ settings: { ...E, lowPowerHevc: false } })).toBe('unproven'); // fingerprint changed
    expect(state({ settings: null })).toBe('unproven');
    expect(state({ probe: probe({ ok: false, reason: 'not_hevc', speed: undefined }) })).toBe('failed');
    expect(state({ probe: probe({ ok: false, reason: 'http', speed: undefined }) })).toBe('failed');
    expect(state({ probe: probe({ ok: false, reason: 'slow', speed: 1.2 }) })).toBe('slow');
    expect(state({ probe: probe({ ok: true, speed: 1.2 }) })).toBe('slow');
    expect(state()).toBe('ready');
  });
  it('two failures from two devices within 60 min pause it for 6 h; one device alone does not', () => {
    const f = (min: number, device: string) => ({ at: NOW - min * 60_000, device });
    expect(state({ failures: [f(20, 'a'), f(10, 'b')] })).toBe('runtime_failed');
    expect(state({ failures: [f(20, 'a'), f(10, 'a')] })).toBe('ready');
    expect(state({ failures: [f(200, 'a'), f(10, 'b')] })).toBe('ready'); // too far apart
    expect(state({ failures: [f(20, 'a'), f(10, 'b')], now: NOW + HEVC_FAIL_COOLDOWN_MS - 11 * 60_000 })).toBe('runtime_failed');
    expect(state({ failures: [f(20, 'a'), f(10, 'b')], now: NOW + HEVC_FAIL_COOLDOWN_MS })).toBe('ready'); // 6 h after the second one
  });
});

describe('effectiveLimit (owner Q2)', () => {
  it('one while the probe measured less than 3x real time', () => {
    expect(effectiveLimit(2, 2.4)).toBe(1);
    expect(effectiveLimit(2, 3.2)).toBe(2);
    expect(effectiveLimit(4, 3)).toBe(4);
    expect(effectiveLimit(0, 2)).toBe(0);
  });
});

let env: TestEnv;
let admin: UserRow;
let settings: EncoderSettings | null = E;
let sessions: () => Promise<ServerSession[]> = async () => [];
beforeAll(async () => {
  env = await makeEnv();
  await env.login(ADMIN);
  admin = (await env.pool.query<UserRow>("select * from users where authentik_sub='sub-admin'")).rows[0]!;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg, HEVC_STREAMS: 2 };
  settings = E;
  sessions = async () => [];
  env.ctx.jf.admin.encoderSettings = async () => { if (!settings) throw new Error('boom'); return settings; };
  env.ctx.jf.admin.transcodeSessions = () => sessions();
  for (const p of ['hevcenc:', 'hevcgrant:', 'play:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const putProbe = (o: Partial<HevcProbeRecord> = {}) => env.kv.set('hevcenc:probe', JSON.stringify(probe({ ...o, at: Date.now() - 1000 })), 3600);
const hevcSession = (ps: string, o: Partial<ServerSession> = {}): ServerSession => ({
  sessionId: `s-${ps}`, serverUserId: 'u1', item: { id: 'a'.repeat(32), name: 'x' }, playSessionId: ps, playMethod: 'Transcode', reasons: [], paused: false, videoCodec: 'hevc', videoDirect: false, ...o,
});
const ask = (deviceId = 'dev-a', hint?: string) => hevcGate(env.ctx, { userId: admin.id, deviceId, ...(hint ? { playSessionIdHint: hint } : {}) });

describe('hevcStatus', () => {
  it('reads settings and the stored probe; speed and time only while the probe still fits the settings', async () => {
    expect(await hevcStatus(env.ctx)).toEqual({ state: 'unproven' });
    await putProbe({ speed: 2.4 });
    expect(await hevcStatus(env.ctx)).toMatchObject({ state: 'ready', speed: 2.4, at: expect.stringMatching(/^\d{4}-/) });
    settings = { ...E, lowPowerHevc: false };
    expect(await hevcStatus(env.ctx)).toEqual({ state: 'unproven' });
    settings = null; // unreadable: never ready
    expect((await hevcStatus(env.ctx)).state).toBe('unproven');
    env.ctx.cfg = { ...cfg, HEVC_STREAMS: 0 };
    expect(await hevcStatus(env.ctx)).toEqual({ state: 'off' });
  });
});

describe('gate', () => {
  it('ready with no sessions: ok, and a grant is written for 30 s', async () => {
    await putProbe();
    expect(await ask('dev-a', 'grant-1')).toEqual({ ok: true });
    expect(await env.kv.get('hevcgrant:grant-1')).not.toBeNull();
    expect(HEVC_GRANT_TTL_S).toBe(30);
  });
  it('a state that is not ready refuses with the matching code', async () => {
    expect(await ask()).toEqual({ ok: false, why: 'h264_unproven' });
    await putProbe({ ok: false, reason: 'not_hevc', speed: undefined });
    expect(await ask()).toEqual({ ok: false, why: 'h264_unhealthy' });
    await putProbe({ ok: false, reason: 'slow', speed: 1.2 });
    expect(await ask()).toEqual({ ok: false, why: 'h264_unhealthy' });
    await putProbe();
    settings = { ...E, hevcEncode: false };
    expect(await ask()).toEqual({ ok: false, why: 'h264_off' });
    settings = { ...E, hwEncode: false };
    expect(await ask()).toEqual({ ok: false, why: 'h264_off' });
    settings = E;
    env.ctx.cfg = { ...cfg, HEVC_STREAMS: 0 };
    expect(await ask()).toEqual({ ok: false, why: 'h264_off' });
    env.ctx.cfg = { ...cfg, HEVC_STREAMS: 2 };
    await noteHevcFailure(env.ctx, 'dev-x');
    await noteHevcFailure(env.ctx, 'dev-y');
    expect(await ask()).toEqual({ ok: false, why: 'h264_unhealthy' }); // runtime_failed
  });
  it('probe 2.4x: the limit is 1, so the second HEVC grant is refused h264_busy; probe 3.2x: the second is granted, the third refused', async () => {
    await putProbe({ speed: 2.4 });
    expect(await ask('dev-a', 'g1')).toEqual({ ok: true });
    expect(await ask('dev-b', 'g2')).toEqual({ ok: false, why: 'h264_busy' });
    for (const k of await env.kv.keys('hevcgrant:')) await env.kv.del(k);
    await putProbe({ speed: 3.2 });
    expect(await ask('dev-a', 'g1')).toEqual({ ok: true });
    expect(await ask('dev-b', 'g2')).toEqual({ ok: true });
    expect(await ask('dev-c', 'g3')).toEqual({ ok: false, why: 'h264_busy' });
  });
  it('HEVC_STREAMS 1 allows one even at 3.2x', async () => {
    env.ctx.cfg = { ...cfg, HEVC_STREAMS: 1 };
    await putProbe({ speed: 3.2 });
    expect(await ask('dev-a', 'g1')).toEqual({ ok: true });
    expect(await ask('dev-b', 'g2')).toEqual({ ok: false, why: 'h264_busy' });
  });
  it('counts only non-direct HEVC sessions of the server; the requester\'s own live stream does not count', async () => {
    await putProbe({ speed: 2.4 });
    sessions = async () => [hevcSession('ps-h264', { videoCodec: 'h264' }), hevcSession('ps-copy', { videoDirect: true }), hevcSession('ps-unknown', { videoDirect: undefined })];
    expect(await ask('dev-a', 'g1')).toEqual({ ok: true }); // none of those is a HEVC conversion
    for (const k of await env.kv.keys('hevcgrant:')) await env.kv.del(k);
    sessions = async () => [hevcSession('ps-other')];
    expect(await ask('dev-a')).toEqual({ ok: false, why: 'h264_busy' });
    // the same device's own stream is replaced by the new one: not counted
    await setLive(env.ctx, { userId: admin.id, userName: 'A', itemId: 'i', title: 't', positionTicks: 0, isPaused: false, playSessionId: 'ps-other', updatedAt: Date.now(), source: 'portal', deviceId: 'dev-a' });
    expect(await ask('dev-a')).toEqual({ ok: true });
    expect(await ask('dev-b')).toEqual({ ok: false, why: 'h264_busy' }); // another device still sees it as taken (and the grant just written)
  });
  it('an unexpired grant counts until the server lists its session', async () => {
    await putProbe({ speed: 2.4 });
    expect(await ask('dev-a', 'g1')).toEqual({ ok: true });
    expect(await ask('dev-b', 'g2')).toEqual({ ok: false, why: 'h264_busy' });
    const { bindHevcGrant } = await import('../src/hevcenc.js');
    await bindHevcGrant(env.ctx, 'g1', 'ps-real');
    expect(await env.kv.get('hevcgrant:g1')).toBeNull();
    expect(await ask('dev-b')).toEqual({ ok: false, why: 'h264_busy' }); // bound grant still counts
    sessions = async () => [hevcSession('ps-real')]; // now the server's list counts it once, not twice
    expect(await ask('dev-b')).toEqual({ ok: false, why: 'h264_busy' });
    sessions = async () => [hevcSession('ps-real', { videoDirect: true })]; // it turned out to copy: free again
    expect(await ask('dev-b')).toEqual({ ok: true });
    await bindHevcGrant(env.ctx, 'nobody', null); // nothing to bind: harmless
  });
  it('a failing or slow session list means busy', async () => {
    await putProbe({ speed: 3.2 });
    sessions = async () => { throw new Error('http://jellyfin:8096 down'); };
    expect(await ask()).toEqual({ ok: false, why: 'h264_busy' });
    vi.useFakeTimers();
    sessions = () => new Promise(() => undefined);
    const p = ask();
    await vi.advanceTimersByTimeAsync(HEVC_SESSIONS_TIMEOUT_MS + 5);
    expect(await p).toEqual({ ok: false, why: 'h264_busy' });
    vi.useRealTimers();
    env.ctx.jf.admin.transcodeSessions = undefined; // a server that cannot list its sessions
    expect(await ask()).toEqual({ ok: false, why: 'h264_busy' });
  });
});

describe('noteHevcFailure', () => {
  it('two devices pause HEVC; one device twice does not; Health state shows it', async () => {
    await putProbe();
    await noteHevcFailure(env.ctx, 'dev-a');
    await noteHevcFailure(env.ctx, 'dev-a');
    expect((await hevcStatus(env.ctx)).state).toBe('ready');
    await noteHevcFailure(env.ctx, 'dev-b');
    expect((await hevcStatus(env.ctx)).state).toBe('runtime_failed');
  });
});

describe('probe', () => {
  const user = () => admin;
  const INIT_OK = Buffer.concat([Buffer.from('....ftypiso6'), Buffer.from('hvcC'), Buffer.from('....')]);
  const INIT_BAD = Buffer.from('....ftypiso6avcC....');
  const SEG = Buffer.alloc(2000, 1);
  const playlist = (n = 6) => ['#EXTM3U', '#EXT-X-MAP:URI="hls1/main/-1.mp4"', ...Array.from({ length: n }, (_, i) => `#EXTINF:3.0,\nhls1/main/${i}.mp4`)].join('\n');
  let t = 0;
  let stopped: string[] = [];
  let paths: string[] = [];
  let mode: { init?: Buffer; fail?: string; segMs?: number; titles?: 'none' | 'series' | 'movie' } = {};
  const now = () => t;
  beforeEach(() => {
    t = 1_000_000; stopped = []; paths = []; mode = {};
    vi.spyOn(env.ctx.jf, 'items').mockImplementation(async () => (mode.titles === 'none' ? { items: [], total: 0 } : { items: [{ id: 'm'.repeat(32), name: 'Dunmoor', type: mode.titles === 'series' ? 'Series' : 'Movie' }] as never, total: 1 }));
    vi.spyOn(env.ctx.jf, 'firstEpisode').mockResolvedValue({ id: 'e'.repeat(32) });
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockResolvedValue({ playSessionId: 'ps-probe-1', hlsUrl: '/media/Videos/x/master.m3u8?PlaySessionId=ps-probe-1' } as never);
    vi.spyOn(env.ctx.jf, 'clipTranscode').mockResolvedValue({ path: '/Videos/x/master.m3u8?PlaySessionId=ps-probe-1', playSessionId: 'ps-probe-1' });
    vi.spyOn(env.ctx.jf, 'stopEncoding').mockImplementation(async (_u, ps) => { stopped.push(ps); });
    vi.spyOn(env.ctx.jf, 'mediaFetch').mockImplementation(async (_u, path) => {
      paths.push(path);
      if (mode.fail && path.includes(mode.fail)) return new Response('x', { status: 500 });
      if (path.includes('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?x=1\n');
      if (path.includes('main.m3u8')) return new Response(playlist());
      if (path.includes('-1.mp4')) return new Response(new Uint8Array(mode.init ?? INIT_OK));
      t += mode.segMs ?? 1500; // each segment takes this long to arrive
      return new Response(new Uint8Array(SEG));
    });
  });

  it('init with hvcC and 4 segments over 6 s: ok, speed 2; stored with the settings fingerprint; the conversion is stopped', async () => {
    const r = await probeHevcEncoder(env.ctx, user(), { now });
    expect(r).toEqual({ ok: true, speed: 2, fingerprint: FP, at: t });
    expect(stopped).toEqual(['ps-probe-1']);
    expect(JSON.parse((await env.kv.get('hevcenc:probe'))!)).toEqual(r);
    expect((await hevcStatus(env.ctx)).state).toBe('ready');
    // master, variant, init, then segments 0..3 in order and no more
    expect(paths.map((p) => p.split('?')[0]!.split('/').pop())).toEqual(['master.m3u8', 'main.m3u8', '-1.mp4', '0.mp4', '1.mp4', '2.mp4', '3.mp4']);
    expect(env.ctx.jf.clipTranscode).toHaveBeenCalledWith(user(), expect.anything(), { videoCodec: 'hevc', fmp4: true, videoBitrate: 6_000_000, audioBitrate: 128_000, maxWidth: 1920, segmentLength: 3 });
  });
  it('a series is probed on its first episode', async () => {
    mode.titles = 'series';
    expect((await probeHevcEncoder(env.ctx, user(), { now })).ok).toBe(true);
    expect(env.ctx.jf.playbackInfo).toHaveBeenCalledWith(user(), 'e'.repeat(32), expect.anything());
  });
  it('slower than 1.5x: slow with the speed', async () => {
    mode.segMs = 3000; // 12 s of media in 12 s: 1.0x
    expect(await probeHevcEncoder(env.ctx, user(), { now })).toMatchObject({ ok: false, reason: 'slow', speed: 1 });
    expect(stopped).toEqual(['ps-probe-1']);
    expect((await hevcStatus(env.ctx)).state).toBe('slow');
  });
  it('no hvcC in the init: not_hevc (the server fell back to H.264); stopped', async () => {
    mode.init = INIT_BAD;
    expect(await probeHevcEncoder(env.ctx, user(), { now })).toMatchObject({ ok: false, reason: 'not_hevc' });
    expect(stopped).toEqual(['ps-probe-1']);
    expect((await hevcStatus(env.ctx)).state).toBe('failed');
  });
  it('HTTP 500 anywhere: http; stopped each time', async () => {
    for (const fail of ['master.m3u8', 'main.m3u8', '-1.mp4', '2.mp4']) {
      stopped = []; mode.fail = fail;
      expect(await probeHevcEncoder(env.ctx, user(), { now })).toMatchObject({ ok: false, reason: 'http' });
      expect(stopped).toEqual(['ps-probe-1']);
    }
  });
  it('a throwing fetch is http too; no title is stored as no_title and stays unproven; nothing is stored without readable settings', async () => {
    vi.spyOn(env.ctx.jf, 'mediaFetch').mockRejectedValue(new Error('http://jellyfin:8096/x?api_key=SECRET timeout'));
    const r = await probeHevcEncoder(env.ctx, user(), { now });
    expect(r).toMatchObject({ ok: false, reason: 'http' });
    expect(JSON.stringify(r)).not.toMatch(/jellyfin|SECRET|:\/\//);
    expect(stopped).toEqual(['ps-probe-1']);
    mode.titles = 'none';
    expect(await probeHevcEncoder(env.ctx, user(), { now })).toMatchObject({ ok: false, reason: 'no_title' });
    expect((await hevcStatus(env.ctx)).state).toBe('unproven');
    await env.kv.del('hevcenc:probe');
    settings = null;
    await probeHevcEncoder(env.ctx, user(), { now });
    expect(await env.kv.get('hevcenc:probe')).toBeNull();
  });
  it('previews are paused during the probe and the pause is lifted afterwards', async () => {
    const pv = previews(env.ctx);
    let during = false;
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockImplementation(async () => { during = pv.paused; return { playSessionId: 'ps-probe-1', hlsUrl: '/x' } as never; });
    await probeHevcEncoder(env.ctx, user(), { now });
    expect([during, pv.paused]).toEqual([true, false]);
  });
});

describe('hevcTick', () => {
  beforeEach(() => {
    vi.spyOn(env.ctx.jf, 'items').mockResolvedValue({ items: [], total: 0 }); // the probe ends at once (no_title)
  });
  it('probes only while unproven; at most one attempt per 30 min; nothing while a live record exists or the feature is off', async () => {
    expect(await hevcTick(env.ctx)).toBe(true);
    expect(await hevcTick(env.ctx)).toBe(false); // 30 min gap
    await env.kv.del('hevcenc:attempt');
    await setLive(env.ctx, { userId: admin.id, userName: 'A', itemId: 'i', title: 't', positionTicks: 0, isPaused: false, playSessionId: 'ps-live', updatedAt: Date.now(), source: 'portal' });
    expect(await hevcTick(env.ctx)).toBe(false);
    for (const k of await env.kv.keys('play:')) await env.kv.del(k);
    env.ctx.cfg = { ...cfg, HEVC_STREAMS: 0 };
    expect(await hevcTick(env.ctx)).toBe(false);
    env.ctx.cfg = { ...cfg, HEVC_STREAMS: 2 };
    await putProbe();
    expect(await hevcTick(env.ctx)).toBe(false); // ready: nothing to prove
    await env.kv.del('hevcenc:probe');
    settings = { ...E, hevcEncode: false };
    expect(await hevcTick(env.ctx)).toBe(false); // the server has it off
  });
  it('waits for idle previews', async () => {
    const pv = previews(env.ctx);
    vi.spyOn(pv, 'idle', 'get').mockReturnValue(false);
    expect(await hevcTick(env.ctx)).toBe(false);
  });
});

describe('POST /api/admin/hevc-check', () => {
  let s: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => { s = await env.login(ADMIN); });
  const post = () => env.app.inject({ method: 'POST', url: '/api/admin/hevc-check', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });
  beforeEach(() => { vi.spyOn(env.ctx.jf, 'items').mockResolvedValue({ items: [], total: 0 }); });
  it('409 busy while a portal stream is live; otherwise probes and answers the state', async () => {
    await setLive(env.ctx, { userId: admin.id, userName: 'A', itemId: 'i', title: 't', positionTicks: 0, isPaused: false, playSessionId: 'ps-live', updatedAt: Date.now(), source: 'portal' });
    const busy = await post();
    expect([busy.statusCode, busy.json()]).toEqual([409, { error: 'busy' }]);
    for (const k of await env.kv.keys('play:')) await env.kv.del(k);
    const ok = await post();
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true, state: 'unproven' }]);
    expect(env.ctx.jf.items).toHaveBeenCalled();
  });
  it('a server with HEVC encoding off is not probed', async () => {
    settings = { ...E, hevcEncode: false };
    const r = await post();
    expect(r.json()).toEqual({ ok: true, state: 'server_off' });
    expect(env.ctx.jf.items).not.toHaveBeenCalled();
  });
  it('is for admins only', async () => {
    const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { role: 'friend', ttlHours: 1 } });
    env.claims.current = { sub: 'sub-fr', email: 'fr@example.com', name: 'Fr', groups: [] };
    const l = await env.app.inject(`/auth/login?invite=${inv.json().link.split('/').pop()}`);
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
    const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
    const f = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken as string };
    expect((await env.app.inject({ method: 'POST', url: '/api/admin/hevc-check', cookies: f.cookies, headers: { 'x-csrf-token': f.csrf } })).statusCode).toBe(403);
  });
});

describe('POST /api/playback/info: fellBack', () => {
  let s: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => { s = await env.login(ADMIN); });
  const failures = async () => JSON.parse((await env.kv.get('hevcenc:failures')) ?? '[]') as Array<{ device: string }>;
  const info = (body: Record<string, unknown>) => env.app.inject({ method: 'POST', url: '/api/playback/info', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { itemId: 'a'.repeat(32), ...body } });
  beforeEach(() => {
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockResolvedValue({ playSessionId: 'ps-new-0001', hlsUrl: '/media/x', mediaSourceId: 'ms', maxBitrate: 1_000_000 } as never);
    vi.spyOn(env.ctx.jf, 'playMeta').mockResolvedValue({ positionTicks: 0, trickplay: () => undefined } as never);
  });
  it('fellBack hevc with a prevPs whose pbinfo says video hevc records a failure; without that pbinfo nothing', async () => {
    await env.kv.set(`pbinfo:${admin.id}:ps-prev-hevc`, JSON.stringify({ reason: null, bitrate: 4_000_000, remote: true, video: 'hevc', audio: 'stereo' }), 600);
    await env.kv.set(`pbinfo:${admin.id}:ps-prev-h264`, JSON.stringify({ reason: null, bitrate: 4_000_000, remote: true, video: 'h264', audio: 'stereo' }), 600);
    expect((await info({ fellBack: 'surround', prevPs: 'ps-prev-hevc' })).statusCode).toBe(200);
    expect((await info({ fellBack: 'hevc', prevPs: 'ps-prev-h264' })).statusCode).toBe(200);
    expect((await info({ fellBack: 'hevc', prevPs: 'ps-unknown-1' })).statusCode).toBe(200);
    expect((await info({ fellBack: 'hevc' })).statusCode).toBe(200);
    expect(await failures()).toEqual([]);
    expect((await info({ fellBack: 'hevc', prevPs: 'ps-prev-hevc' })).statusCode).toBe(200);
    expect(await failures()).toHaveLength(1);
    expect((await info({ fellBack: 'both', prevPs: 'ps-prev-hevc' })).statusCode).toBe(200);
    expect(await failures()).toHaveLength(2);
  });
});
