// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FetchError, type FetchOptions, type GuardDeps, type GuardedResponse } from '../src/fetch.js';
import { alignStart, openInput } from '../src/inputs.js';
import { parseMedia } from '../src/passthrough.js';

const GUARD: GuardDeps = { own: [], lookup: async () => ['192.0.2.40'] };
const T = Date.parse('2026-11-14T12:00:00.000Z');

/** a live media playlist: `n` segments from `seq` (`<prefix><seq>.ts`), with date-times from `pdt` and discontinuities before `disc` */
function pl(seq: number, n: number, o: { target?: number; dur?: number; pdt?: number; disc?: number[]; prefix?: string } = {}): string {
  const dur = o.dur ?? 4;
  const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${o.target ?? dur}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  for (let i = 0; i < n; i++) {
    if (o.disc?.includes(seq + i)) lines.push('#EXT-X-DISCONTINUITY');
    if (o.pdt !== undefined) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(o.pdt + i * dur * 1000).toISOString()}`);
    lines.push(`#EXTINF:${dur.toFixed(1)},`, `${o.prefix ?? 's'}${seq + i}.ts`);
  }
  return `${lines.join('\n')}\n`;
}
const P = (...a: Parameters<typeof pl>) => parseMedia(pl(...a))!;

describe('alignStart (I1)', () => {
  it('by media sequence: equal windows, an audio window one ahead or one behind → both start at the same number', () => {
    expect(alignStart(P(10, 6), P(10, 6))).toEqual({ video: 13, audio: 13, shift: 0, by: 'sequence' });
    // audio one ahead (its live edge is 16, the video's 15): the newest 3 both have are 13..15
    expect(alignStart(P(10, 6), P(11, 6))).toEqual({ video: 13, audio: 13, shift: 0, by: 'sequence' });
    // audio one behind (its live edge is 14): 12..14, the video starts one further back
    expect(alignStart(P(10, 6), P(9, 6))).toEqual({ video: 12, audio: 12, shift: 0, by: 'sequence' });
    // date-times that agree do not change it
    expect(alignStart(P(10, 6, { pdt: T }), P(11, 6, { pdt: T + 4000 }))).toEqual({ video: 13, audio: 13, shift: 0, by: 'sequence' });
  });

  it('a discontinuity among the start segments: both start at it (no timestamp jump inside the start)', () => {
    expect(alignStart(P(10, 6, { disc: [14] }), P(10, 6, { disc: [14] }))).toMatchObject({ video: 14, audio: 14, by: 'sequence' });
    // one in an older segment changes nothing
    expect(alignStart(P(10, 6, { disc: [11] }), P(10, 6, { disc: [11] }))).toMatchObject({ video: 13, audio: 13 });
  });

  it('sequences that do not correspond → by program date-time, the rest as shift', () => {
    // no common numbers at all: the audio counts from 1000, its first segment 4 s before the video's
    expect(alignStart(P(10, 6, { pdt: T }), P(1000, 6, { pdt: T - 4000 }))).toEqual({ video: 13, audio: 1004, shift: 0, by: 'pdt' });
    // its segments start 300 ms after the video's: the nearest one, the audio moved 0.3 s later
    expect(alignStart(P(10, 6, { pdt: T }), P(1000, 6, { pdt: T - 3700 }))).toEqual({ video: 13, audio: 1004, shift: 0.3, by: 'pdt' });
    // ... 300 ms before: moved 0.3 s earlier (ffmpegArgs then moves the video later)
    expect(alignStart(P(10, 6, { pdt: T }), P(1000, 6, { pdt: T - 4300 }))).toEqual({ video: 13, audio: 1004, shift: -0.3, by: 'pdt' });
    // common numbers but date-times 8 s apart: the numbers mean different times
    expect(alignStart(P(10, 6, { pdt: T }), P(10, 6, { pdt: T + 8000 }))).toEqual({ video: 13, audio: 11, shift: 0, by: 'pdt' });
    // 6-s video segments, 2-s audio segments with the same numbers: counting segments would start 12 s apart
    expect(alignStart(P(10, 6, { dur: 6, pdt: T }), P(10, 18, { dur: 2, pdt: T }))).toEqual({ video: 13, audio: 19, shift: 0, by: 'pdt' });
    // an audio window that lags behind: an older video segment is taken
    expect(alignStart(P(10, 6, { pdt: T }), P(1000, 3, { pdt: T - 4000 }))).toEqual({ video: 11, audio: 1002, shift: 0, by: 'pdt' });
  });

  it('nothing to go by → null (each starts at its own live edge)', () => {
    expect(alignStart(P(10, 6), P(1000, 6))).toBeNull();
    expect(alignStart(P(10, 6, { pdt: T }), P(1000, 6))).toBeNull();
    expect(alignStart(P(10, 6, { pdt: T }), P(1000, 6, { pdt: T + 600_000 }))).toBeNull();
    expect(alignStart(P(10, 6), parseMedia('#EXTM3U\n#EXT-X-TARGETDURATION:4\n')!)).toBeNull();
  });
});

