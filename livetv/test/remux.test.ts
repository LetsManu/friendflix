// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer as netServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardDeps } from '../src/fetch.js';
import { SEGMENT_SECONDS } from '../src/ffmpeg.js';
import type { ProbeResult, StreamInput } from '../src/probe.js';
import { deriveKey, sign } from '../src/protocol.js';
import { STALL_MS, remuxDriver } from '../src/remux.js';
import { streamRoutes } from '../src/routes/streams.js';
import type { Run, RunOptions, RunResult } from '../src/run.js';
import { start, type RouteCall } from '../src/server.js';
import { BACKOFF_MS, Streams, type StartBody } from '../src/streams.js';
import type { Encoder } from '../src/system.js';
import { fakeFetch, flush, memoryStore, type Served } from './streams-helpers.js';

const NOW = Date.parse('2026-11-11T20:15:00.000Z');
const ROOT = '/cache';
const TS_URL = 'http://iptv.example.com/live/anna/geheim/102.ts';
const SRT_URL = 'srt://iptv.example.com:9000?streamid=geheim&passphrase=geheimgeheim';
const SRT_LITERAL = 'srt://192.0.2.40:9000?streamid=geheim&passphrase=geheimgeheim';
const TS = Buffer.alloc(376, 0x47);
const GUARD: GuardDeps = { own: [], lookup: async () => ['192.0.2.40'] };

const H264: ProbeResult = { ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux' };
const HEVC_MP2: ProbeResult = { ok: true, video: { codec: 'hevc', width: 1280, height: 720, fps: 50 }, audio: { codec: 'mp2', channels: 2 }, needs: 'transcode' };
const FAILED: ProbeResult = { ok: false, needs: 'transcode', error: 'timeout' };

const has = (args: readonly string[], part: readonly string[]): boolean =>
  part.length > 0 && args.some((_, i) => part.every((p, j) => args[i + j] === p));
const after = (args: readonly string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const carrying = (args: readonly string[]) => args.filter((x) => x.length >= 3 && (x.startsWith('-') || /[/:=,]/.test(x)));

/** one scripted ffmpeg process: stdout text at times after its start (ms), then an exit (none: it runs until stopped; 0: at once) */
interface Plan { out?: Array<[number, string]>; exitAt?: number; code?: number }
type Call = { cmd: string; args: string[]; at: number; o: RunOptions; endedAt: number | null };

/**
 * A fake ffmpeg following `plans` in call order. Like the real one it writes each segment file before its CSV line reaches stdout
 * (into the memory store, next to the output pattern); it ends at once when `o.signal` aborts. `exitAt: 0` exits in a microtask,
 * not through a 0-ms timer (fake timers run a 0-ms timer scheduled during a tick 1 ms later). Each call records when it ended.
 * Its stderr names the provider URL and a password: a driver that logs it fails the log test.
 */
function fakeFfmpeg(plans: Plan[], files: Map<string, Buffer>): Run & { calls: Call[] } {
  const calls: Call[] = [];
  const run = ((cmd, args, o) => new Promise<RunResult>((resolve) => {
    const plan = plans[calls.length] ?? {};
    const call: Call = { cmd, args, at: Date.now(), o, endedAt: null };
    calls.push(call);
    const dir = dirname(args.at(-1) ?? '');
    const timers: NodeJS.Timeout[] = [];
    let pending = '';
    const onAbort = () => end(255);
    const end = (code: number) => {
      if (call.endedAt !== null) return;
      call.endedAt = Date.now();
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.alloc(0), stderr: `Error opening input ${TS_URL} password=geheim\n` });
    };
    if (o.signal?.aborted) { end(255); return; }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    for (const [t, text] of plan.out ?? []) {
      timers.push(setTimeout(() => {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop()!;
        for (const l of lines) {
          const m = /^(\d+\.ts),/.exec(l);
          if (m) files.set(join(dir, m[1]!), TS);
        }
        o.onStdout?.(Buffer.from(text));
      }, t));
    }
    if (plan.exitAt === 0) queueMicrotask(() => end(plan.code ?? 1));
    else if (plan.exitAt !== undefined) timers.push(setTimeout(() => end(plan.code ?? 1), plan.exitAt));
  })) as Run & { calls: Call[] };
  run.calls = calls;
  return run;
}

const body = (over: Partial<StartBody> = {}): StartBody => ({
  channelId: 'ch-hafenkanal', input: { url: TS_URL, kind: 'ts', allowLan: false }, mode: 'remux', encoder: 'libx264', dvrSeconds: 7200, maxBitrate: 10_000_000, ...over,
});

