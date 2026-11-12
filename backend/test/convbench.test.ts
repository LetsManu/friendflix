// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { BENCH_ATTEMPT_GAP_S, BENCH_LAST_TTL_S, BENCH_TTL_S, conversionsView, convBenchTick, runBenchmark } from '../src/convbench.js';
import { listErrors } from '../src/errorlog.js';
import { __resetConvMemo, admitConversion, markConvExempt, type BenchRecord } from '../src/convbudget.js';
import { busyFrom, claimHevcProbe, fingerprint, probeHevcEncoder } from '../src/hevcenc.js';
import { setLive } from '../src/live.js';
import type { EncoderSettings, MediaTraits } from '../src/media/types.js';
import { previews } from '../src/previews.js';
import type { UserRow } from '../src/types.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Live TV Phase 1, Task 4: the conversion benchmark, the recommendation, the automatic first measurement and the admin API (spec §5.3, §5.6, ruling 11).

const E: EncoderSettings = { hwAccel: 'qsv', tonemap: true, throttle: true, keyframeMkv: true, hevcEncode: true, hwEncode: true, lowPowerHevc: true, downmix: 'dave750' };
const FP = fingerprint(E);
const SDR_HD: MediaTraits = { resolution: 'hd', hdr: null, audio: null, sdr: true };
const bench = (o: Partial<BenchRecord> = {}): BenchRecord => ({ speed: 4.6, hwAccel: 'qsv', fingerprint: FP, at: Date.now() - 1000, ...o });

type RawSession = Record<string, unknown>;
const jfSession = (ps: string, o: { method: 'Transcode' | 'DirectStream' | 'DirectPlay'; videoDirect?: boolean; name?: string }): RawSession => ({
  Id: `s-${ps}`, UserId: 'jf-u1', DeviceId: `dev-${ps}`, Client: 'Other app', DeviceName: 'Wohnzimmer',
  NowPlayingItem: { Id: 'a'.repeat(32), Name: o.name ?? 'Dunmoor', Type: 'Movie' },
  PlayState: { PlayMethod: o.method, PlaySessionId: ps, IsPaused: false },
  ...(o.videoDirect !== undefined ? { TranscodingInfo: { IsVideoDirect: o.videoDirect, IsAudioDirect: false, VideoCodec: 'h264' } } : {}),
});
const converting = (ps: string, name = 'Dunmoor') => jfSession(ps, { method: 'Transcode', videoDirect: false, name });

let env: TestEnv;
let admin: UserRow;
let raw: RawSession[] = [];
let settings: EncoderSettings | null = E;
let origSessions: typeof env.ctx.jf.admin.transcodeSessions;
let origTraits: typeof env.ctx.jf.mediaTraits;

// the clip fake: a fMP4 playlist of 3-s segments, each segment advances the fake clock by segMs
let t = 0;
const now = () => t;
let stopped: string[] = [];
let paths: string[] = [];
let mode: { fail?: string; segMs?: number; during?: () => Promise<void> } = {};
const playlist = (n = 10) => ['#EXTM3U', '#EXT-X-MAP:URI="hls1/main/-1.mp4"', ...Array.from({ length: n }, (_, i) => `#EXTINF:3.0,\nhls1/main/${i}.mp4`)].join('\n');

