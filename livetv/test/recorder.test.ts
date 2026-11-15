// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 3 Task 2: the recorder taps a channel's shared stream and copies its segments into `/recordings/<dir>/` with an EVENT playlist
 * (spec §15.2). Real files in temporary folders, the shared stream is a real `Streams` with a test driver, the recorder's clock is a
 * variable and its tick is called by the test; ENOSPC comes from a wrapped file seam.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayCache, sign } from '../src/protocol.js';
import { FREE_MIN_BYTES, GAP_TARGETS, Recorder, nodeRecFs, type RecFs } from '../src/recorder.js';
import { recordingRoutes } from '../src/routes/recordings.js';
import { createApp } from '../src/server.js';
import { Streams, type Driver, type DriverContext, type StartBody } from '../src/streams.js';
import type { SystemView } from '../src/system.js';
import { deriveKey } from './streams-helpers.js';

const CH = 'ch-nordlicht';
const ID = '0f000000-0000-4000-a000-000000000001';
const DIR = '0f000000-0000-4000-a000-0000000000d1';
const T0 = Date.parse('2026-11-15T19:58:00.000Z');
const KEY = 'iptv.example.com/live/anna/geheim';

let root = '';
let cache = '';
let streams: Streams;
let recorder: Recorder;
let clock = T0;
const logs: string[] = [];
let ctxOf: DriverContext | null = null;
let full = false;
const keepAlives: string[] = [];