let mem: ReturnType<typeof memoryStore>;
let current: Streams | null = null;
const logs: string[] = [];

function setup(plans: Plan[], probed: () => ProbeResult = () => H264) {
  const run = fakeFfmpeg(plans, mem.files);
  const ff = fakeFetch(new Map<string, Served>([[TS_URL, TS]]));
  const probe = vi.fn(async (_input: StreamInput) => probed());
  const log = (m: string) => { logs.push(m); };
  const driver = remuxDriver({ run, guard: GUARD, fetch: ff.fetch, probe, log, size: async (p: string) => mem.files.get(p)?.length ?? 0 });
  const streams = new Streams({ root: ROOT, maxBytes: 1024 ** 3, drivers: { remux: driver, transcode: driver }, store: mem.store, log });
  current = streams;
  return { run, ff, probe, streams };
}

const playlist = (key: string) => mem.files.get(`${ROOT}/${key}/index.m3u8`)?.toString('utf8') ?? '';
const uris = (text: string) => text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
const pdts = (text: string) => text.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));
const viewOf = (s: Streams, id: string) => s.list().find((v) => v.channelId === id)!;
/** the time from each run's exit to the next run's start */
const gaps = (calls: Call[]) => calls.slice(1).map((c, i) => c.at - calls[i]!.endedAt!);