beforeAll(async () => {
  env = await makeEnv({
    'GET /Sessions': () => ({ json: raw }),
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  });
  await env.login(ADMIN);
  admin = (await env.pool.query<UserRow>("select * from users where authentik_sub='sub-admin'")).rows[0]!;
  origSessions = env.ctx.jf.admin.transcodeSessions;
  origTraits = env.ctx.jf.mediaTraits;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  __resetConvMemo();
  raw = [];
  settings = E;
  env.ctx.jf.admin.encoderSettings = async () => { if (!settings) throw new Error('boom'); return settings; };
  for (const p of ['conv:', 'play:', 'hevcenc:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  t = 1_000_000; stopped = []; paths = []; mode = {};
  env.ctx.jf.mediaTraits = async () => SDR_HD;
  vi.spyOn(env.ctx.jf, 'items').mockResolvedValue({ items: [{ id: 'm'.repeat(32), name: 'Dunmoor', type: 'Movie' }] as never, total: 1 });
  vi.spyOn(env.ctx.jf, 'playbackInfo').mockResolvedValue({ playSessionId: 'ps-bench-1', hlsUrl: '/media/Videos/x/master.m3u8?PlaySessionId=ps-bench-1' } as never);
  vi.spyOn(env.ctx.jf, 'clipTranscode').mockResolvedValue({ path: '/Videos/x/master.m3u8?PlaySessionId=ps-bench-1', playSessionId: 'ps-bench-1' });
  vi.spyOn(env.ctx.jf, 'stopEncoding').mockImplementation(async (_u, ps) => { stopped.push(ps); });
  vi.spyOn(env.ctx.jf, 'mediaFetch').mockImplementation(async (_u, path) => {
    paths.push(path);
    if (mode.fail && path.includes(mode.fail)) return new Response('x', { status: 500 });
    if (path.includes('master.m3u8')) await mode.during?.();
    if (path.includes('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?x=1\n');
    if (path.includes('main.m3u8')) return new Response(playlist());
    if (path.includes('-1.mp4')) return new Response(new Uint8Array(Buffer.from('....ftypiso6avcC....')));
    t += mode.segMs ?? 4500 / 7; // 7 segments in 4.5 s
    return new Response(new Uint8Array(Buffer.alloc(2000, 1)));
  });
});
afterEach(() => {
  env.ctx.jf.admin.transcodeSessions = origSessions;
  env.ctx.jf.mediaTraits = origTraits;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const watch = (ps = 'ps-live', deviceId?: string) =>
  setLive(env.ctx, { userId: admin.id, userName: 'Anna Beispiel', itemId: 'a'.repeat(32), title: 'Dunmoor', positionTicks: 0, isPaused: false, playSessionId: ps, updatedAt: Date.now(), source: 'portal', ...(deviceId ? { deviceId } : {}) });
const segNames = () => paths.map((p) => p.split('?')[0]!.split('/').pop());
const benchErrors = async () => (await listErrors(env.ctx, { source: 'job' })).entries.filter((e) => e.code === 'conv-bench').reduce((a, e) => a + e.count, 0);
/** the media server is Plex while fn runs */
async function asPlex(fn: () => Promise<void>): Promise<void> {
  const kind = Object.getOwnPropertyDescriptor(env.ctx.jf, 'kind');
  Object.defineProperty(env.ctx.jf, 'kind', { value: 'plex', configurable: true, writable: true });
  try { await fn(); } finally {
    if (kind) Object.defineProperty(env.ctx.jf, 'kind', kind); else delete (env.ctx.jf as { kind?: string }).kind;
  }
}
/** no admin account to convert as (serviceUser finds none) */
function noServiceUser() {
  const q = env.pool.query.bind(env.pool) as (...a: unknown[]) => unknown; // the pool under ctx.db's timing proxy (spying on the proxy recurses)
  return vi.spyOn(env.pool, 'query').mockImplementation(((sql: unknown, ...rest: unknown[]) =>
    (typeof sql === 'string' && sql.includes("role = 'admin' and not disabled") ? Promise.resolve({ rows: [] }) : q(sql, ...rest))) as never);
}

describe('runBenchmark', () => {
  it('measures 21 s of 1080p H.264 and stores the speed', async () => {
    const set = vi.spyOn(env.kv, 'set');
    const r = await runBenchmark(env.ctx, 'admin', { now });
    expect(r).toEqual({ ok: true, jellyfin: { speed: 4.67, hwAccel: 'qsv', fingerprint: FP, at: t }, livetv: null });
    expect(JSON.parse((await env.kv.get('conv:bench'))!)).toEqual({ speed: 4.67, hwAccel: 'qsv', fingerprint: FP, at: t });
    expect(set.mock.calls.find(([k]) => k === 'conv:bench')?.[2]).toBe(BENCH_TTL_S);
    expect(BENCH_TTL_S).toBe(30 * 86_400);
    expect(env.ctx.jf.clipTranscode).toHaveBeenCalledWith(admin, expect.anything(), expect.objectContaining({ videoCodec: 'h264', videoBitrate: 6_000_000, maxWidth: 1920, maxHeight: 1080, segmentLength: 3 }));
    // master, variant, init, then segments 0..6 in order and no more
    expect(segNames()).toEqual(['master.m3u8', 'main.m3u8', '-1.mp4', '0.mp4', '1.mp4', '2.mp4', '3.mp4', '4.mp4', '5.mp4', '6.mp4']);
    expect(stopped).toEqual(['ps-bench-1']);
    expect(await env.kv.get('conv:exempt:ps-bench-1')).not.toBeNull();
    expect(await env.kv.get('hevcenc:running')).toBeNull(); // the claim is released
    expect(previews(env.ctx).paused).toBe(false);
    expect(await env.kv.get('conv:bench')).not.toMatch(/Videos|PlaySession|bench-1/);
  });
  it('previews are paused while it measures', async () => {
    const pv = previews(env.ctx);
    let during = false;
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockImplementation(async () => { during = pv.paused; return { playSessionId: 'ps-bench-1', hlsUrl: '/x' } as never; });
    await runBenchmark(env.ctx, 'admin', { now });
    expect([during, pv.paused]).toEqual([true, false]);
  });
  it('a failing clip stores nothing and always stops its conversion; no title is its own code', async () => {
    mode.fail = '3.mp4';
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'failed' });
    expect(stopped).toEqual(['ps-bench-1']);
    expect(await env.kv.get('conv:bench')).toBeNull();
    vi.spyOn(env.ctx.jf, 'items').mockResolvedValue({ items: [], total: 0 });
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'no_title' });
    expect(await env.kv.get('hevcenc:running')).toBeNull();
  });
  it('refused while anyone watches', async () => {
    await watch();
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'busy' });
    for (const k of await env.kv.keys('play:')) await env.kv.del(k);
    raw = [converting('ps-other')]; // another app converts
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'busy' });
    raw = [];
    expect(await admitConversion(env.ctx, { kind: 'film', userId: admin.id, deviceId: 'd1', hint: 'h1' })).toEqual({ ok: true }); // someone just pressed play
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'busy' });
    for (const k of await env.kv.keys('conv:grant:')) await env.kv.del(k);
    env.ctx.jf.admin.transcodeSessions = async () => { throw new Error('http://jellyfin:8096 down'); };
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'busy' }); // unknown is busy too
    expect(await env.kv.get('conv:bench')).toBeNull();
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
    expect(env.ctx.jf.stopEncoding).not.toHaveBeenCalled(); // a running conversion is never stopped
    expect(await env.kv.get('hevcenc:running')).toBeNull();
    expect(previews(env.ctx).paused).toBe(false);
  });
  it('one heavy measurement at a time', async () => {
    const held = await claimHevcProbe(env.ctx);
    expect(held).toBeTruthy();
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'running' });
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
    await env.kv.del('hevcenc:running');
    // the HEVC probe finds the claim taken while a benchmark measures
    let inner: unknown = 'unset';
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockImplementation(async () => {
      inner = await probeHevcEncoder(env.ctx, admin, { now });
      return { playSessionId: 'ps-bench-1', hlsUrl: '/x' } as never;
    });
    expect((await runBenchmark(env.ctx, 'admin', { now })).ok).toBe(true);
    expect(inner).toBeNull();
    expect(env.ctx.jf.clipTranscode).toHaveBeenCalledTimes(1);
    // two at once: one measures, the other is refused
    const both = await Promise.all([runBenchmark(env.ctx, 'admin', { now }), runBenchmark(env.ctx, 'auto', { now })]);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, why: 'running' }]);
  });
  it('returns the stored livetv record with it', async () => {
    await env.kv.set('conv:bench:livetv', JSON.stringify(bench({ speed: 4.4, hwAccel: 'vaapi' })), 3600);
    const r = await runBenchmark(env.ctx, 'enable', { now });
    expect(r).toMatchObject({ ok: true, livetv: { speed: 4.4, hwAccel: 'vaapi' } });
  });
});