/** a driver that waits; the test feeds its segments through `emit` */
const manual: Driver = async (ctx) => {
  ctxOf = ctx;
  await ctx.sleep(Number.MAX_SAFE_INTEGER);
};
let n = 0;
async function emit(o: { duration?: number; pdt: number; disc?: boolean; init?: number; bytes?: number }): Promise<void> {
  const c = ctxOf!;
  const fmp4 = o.init !== undefined;
  c.window(fmp4 ? { ext: 'm4s', init: true } : { ext: 'ts' });
  const file = `s${n++}.${fmp4 ? 'm4s' : 'ts'}`;
  if (fmp4 && !existsSync(join(c.dir, `init-${o.init}.mp4`))) writeFileSync(join(c.dir, `init-${o.init}.mp4`), `init ${o.init}`);
  const body = Buffer.alloc(o.bytes ?? 188, n);
  writeFileSync(join(c.dir, file), body);
  await c.segment({ file, duration: o.duration ?? 4, bytes: body.length, pdt: o.pdt, ...(o.disc ? { discontinuity: true } : {}), ...(fmp4 ? { init: o.init } : {}) });
}
const body = (over: Partial<StartBody> = {}): StartBody => ({
  channelId: CH, input: { url: `http://${KEY}/101.m3u8`, kind: 'hls', allowLan: false }, mode: 'passthrough', encoder: 'libx264', dvrSeconds: 1800, maxBitrate: 10_000_000, ...over,
});
async function startStream(): Promise<string> {
  ctxOf = null;
  const { streamKey } = streams.start(body());
  await vi.waitFor(() => expect(ctxOf).not.toBeNull());
  return streamKey;
}
const fsSeam: RecFs = {
  ...nodeRecFs,
  copy: async (s, d) => { if (full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return nodeRecFs.copy(s, d); },
  writeAtomic: async (p, t) => { if (full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return nodeRecFs.writeAtomic(p, t); },
  free: async () => (full ? FREE_MIN_BYTES - 1 : 50 * 1024 ** 3),
};
const newRecorder = () => new Recorder({ root, streams: { view: (id) => streams.view(id), keepAlive: (id) => { keepAlives.push(id); streams.keepAlive(id); } }, fs: fsSeam, log: (m) => logs.push(m), now: () => clock, tickMs: 0 });
const playlist = () => readFileSync(join(root, DIR, 'index.m3u8'), 'utf8');
const settled = () => vi.waitFor(() => expect(recorder.list().length).toBeGreaterThan(0)).then(() => new Promise((r) => setTimeout(r, 30)));
const lines = (p: string, prefix: string) => p.split('\n').filter((l) => l.startsWith(prefix));
const segs = (p: string) => p.split('\n').filter((l) => /^[0-9]+\.(ts|m4s)$/.test(l));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ltv-rec-'));
  cache = mkdtempSync(join(tmpdir(), 'ltv-rec-cache-'));
  clock = T0;
  full = false;
  n = 0;
  logs.length = 0;
  keepAlives.length = 0;
  recorder = undefined as unknown as Recorder;
  streams = new Streams({
    root: cache, maxBytes: 1024 ** 3, drivers: { passthrough: manual }, log: (m) => logs.push(m),
    onSegment: (id, s) => recorder?.segment(id, s), onStop: (id) => recorder?.streamStopped(id),
  });
  recorder = newRecorder();
});
afterEach(async () => {
  recorder.close();
  await streams.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

describe('the recorder', () => {
  it('copies segments and writes an EVENT playlist with program date-times', async () => {
    await startStream();
    expect(await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 })).toEqual({ ok: true, state: 'recording', segments: null });
    for (let i = 0; i < 3; i++) await emit({ pdt: T0 + i * 4000 });
    await settled();
    await vi.waitFor(() => expect(segs(playlist())).toEqual(['0.ts', '1.ts', '2.ts']));
    const p = playlist();
    expect(p).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(p).toContain('#EXT-X-TARGETDURATION:4');
    expect(p).not.toContain('#EXT-X-ENDLIST');
    expect(p).not.toContain('#EXT-X-DISCONTINUITY');
    expect(lines(p, '#EXT-X-PROGRAM-DATE-TIME:')).toEqual([0, 1, 2].map((i) => `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + i * 4000).toISOString()}`));
    expect(readFileSync(join(root, DIR, '1.ts'))).toEqual(Buffer.alloc(188, 2));
    expect(recorder.list()).toEqual([{ id: ID, channelId: CH, dir: DIR, state: 'recording', segments: 'ts', bytes: 3 * 188, durationS: 12, gaps: [], error: null, since: T0 }]);
    expect(keepAlives.length).toBeGreaterThanOrEqual(3);
  });

  it('fmp4 stream: init files are copied once and EXT-X-MAP changes with the init', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0, init: 0 });
    await emit({ pdt: T0 + 4000, init: 0 });
    await emit({ pdt: T0 + 8000, init: 1 });
    await vi.waitFor(() => expect(segs(playlist())).toEqual(['0.m4s', '1.m4s', '2.m4s']));
    const p = playlist();
    expect(lines(p, '#EXT-X-MAP')).toEqual(['#EXT-X-MAP:URI="init-0.mp4"', '#EXT-X-MAP:URI="init-1.mp4"']);
    expect(p).toContain('#EXT-X-VERSION:7');
    expect(p.indexOf('#EXT-X-DISCONTINUITY')).toBeLessThan(p.indexOf('init-1.mp4')); // an init change is a discontinuity
    expect(readdirSync(join(root, DIR)).sort()).toEqual(['0.m4s', '1.m4s', '2.m4s', 'index.m3u8', 'init-0.mp4', 'init-1.mp4']);
    expect(readFileSync(join(root, DIR, 'init-1.mp4'), 'utf8')).toBe('init 1');
    expect(recorder.list()[0]!.segments).toBe('fmp4');
  });

  it('ENDLIST at endAt; PATCH extends endAt', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 8000 });
    await emit({ pdt: T0 });
    expect(recorder.setEnd(ID, T0 + 12_000)).toBe(true);
    clock = T0 + 8000;
    recorder.tick();
    await emit({ pdt: T0 + 4000 });
    await emit({ pdt: T0 + 8000 });
    // a segment that starts at or after the end is not recorded
    await emit({ pdt: T0 + 12_000 });
    clock = T0 + 12_000;
    recorder.tick();
    await vi.waitFor(() => expect(recorder.list()[0]!.state).toBe('done'));
    const p = playlist();
    expect(segs(p)).toEqual(['0.ts', '1.ts', '2.ts']);
    expect(p.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(recorder.setEnd(ID, T0 + 20_000)).toBe(false); // finished
    expect(logs).toContain(`recording ${ID} done`);
  });

  it('resume after restart continues numbering with a discontinuity and records the gap', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await emit({ pdt: T0 + 4000 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(2));
    // livetv restarts: a new process, the same folder
    recorder.close();
    recorder = newRecorder();
    clock = T0 + 60_000;
    expect(await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 })).toMatchObject({ ok: true, state: 'recording' });
    expect(logs).toContain(`recording ${ID} resumed`);
    await emit({ pdt: T0 + 60_000 });
    await vi.waitFor(() => expect(segs(playlist())).toEqual(['0.ts', '1.ts', '2.ts']));
    const p = playlist();
    expect(p.split('\n').slice(p.split('\n').indexOf('1.ts') + 1, p.split('\n').indexOf('2.ts'))[0]).toBe('#EXT-X-DISCONTINUITY');
    expect(recorder.list()[0]).toMatchObject({ gaps: [{ from: T0 + 8000, to: T0 + 60_000 }], bytes: 3 * 188, durationS: 12 });
  });

  it('ENOSPC ends with storage_full and a closed playlist', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    // the disk fills: the next copy fails; the playlist write fails too, so the last good playlist stays and is closed afterwards
    full = true;
    await emit({ pdt: T0 + 4000 });
    await vi.waitFor(() => expect(recorder.list()[0]).toMatchObject({ state: 'failed', error: 'storage_full', bytes: 188 }));
    expect(playlist()).not.toContain('#EXT-X-ENDLIST'); // the disk had no room for it
    full = false;
    await recorder.stop(ID); // the backend's stop closes it once there is room
    expect(segs(playlist())).toEqual(['0.ts']);
    expect(playlist().trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(logs).toContain(`recording ${ID} failed (storage_full)`);
    // a new recording is refused while less than 2 GiB are free
    full = true;
    expect(await recorder.start({ id: '0f000000-0000-4000-a000-000000000002', channelId: CH, dir: '0f000000-0000-4000-a000-0000000000d2', endAt: T0 + 3_600_000 }))
      .toEqual({ ok: false, status: 507, error: 'storage_full' });
  });

  it('ENOSPC with space for the playlist: the playlist is closed with what was copied', async () => {
    const seam: RecFs = { ...fsSeam, copy: async (s, d) => { if (full) throw Object.assign(new Error('x'), { code: 'ENOSPC' }); return nodeRecFs.copy(s, d); }, writeAtomic: nodeRecFs.writeAtomic, free: async () => 50 * 1024 ** 3 };
    recorder.close();
    recorder = new Recorder({ root, streams, fs: seam, now: () => clock, tickMs: 0 });
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    full = true;
    await emit({ pdt: T0 + 4000 });
    await vi.waitFor(() => expect(recorder.list()[0]!.error).toBe('storage_full'));
    await vi.waitFor(() => expect(playlist()).toContain('#EXT-X-ENDLIST'));
    const p = playlist();
    expect(segs(p)).toEqual(['0.ts']);
    expect(p.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('stream stop during recording records a gap; segments after a restart continue', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    await streams.stop(CH); // the stream ends (an admin, the input); the recording waits for the next one
    expect(recorder.list()[0]!.state).toBe('recording');
    await startStream();
    await emit({ pdt: T0 + 30_000 });
    await vi.waitFor(() => expect(segs(playlist())).toEqual(['0.ts', '1.ts']));
    expect(playlist()).toContain('#EXT-X-DISCONTINUITY');
    expect(recorder.list()[0]!.gaps).toEqual([{ from: T0 + 4000, to: T0 + 30_000 }]);
  });

  it('three target durations without a segment open a gap; it ends with the next segment', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    clock += GAP_TARGETS * 4000 - 1;
    recorder.tick();
    clock += 1;
    recorder.tick();
    await emit({ pdt: T0 + 40_000 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(2));
    expect(recorder.list()[0]!.gaps).toEqual([{ from: T0 + 4000, to: T0 + 40_000 }]);
    expect(playlist()).toContain('#EXT-X-DISCONTINUITY');
  });

  it('keepAlive prevents the idle stop while recording', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    keepAlives.length = 0;
    recorder.tick(); // every tick keeps the stream alive, also while no segment arrives
    expect(keepAlives).toEqual([CH]);
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(keepAlives.length).toBe(2));
    // a finished recording keeps nothing alive
    await recorder.stop(ID);
    keepAlives.length = 0;
    recorder.tick();
    expect(keepAlives).toEqual([]);
  });

  it('a recording that got no segment at all fails stream_gone; finished entries stay listed for an hour', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 10_000 });
    clock = T0 + 10_000;
    recorder.tick();
    await vi.waitFor(() => expect(recorder.list()[0]).toMatchObject({ state: 'failed', error: 'stream_gone' }));
    clock += 3_600_000 - 1;
    recorder.tick();
    expect(recorder.list()).toHaveLength(1);
    clock += 1;
    recorder.tick();
    expect(recorder.list()).toEqual([]);
  });

  it('no log line contains a path, a stream key or a title', async () => {
    const key = await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    full = true;
    await emit({ pdt: T0 + 4000 });
    await vi.waitFor(() => expect(recorder.list()[0]!.state).toBe('failed'));
    full = false;
    await recorder.remove(ID, DIR);
    const all = logs.join('\n');
    for (const bad of [root, cache, key, DIR, 'iptv.example.com', 'geheim', 'Sternstunde']) expect(all).not.toContain(bad);
    expect(all).toContain(`recording ${ID}`);
  });
});