type Route = string | Buffer | FetchError | (() => string | Buffer | FetchError);
/** a provider: `routes` by URL, `moved` sends a URL on to another (a redirect: the response carries the final URL) */
function provider(routes: Map<string, Route>, moved = new Map<string, string>()) {
  const calls: string[] = [];
  let audioAsked: () => void = () => {};
  const audioRequested = new Promise<void>((r) => { audioAsked = r; });
  const fetch = async (url: string, o: FetchOptions): Promise<GuardedResponse> => {
    calls.push(url);
    if (o.signal?.aborted) throw new FetchError('unreachable');
    if (/audio.*\.m3u8$/.test(url)) audioAsked();
    const final = moved.get(url) ?? url;
    const r = routes.get(final);
    if (r === undefined) throw new FetchError('not_found');
    const v = typeof r === 'function' ? r() : r;
    if (v instanceof FetchError) throw v;
    const buf = Buffer.from(v);
    return { status: 200, url: final, headers: {}, body: (async function* () { yield buf; })() };
  };
  return { calls, fetch, audioRequested };
}

const BASE = 'http://iptv.example.com/live/nordlicht';
const MASTER = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch",DEFAULT=YES,URI="audio/de.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"', 'video/index.m3u8'].join('\n');
/** segments named after their rendition and number, so the bytes say which one came */
function segments(routes: Map<string, Route>, from: number, to: number) {
  for (let n = from; n <= to; n++) {
    routes.set(`${BASE}/video/v${n}.ts`, `v${n};`);
    routes.set(`${BASE}/audio/a${n}.ts`, `a${n};`);
  }
}
async function first(src: AsyncIterable<Uint8Array>): Promise<string> {
  const it = src[Symbol.asyncIterator]();
  const r = await it.next();
  return r.done ? '' : Buffer.from(r.value).toString();
}
/** everything `src` gives until it ends; `error` is set when it ended by failing */
async function drain(src: AsyncIterable<Uint8Array>): Promise<{ text: string; error?: unknown }> {
  let text = '';
  try {
    for await (const c of src) text += Buffer.from(c).toString();
    return { text };
  } catch (error) {
    return { text, error };
  }
}