describe('runBenchmark: outcomes for the card', () => {
  it('every outcome but running is kept for 24 h; a failed run is a job error whatever the trigger', async () => {
    const set = vi.spyOn(env.kv, 'set');
    expect((await runBenchmark(env.ctx, 'admin', { now })).ok).toBe(true);
    expect((await conversionsView(env.ctx)).measure.last).toEqual({ outcome: 'ok', at: new Date(t).toISOString() });
    expect(set.mock.calls.find(([k]) => k === 'conv:bench:last')?.[2]).toBe(BENCH_LAST_TTL_S);
    expect(BENCH_LAST_TTL_S).toBe(86_400);
    const before = await benchErrors();
    mode.fail = '2.mp4';
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'failed' });
    expect((await conversionsView(env.ctx)).measure.last).toMatchObject({ outcome: 'failed' });
    expect(await benchErrors()).toBe(before + 1);
    mode.fail = undefined;
    vi.spyOn(env.ctx.jf, 'items').mockResolvedValue({ items: [], total: 0 });
    expect(await runBenchmark(env.ctx, 'enable', { now })).toEqual({ ok: false, why: 'no_title' });
    expect((await conversionsView(env.ctx)).measure.last).toMatchObject({ outcome: 'no_title' });
    expect(await benchErrors()).toBe(before + 1); // no title is not an error
    await watch();
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'busy' });
    expect((await conversionsView(env.ctx)).measure.last).toMatchObject({ outcome: 'busy' });
    for (const k of await env.kv.keys('play:')) await env.kv.del(k);
    await claimHevcProbe(env.ctx);
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'running' });
    expect((await conversionsView(env.ctx)).measure.last).toMatchObject({ outcome: 'busy' }); // a run that did not start leaves the last one
  });
  it('without an admin account to convert as: no_user, nothing converted', async () => {
    noServiceUser();
    expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'no_user' });
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
    expect((await conversionsView(env.ctx)).measure.last).toMatchObject({ outcome: 'no_user' });
    expect(await env.kv.get('hevcenc:running')).toBeNull();
  });
  it('the benchmark\'s own clip is not someone watching', async () => {
    let view: Awaited<ReturnType<typeof conversionsView>> | undefined;
    vi.spyOn(env.ctx.jf, 'clipTranscode').mockImplementation(async () => {
      raw = [converting('ps-bench-1')]; // the media server lists the clip as a conversion
      return { path: '/Videos/x/master.m3u8?PlaySessionId=ps-bench-1', playSessionId: 'ps-bench-1' };
    });
    mode.during = async () => { view = await conversionsView(env.ctx); };
    expect((await runBenchmark(env.ctx, 'admin', { now })).ok).toBe(true);
    expect(view!.measure).toMatchObject({ running: true, busy: null });
    expect(view!.used).toBe(0); // exempt from the budget too
    raw = [converting('ps-other')];
    expect((await conversionsView(env.ctx)).measure.busy).toBe('watching'); // another app's conversion still is
  });
  it('Plex is not measured: unsupported, and the budget stays at its default or the admin value', async () => {
    await asPlex(async () => {
      expect(await runBenchmark(env.ctx, 'admin', { now })).toEqual({ ok: false, why: 'unsupported' });
      expect(await convBenchTick(env.ctx)).toBe(false);
      expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
      expect(await env.kv.get('conv:bench:attempt')).toBeNull();
      expect(await env.kv.get('hevcenc:running')).toBeNull();
      const v = await conversionsView(env.ctx);
      expect(v.measure.last).toEqual({ outcome: 'unsupported', at: null });
      expect(v).toMatchObject({ limit: 2, auto: 2, custom: null });
      env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 4 };
      expect(await conversionsView(env.ctx)).toMatchObject({ limit: 4, custom: 4 });
    });
  });
});