describe('the recording routes', () => {
  const key = deriveKey('recorder-test-secret-0123456789');
  let api: http.Server;
  let base = '';
  beforeEach(async () => {
    const app = createApp({
      verifier: { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 }, version: null, bootId: '0123456789abcdef',
      system: async () => ({}) as SystemView, routes: recordingRoutes(recorder, { now: () => clock }), warn: (m) => logs.push(m),
    });
    api = http.createServer((req, res) => { void app(req, res); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => { api.closeAllConnections(); api.close(() => r()); }); });
  const call = async (method: string, path: string, b?: unknown) => {
    const s = b === undefined ? '' : JSON.stringify(b);
    const r = await fetch(base + path, { method, ...(s ? { body: s } : {}), headers: { ...sign(key, method, path, s), ...(s ? { 'content-type': 'application/json' } : {}) } });
    return { status: r.status, json: r.status === 204 ? null : await r.json() };
  };
  const post = (o: Record<string, unknown> = {}) => call('POST', '/v1/recordings', { id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000, ...o });

  it('POST is idempotent per id', async () => {
    expect(await post()).toEqual({ status: 409, json: { error: 'stream_not_running' } }); // the backend starts the stream first
    await startStream();
    expect(await post()).toEqual({ status: 200, json: { state: 'recording', segments: null } });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    expect(await post()).toEqual({ status: 200, json: { state: 'recording', segments: 'ts' } });
    // two at once: still one recorder
    await Promise.all([post({ id: '0f000000-0000-4000-a000-000000000003', dir: '0f000000-0000-4000-a000-0000000000d3' }), post({ id: '0f000000-0000-4000-a000-000000000003', dir: '0f000000-0000-4000-a000-0000000000d3' })]);
    expect((await call('GET', '/v1/recordings')).json.map((r: { id: string }) => r.id).sort()).toEqual([ID, '0f000000-0000-4000-a000-000000000003']);
    // a second recording id into a folder another one writes is refused
    expect((await post({ id: '0f000000-0000-4000-a000-000000000004' })).json).toEqual({ error: 'invalid_dir' });
    for (const [field, o] of [['id', { id: 'x' }], ['dir', { dir: '../etc' }], ['channelId', { channelId: 'a/b' }], ['endAt', { endAt: T0 - 1 }]] as const) {
      expect(await post(o), field).toEqual({ status: 400, json: { error: 'invalid', field } });
    }
    expect((await call('PATCH', `/v1/recordings/${ID}`, { endAt: T0 + 7_200_000 })).status).toBe(200);
    expect((await call('DELETE', `/v1/recordings/${ID}`)).status).toBe(204);
    expect((await call('GET', '/v1/recordings')).json.find((r: { id: string }) => r.id === ID)).toMatchObject({ state: 'done', bytes: 188, durationS: 4 });
    expect((await call('DELETE', '/v1/recordings/0f000000-0000-4000-a000-0000000000ff')).status).toBe(404);
  });

  it('delete refuses a non-uuid dir and a symlinked folder', async () => {
    expect(await call('POST', `/v1/recordings/${ID}/delete`, { dir: '..' })).toEqual({ status: 400, json: { error: 'invalid', field: 'dir' } });
    expect(await call('POST', `/v1/recordings/${ID}/delete`, { dir: `${DIR}/../x` })).toEqual({ status: 400, json: { error: 'invalid', field: 'dir' } });
    // a link planted where a folder should be: refused, the target untouched
    const outside = mkdtempSync(join(tmpdir(), 'ltv-outside-'));
    writeFileSync(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(root, DIR));
    expect(await call('POST', `/v1/recordings/${ID}/delete`, { dir: DIR })).toEqual({ status: 409, json: { error: 'not_a_folder' } });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    // and a recording is never started into it
    await startStream();
    expect(await post()).toEqual({ status: 409, json: { error: 'invalid_dir' } });
    rmSync(join(root, DIR));
    rmSync(outside, { recursive: true, force: true });
    // a real folder goes (the running recorder of that id first); a second delete is 404
    expect((await post()).status).toBe(200);
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    mkdirSync(join(root, DIR, 'sub'));
    expect((await call('POST', `/v1/recordings/${ID}/delete`, { dir: DIR })).status).toBe(204);
    expect(existsSync(join(root, DIR))).toBe(false);
    expect(recorder.list()).toEqual([]);
    expect(await call('POST', `/v1/recordings/${ID}/delete`, { dir: DIR })).toEqual({ status: 404, json: { error: 'not_found' } });
  });
});

describe('finalisation and races (fix round 1)', () => {
  it('B-I1: a recording ends itself at its end on its own timer, without a tick', async () => {
    recorder.close();
    recorder = new Recorder({ root, streams, fs: fsSeam, tickMs: 60_000, endTimers: true });
    await startStream();
    const endAt = Date.now() + 300;
    expect((await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt })).ok).toBe(true);
    await emit({ pdt: Date.now() - 1000 });
    await vi.waitFor(() => expect(recorder.list()[0]!.state).toBe('done'), { timeout: 3000 });
    expect(playlist().trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('B-I1: done only after the ENDLIST is written (one retry); a playlist that could not be closed is closed by the tick later', async () => {
    let failWrites = 0;
    const seam: RecFs = { ...fsSeam, free: async () => 50 * 1024 ** 3, writeAtomic: async (p, t) => { if (failWrites > 0 && t.includes('#EXT-X-ENDLIST')) { failWrites--; throw Object.assign(new Error('x'), { code: 'EIO' }); } return nodeRecFs.writeAtomic(p, t); } };
    recorder.close();
    recorder = new Recorder({ root, streams, fs: seam, now: () => clock, tickMs: 0 });
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 8000 });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    failWrites = 1; // the first closing write fails, the retry works
    clock = T0 + 8000;
    recorder.tick();
    await vi.waitFor(() => expect(recorder.list()[0]!.state).toBe('done'));
    expect(playlist()).toContain('#EXT-X-ENDLIST');
    // a full disk under ENOSPC: failed at once, the playlist closed by a later tick (no backend stop needed)
    const id2 = '0f000000-0000-4000-a000-000000000002';
    const dir2 = '0f000000-0000-4000-a000-0000000000d2';
    await recorder.start({ id: id2, channelId: CH, dir: dir2, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 + 4000 });
    await vi.waitFor(() => expect(recorder.list().find((r) => r.id === id2)!.bytes).toBeGreaterThan(0));
    full = true;
    failWrites = 5;
    await emit({ pdt: T0 + 8000 });
    await vi.waitFor(() => expect(recorder.list().find((r) => r.id === id2)!.error).toBe('storage_full'));
    const pl2 = () => readFileSync(join(root, dir2, 'index.m3u8'), 'utf8');
    expect(pl2()).not.toContain('#EXT-X-ENDLIST');
    full = false;
    failWrites = 0;
    recorder.tick();
    await vi.waitFor(() => expect(pl2()).toContain('#EXT-X-ENDLIST'));
  });

  it('B-I2: close finalises a folder without a recorder: ENDLIST written, facts read from the folder', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await emit({ pdt: T0 + 4000 });
    await emit({ pdt: T0 + 60_000, disc: true }); // after an outage
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(3));
    // livetv restarts after the end: a new process knows nothing of the recording
    recorder.close();
    recorder = newRecorder();
    const r = await recorder.closeFolder(ID, DIR);
    expect(r).toEqual({ id: ID, channelId: '', dir: DIR, state: 'done', segments: 'ts', bytes: 3 * 188, durationS: 12, gaps: [{ from: T0 + 8000, to: T0 + 60_000 }], error: null });
    expect(playlist().trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(await recorder.closeFolder(ID, '0f000000-0000-4000-a000-0000000000ee')).toBeNull();
  });

  it('B-M3: ticks past the end while the queue is busy queue one finish, not one per tick', async () => {
    await startStream();
    expect((await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 10_000 })).ok).toBe(true);
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    const finish = vi.spyOn(recorder as unknown as { finish: (...a: unknown[]) => Promise<void> }, 'finish');
    clock = T0 + 20_000;
    for (let i = 0; i < 5; i++) recorder.tick();
    expect(finish).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(recorder.list()[0]!.state).toBe('done'));
  });

  it('A-I3/B-I3: stop and remove during an in-flight start leave no recorder and do not recreate the folder', async () => {
    let releaseFree!: () => void;
    const slow: RecFs = { ...fsSeam, free: () => new Promise((r) => { releaseFree = () => r(50 * 1024 ** 3); }) };
    recorder.close();
    recorder = new Recorder({ root, streams, fs: slow, now: () => clock, tickMs: 0 });
    await startStream();
    const p = recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await vi.waitFor(() => expect(releaseFree).toBeTypeOf('function'));
    const removing = recorder.remove(ID, DIR);
    releaseFree();
    expect(await p).toEqual({ ok: false, status: 410, error: 'removed' });
    expect(await removing).toBe('not_found');
    expect(recorder.list()).toEqual([]);
    expect(existsSync(join(root, DIR))).toBe(false);
    // and a later start (a resume racing the delete) is refused
    expect(await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 })).toEqual({ ok: false, status: 410, error: 'removed' });
    // a stop during a start reaches the recorder that start creates
    let release2!: () => void;
    const slow2: RecFs = { ...fsSeam, free: () => new Promise((r) => { release2 = () => r(50 * 1024 ** 3); }) };
    recorder.close();
    recorder = new Recorder({ root, streams, fs: slow2, now: () => clock, tickMs: 0 });
    const id3 = '0f000000-0000-4000-a000-000000000003';
    const p3 = recorder.start({ id: id3, channelId: CH, dir: '0f000000-0000-4000-a000-0000000000d3', endAt: T0 + 3_600_000 });
    await vi.waitFor(() => expect(release2).toBeTypeOf('function'));
    const stopping = recorder.stop(id3);
    release2();
    await p3;
    expect(await stopping).toBe(true);
    expect(recorder.list().find((r) => r.id === id3)?.state).not.toBe('recording');
  });

  it('B-M7: a repeated POST of a running id with another folder or channel is refused', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    expect(await recorder.start({ id: ID, channelId: CH, dir: '0f000000-0000-4000-a000-0000000000d4', endAt: T0 + 3_600_000 })).toEqual({ ok: false, status: 409, error: 'invalid_dir' });
    expect(await recorder.start({ id: ID, channelId: 'ch-hafen', dir: DIR, endAt: T0 + 3_600_000 })).toEqual({ ok: false, status: 409, error: 'invalid_dir' });
  });

  it('B-M4: an init file the cache dropped before the copy is a gap, not a write failure', async () => {
    await startStream();
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0, init: 0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    // a new init whose file is gone by the time the recorder copies it
    const c = ctxOf!;
    writeFileSync(join(c.dir, 'z.m4s'), 'x');
    await c.segment({ file: 'z.m4s', duration: 4, bytes: 1, pdt: T0 + 4000, init: 7 });
    await emit({ pdt: T0 + 8000, init: 0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(2));
    expect(recorder.list()[0]).toMatchObject({ state: 'recording', error: null });
    expect(recorder.list()[0]!.gaps).toHaveLength(1);
  });

  it('B-M2: segments arrive under .part and are renamed; leftovers are cleaned on a resume', async () => {
    await startStream();
    mkdirSync(join(root, DIR), { recursive: true });
    writeFileSync(join(root, DIR, '0.ts.part'), 'half');
    writeFileSync(join(root, DIR, 'index.m3u8.tmp'), 'half');
    await recorder.start({ id: ID, channelId: CH, dir: DIR, endAt: T0 + 3_600_000 });
    await emit({ pdt: T0 });
    await vi.waitFor(() => expect(segs(playlist())).toHaveLength(1));
    expect(readdirSync(join(root, DIR)).sort()).toEqual(['0.ts', 'index.m3u8']);
  });
});