describe('openInput with a separate audio rendition (I1)', () => {
  it('reads both media playlists at the same time and starts both at the same media sequence (audio one ahead / behind)', async () => {
    for (const [aSeq, start] of [[11, 13], [9, 12], [10, 13]] as const) {
      const routes = new Map<string, Route>([[`${BASE}/master.m3u8`, MASTER], [`${BASE}/audio/de.m3u8`, pl(aSeq, 6, { prefix: 'a' })]]);
      segments(routes, 8, 17);
      const p = provider(routes);
      // the video playlist answers only once the audio one was asked for: one after the other would never get here
      routes.set(`${BASE}/video/index.m3u8`, pl(10, 6, { prefix: 'v' }));
      const fetch = async (url: string, o: FetchOptions) => {
        if (url.endsWith('/video/index.m3u8')) await Promise.race([p.audioRequested, new Promise((_, rej) => setTimeout(() => rej(new Error('audio playlist not asked for')), 1_000))]);
        return p.fetch(url, o);
      };
      const opened = await openInput({ url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false }, { guard: GUARD, fetch });
      const ff = opened.ffInput;
      if (ff.kind !== 'pipe' || !ff.audio) throw new Error('an audio pipe is expected');
      expect([await first(ff.stdin), await first(ff.audio.stdin)]).toEqual([`v${start};`, `a${start};`]);
      expect(ff.audio.shift).toBeUndefined();
      opened.close();
    }
  });

  it('no common sequence and no date-time: each at its own live edge, said once in fixed words', async () => {
    const routes = new Map<string, Route>([[`${BASE}/master.m3u8`, MASTER], [`${BASE}/video/index.m3u8`, pl(10, 6, { prefix: 'v' })], [`${BASE}/audio/de.m3u8`, pl(1000, 6, { prefix: 'a' })]]);
    for (let n = 10; n <= 15; n++) routes.set(`${BASE}/video/v${n}.ts`, `v${n};`);
    for (let n = 1000; n <= 1005; n++) routes.set(`${BASE}/audio/a${n}.ts`, `a${n};`);
    const logs: string[] = [];
    const opened = await openInput({ url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false }, { guard: GUARD, fetch: provider(routes).fetch, log: (m) => logs.push(m) });
    const ff = opened.ffInput;
    if (ff.kind !== 'pipe' || !ff.audio) throw new Error('an audio pipe is expected');
    expect([await first(ff.stdin), await first(ff.audio.stdin)]).toEqual(['v13;', 'a1003;']);
    expect(logs).toEqual(['separate audio: no common media sequence or program date-time, each rendition starts at its live edge']);
    expect(logs.join(' ')).not.toMatch(/example\.com|\.m3u8/);
    opened.close();
  });

  it('by date-time: the shift reaches the input', async () => {
    const routes = new Map<string, Route>([[`${BASE}/master.m3u8`, MASTER], [`${BASE}/video/index.m3u8`, pl(10, 6, { prefix: 'v', pdt: T })], [`${BASE}/audio/de.m3u8`, pl(1000, 6, { prefix: 'a', pdt: T - 4300 })]]);
    for (let n = 10; n <= 15; n++) routes.set(`${BASE}/video/v${n}.ts`, `v${n};`);
    for (let n = 1000; n <= 1005; n++) routes.set(`${BASE}/audio/a${n}.ts`, `a${n};`);
    const opened = await openInput({ url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false }, { guard: GUARD, fetch: provider(routes).fetch });
    const ff = opened.ffInput;
    if (ff.kind !== 'pipe' || !ff.audio) throw new Error('an audio pipe is expected');
    expect([await first(ff.stdin), await first(ff.audio.stdin), ff.audio.shift]).toEqual(['v13;', 'a1004;', -0.3]);
    opened.close();
  });

  it('a segment gone (404) in one rendition ends BOTH pipes (no silent skip), so the driver restarts and aligns again', async () => {
    const routes = new Map<string, Route>([[`${BASE}/master.m3u8`, MASTER], [`${BASE}/video/index.m3u8`, pl(10, 6, { prefix: 'v' })], [`${BASE}/audio/de.m3u8`, pl(10, 6, { prefix: 'a' })]]);
    segments(routes, 10, 15);
    routes.delete(`${BASE}/audio/a14.ts`);
    const logs: string[] = [];
    const opened = await openInput({ url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false }, { guard: GUARD, fetch: provider(routes).fetch, log: (m) => logs.push(m) });
    const ff = opened.ffInput;
    if (ff.kind !== 'pipe' || !ff.audio) throw new Error('an audio pipe is expected');
    const audio = await drain(ff.audio.stdin);
    expect(audio.text).toBe('a13;');
    expect(audio.error).toBeInstanceOf(FetchError);
    // the sibling ends too (at once, not after its next poll)
    const video = await drain(ff.stdin);
    expect(video.text).toBe('');
    expect(logs).toEqual(['separate audio: a rendition skipped, both restart to align again']);
  });

  it('missed segments or a discontinuity on a later poll end both pipes too', async () => {
    for (const later of [pl(18, 6, { prefix: 'a', dur: 2 }), pl(11, 6, { prefix: 'a', dur: 2, disc: [16] })]) {
      let polls = 0;
      const routes = new Map<string, Route>([[`${BASE}/master.m3u8`, MASTER], [`${BASE}/video/index.m3u8`, pl(10, 6, { prefix: 'v', dur: 2 })],
        [`${BASE}/audio/de.m3u8`, () => (++polls === 1 ? pl(10, 6, { prefix: 'a', dur: 2 }) : later)]]);
      segments(routes, 10, 23);
      const opened = await openInput({ url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false }, { guard: GUARD, fetch: provider(routes).fetch });
      const ff = opened.ffInput;
      if (ff.kind !== 'pipe' || !ff.audio) throw new Error('an audio pipe is expected');
      const audio = await drain(ff.audio.stdin);
      expect(audio.text).toBe('a13;a14;a15;');
      expect(audio.error).toBeInstanceOf(FetchError);
      expect(polls).toBe(2);
      expect((await drain(ff.stdin)).text).toBe('');
    }
  });

  it('M1/M8: the audio URI resolves against the redirected master; its playlist is polled again at its own URL, segments against the redirect', async () => {
    const CDN = 'http://cdn.example.com/x';
    const EDGE = 'http://edge.example.com/tok-1';
    const routes = new Map<string, Route>([[`${CDN}/master.m3u8`, MASTER], [`${CDN}/video/index.m3u8`, pl(10, 3, { prefix: 'v', dur: 2 })],
      [`${EDGE}/de.m3u8`, pl(10, 3, { prefix: 'a', dur: 2 })], [`${EDGE}/a10.ts`, 'a10;'], [`${EDGE}/a11.ts`, 'a11;'], [`${EDGE}/a12.ts`, 'a12;']]);
    for (let n = 10; n <= 12; n++) routes.set(`${CDN}/video/v${n}.ts`, `v${n};`);
    const p = provider(routes, new Map([[`${BASE}/master.m3u8`, `${CDN}/master.m3u8`], [`${CDN}/audio/de.m3u8`, `${EDGE}/de.m3u8`]]));
    const opened = await openInput({ url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false }, { guard: GUARD, fetch: p.fetch });
    const ff = opened.ffInput;
    if (ff.kind !== 'pipe' || !ff.audio) throw new Error('an audio pipe is expected');
    const it = ff.audio.stdin[Symbol.asyncIterator]();
    let text = '';
    for (let i = 0; i < 3; i++) text += Buffer.from((await it.next()).value as Uint8Array).toString();
    expect(text).toBe('a10;a11;a12;');
    // the next poll (after 1 s): the rendition's own URL again, not the redirect target (whose token may expire)
    const next = it.next();
    await new Promise((r) => setTimeout(r, 1_300));
    opened.close();
    await next.catch(() => undefined);
    expect(p.calls.filter((u) => u.endsWith('de.m3u8'))).toEqual([`${CDN}/audio/de.m3u8`, `${CDN}/audio/de.m3u8`]);
    expect(p.calls).toContain(`${EDGE}/a10.ts`);
  });
});