describe('conversionsView', () => {
  it('the admin view', async () => {
    await env.kv.set('conv:bench', JSON.stringify(bench()), 3600);
    const v = await conversionsView(env.ctx);
    expect(v).toMatchObject({ limit: 3, auto: 3, custom: null, priority: 'films', used: 0, running: [] });
    expect(v.bench).toEqual({ jellyfin: { speed: 4.6, hwAccel: 'qsv', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }, livetv: null, recommended: 3, stale: false, noRealtime: false });
    expect(v.measure).toEqual({ running: false, busy: null, last: null });

    await env.kv.set('conv:bench', JSON.stringify(bench({ speed: 0.8 })), 3600);
    expect((await conversionsView(env.ctx)).bench).toMatchObject({ recommended: 1, noRealtime: true });
    await env.kv.set('conv:bench', JSON.stringify(bench()), 3600);
    await env.kv.set('conv:bench:livetv', JSON.stringify(bench({ speed: 0.9, hwAccel: 'software' })), 3600);
    expect((await conversionsView(env.ctx)).bench).toMatchObject({ livetv: { speed: 0.9, encoder: 'software' }, recommended: 1, noRealtime: true });
    await env.kv.del('conv:bench:livetv');

    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 5, CONVERSION_PRIORITY: 'equal' };
    expect(await conversionsView(env.ctx)).toMatchObject({ limit: 5, auto: 3, custom: 5, priority: 'equal' });
  });
  it('lists what converts: one film session', async () => {
    raw = [converting('ps-a', 'Dunmoor')];
    const v = await conversionsView(env.ctx);
    expect(v.used).toBe(1);
    expect(v.running).toEqual([{ kind: 'film', hevc: false, label: 'Dunmoor', since: null, device: 'Wohnzimmer' }]); // another app: the server's device name
    expect(v.measure.busy).toBe('watching');
    // a FriendFlix stream: the device's FriendFlix label
    await env.pool.query("insert into devices(user_id, device_id, label, name, approved) values ($1, 'd-tv', 'Chrome on Linux', 'Wohnzimmer-TV', true) on conflict (user_id, device_id) do update set name = excluded.name", [admin.id]);
    await watch('ps-a', 'd-tv');
    expect((await conversionsView(env.ctx)).running[0]).toMatchObject({ kind: 'film', label: 'Dunmoor', device: 'Wohnzimmer-TV' });
  });
  it('an unreadable session list is unknown, never a guess', async () => {
    env.ctx.jf.admin.transcodeSessions = async () => { throw new Error('x'); };
    const v = await conversionsView(env.ctx);
    expect(v.measure.busy).toBe('unknown');
    expect(v.running).toEqual([]);
  });
});