describe('the remux / transcode driver', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mem = memoryStore();
    logs.length = 0;
  });
  afterEach(async () => {
    await current?.close();
    current = null;
    vi.useRealTimers();
  });

  it('CSV lines become window entries', async () => {
    const { run, streams } = setup([{
      out: [
        [4_000, '0.ts,0.000000,4.000000\n'],
        [8_000, '1.ts,4.000000,8.000000\n'],
        // garbage and a name that is not a local segment are ignored
        [10_000, 'x\n../evil.ts,8.000000,12.000000\n'],
        [12_500, '2.ts,8.000000,12.480000\n'],
        // a line split over two chunks
        [16_000, '3.ts,12.480000,16.4'],
        [16_500, '80000\n'],
      ],
    }]);
    const { streamKey } = streams.start(body());
    await flush();
    expect(run.calls).toHaveLength(1);
    expect(after(run.calls[0]!.args, '-segment_start_number')).toBe('0');
    await vi.advanceTimersByTimeAsync(17_000);
    await flush();
    const text = playlist(streamKey);
    expect(uris(text)).toEqual(['0.ts', '1.ts', '2.ts', '3.ts']);
    expect(text.split('\n').filter((l) => l.startsWith('#EXTINF:'))).toEqual(['#EXTINF:4.000,', '#EXTINF:4.000,', '#EXTINF:4.480,', '#EXTINF:4.000,']);
    // each date-time is the line's arrival − the segment's duration (not chained: 2.ts arrived 500 ms late)
    expect(pdts(text)).toEqual([NOW, NOW + 4_000, NOW + 8_020, NOW + 12_500]);
    expect(text.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY')).toEqual([]);
    expect(streams.file(streamKey, '2.ts')).toEqual({ path: `${ROOT}/${streamKey}/2.ts`, type: 'video/mp2t' });
    expect(streams.file(streamKey, '4.ts')).toBeNull();
    expect(viewOf(streams, 'ch-hafenkanal')).toMatchObject({ mode: 'remux', state: 'running', lastSegmentAt: NOW + 16_500, errors: [] });
  });

  it('reconnect backoff', async () => {
    expect(BACKOFF_MS).toEqual([2_000, 4_000, 8_000, 15_000, 30_000]);
    const quick: Plan = { exitAt: 0 };
    const { run, ff, probe, streams } = setup([
      { out: [[4_000, '0.ts,0.000000,4.000000\n']], exitAt: 4_000, code: 0 },
      quick, quick, quick, quick, quick,
      { out: [[4_000, '1.ts,0.000000,4.000000\n']] },
    ]);
    const { streamKey } = streams.start(body());
    await flush();
    await vi.advanceTimersByTimeAsync(100_000);
    await flush();
    expect(run.calls).toHaveLength(7);
    // each restart comes exactly its delay after the previous ffmpeg ended: 2, 4, 8, 15, 30, then 30 s again
    expect(gaps(run.calls)).toEqual([2_000, 4_000, 8_000, 15_000, 30_000, 30_000]);
    expect(run.calls.slice(0, 6).map((c) => c.endedAt! - NOW)).toEqual([4_000, 6_000, 10_000, 18_000, 33_000, 63_000]);
    expect(run.calls.map((c) => c.at - NOW)).toEqual([0, 6_000, 10_000, 18_000, 33_000, 63_000, 93_000]);
    // every attempt opens the input again (through livetv, into stdin); the probe ran once, at the start
    expect(ff.calls.map((c) => c.url)).toEqual(Array(7).fill(TS_URL));
    expect(run.calls.every((c) => c.o.stdin !== undefined)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    // local numbering continues across restarts
    expect(run.calls.map((c) => after(c.args, '-segment_start_number'))).toEqual(['0', '1', '1', '1', '1', '1', '1']);
    const text = playlist(streamKey);
    expect(uris(text)).toEqual(['0.ts', '1.ts']);
    const l = text.split('\n');
    expect(l.filter((x) => x === '#EXT-X-DISCONTINUITY')).toHaveLength(1);
    expect(l[l.indexOf('#EXT-X-DISCONTINUITY') + 3]).toBe('1.ts');
    // events as Task 27: the outage starts at the exit and ends with the first new segment
    const v = viewOf(streams, 'ch-hafenkanal');
    expect(v.errors).toEqual([{ at: NOW + 4_000, code: 'input_lost' }, { at: NOW + 97_000, code: 'input_back', seconds: 93 }]);
    expect(v.state).toBe('running');
  });

  it('a run that delivers a segment resets the backoff to 2 s', async () => {
    const quick: Plan = { exitAt: 0 };
    // fail, fail, then a run that produces a segment, then that run fails too
    const { run, streams } = setup([quick, quick, { out: [[4_000, '0.ts,0.000000,4.000000\n']], exitAt: 8_000 }, {}]);
    streams.start(body());
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(run.calls).toHaveLength(4);
    expect(gaps(run.calls)).toEqual([2_000, 4_000, 2_000]);
    expect(run.calls.map((c) => c.at - NOW)).toEqual([0, 2_000, 6_000, 16_000]);
    expect(run.calls.map((c) => after(c.args, '-segment_start_number'))).toEqual(['0', '0', '0', '1']);
    expect(viewOf(streams, 'ch-hafenkanal').errors).toEqual([
      { at: NOW, code: 'input_lost' },
      { at: NOW + 10_000, code: 'input_back', seconds: 10 },
      { at: NOW + 14_000, code: 'input_lost' },
    ]);
  });

  it('a stop ends ffmpeg and never restarts it', async () => {
    const { run, streams } = setup([{ out: [[4_000, '0.ts,0.000000,4.000000\n']] }]);
    streams.start(body());
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await streams.stop('ch-hafenkanal');
    expect(run.calls[0]!.o.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(run.calls).toHaveLength(1);
    expect(streams.list()).toEqual([]);
    expect(logs.join('\n')).not.toContain('input lost');
  });

  it('a stop during the start probe returns at once and aborts the probe', async () => {
    let seen: AbortSignal | undefined;
    const run = fakeFfmpeg([], mem.files);
    // a probe that would take its whole 10-s budget
    const slowProbe = (_input: StreamInput, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<ProbeResult>((r) => { setTimeout(() => r(H264), 10_000); });
    };
    const driver = remuxDriver({ run, guard: GUARD, probe: slowProbe, log: (m) => { logs.push(m); } });
    const streams = new Streams({ root: ROOT, maxBytes: 1024 ** 3, drivers: { remux: driver }, store: mem.store, log: (m) => { logs.push(m); } });
    current = streams;
    streams.start(body());
    await flush();
    expect(seen?.aborted).toBe(false);
    let stopped = false;
    const stopping = streams.stop('ch-hafenkanal').then(() => { stopped = true; });
    // no fake time passes: the stop does not wait for the probe
    await flush();
    expect(stopped).toBe(true);
    expect(seen?.aborted).toBe(true);
    await stopping;
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(run.calls).toHaveLength(0);
    expect(streams.list()).toEqual([]);
  });

  it('transcode that probes remuxable runs as remux', async () => {
    let probed = H264;
    const { run, streams } = setup([{}, {}, {}], () => probed);

    // H.264 + AAC: a requested transcode copies instead and reports remux (spec §7.4 step 4)
    streams.start(body({ channelId: 'ch-nordlicht', mode: 'transcode', encoder: 'h264_qsv' }));
    await flush();
    const a = run.calls[0]!.args;
    expect(has(a, ['-c:v', 'copy'])).toBe(true);
    expect(has(a, ['-c:a', 'copy'])).toBe(true);
    expect(a).not.toContain('h264_qsv');
    expect(a).not.toContain('-b:v');
    expect(viewOf(streams, 'ch-nordlicht').mode).toBe('remux');

    // HEVC + MP2 at 720 lines: a real transcode, 3M, AAC
    probed = HEVC_MP2;
    streams.start(body({ channelId: 'ch-bergblick', mode: 'transcode', encoder: 'h264_qsv' }));
    await flush();
    const b = run.calls[1]!.args;
    expect(has(b, ['-c:v', 'h264_qsv'])).toBe(true);
    expect(after(b, '-b:v')).toBe('3M');
    expect(has(b, ['-c:a', 'aac', '-ac', '2', '-b:a', '160k'])).toBe(true);
    expect(viewOf(streams, 'ch-bergblick').mode).toBe('transcode');

    // a failed probe never downgrades: transcode at the full rate
    probed = FAILED;
    streams.start(body({ channelId: 'ch-kinderinsel', mode: 'transcode', encoder: 'libx264' }));
    await flush();
    const c = run.calls[2]!.args;
    expect(has(c, ['-c:v', 'libx264'])).toBe(true);
    expect(after(c, '-b:v')).toBe('6M');
    expect(viewOf(streams, 'ch-kinderinsel').mode).toBe('transcode');
  });

  it('an encoder not in /v1/system.encoders is 400 encoder_unavailable', async () => {
    const { run, streams } = setup([{}]);
    const post = streamRoutes(streams, { encoders: async (): Promise<Encoder[]> => ['libx264'] })
      .find((r) => r.method === 'POST' && r.path === '/v1/streams')!;
    const handle = (json: unknown) => post.handle({ json, params: [] } as unknown as RouteCall);
    expect(await handle(body({ mode: 'transcode', encoder: 'h264_nvenc' }))).toEqual({ status: 400, json: { error: 'encoder_unavailable' } });
    expect(streams.list()).toEqual([]);
    // a registered mode no longer answers 422 (R6)
    expect(await handle(body({ mode: 'transcode', encoder: 'libx264' }))).toMatchObject({ status: 200 });
    await flush();
    expect(run.calls).toHaveLength(1);
  });

  it('no log line contains iptv.example.com or an ffmpeg argument', async () => {
    const { run, streams } = setup([
      { out: [[4_000, '0.ts,0.000000,4.000000\n']], exitAt: 4_000 },
      { exitAt: 0 },
      { out: [[4_000, '1.ts,0.000000,4.000000\n']] },
    ], () => HEVC_MP2);
    const { streamKey } = streams.start(body({ input: { url: SRT_URL, kind: 'srt', allowLan: false }, mode: 'transcode', encoder: 'h264_vaapi' }));
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(run.calls).toHaveLength(3);
    expect(viewOf(streams, 'ch-hafenkanal').errors.map((e) => e.code)).toEqual(['input_lost', 'input_back']);
    // ffmpeg's stderr reaches the log only through run.ts (scrubLine), named by the channel id
    for (const c of run.calls) expect(c.o.stderrLog?.channelId).toBe('ch-hafenkanal');
    run.calls[0]!.o.stderrLog!.log('stream ch-hafenkanal ffmpeg: Conversion failed!');
    expect(logs.some((l) => l.includes('Conversion failed!'))).toBe(true);
    const text = logs.join('\n');
    expect(text).toContain('ch-hafenkanal');
    expect(text).not.toMatch(/iptv\.example\.com|192\.0\.2\.40|geheim|streamid|passphrase/);
    expect(text).not.toContain(streamKey);
    for (const c of run.calls) {
      expect(has(c.args, ['-i', SRT_LITERAL])).toBe(true);
      expect(text).not.toContain(c.args.join(' '));
      for (const x of carrying(c.args)) expect([x, text.includes(x)]).toEqual([x, false]);
    }
  });

  // The stall watchdog (Task 28 review finding, ruled into Task 29's branch): a run is aborted when no segment line arrived for
  // STALL_MS while ffmpeg runs; the reconnect loop restarts it. A player polling the playlist (touch) keeps the 180-s safety net
  // away, so only the watchdog can end a frozen run.
  it('watchdog: a slow but alive ffmpeg is never cut', async () => {
    // about 3 segment durations + 20 s
    expect(STALL_MS).toBe(3 * SEGMENT_SECONDS * 1000 + 20_000);
    // a segment line every STALL_MS − 2 s, the first one too: slower than real time, but alive
    const every = STALL_MS - 2_000;
    const out: Array<[number, string]> = Array.from({ length: 10 }, (_, i) => [(i + 1) * every, `${i}.ts,${i * 4}.000000,${i * 4 + 4}.000000\n`]);
    const { run, streams } = setup([{ out }]);
    const { streamKey } = streams.start(body());
    await flush();
    for (let t = 0; t < 10 * every + 1_000; t += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      streams.touch(streamKey);
    }
    await flush();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.o.signal?.aborted).toBe(false);
    expect(run.calls[0]!.endedAt).toBeNull();
    expect(uris(playlist(streamKey))).toEqual(Array.from({ length: 10 }, (_, i) => `${i}.ts`));
    expect(viewOf(streams, 'ch-hafenkanal')).toMatchObject({ state: 'running', errors: [] });
  });

  it('watchdog: a frozen ffmpeg is cut and restarted with a discontinuity', async () => {
    const { run, streams } = setup([
      // two segments, then it hangs: still running (maybe still reading input), but no line any more
      { out: [[4_000, '0.ts,0.000000,4.000000\n'], [8_000, '1.ts,4.000000,8.000000\n']] },
      // hangs from its start: not even a first segment
      {},
      { out: [[4_000, '2.ts,0.000000,4.000000\n']] },
    ]);
    const { streamKey } = streams.start(body());
    await flush();
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      streams.touch(streamKey);
    }
    await flush();
    expect(run.calls).toHaveLength(3);
    const [a, b, c] = run.calls as [Call, Call, Call];
    // the first run is cut STALL_MS (allowing a coarse check: up to 5 s more) after its last line; only the run is aborted
    expect(a.o.signal?.aborted).toBe(true);
    expect(a.endedAt! - (NOW + 8_000)).toBeGreaterThanOrEqual(STALL_MS);
    expect(a.endedAt! - (NOW + 8_000)).toBeLessThanOrEqual(STALL_MS + 5_000);
    // the second one STALL_MS after its start
    expect(b.o.signal?.aborted).toBe(true);
    expect(b.endedAt! - b.at).toBeGreaterThanOrEqual(STALL_MS);
    expect(b.endedAt! - b.at).toBeLessThanOrEqual(STALL_MS + 5_000);
    // the third delivers and runs on
    expect(c.endedAt).toBeNull();
    expect(c.o.signal?.aborted).toBe(false);
    // the reconnect loop's backoff: 2 s, then 4 s (the second run delivered nothing); numbering continues
    expect(gaps(run.calls)).toEqual([2_000, 4_000]);
    expect(run.calls.map((x) => after(x.args, '-segment_start_number'))).toEqual(['0', '2', '2']);
    const text = playlist(streamKey);
    expect(uris(text)).toEqual(['0.ts', '1.ts', '2.ts']);
    const l = text.split('\n');
    expect(l.filter((x) => x === '#EXT-X-DISCONTINUITY')).toHaveLength(1);
    expect(l[l.indexOf('#EXT-X-DISCONTINUITY') + 3]).toBe('2.ts');
    const v = viewOf(streams, 'ch-hafenkanal');
    expect(v.errors.map((e) => e.code)).toEqual(['input_lost', 'input_back']);
    expect(v.errors[0]!.at).toBe(a.endedAt);
    expect(v.state).toBe('running');
  });
});

