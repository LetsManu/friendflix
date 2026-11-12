// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONV_DEFAULT_SLOTS, CONV_EXEMPT_TTL_S, CONV_GRANT_TTL_S, __resetConvMemo, admitConversion, admits, bindConvGrant, conversionLimit, countConversions, dropConvGrant, holdback,
  markConvExempt, readBench, recommend, type BenchRecord, type ConvKind, type ConvPriority,
} from '../src/convbudget.js';
import { clearDownloadConv, markDownloadConv } from '../src/convexempt.js';
import { fingerprint, probeHevcEncoder } from '../src/hevcenc.js';
import { setLive } from '../src/live.js';
import type { EncoderSettings, MediaTraits } from '../src/media/types.js';
import { previews } from '../src/previews.js';
import type { UserRow } from '../src/types.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Live TV Phase 1, Task 1: one budget for every video conversion (spec §5.1, §5.2, ruling 10).

describe('admits follows the priority table', () => {
  const rows: Array<[number, number, ConvKind, ConvPriority, boolean]> = [
    [3, 2, 'film', 'films', true],
    [3, 2, 'live', 'films', false],
    [3, 1, 'live', 'films', true],
    [3, 2, 'live', 'live', true],
    [3, 2, 'film', 'live', false],
    [3, 2, 'live', 'equal', true],
    [3, 2, 'record', 'films', true],
    [3, 3, 'record', 'films', false],
    [3, 1, 'download', 'films', false],
    [3, 0, 'download', 'films', true],
    [1, 0, 'live', 'films', true],
    [1, 0, 'download', 'films', true],
    [1, 1, 'download', 'films', false],
    [2, 1, 'download', 'equal', false],
  ];
  it.each(rows)('L=%i U=%i %s (%s) -> %s', (l, u, kind, prio, want) => {
    expect(admits(kind, u, l, prio)).toBe(want);
  });
  it('reencode waits like a download', () => {
    expect(admits('reencode', 0, 1, 'films')).toBe(true);
    expect(admits('reencode', 1, 3, 'films')).toBe(false);
  });
});

describe('holdback and recommend', () => {
  it('holds one slot back from 2 slots on, never when equal', () => {
    expect(holdback(1, 'films')).toBe(0);
    expect(holdback(2, 'films')).toBe(1);
    expect(holdback(2, 'live')).toBe(1);
    expect(holdback(4, 'equal')).toBe(0);
  });
  it('floor(min x 0.7) within 1..16 (spec §5.3, §5.6)', () => {
    expect(recommend({ jellyfin: 4.6 })).toBe(3);
    expect(recommend({ jellyfin: 0.8 })).toBe(1);
    expect(recommend({ jellyfin: 4.6, livetv: 3.9 })).toBe(2);
    expect(recommend({ jellyfin: 4.6, livetv: 4.4 })).toBe(3);
    expect(recommend({ jellyfin: 30 })).toBe(16);
    expect(recommend({ jellyfin: 10 })).toBe(7);
    expect(recommend({ jellyfin: 20 })).toBe(14);
  });
  it('constants', () => {
    expect([CONV_DEFAULT_SLOTS, CONV_GRANT_TTL_S, CONV_EXEMPT_TTL_S]).toEqual([2, 30, 900]);
  });
});

const E: EncoderSettings = { hwAccel: 'qsv', tonemap: true, throttle: true, keyframeMkv: true, hevcEncode: true, hwEncode: true, lowPowerHevc: true, downmix: 'dave750' };
const bench = (o: Partial<BenchRecord> = {}): BenchRecord => ({ speed: 4.6, hwAccel: 'qsv', fingerprint: fingerprint(E), at: Date.now() - 1000, ...o });