describe('convBenchTick', () => {
  it('the tick measures once when idle', async () => {
    const setnx = vi.spyOn(env.kv, 'setnx');
    expect(await convBenchTick(env.ctx)).toBe(true);
    expect(await env.kv.get('conv:bench')).not.toBeNull();
    expect(setnx.mock.calls.find(([k]) => k === 'conv:bench:attempt')?.[2]).toBe(BENCH_ATTEMPT_GAP_S);
    expect(BENCH_ATTEMPT_GAP_S).toBe(1800);
    expect(await convBenchTick(env.ctx)).toBe(false);
    await env.kv.del('conv:bench:attempt');
    expect(await convBenchTick(env.ctx)).toBe(false); // measured: nothing to do
    expect(env.ctx.jf.clipTranscode).toHaveBeenCalledTimes(1);

    // a failed run is retried only after 30 min
    await env.kv.del('conv:bench');
    await env.kv.del('conv:bench:attempt');
    mode.fail = '0.mp4';
    expect(await convBenchTick(env.ctx)).toBe(true);
    expect(await env.kv.get('conv:bench')).toBeNull();
    expect((await listErrors(env.ctx, { source: 'job' })).entries.map((e) => e.code)).toContain('conv-bench'); // an automatic failure is noted
    expect(await convBenchTick(env.ctx)).toBe(false);
    mode.fail = undefined;
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + (BENCH_ATTEMPT_GAP_S + 1) * 1000);
    expect(await convBenchTick(env.ctx)).toBe(true);
    expect(await env.kv.get('conv:bench')).not.toBeNull();
  });
  it('does nothing while someone watches, previews work or a probe runs', async () => {
    await watch();
    expect(await convBenchTick(env.ctx)).toBe(false);
    for (const k of await env.kv.keys('play:')) await env.kv.del(k);
    const idle = vi.spyOn(previews(env.ctx), 'idle', 'get').mockReturnValue(false);
    expect(await convBenchTick(env.ctx)).toBe(false);
    idle.mockRestore();
    await claimHevcProbe(env.ctx);
    expect(await convBenchTick(env.ctx)).toBe(false);
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
    await env.kv.del('hevcenc:running');
    expect(await convBenchTick(env.ctx)).toBe(true); // none of those used up the attempt
  });
  it('skips quietly without an admin account to convert as, until one exists', async () => {
    const before = await benchErrors();
    const spy = noServiceUser();
    expect(await convBenchTick(env.ctx)).toBe(false);
    expect(await convBenchTick(env.ctx)).toBe(false);
    expect(await env.kv.get('conv:bench:attempt')).toBeNull(); // no attempt used up
    expect(await benchErrors()).toBe(before);
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(await convBenchTick(env.ctx)).toBe(true);
  });
  it('stale fingerprint', async () => {
    await env.kv.set('conv:bench', JSON.stringify(bench()), 3600);
    expect(await convBenchTick(env.ctx)).toBe(false); // current
    settings = { ...E, hwAccel: 'vaapi' };
    __resetConvMemo();
    const v = await conversionsView(env.ctx);
    expect(v.bench).toMatchObject({ stale: true, recommended: null, jellyfin: { speed: 4.6, hwAccel: 'qsv' } });
    expect(v).toMatchObject({ auto: 2, limit: 2 });
    expect(await convBenchTick(env.ctx)).toBe(true);
    expect(JSON.parse((await env.kv.get('conv:bench'))!)).toMatchObject({ hwAccel: 'vaapi', fingerprint: fingerprint(settings) });
    __resetConvMemo();
    expect((await conversionsView(env.ctx)).bench.stale).toBe(false);
  });
});

