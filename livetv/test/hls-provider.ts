// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { FetchError, type FetchOptions, type GuardDeps, type GuardedResponse } from '../src/fetch.js';
import type { StreamInput } from '../src/probe.js';

/**
 * A scripted live HLS provider for the input tests: the video and audio media playlists are functions of how often each was read
 * (read 0 is openInput's own read), segments answer `v<seq>;` / `a<seq>;` unless `fail` says otherwise. Placeholder host only.
 */
export const BASE = 'http://iptv.example.com/live/nordlicht';
export const GUARD: GuardDeps = { own: [], lookup: async () => ['192.0.2.40'] };
export const PAIR_MASTER = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch",DEFAULT=YES,URI="audio/de.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"', 'video/index.m3u8'].join('\n');
export const ONE_MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.2"', 'video/index.m3u8'].join('\n');
export const INPUT: StreamInput = { url: `${BASE}/master.m3u8`, kind: 'hls', allowLan: false };

/** a live window `first`..`last` of `dur`-s segments named `<prefix><seq>.ts`, discontinuities before `disc`, date-times from `pdt` (for `first`) */
export function win(first: number, last: number, o: { prefix: string; target?: number; dur?: number; disc?: number[]; pdt?: number }): string {
  const dur = o.dur ?? 4;
  const l = ['#EXTM3U', `#EXT-X-TARGETDURATION:${o.target ?? dur}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
  for (let s = first; s <= last; s++) {
    if (o.disc?.includes(s)) l.push('#EXT-X-DISCONTINUITY');
    if (o.pdt !== undefined) l.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(o.pdt + (s - first) * dur * 1000).toISOString()}`);
    l.push(`#EXTINF:${dur.toFixed(1)},`, `${o.prefix}${s}.ts`);
  }
  return `${l.join('\n')}\n`;
}

type Answer = string | Buffer | FetchError;
export interface Script {
  master?: string;
  video: (read: number) => Answer;
  audio?: (read: number) => Answer;
  /** a segment's answer for its `n`-th request (0-based); undefined: the usual body */
  segment?: (name: string, n: number) => Answer | undefined;
}

export function provider(s: Script) {
  const reads = { video: 0, audio: 0 };
  const asked = new Map<string, number>();
  const calls: string[] = [];
  const fetch = async (url: string, o: FetchOptions): Promise<GuardedResponse> => {
    calls.push(url);
    if (o.signal?.aborted) throw new FetchError('unreachable');
    const path = url.slice(BASE.length + 1);
    let v: Answer;
    if (path === 'master.m3u8') v = s.master ?? PAIR_MASTER;
    else if (path === 'video/index.m3u8') v = s.video(reads.video++);
    else if (path === 'audio/de.m3u8') v = s.audio ? s.audio(reads.audio++) : new FetchError('not_found');
    else {
      const name = path.split('/').pop()!;
      const n = asked.get(name) ?? 0;
      asked.set(name, n + 1);
      v = s.segment?.(name, n) ?? `${name.replace(/\.ts$/, '')};`;
    }
    if (v instanceof FetchError) throw v;
    const buf = Buffer.from(v);
    return { status: 200, url, headers: {}, body: (async function* () { yield buf; })() };
  };
  return { fetch, reads, calls, asked };
}

/** reads `src` in the background: `got` is every `<x><seq>` token in order, `error` set when it ended by failing */
export function reader(src: AsyncIterable<Uint8Array>) {
  const r = { got: [] as string[], error: undefined as unknown, ended: false, done: Promise.resolve() };
  r.done = (async () => {
    try {
      for await (const c of src) {
        const text = Buffer.from(c).toString('latin1');
        // TS test bodies are binary: only the text bodies of the scripted provider become tokens
        if (/^[a-z]\d+;/.test(text)) r.got.push(...text.split(';').filter(Boolean));
        else r.got.push(`<${c.length} bytes>`);
      }
    } catch (e) {
      r.error = e;
    }
    r.ended = true;
  })();
  return r;
}

/** the numbers of `got`'s tokens */
export const seqs = (got: string[]): number[] => got.map((g) => Number(g.slice(1)));