describe('start', () => {
  it('registers the remux and transcode drivers; transcode needs an encoder of /v1/system', async () => {
    const free = await new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const n = (s.address() as AddressInfo).port; s.close(() => r(n)); }); });
    const secret = 'start-remux-secret-0123456789ab';
    const s = await start({ PORT: String(free), INTERNAL_SECRET: secret, LIVETV_SRT_PORTS: '9000' }, { log: () => {}, host: '127.0.0.1' });
    const k = deriveKey(secret);
    const call = (method: string, path: string, b?: unknown) => {
      const text = b === undefined ? '' : JSON.stringify(b);
      return fetch(`http://127.0.0.1:${free}${path}`, { method, ...(text ? { body: text } : {}), headers: { ...sign(k, method, path, text), ...(text ? { 'content-type': 'application/json' } : {}) } });
    };
    try {
      const start = { channelId: 'ch-sternwarte', input: { url: 'srt://192.0.2.40:9000?streamid=geheim', kind: 'srt', allowLan: false }, encoder: 'libx264', dvrSeconds: 60, maxBitrate: 10_000_000 };
      // no ffmpeg here: /v1/system lists no encoder, so a transcode is refused before anything starts
      const t = await call('POST', '/v1/streams', { ...start, mode: 'transcode' });
      expect([t.status, await t.json()]).toEqual([400, { error: 'encoder_unavailable' }]);
      const r = await call('POST', '/v1/streams', { ...start, mode: 'remux' });
      expect(r.status).toBe(200);
      expect((await call('DELETE', '/v1/streams/ch-sternwarte')).status).toBe(204);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