describe('admin API', () => {
  let s: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => { s = await env.login(ADMIN); });
  const post = (c = s) => env.app.inject({ method: 'POST', url: '/api/admin/conversions/benchmark', cookies: c.cookies, headers: { 'x-csrf-token': c.csrf } });
  const get = (c = s) => env.app.inject({ method: 'GET', url: '/api/admin/conversions', cookies: c.cookies });

  it('POST benchmark', async () => {
    let release: (() => void) | undefined;
    vi.spyOn(env.ctx.jf, 'items').mockImplementation(() => new Promise((res) => { release = () => res({ items: [{ id: 'm'.repeat(32), name: 'Dunmoor', type: 'Movie' }] as never, total: 1 }); }));
    const ok = await post();
    expect([ok.statusCode, ok.json()]).toEqual([202, { started: true }]);
    const during = await get();
    expect(during.headers['cache-control']).toBe('no-store');
    expect(during.json().measure.running).toBe(true);
    const again = await post();
    expect([again.statusCode, again.json()]).toEqual([409, { error: 'running' }]);
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await vi.waitFor(async () => expect((await get()).json().measure.running).toBe(false));
    expect((await get()).json().bench.jellyfin).toMatchObject({ hwAccel: 'qsv' });
    const audit = await env.pool.query<{ action: string; meta: unknown }>("select action, meta from audit_log where action = 'conversions.benchmark'");
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0]!.meta)).not.toMatch(/Videos|PlaySession|ps-/);
  });
  it('409 busy while someone watches', async () => {
    await watch();
    const r = await post();
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'busy', reason: 'watching' }]);
    expect(await env.kv.get('hevcenc:running')).toBeNull(); // the claim taken for the check is released
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
  });
  const settle = () => vi.waitFor(async () => expect((await get()).json().measure.running).toBe(false));
  it('a preview clip that is being built does not refuse it (the run waits for previews)', async () => {
    raw = [converting('ps-prev-9')];
    await markConvExempt(env.ctx, 'ps-prev-9');
    const r = await post();
    expect([r.statusCode, r.json()]).toEqual([202, { started: true }]);
    await settle();
    expect((await get()).json().measure.last).toMatchObject({ outcome: 'ok' });
  });
  it('409 no_user without an admin account to convert as; 409 unsupported on Plex', async () => {
    const spy = noServiceUser();
    const r = await post();
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'no_user' }]);
    expect(await env.kv.get('hevcenc:running')).toBeNull();
    spy.mockRestore();
    await asPlex(async () => {
      const p = await post();
      expect([p.statusCode, p.json()]).toEqual([409, { error: 'unsupported' }]);
      expect((await get()).json().measure.last).toEqual({ outcome: 'unsupported', at: null });
    });
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
  });
  it('is for admins only', async () => {
    const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { role: 'friend', ttlHours: 1 } });
    env.claims.current = { sub: 'sub-fr', email: 'fr@example.com', name: 'Fr', groups: [] };
    const l = await env.app.inject(`/auth/login?invite=${inv.json().link.split('/').pop()}`);
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
    const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
    const f = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken as string };
    env.claims.current = ADMIN;
    expect((await post(f)).statusCode).toBe(403);
    expect((await get(f)).statusCode).toBe(403);
    expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
  });
});