type RawSession = Record<string, unknown>;
/** a session as Jellyfin's /Sessions lists it; videoDirect undefined = no TranscodingInfo */
const jfSession = (ps: string, o: { method: 'Transcode' | 'DirectStream' | 'DirectPlay'; videoDirect?: boolean; name?: string; series?: string; codec?: string }): RawSession => ({
  Id: `s-${ps}`, UserId: 'jf-u1', DeviceId: `dev-${ps}`, Client: 'Other app', DeviceName: 'Wohnzimmer',
  NowPlayingItem: { Id: 'a'.repeat(32), Name: o.name ?? 'Dunmoor', ...(o.series ? { SeriesName: o.series, Type: 'Episode' } : { Type: 'Movie' }) },
  PlayState: { PlayMethod: o.method, PlaySessionId: ps, IsPaused: false },
  ...(o.videoDirect !== undefined ? { TranscodingInfo: { IsVideoDirect: o.videoDirect, IsAudioDirect: false, VideoCodec: o.codec ?? 'h264' } } : {}),
});
const converting = (ps: string, name = 'Dunmoor') => jfSession(ps, { method: 'Transcode', videoDirect: false, name });

let env: TestEnv;
let admin: UserRow;
let raw: RawSession[] = [];
let origSessions: typeof env.ctx.jf.admin.transcodeSessions;
const ANNA = randomUUID();
const BEN = randomUUID();

