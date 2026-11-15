// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FetchError, type GuardDeps } from '../src/fetch.js';
import { SEGMENT_RETRY_MS } from '../src/inputs.js';
import { START_PROBE_MS, type ProbeResult, type StreamInput } from '../src/probe.js';
import { AUDIO_FAULTS, AUDIO_FAULT_WINDOW_MS, AUDIO_HEALTHY_SEGMENTS, AUDIO_TRIES, probedPassthrough, remuxDriver } from '../src/remux.js';
import type { Driver, DriverContext } from '../src/streams.js';
import { fakeFetch, type Served } from './streams-helpers.js';

const GUARD: GuardDeps = { own: [], lookup: async () => ['192.0.2.40'] };
const input: StreamInput = { url: 'http://iptv.example.com/live/nordlicht/master.m3u8', kind: 'hls', allowLan: false };
const video = { codec: 'h264', width: 1280, height: 720, fps: 25 };
const AAC: ProbeResult = { ok: true, video, audio: { codec: 'aac', channels: 2 }, needs: 'passthrough' };
const MP2: ProbeResult = { ok: true, video, audio: { codec: 'mp2', channels: 2 }, needs: 'remux' };
const HEVC: ProbeResult = { ok: true, video: { ...video, codec: 'hevc' }, audio: { codec: 'aac', channels: 2 }, needs: 'transcode' };

function ctx(signal = new AbortController().signal) {
  const runsAs = vi.fn();
  const fail = vi.fn();
  const window = vi.fn();
  const c = { input, signal, mode: 'passthrough', channelId: 'hafenkanal', runsAs, fail, window, maxBitrate: 1, log: () => {} } as unknown as DriverContext;
  return { c, runsAs, fail };
}

describe('probedPassthrough', () => {
  const setup = (result: ProbeResult | Error) => {
    const probe = vi.fn(async () => { if (result instanceof Error) throw result; return result; });
    const media = vi.fn(async () => {});
    const pass = vi.fn<Driver>(async () => {});
    const driver = probedPassthrough({ run: vi.fn(), guard: GUARD, probe }, media, pass);
    return { probe, media, pass, driver };
  };

  it('AAC audio: the passthrough driver runs', async () => {
    const s = setup(AAC);
    const { c, runsAs } = ctx();
    await s.driver(c);
    expect(s.pass).toHaveBeenCalledWith(c);
    expect(s.media).not.toHaveBeenCalled();
    expect(runsAs).not.toHaveBeenCalled();
  });

  it('MP2 audio: runs as remux through the media driver, which gets the facts', async () => {
    const s = setup(MP2);
    const { c } = ctx();
    await s.driver(c);
    expect(s.pass).not.toHaveBeenCalled();
    expect(s.media).toHaveBeenCalledWith(c, MP2);
    expect(s.probe).toHaveBeenCalledTimes(1);
  });

  it('a failed or throwing probe, and a transcode verdict, stay plain passthrough', async () => {
    for (const r of [{ ok: false, needs: 'transcode', error: 'timeout' } as ProbeResult, new Error('boom'), HEVC]) {
      const s = setup(r);
      await s.driver(ctx().c);
      expect(s.pass).toHaveBeenCalledTimes(1);
      expect(s.media).not.toHaveBeenCalled();
    }
  });

  it('I4/M4: the start probe has the 5-s start budget and the stream\'s variant limit', async () => {
    const s = setup(AAC);
    const { c } = ctx();
    await s.driver(c);
    expect(s.probe).toHaveBeenCalledWith(input, c.signal, expect.objectContaining({ budgetMs: START_PROBE_MS, maxBitrate: 1 }));
    expect(START_PROBE_MS).toBe(5_000);
  });

  it('I3: a probe that failed after the master showed a separate audio rendition runs the remux (never the silent passthrough)', async () => {
    for (const result of [{ ok: false, needs: 'transcode', error: 'timeout' } as ProbeResult, new Error('boom')]) {
      const probe = vi.fn(async (_i: StreamInput, _s: AbortSignal, o?: { onSeparateAudio?: () => void }) => {
        o?.onSeparateAudio?.();
        if (result instanceof Error) throw result;
        return result;
      });
      const media = vi.fn(async () => {});
      const pass = vi.fn<Driver>(async () => {});
      const { c } = ctx();
      await probedPassthrough({ run: vi.fn(), guard: GUARD, probe }, media, pass)(c);
      expect(pass).not.toHaveBeenCalled();
      expect(media).toHaveBeenCalledWith(c, expect.objectContaining({ ok: false }));
    }
  });

  it('4: a failed start probe is logged once, in fixed words (its code, no URL)', async () => {
    const s = setup({ ok: false, needs: 'transcode', error: 'timeout' });
    const logs: string[] = [];
    await s.driver({ ...ctx().c, log: (m: string) => logs.push(m) } as unknown as DriverContext);
    expect(logs).toEqual(['start probe failed (timeout), passing through']);
    expect(s.pass).toHaveBeenCalledTimes(1);
  });

  it('a stop while the probe is still running ends the driver without starting either one', async () => {
    const ac = new AbortController();
    let answer: (r: ProbeResult) => void = () => {};
    const probe = vi.fn(() => new Promise<ProbeResult>((r) => { answer = r; }));
    const media = vi.fn(async () => {});
    const pass = vi.fn<Driver>(async () => {});
    const done = probedPassthrough({ run: vi.fn(), guard: GUARD, probe }, media, pass)(ctx(ac.signal).c);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await done;
    answer(MP2);
    await new Promise((r) => setTimeout(r, 10));
    expect(pass).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
  });

  it('a stop during the probe ends the driver', async () => {
    const ac = new AbortController();
    const s = setup(AAC);
    ac.abort();
    await s.driver(ctx(ac.signal).c);
    expect(s.pass).not.toHaveBeenCalled();
    expect(s.media).not.toHaveBeenCalled();
  });
});