describe('admin API: rate limit', () => {
  // the limiter's key is portal-wide and its store lives in the app: the tests above already spent part of env.app's budget, so this
  // one builds a fresh app on the same ctx (same database, KV and sessions) and sees the whole "6 allowed, then 429" path
  it('at most 6 per 10 minutes for the whole portal', async () => {
    const s = await env.login(ADMIN);
    const app = await buildApp(env.ctx);
    try {
      const post = () => app.inject({ method: 'POST', url: '/api/admin/conversions/benchmark', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });
      await watch(); // each allowed answer is a quick 409 busy
      for (let i = 0; i < 6; i++) {
        const r = await post();
        expect([r.statusCode, r.headers['x-ratelimit-limit'], r.headers['x-ratelimit-remaining']]).toEqual([409, '6', String(5 - i)]);
      }
      expect((await post()).statusCode).toBe(429);
      expect(env.ctx.jf.clipTranscode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('busyFrom', () => {
  it('the one rule behind hevcBusyReason and the benchmark', () => {
    const tr = { playMethod: 'Transcode', playSessionId: 'ps-x' } as never;
    const dp = { playMethod: 'DirectPlay', playSessionId: 'ps-y' } as never;
    expect(busyFrom(null, [])).toBe('watching'); // unreadable live list
    expect(busyFrom([{}], [])).toBe('watching');
    expect(busyFrom([], null)).toBe('unknown');
    expect(busyFrom([], [])).toBeNull();
    expect(busyFrom([], [dp])).toBeNull();
    expect(busyFrom([], [tr])).toBe('watching');
    expect(busyFrom([], [tr], new Set(['ps-x']))).toBeNull(); // an exempt clip of FriendFlix's own
  });
});

describe('module graph', () => {
  it('cliptime.ts stays a leaf', () => {
    const src = readFileSync(new URL('../src/cliptime.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '\.\/(convbudget|hevcenc|convbench)\.js'/);
    expect(readFileSync(new URL('../src/convbench.ts', import.meta.url), 'utf8')).not.toMatch(/stopEncoding/); // only cliptime stops its own clip
  });
});