beforeAll(async () => {
  env = await makeEnv({
    'GET /Sessions': () => ({ json: raw }),
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  });
  await env.login(ADMIN);
  admin = (await env.pool.query<UserRow>("select * from users where authentik_sub='sub-admin'")).rows[0]!;
  env.ctx.jf.admin.encoderSettings = async () => E;
  origSessions = env.ctx.jf.admin.transcodeSessions;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  __resetConvMemo();
  raw = [];
  for (const p of ['conv:', 'play:', 'hevcenc:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
  await env.pool.query('delete from download_jobs');
});
afterEach(() => {
  env.ctx.jf.admin.transcodeSessions = origSessions;
  env.ctx.jf.admin.encoderSettings = async () => E;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const live = (userId: string, ps: string, deviceId: string) =>
  setLive(env.ctx, { userId, userName: 'Anna Beispiel', itemId: 'a'.repeat(32), title: 'Dunmoor', positionTicks: 0, isPaused: false, playSessionId: ps, updatedAt: Date.now(), source: 'portal', deviceId });
const ask = (o: { userId?: string; deviceId?: string; hint?: string; kind?: ConvKind; swap?: boolean } = {}) =>
  admitConversion(env.ctx, { kind: o.kind ?? 'film', userId: o.userId ?? ANNA, ...(o.deviceId ? { deviceId: o.deviceId } : {}), hint: o.hint ?? randomUUID(), ...(o.swap ? { swap: true } : {}) });

describe('readBench and conversionLimit', () => {
  it('nothing measured: automatic 2', async () => {
    expect(await readBench(env.ctx)).toEqual({ jellyfin: null, livetv: null, stale: false });
    expect(await conversionLimit(env.ctx)).toEqual({ limit: 2, auto: 2, custom: null, recommended: null, priority: 'films' });
  });
  it('a bench of 4.6x recommends 3; an admin value wins; a livetv bench lowers the recommendation', async () => {
    await env.kv.set('conv:bench', JSON.stringify(bench()), 3600);
    expect(await conversionLimit(env.ctx)).toEqual({ limit: 3, auto: 3, custom: null, recommended: 3, priority: 'films' });
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 5, CONVERSION_PRIORITY: 'live' };
    expect(await conversionLimit(env.ctx)).toEqual({ limit: 5, auto: 3, custom: 5, recommended: 3, priority: 'live' });
    env.ctx.cfg = { ...cfg };
    await env.kv.set('conv:bench:livetv', JSON.stringify(bench({ speed: 3.9, hwAccel: 'vaapi' })), 3600);
    expect((await readBench(env.ctx)).livetv).toMatchObject({ speed: 3.9, hwAccel: 'vaapi' });
    expect(await conversionLimit(env.ctx)).toMatchObject({ limit: 2, auto: 2, recommended: 2 });
  });
  it('a bench taken with other encoder settings is stale: automatic falls back to 2', async () => {
    await env.kv.set('conv:bench', JSON.stringify(bench({ fingerprint: 'vaapi|0|1|0' })), 3600);
    expect((await readBench(env.ctx)).stale).toBe(true);
    expect(await conversionLimit(env.ctx)).toMatchObject({ limit: 2, auto: 2, custom: null });
  });
  it('a broken record counts as not measured', async () => {
    await env.kv.set('conv:bench', '{"speed":"fast"}', 3600);
    expect(await readBench(env.ctx)).toEqual({ jellyfin: null, livetv: null, stale: false });
  });
});

describe('countConversions', () => {
  it('counts server conversions', async () => {
    raw = [
      converting('ps-a', 'Dunmoor'),
      jfSession('ps-b', { method: 'DirectStream', videoDirect: true }),
      jfSession('ps-c', { method: 'Transcode', name: 'Episode 1', series: 'Saltwater Almanac' }), // videoDirect not reported: counted (fail-safe)
      jfSession('ps-d', { method: 'DirectPlay' }),
    ];
    const got = await countConversions(env.ctx);
    expect(got).toHaveLength(2);
    expect(got!.map((e) => [e.kind, e.label, e.key])).toEqual([['film', 'Dunmoor', 'ps-a'], ['film', 'Saltwater Almanac', 'ps-c']]);
    expect(got!.every((e) => e.pending === undefined)).toBe(true);
  });
  it('a HEVC conversion is a film entry with the hevc flag; a portal stream carries its user and device', async () => {
    raw = [jfSession('ps-h', { method: 'Transcode', videoDirect: false, codec: 'hevc' })];
    await live(ANNA, 'ps-h', 'd1');
    expect(await countConversions(env.ctx)).toEqual([{ kind: 'film', key: 'ps-h', hevc: true, label: 'Dunmoor', since: null, device: 'd1', userId: ANNA }]);
  });
  it('exempt and download sessions', async () => {
    raw = [converting('ps-probe'), converting('ps-dl')];
    await markConvExempt(env.ctx, 'ps-probe');
    expect(await env.kv.get('conv:exempt:ps-probe')).not.toBeNull();
    await env.pool.query("insert into download_jobs(id, item_id, quality, status, play_session_id) values (gen_random_uuid(), $1, 'hd', 'preparing', 'ps-dl')", ['a'.repeat(32)]);
    const got = await countConversions(env.ctx);
    expect(got!.map((e) => [e.kind, e.key])).toEqual([['download', 'ps-dl']]);
    // a finished job's session is a film again (the play session id outlives the preparation)
    await env.pool.query("update download_jobs set status = 'ready'");
    expect((await countConversions(env.ctx))!.map((e) => e.kind)).toEqual(['film']);
  });
  it('a running download counts from its mark, once per play session, listed or not', async () => {
    const jobId = randomUUID();
    await env.pool.query("insert into download_jobs(id, item_id, quality, status, play_session_id) values ($1, $2, 'hd', 'preparing', 'ps-dl2')", [jobId, 'a'.repeat(32)]);
    await markDownloadConv(env.ctx, jobId, { ps: 'ps-dl2', label: 'Dunmoor', user: ANNA });
    expect(await countConversions(env.ctx)).toEqual([{ kind: 'download', key: 'ps-dl2', label: 'Dunmoor', since: null, device: null, userId: ANNA }]);
    // its grant and the server's own entry for the same play session do not add up
    await admitConversion(env.ctx, { kind: 'download', userId: ANNA, hint: `dl:${jobId}` });
    await bindConvGrant(env.ctx, `dl:${jobId}`, 'ps-dl2');
    expect((await countConversions(env.ctx))!.map((e) => [e.kind, e.key])).toEqual([['download', 'ps-dl2']]);
    raw = [converting('ps-dl2')];
    expect((await countConversions(env.ctx))!.map((e) => [e.kind, e.key])).toEqual([['download', 'ps-dl2']]);
    // paused (mark gone, session stopped, grant dropped): nothing
    raw = [];
    await clearDownloadConv(env.ctx, jobId);
    await dropConvGrant(env.ctx, 'ps-dl2');
    expect(await countConversions(env.ctx)).toEqual([]);
    // a mark of a job that is no longer preparing does not count
    await markDownloadConv(env.ctx, jobId, { ps: 'ps-dl2' });
    await env.pool.query("update download_jobs set status = 'ready'");
    expect(await countConversions(env.ctx)).toEqual([]);
  });
  it('pending grants count once', async () => {
    expect(await ask({ deviceId: 'd1', hint: 'h1' })).toEqual({ ok: true });
    const first = await countConversions(env.ctx);
    expect(first).toHaveLength(1);
    expect(first![0]).toMatchObject({ kind: 'film', pending: true, userId: ANNA, device: 'd1' });
    await bindConvGrant(env.ctx, 'h1', 'ps1');
    expect(await env.kv.get('conv:grant:h1')).toBeNull();
    expect(await countConversions(env.ctx)).toHaveLength(1); // bound, not listed yet: still pending
    raw = [converting('ps1')];
    const now = await countConversions(env.ctx);
    expect(now).toHaveLength(1); // the server lists it: counted by its own entry, not twice
    expect(now![0]!.pending).toBeUndefined();
    raw = [jfSession('ps1', { method: 'DirectStream', videoDirect: true })];
    expect(await countConversions(env.ctx)).toEqual([]); // it turned out to copy: free again
  });
  it('a dropped grant no longer counts; binding nothing is harmless', async () => {
    expect(await ask({ deviceId: 'd1', hint: 'h2' })).toEqual({ ok: true });
    await dropConvGrant(env.ctx, 'h2');
    expect(await env.kv.keys('conv:grant:')).toEqual([]);
    await bindConvGrant(env.ctx, 'nobody', 'ps9');
    expect(await env.kv.keys('conv:grant:')).toEqual([]);
  });
  it('binding writes the new key before it drops the hint; a hint that already is the play session stays', async () => {
    expect(await ask({ deviceId: 'd1', hint: 'h5' })).toEqual({ ok: true });
    const set = vi.spyOn(env.kv, 'set');
    const del = vi.spyOn(env.kv, 'del');
    await bindConvGrant(env.ctx, 'h5', 'ps5');
    const wrote = set.mock.calls.findIndex(([k]) => k === 'conv:grant:ps5');
    const dropped = del.mock.calls.findIndex(([k]) => k === 'conv:grant:h5');
    expect(set.mock.invocationCallOrder[wrote]!).toBeLessThan(del.mock.invocationCallOrder[dropped]!);
    expect(await env.kv.keys('conv:grant:')).toEqual(['conv:grant:ps5']);
    await bindConvGrant(env.ctx, 'ps5', 'ps5');
    expect(JSON.parse((await env.kv.get('conv:grant:ps5'))!)).toMatchObject({ kind: 'film', ps: 'ps5' });
  });
  it('without a session list the grants still count; a slow or failing list is unknown (null)', async () => {
    env.ctx.jf.admin.transcodeSessions = undefined;
    expect(await countConversions(env.ctx)).toEqual([]);
    expect(await ask({ deviceId: 'd1', hint: 'h3' })).toEqual({ ok: true });
    expect(await countConversions(env.ctx)).toHaveLength(1);
    env.ctx.jf.admin.transcodeSessions = async () => { throw new Error('http://jellyfin:8096 down'); };
    expect(await countConversions(env.ctx)).toBeNull();
    vi.useFakeTimers();
    env.ctx.jf.admin.transcodeSessions = () => new Promise(() => undefined);
    const p = countConversions(env.ctx);
    await vi.advanceTimersByTimeAsync(805);
    expect(await p).toBeNull();
  });
  it('two devices of one profile share one server session: the unlisted one counts from its pbinfo record', async () => {
    // the server lists one session per profile, so only the newer play session shows; the portal's own record says both convert
    raw = [converting('ps-b')];
    await live(ANNA, 'ps-a', 'd1');
    await live(ANNA, 'ps-b', 'd2');
    const rec = (o: Record<string, unknown>) => JSON.stringify({ reason: 'network', bitrate: 4_000_000, remote: false, video: 'h264', audio: 'stereo', ...o });
    await env.kv.set(`pbinfo:${ANNA}:ps-a`, rec({ conv: true }), 600);
    await env.kv.set(`pbinfo:${ANNA}:ps-b`, rec({ conv: true }), 600);
    const got = await countConversions(env.ctx);
    expect(got!.map((e) => [e.key, e.kind, e.device, e.userId]).sort()).toEqual([['ps-a', 'film', 'd1', ANNA], ['ps-b', 'film', 'd2', ANNA]]);
    expect(got!.find((e) => e.key === 'ps-a')).toMatchObject({ label: 'Dunmoor' });
    // the same device is still replaced by its own new stream
    expect((await countConversions(env.ctx, { exceptUser: ANNA, exceptDevice: 'd1' }))!.map((e) => e.key)).toEqual(['ps-b']);
    // pbinfo.video also describes direct-play answers: without `conv` the record is not a conversion
    await env.kv.set(`pbinfo:${ANNA}:ps-a`, rec({ reason: null }), 600);
    expect((await countConversions(env.ctx))!.map((e) => e.key)).toEqual(['ps-b']);
    // a HEVC conversion keeps its flag; a play session the server lists as direct is decided by the server
    await env.kv.set(`pbinfo:${ANNA}:ps-a`, rec({ video: 'hevc', conv: true }), 600);
    expect((await countConversions(env.ctx))!.find((e) => e.key === 'ps-a')).toMatchObject({ hevc: true });
    raw = [converting('ps-b'), jfSession('ps-a', { method: 'DirectStream', videoDirect: true })];
    expect((await countConversions(env.ctx))!.map((e) => e.key)).toEqual(['ps-b']);
  });
  it('a grant whose new key cannot be written keeps its hint key (never lost)', async () => {
    expect(await ask({ deviceId: 'd1', hint: 'h6' })).toEqual({ ok: true });
    const real = env.kv.set.bind(env.kv);
    vi.spyOn(env.kv, 'set').mockImplementation((k: string, v: string, ttl?: number) => (k === 'conv:grant:ps6' ? Promise.reject(new Error('down')) : real(k, v, ttl)));
    await bindConvGrant(env.ctx, 'h6', 'ps6');
    expect(await env.kv.keys('conv:grant:')).toEqual(['conv:grant:h6']);
    expect(await countConversions(env.ctx)).toHaveLength(1);
    vi.restoreAllMocks();
    await bindConvGrant(env.ctx, 'h6', 'ps6', { hevc: true, label: 'Saltwater Almanac' });
    expect(await env.kv.keys('conv:grant:')).toEqual(['conv:grant:ps6']);
    expect(JSON.parse((await env.kv.get('conv:grant:ps6'))!)).toMatchObject({ kind: 'film', ps: 'ps6', hevc: true, label: 'Saltwater Almanac' });
    await bindConvGrant(env.ctx, 'ps6', 'ps6', { hevc: false });
    expect(JSON.parse((await env.kv.get('conv:grant:ps6'))!)).not.toHaveProperty('hevc');
  });
  it('the requester\'s own live stream and own earlier grant are left out', async () => {
    raw = [converting('ps1')];
    await live(ANNA, 'ps1', 'd1');
    expect(await ask({ deviceId: 'd1', hint: 'h4' })).toEqual({ ok: true });
    expect(await countConversions(env.ctx)).toHaveLength(2);
    expect(await countConversions(env.ctx, { exceptUser: ANNA, exceptDevice: 'd1' })).toEqual([]);
    expect(await countConversions(env.ctx, { exceptUser: BEN, exceptDevice: 'd1' })).toHaveLength(2); // same device id, other person
  });
});

describe('admitConversion', () => {
  it('writes a grant for 30 s with what the card shows', async () => {
    const set = vi.spyOn(env.kv, 'set');
    expect(await admitConversion(env.ctx, { kind: 'film', userId: ANNA, deviceId: 'd1', hint: 'g1', hevc: true, label: 'Dunmoor' })).toEqual({ ok: true });
    expect(JSON.parse((await env.kv.get('conv:grant:g1'))!)).toEqual({ kind: 'film', user: ANNA, device: 'd1', hevc: true, label: 'Dunmoor' });
    expect(set.mock.calls.find(([k]) => k === 'conv:grant:g1')?.[2]).toBe(30);
    expect(await env.kv.get('conv:gate')).toBeNull(); // released
  });
  it('own device is replaced', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    raw = [converting('ps1')];
    await live(ANNA, 'ps1', 'd1');
    expect(await ask({ userId: ANNA, deviceId: 'd1' })).toEqual({ ok: true });
    expect(await ask({ userId: BEN, deviceId: 'd2' })).toEqual({ ok: false, why: 'full' });
  });
  it('a device\'s new grant replaces its own pending grants; its playing stream\'s grant and other devices\' grants stay', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 4 };
    const swap = (who: string, deviceId: string, hint: string) => ask({ userId: who, deviceId, hint, swap: true });
    expect(await swap(ANNA, 'd1', 'hover1')).toEqual({ ok: true });
    await bindConvGrant(env.ctx, 'hover1', 'ps-hover1'); // a prefetch answer nobody took
    expect(await swap(ANNA, 'd1', 'hover2')).toEqual({ ok: true }); // stays on its hint (not bound yet)
    expect(await swap(BEN, 'd2', 'ben1')).toEqual({ ok: true });
    expect(await ask({ userId: ANNA, deviceId: 'd1', hint: 'cast1' })).toEqual({ ok: true }); // a cast grant (no swap) replaces nothing ...
    expect((await env.kv.keys('conv:grant:')).sort()).toEqual(['conv:grant:ben1', 'conv:grant:cast1', 'conv:grant:hover2']);
    expect(await swap(ANNA, 'd1', 'hover3')).toEqual({ ok: true });
    // ... and is never replaced; the unbound swap grant is
    expect((await env.kv.keys('conv:grant:')).sort()).toEqual(['conv:grant:ben1', 'conv:grant:cast1', 'conv:grant:hover3']);
    await env.kv.del('conv:grant:cast1');
    // a stream that plays (live record) or that the server lists keeps its grant
    await bindConvGrant(env.ctx, 'hover3', 'ps-play');
    await live(ANNA, 'ps-play', 'd1');
    expect(await swap(ANNA, 'd1', 'next1')).toEqual({ ok: true });
    await bindConvGrant(env.ctx, 'next1', 'ps-listed');
    raw = [jfSession('ps-listed', { method: 'Transcode' })];
    expect(await swap(ANNA, 'd1', 'next2')).toEqual({ ok: true });
    expect((await env.kv.keys('conv:grant:')).sort()).toEqual(['conv:grant:ben1', 'conv:grant:next2', 'conv:grant:ps-listed', 'conv:grant:ps-play']);
    // two hovers on one device hold one slot for everyone else
    expect((await countConversions(env.ctx, { exceptUser: BEN, exceptDevice: 'd2' }))!.filter((e) => e.userId === ANNA && e.pending)).toHaveLength(2); // ps-play, next2
  });
  it('a refused ask replaces nothing', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    expect(await ask({ userId: ANNA, deviceId: 'd1', hint: 'mine', swap: true })).toEqual({ ok: true });
    raw = [converting('x1'), converting('x2')];
    expect(await ask({ userId: ANNA, deviceId: 'd1', hint: 'again', swap: true })).toEqual({ ok: false, why: 'full' });
    expect(await env.kv.keys('conv:grant:')).toEqual(['conv:grant:mine']);
  });
  it('admission reads the grant index, never scans the keyspace; bind and drop keep the index', async () => {
    const keys = vi.spyOn(env.kv, 'keys');
    expect(await ask({ userId: ANNA, deviceId: 'd1', hint: 'i1' })).toEqual({ ok: true });
    expect(await ask({ userId: BEN, deviceId: 'd2', hint: 'i2' })).toEqual({ ok: true });
    expect(keys.mock.calls.filter(([p]) => p.startsWith('conv:grant'))).toEqual([]);
    expect((await env.kv.indexMembers('conv:grants')).sort()).toEqual(['i1', 'i2']);
    await bindConvGrant(env.ctx, 'i1', 'ps-i1');
    expect((await env.kv.indexMembers('conv:grants')).sort()).toEqual(['i2', 'ps-i1']);
    await dropConvGrant(env.ctx, 'i2');
    expect(await env.kv.indexMembers('conv:grants')).toEqual(['ps-i1']);
    expect((await countConversions(env.ctx))!.map((e) => e.key)).toEqual(['ps-i1']);
    // a grant that could not be indexed is not written (the count could not see it): unknown, the caller treats it as busy
    vi.spyOn(env.kv, 'indexAdd').mockRejectedValueOnce(new Error('down'));
    expect(await ask({ userId: BEN, deviceId: 'd2', hint: 'i3' })).toEqual({ ok: false, why: 'unknown' });
    expect(await env.kv.get('conv:grant:i3')).toBeNull();
  });
  it('unreadable list means unknown', async () => {
    env.ctx.jf.admin.transcodeSessions = () => new Promise(() => undefined);
    const t0 = Date.now();
    expect(await ask({ deviceId: 'd1' })).toEqual({ ok: false, why: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await env.kv.keys('conv:grant:')).toEqual([]);
  });
  it('two asks for the last slot', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    const both = await Promise.all([ask({ userId: ANNA, deviceId: 'd1', hint: 'r1' }), ask({ userId: BEN, deviceId: 'd2', hint: 'r2' })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, why: 'full' }); // the slot was taken, not "unknown"
    expect(await env.kv.keys('conv:grant:')).toHaveLength(1);
  });
  it('a holder whose session read takes 700 ms does not turn the second ask into unknown', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 2 };
    const slow = () => new Promise<[]>((r) => setTimeout(() => r([]), 700));
    env.ctx.jf.admin.transcodeSessions = slow;
    const both = await Promise.all([ask({ userId: ANNA, deviceId: 'd1', hint: 'r3' }), ask({ userId: BEN, deviceId: 'd2', hint: 'r4' })]);
    expect(both).toEqual([{ ok: true }, { ok: true }]);
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 1 };
    for (const k of await env.kv.keys('conv:grant:')) await env.kv.del(k);
    const race = await Promise.all([ask({ userId: ANNA, deviceId: 'd1', hint: 'r5' }), ask({ userId: BEN, deviceId: 'd2', hint: 'r6' })]);
    expect(race.filter((r) => r.ok)).toHaveLength(1);
    expect(race.find((r) => !r.ok)).toEqual({ ok: false, why: 'full' });
  });
  it('a hanging settings read on an expired memo does not slow the admission (never a slow start)', async () => {
    await env.kv.set('conv:bench', JSON.stringify(bench({ fingerprint: 'vaapi|0|1|0' })), 3600); // stale while settings are readable
    expect((await conversionLimit(env.ctx)).limit).toBe(2); // memo filled with readable settings
    env.ctx.jf.admin.encoderSettings = () => new Promise(() => undefined);
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 61_000); // the memo is a minute old
    const t0 = performance.now();
    expect(await ask({ deviceId: 'd1' })).toEqual({ ok: true });
    expect(performance.now() - t0).toBeLessThan(1200);
    expect((await conversionLimit(env.ctx, { settingsMs: 50 })).limit).toBe(3); // late settings: not stale, the bench's 3 applies
  });
  it('a lock held by another asker is waited for (up to about 1 s); a stale holder keeps its lock', async () => {
    await env.kv.set('conv:gate', 'someone', 3);
    setTimeout(() => void env.kv.del('conv:gate'), 50);
    expect(await ask({ deviceId: 'd1' })).toEqual({ ok: true });
    await env.kv.set('conv:gate', 'someone-else', 30);
    expect(await ask({ deviceId: 'd2' })).toEqual({ ok: false, why: 'unknown' });
    expect(await env.kv.get('conv:gate')).toBe('someone-else');
  });
  it('priority: live is held back from the last slot while films come first', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 3 };
    raw = [converting('ps1'), converting('ps2')];
    expect(await ask({ kind: 'live', deviceId: 'd1' })).toEqual({ ok: false, why: 'full' });
    expect(await ask({ kind: 'download', deviceId: 'd2' })).toEqual({ ok: false, why: 'full' });
    expect(await ask({ kind: 'film', deviceId: 'd3' })).toEqual({ ok: true });
  });
  it('other apps may push U above L and are never stopped', async () => {
    env.ctx.cfg = { ...cfg, CONVERSION_SLOTS: 2 };
    raw = [converting('x1'), converting('x2'), converting('x3')];
    const before = env.jfCalls.length;
    expect(await ask({ deviceId: 'd1' })).toEqual({ ok: false, why: 'full' });
    expect(await countConversions(env.ctx)).toHaveLength(3);
    expect(env.jfCalls.slice(before).filter((c) => c.method === 'DELETE' || c.path.includes('ActiveEncodings'))).toEqual([]);
    expect(readFileSync(new URL('../src/convbudget.ts', import.meta.url), 'utf8')).not.toMatch(/stopEncoding/);
  });
});