describe('remuxDriver with known facts', () => {
  it('reports remux for a passthrough request and does not probe again', async () => {
    const probe = vi.fn(async () => MP2);
    const fetch = vi.fn(async () => { throw new FetchError('scheme'); });
    const driver = remuxDriver({ run: vi.fn(), guard: GUARD, probe, fetch });
    const { c, runsAs, fail } = ctx();
    await driver(c, MP2);
    expect(probe).not.toHaveBeenCalled();
    expect(runsAs).toHaveBeenCalledWith('remux');
    expect(fail).toHaveBeenCalledWith('scheme');
  });
});

describe('remuxDriver with a separate audio rendition', () => {
  it('starts ffmpeg with two pipe inputs, mapped video 0 and audio 1, both fed by livetv', async () => {
    const base = 'http://iptv.example.com/live/nordlicht';
    const pl = (seg: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4.0,\n${seg}\n`;
    const ff = fakeFetch(new Map<string, Served>([
      [`${base}/master.m3u8`, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="de.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="a"\nv.m3u8\n'],
      [`${base}/v.m3u8`, pl('v1.ts')], [`${base}/v1.ts`, Buffer.alloc(188, 1)],
      [`${base}/de.m3u8`, pl('a1.aac')], [`${base}/a1.aac`, Buffer.alloc(100, 2)],
    ]));
    const seen: { args: string[]; video: number; audio: number }[] = [];
    const run = vi.fn(async (_c: string, args: string[], o: { stdin?: AsyncIterable<Uint8Array>; audioStdin?: AsyncIterable<Uint8Array> }) => {
      const first = async (src?: AsyncIterable<Uint8Array>) => {
        if (!src) return 0;
        const it = src[Symbol.asyncIterator]();
        const r = await it.next();
        await it.return?.();
        return r.done ? 0 : r.value.length;
      };
      seen.push({ args, video: await first(o.stdin), audio: await first(o.audioStdin) });
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    });
    const ac = new AbortController();
    const c = { ...ctx(ac.signal).c, window: vi.fn(), back: vi.fn(), lost: () => 1, sleep: async () => { ac.abort(); return false; }, bitrate: vi.fn(), encoder: 'libx264', dir: '/cache/k', segment: vi.fn() } as unknown as DriverContext;
    (c as { input: StreamInput }).input = { url: `${base}/master.m3u8`, kind: 'hls', allowLan: false };
    const driver = remuxDriver({ run: run as never, guard: GUARD, probe: async () => MP2, fetch: ff.fetch });
    await driver(c);
    expect(seen).toHaveLength(1);
    const a = seen[0]!.args;
    expect(a.filter((x) => x === '-i')).toHaveLength(2);
    expect(a.join(' ')).toContain('-i pipe:0');
    expect(a.join(' ')).toContain('-i pipe:3');
    expect(a.join(' ')).toContain('-map 0:v:0 -map 1:a:0');
    expect(seen[0]!.video).toBe(188);
    expect(seen[0]!.audio).toBe(100);
    expect(ff.calls.map((x) => x.url)).toContain(`${base}/de.m3u8`);
  });
});

describe('remuxDriver: a separate audio rendition that fails (I3, M3)', () => {
  const base = 'http://iptv.example.com/live/nordlicht';
  const pl = (prefix: string, from = 1, n = 3) =>
    `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${from}\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.0,\n${prefix}${from + i}.ts`).join('\n')}\n`;
  const MASTER = (audio: string) => `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="${audio}"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="a"\nv.m3u8\n`;
  /** a driver context that stops after `runs` ffmpeg runs; logs, sleeps and segments are recorded */
  function setup(routes: Map<string, Served>, runs: number, answer: (n: number, o: RunOpts & { args?: string[] }) => Promise<string> = async () => '') {
    const ff = fakeFetch(routes);
    const seen: { args: string[]; audio: boolean }[] = [];
    const ac = new AbortController();
    const run = vi.fn(async (_c: string, args: string[], o: RunOpts) => {
      seen.push({ args, audio: o.audioStdin !== undefined });
      const stdout = await answer(seen.length, { ...o, args });
      if (stdout) o.onStdout?.(Buffer.from(stdout));
      return { code: stdout ? 0 : 1, stdout: Buffer.alloc(0), stderr: '' };
    });
    const logs: string[] = [];
    const sleeps: number[] = [];
    const segment = vi.fn(async () => 0);
    const c = {
      ...ctx(ac.signal).c, input: { url: `${base}/master.m3u8`, kind: 'hls', allowLan: false }, mode: 'remux', window: vi.fn(), back: vi.fn(),
      lost: () => 2_000, sleep: async (ms: number) => { sleeps.push(ms); return seen.length < runs; }, bitrate: vi.fn(), encoder: 'libx264',
      dir: '/cache/k', segment, log: (m: string) => logs.push(m),
    } as unknown as DriverContext;
    const driver = remuxDriver({ run: run as never, guard: GUARD, fetch: ff.fetch, size: async () => 100 });
    return { driver, c, seen, logs, sleeps, segment, ff };
  }
  type RunOpts = { stdin?: AsyncIterable<Uint8Array>; audioStdin?: AsyncIterable<Uint8Array>; onStdout?: (c: Buffer) => void };
  const videoOnly = (args: string[]) => !args.includes('pipe:3') && args.join(' ').includes('-map 0:v:0 -map 0:a:0?') && args.join(' ').includes('-c:a aac');
  const NO_AUDIO = 'separate audio rendition unavailable, playing the video without it; trying it again in 3 min';

  it('a refused rendition (fatal): the video runs at once without it, its own audio made AAC; logged once, no URL', async () => {
    const routes = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, pl('v')], [`${base}/v1.ts`, Buffer.alloc(188, 1)],
      [`${base}/de.m3u8`, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4.0,\na1.ts\n']]);
    const s = setup(routes, 1);
    await s.driver(s.c, AAC);
    expect(s.seen).toHaveLength(1);
    expect(videoOnly(s.seen[0]!.args)).toBe(true);
    expect(s.seen[0]!.audio).toBe(false);
    expect(s.logs.filter((l) => !l.startsWith('run ended'))).toEqual([NO_AUDIO]);
    // no backoff before the video-only run (the one sleep is after it, where the test stops the stream)
    expect(s.sleeps).toHaveLength(1);
  });

  it(`a rendition playlist that is gone: retried once after the backoff, then the video runs without it (${AUDIO_TRIES} tries)`, async () => {
    const routes = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, pl('v')], [`${base}/v1.ts`, Buffer.alloc(188, 1)]]);
    const s = setup(routes, 1);
    await s.driver(s.c, AAC);
    expect(s.ff.calls.filter((x) => x.url === `${base}/de.m3u8`)).toHaveLength(AUDIO_TRIES);
    expect(s.seen).toHaveLength(1);
    expect(videoOnly(s.seen[0]!.args)).toBe(true);
    expect(s.sleeps[0]).toBe(2_000);
  });

  /** a run: ffmpeg reads both inputs to their end, then `segs` segment lines (numbered from the run's start number) */
  const delivering = (segs: (n: number) => number) => async (n: number, o: RunOpts & { args?: string[] }) => {
    // a paired run reads until one side fails and ends both; a video-only one (it would follow the playlist forever) just stops
    if (o.audioStdin) await Promise.all([drainQuiet(o.stdin), drainQuiet(o.audioStdin)]);
    const from = Number(o.args?.[o.args.indexOf('-segment_start_number') + 1] ?? 0);
    return Array.from({ length: segs(n) }, (_, i) => `${from + i}.ts,0.0,4.0\n`).join('');
  };
  async function drainQuiet(src?: AsyncIterable<Uint8Array>) {
    try { if (src) for await (const _ of src) { /* read */ } } catch { /* ended by failing */ }
  }
  /**
   * both playlists grow by a segment every 2 s (fake time) from 1..3; the failing side loads only every 4th segment (1, 5, 9, …):
   * SEGMENT_FAILS in a row end each of its runs, also the ones that resume further on (item 3)
   */
  const routesWith = (fail: 'audio' | 'video') => {
    const t0 = Date.now();
    const grown = (prefix: string) => () => pl(prefix, 1, 3 + Math.floor((Date.now() - t0) / 2_000));
    const r = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, grown('v')], [`${base}/de.m3u8`, grown('a')]]);
    for (let n = 1; n <= 400; n++) {
      const bad = n % 4 !== 1;
      r.set(`${base}/v${n}.ts`, fail === 'video' && bad ? new FetchError('unreachable') : Buffer.alloc(188, n % 256));
      r.set(`${base}/a${n}.ts`, fail === 'audio' && bad ? new FetchError('unreachable') : Buffer.alloc(100, n % 256));
    }
    return r;
  };
  /** `p` with fake timers moved on until it settles (a failed segment is asked for again after SEGMENT_RETRY_MS) */
  async function settled<T>(p: Promise<T>): Promise<T> {
    let done = false;
    void p.finally(() => { done = true; }).catch(() => undefined);
    for (let i = 0; i < 2_000 && !done; i++) await vi.advanceTimersByTimeAsync(SEGMENT_RETRY_MS);
    return p;
  }
  const faked = (fn: () => Promise<void>) => async () => {
    vi.useFakeTimers();
    try { await fn(); } finally { vi.useRealTimers(); }
  };

  it('1a: runs the VIDEO ends (its segments failing) never count against the rendition: it is kept', faked(async () => {
    const s = setup(routesWith('video'), 4, delivering(() => 0));
    await settled(s.driver(s.c, AAC));
    expect(s.seen.map((r) => r.audio)).toEqual([true, true, true, true]);
    expect(s.logs.filter((l) => l.includes('unavailable'))).toEqual([]);
  }));

  it('2: a rendition that fails after a segment or two each run is left out after AUDIO_TRIES runs (the count is not reset by them)', faked(async () => {
    const s = setup(routesWith('audio'), 3, delivering(() => 1));
    await settled(s.driver(s.c, AAC));
    expect(s.seen.map((r) => r.audio)).toEqual([true, true, false]);
    expect(videoOnly(s.seen[2]!.args)).toBe(true);
    // item 6: every restart with its number and reason, none folded into the one before
    expect(s.logs.filter((l) => !l.includes('segment skipped'))).toEqual([
      'run ended (audio segments_failed), restart #1', 'run ended (audio segments_failed), restart #2', NO_AUDIO, 'run ended (ffmpeg_exit), restart #3',
    ]);
  }));

  it(`2: a run with ${AUDIO_HEALTHY_SEGMENTS} segments starts the count again; ${AUDIO_FAULTS} blamed runs within ${AUDIO_FAULT_WINDOW_MS / 60_000} min leave it out anyway`, faked(async () => {
    // 1 segment + fault, 5 + fault (count back to 1), 1 + fault (2: out)
    const a = setup(routesWith('audio'), 4, delivering((n) => (n === 2 ? AUDIO_HEALTHY_SEGMENTS : 1)));
    await settled(a.driver(a.c, AAC));
    expect(a.seen.map((r) => r.audio)).toEqual([true, true, true, false]);
    // healthy runs that each end by an audio fault: out after AUDIO_FAULTS of them
    const b = setup(routesWith('audio'), AUDIO_FAULTS + 1, delivering(() => AUDIO_HEALTHY_SEGMENTS));
    await settled(b.driver(b.c, AAC));
    expect(b.seen.map((r) => r.audio)).toEqual([...Array(AUDIO_FAULTS).fill(true), false]);
  }));

  it('1b: a left-out rendition is tried again after 3 min, again after 6 more when it still fails; the video-only run is ended for it (no backoff)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      let usable = false;
      const ENCRYPTED = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4.0,\na1.ts\n';
      const routes = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, pl('v')], [`${base}/de.m3u8`, () => (usable ? pl('a') : ENCRYPTED)]]);
      for (let n = 1; n <= 3; n++) { routes.set(`${base}/v${n}.ts`, Buffer.alloc(188, n)); routes.set(`${base}/a${n}.ts`, Buffer.alloc(100, n)); }
      const seen: boolean[] = [];
      const run = vi.fn(async (_c: string, args: string[], o: RunOpts & { signal?: AbortSignal }) => {
        seen.push(o.audioStdin !== undefined);
        // a working run: a segment every 4 s until it is ended
        let n = Number(args[args.indexOf('-segment_start_number') + 1]);
        const t = setInterval(() => o.onStdout?.(Buffer.from(`${n++}.ts,0.0,4.0\n`)), 4_000);
        await new Promise<void>((r) => { if (o.signal?.aborted) r(); else o.signal?.addEventListener('abort', () => r(), { once: true }); });
        clearInterval(t);
        return { code: 1, stdout: Buffer.alloc(0), stderr: '' };
      });
      const ac = new AbortController();
      const logs: string[] = [];
      const sleeps: number[] = [];
      const segment = vi.fn(async (_s: { discontinuity?: boolean }) => 0);
      const c = {
        ...ctx(ac.signal).c, input: { url: `${base}/master.m3u8`, kind: 'hls', allowLan: false }, mode: 'remux', window: vi.fn(), back: vi.fn(),
        lost: () => 2_000, sleep: async (ms: number) => { sleeps.push(ms); return false; }, bitrate: vi.fn(), encoder: 'libx264',
        dir: '/cache/k', segment, log: (m: string) => logs.push(m),
      } as unknown as DriverContext;
      const done = remuxDriver({ run: run as never, guard: GUARD, fetch: fakeFetch(routes).fetch, size: async () => 100 })(c, AAC);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toEqual([false]);
      // 3 min: tried again, still encrypted: out again, now for 6 min
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(seen).toEqual([false, false]);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(seen).toEqual([false, false]);
      usable = true;
      await vi.advanceTimersByTimeAsync(66_000);
      expect(seen).toEqual([false, false, true]);
      expect(run.mock.calls[2]![1].join(' ')).toContain('-map 0:v:0 -map 1:a:0?');
      expect(logs.filter((l) => !l.startsWith('run ended'))).toEqual([
        NO_AUDIO, 'separate audio: trying the rendition again',
        'separate audio rendition unavailable, playing the video without it; trying it again in 6 min', 'separate audio: trying the rendition again',
      ]);
      // ended on purpose: no outage, no backoff; each new run starts with a discontinuity
      expect(sleeps).toEqual([]);
      expect(segment.mock.calls.filter(([x]) => x.discontinuity)).toHaveLength(2);
      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('audio segments failing mid-run end the video pipe too; ffmpeg restarts with a discontinuity', faked(async () => {
    const routes = routesWith('audio');
    const ended: string[] = [];
    const s = setup(routes, 2, async (n, o) => {
      if (n === 2) return '0.ts,0.0,4.0\n';
      // ffmpeg reads one video segment, then the audio until it fails, then the video again: it ends without waiting
      const v = o.stdin![Symbol.asyncIterator]();
      await v.next();
      try { for await (const _ of o.audioStdin!) { /* read */ } } catch { ended.push('audio failed'); }
      const r = await Promise.race([v.next(), new Promise((res) => setTimeout(() => res('hangs'), 2_000))]);
      ended.push(r === 'hangs' ? 'video hangs' : (r as IteratorResult<Uint8Array>).done ? 'video ended' : 'video goes on');
      return '';
    });
    await settled(s.driver(s.c, AAC));
    expect(ended).toEqual(['audio failed', 'video ended']);
    expect(s.seen.map((r) => r.audio)).toEqual([true, true]);
    expect(s.segment).toHaveBeenCalledWith(expect.objectContaining({ file: '0.ts', discontinuity: true }));
  }));
});
