// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FetchError, type GuardDeps } from '../src/fetch.js';
import { START_PROBE_MS, type ProbeResult, type StreamInput } from '../src/probe.js';
import { AUDIO_TRIES, probedPassthrough, remuxDriver } from '../src/remux.js';
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
  function setup(routes: Map<string, Served>, runs: number, answer: (n: number, o: RunOpts) => Promise<string> = async () => '') {
    const ff = fakeFetch(routes);
    const seen: { args: string[]; audio: boolean }[] = [];
    const ac = new AbortController();
    const run = vi.fn(async (_c: string, args: string[], o: RunOpts) => {
      seen.push({ args, audio: o.audioStdin !== undefined });
      const stdout = await answer(seen.length, o);
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
  const NO_AUDIO = 'separate audio rendition unavailable, playing the video without it';

  it('a refused rendition (fatal): the video runs at once without it, its own audio made AAC; logged once, no URL', async () => {
    const routes = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, pl('v')], [`${base}/v1.ts`, Buffer.alloc(188, 1)],
      [`${base}/de.m3u8`, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4.0,\na1.ts\n']]);
    const s = setup(routes, 1);
    await s.driver(s.c, AAC);
    expect(s.seen).toHaveLength(1);
    expect(videoOnly(s.seen[0]!.args)).toBe(true);
    expect(s.seen[0]!.audio).toBe(false);
    expect(s.logs).toEqual([NO_AUDIO]);
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

  it('runs with the rendition that deliver no segment: after AUDIO_TRIES the next run is without it; a working run tries it again', async () => {
    const routes = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, pl('v')], [`${base}/v1.ts`, Buffer.alloc(188, 1)],
      [`${base}/de.m3u8`, pl('a')], [`${base}/a1.ts`, Buffer.alloc(100, 2)]]);
    // runs 1 and 2 (with audio) fail, run 3 (without) delivers a segment, run 4 has the audio again
    const s = setup(routes, 4, async (n) => (n === 3 ? '0.ts,0.0,4.0\n' : ''));
    await s.driver(s.c, AAC);
    expect(s.seen.map((r) => r.audio)).toEqual([true, true, false, true]);
    expect(videoOnly(s.seen[2]!.args)).toBe(true);
    expect(s.seen[3]!.args.join(' ')).toContain('-map 0:v:0 -map 1:a:0?');
    expect(s.logs).toEqual([NO_AUDIO]);
  });

  it('an audio segment failing mid-run ends the video pipe too; ffmpeg restarts with a discontinuity', async () => {
    const routes = new Map<string, Served>([[`${base}/master.m3u8`, MASTER('de.m3u8')], [`${base}/v.m3u8`, pl('v')],
      [`${base}/de.m3u8`, pl('a')], [`${base}/a1.ts`, Buffer.alloc(100, 2)], [`${base}/a2.ts`, new FetchError('unreachable')], [`${base}/a3.ts`, Buffer.alloc(100, 2)]]);
    for (let n = 1; n <= 3; n++) routes.set(`${base}/v${n}.ts`, Buffer.alloc(188, n));
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
    await s.driver(s.c, AAC);
    expect(ended).toEqual(['audio failed', 'video ended']);
    expect(s.seen.map((r) => r.audio)).toEqual([true, true]);
    expect(s.segment).toHaveBeenCalledWith(expect.objectContaining({ file: '0.ts', discontinuity: true }));
  });
});