describe('probes and previews are exempt', () => {
  const SDR_HD: MediaTraits = { resolution: 'hd', hdr: null, audio: null, sdr: true };
  beforeEach(() => {
    vi.spyOn(env.ctx.jf, 'stopEncoding').mockResolvedValue(undefined);
    vi.spyOn(env.ctx.jf, 'mediaFetch').mockResolvedValue(new Response('x', { status: 500 }));
  });
  it('the HEVC probe marks its play session', async () => {
    vi.spyOn(env.ctx.jf, 'items').mockResolvedValue({ items: [{ id: 'm'.repeat(32), name: 'Dunmoor', type: 'Movie' }] as never, total: 1 });
    env.ctx.jf.mediaTraits = async () => SDR_HD;
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockResolvedValue({ playSessionId: 'ps-probe-1', hlsUrl: '/x' } as never);
    vi.spyOn(env.ctx.jf, 'clipTranscode').mockResolvedValue({ path: '/Videos/x/master.m3u8?PlaySessionId=ps-probe-1', playSessionId: 'ps-probe-1' });
    expect(await probeHevcEncoder(env.ctx, admin)).toMatchObject({ ok: false, reason: 'http' });
    expect(await env.kv.get('conv:exempt:ps-probe-1')).not.toBeNull();
    expect(env.ctx.jf.stopEncoding).toHaveBeenCalledWith(admin, 'ps-probe-1'); // the probe still stops its own clip
  });
  it('a preview build marks its play session', async () => {
    vi.spyOn(env.ctx.jf, 'trailer').mockResolvedValue('t'.repeat(32));
    vi.spyOn(env.ctx.jf, 'playbackInfo').mockResolvedValue({ playSessionId: 'ps-prev-1', hlsUrl: '/x', audioTracks: [] } as never);
    vi.spyOn(env.ctx.jf, 'clipTranscode').mockResolvedValue({ path: '/Videos/x/master.m3u8?PlaySessionId=ps-prev-1', playSessionId: 'ps-prev-1' });
    await previews(env.ctx).enqueue('p'.repeat(32));
    expect(await env.kv.get('conv:exempt:ps-prev-1')).not.toBeNull();
    raw = [converting('ps-prev-1')];
    expect(await countConversions(env.ctx)).toEqual([]);
  });
});
