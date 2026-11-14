// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FetchError, type GuardDeps } from '../src/fetch.js';
import type { ProbeResult, StreamInput } from '../src/probe.js';
import { probedPassthrough, remuxDriver } from '../src/remux.js';
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
