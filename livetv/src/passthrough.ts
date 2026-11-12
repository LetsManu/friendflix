// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import { FetchError, guardedFetch, type FetchOptions, type GuardDeps, type GuardedResponse } from './fetch.js';
import { PLAYLIST_MAX_BYTES, SEGMENT_MAX_BYTES, pickVariant } from './probe.js';
import type { Driver } from './streams.js';
import type { SegmentExt, SegmentWindow } from './window.js';

/**
 * The HLS passthrough driver (spec §3.3; plan ruling 3): livetv is the HLS proxy. It picks one variant (`pickVariant` with the
 * start's `maxBitrate`), polls its media playlist every `max(1, targetDuration / 2)` s and fetches every new segment once, through
 * `guardedFetch` only (playlists ≤ 2 MB, segments ≤ 50 MB), into the stream's directory. Provider numbering never reaches a
 * client: a media sequence that goes back (an encoder restart) or skips ahead becomes a discontinuity and local numbering just
 * continues (Review Focus 5). `pdt` is the provider's `#EXT-X-PROGRAM-DATE-TIME` when its playlist has one, else arrival −
 * duration (ruling 47, done by the context). A failed fetch is an outage: the master is read again after the backoff (variant
 * URLs may carry tokens that expire). A refused address or scheme fails the stream at once: retrying cannot help.
 */
export type FetchFn = (url: string, o: FetchOptions) => Promise<GuardedResponse>;
export const PLAYLIST_TIMEOUT_MS = 10_000;
export const SEGMENT_TIMEOUT_MS = 60_000;
/** a first look (or a restart) takes the newest 3 segments: the live edge, not the provider's whole window */
export const START_SEGMENTS = 3;
/** the poll interval's bounds in seconds; the upper one keeps a hostile TARGETDURATION from stalling the stream */
const MIN_POLL_S = 1;
const MAX_POLL_S = 15;
const MAX_DURATION_S = 120;
const FATAL = new Set(['address_refused', 'scheme']);

export interface MediaSegment { uri: string; duration: number; pdt?: number; discontinuity: boolean; map: string | null }
export interface MediaPlaylist { targetDuration: number; mediaSequence: number; segments: MediaSegment[] }

class Invalid extends Error {
  constructor() { super('invalid'); }
}

const int = (s: string): number | null => (/^\d{1,15}$/.test(s) ? Number(s) : null);

/**
 * A media playlist's facts; null when it is not one (no `#EXTM3U`, a broken duration). A segment without its own date-time
 * follows on from the previous one's (HLS), never across a discontinuity.
 */
export function parseMedia(text: string): MediaPlaylist | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') return null;
  let target: number | null = null;
  let seq = 0;
  let map: string | null = null;
  let duration: number | null = null;
  let pdt: number | undefined;
  let disc = false;
  const segs: MediaSegment[] = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) target = int(l.slice(22));
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = int(l.slice(22)) ?? 0;
    else if (l.startsWith('#EXT-X-MAP:')) map = /\bURI="([^"]+)"/.exec(l)?.[1] ?? null;
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const t = Date.parse(l.slice(25));
      pdt = Number.isFinite(t) ? t : undefined;
    } else if (l === '#EXT-X-DISCONTINUITY') disc = true;
    else if (l.startsWith('#EXTINF:')) {
      const d = Number(l.slice(8).split(',')[0]);
      if (!(Number.isFinite(d) && d > 0 && d <= MAX_DURATION_S)) return null;
      duration = d;
    } else if (l !== '' && !l.startsWith('#')) {
      const prev = segs.at(-1);
      if (pdt === undefined && prev?.pdt !== undefined && !disc) pdt = prev.pdt + prev.duration * 1000;
      segs.push({ uri: l, duration: duration ?? 0, ...(pdt !== undefined ? { pdt } : {}), discontinuity: disc, map });
      duration = null;
      pdt = undefined;
      disc = false;
    }
  }
  const longest = Math.ceil(Math.max(0, ...segs.map((s) => s.duration)));
  const targetDuration = target !== null && target > 0 ? target : longest || 4;
  for (const s of segs) if (s.duration === 0) s.duration = targetDuration;
  return { targetDuration, mediaSequence: seq, segments: segs };
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    throw new Invalid();
  }
}

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

/** `.m4s`/`.mp4` segment paths and mapped playlists are fMP4 */
const extOf = (s: MediaSegment): SegmentExt => (s.map || /\.(m4s|mp4)$/i.test(s.uri.split(/[?#]/)[0]!) ? 'm4s' : 'ts');

/** the passthrough driver; `fetch` replaces `guardedFetch` in tests, production passes the one `guard` of `start()` */
export function passthroughDriver(d: { guard: GuardDeps } | { fetch: FetchFn }): Driver {
  const fetchFn: FetchFn = 'fetch' in d ? d.fetch : (url, o) => guardedFetch(url, o, d.guard);
  return async (ctx) => {
    const input = ctx.input;
    if ('push' in input || input.kind !== 'hls') { ctx.fail('invalid'); return; }
    const get = async (url: string, maxBytes: number, timeoutMs: number) =>
      fetchFn(url, { allowLan: input.allowLan, userAgent: input.userAgent, timeoutMs, maxBytes, signal: ctx.signal });
    const playlist = async (url: string) => {
      const r = await get(url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
      // relative references resolve against the final hop (after redirects), never the requested URL
      return { text: await text(r.body), base: r.url };
    };

    /** the resolved media playlist URL (internal only); null = read the master (again) */
    let media: string | null = null;
    /** the provider sequence number of the newest segment taken */
    let last: number | null = null;
    let initUrl: string | null = null;
    let win: SegmentWindow | null = null;
    let n = 0;
    let variantRate: number | null = null;

    const take = async (s: MediaSegment & { seq: number }, base: string, disc: boolean): Promise<void> => {
      win ??= ctx.window({ ext: extOf(s), init: s.map !== null });
      let discontinuity = disc || s.discontinuity;
      if (s.map && win.init) {
        const url = resolve(s.map, base);
        if (url !== initUrl) {
          const r = await get(url, SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS);
          await ctx.store.write(join(ctx.dir, 'init.mp4'), r.body);
          // a new init segment (another encoder setup) starts a new discontinuity
          if (initUrl !== null) discontinuity = true;
          initUrl = url;
        }
      }
      const r = await get(resolve(s.uri, base), SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS);
      const file = `${n++}.${win.ext}`;
      const bytes = await ctx.store.write(join(ctx.dir, file), r.body);
      if (ctx.signal.aborted) return;
      await ctx.segment({ file, duration: s.duration, bytes, discontinuity, ...(s.pdt !== undefined ? { pdt: s.pdt } : {}) });
      if (variantRate === null) ctx.bitrate(Math.round((bytes * 8) / s.duration));
      last = s.seq;
    };

    while (!ctx.signal.aborted) {
      let wait: number;
      try {
        let pl: { text: string; base: string };
        if (media === null) {
          pl = await playlist(input.url);
          const v = pickVariant(pl.text, ctx.maxBitrate);
          if (v) {
            media = resolve(v.uri, pl.base);
            variantRate = v.bandwidth;
            ctx.bitrate(v.bandwidth);
            pl = await playlist(media);
          } else media = pl.base;
        } else pl = await playlist(media);
        const p = parseMedia(pl.text);
        if (!p) throw new Invalid();
        const segs = p.segments.map((s, i) => ({ ...s, seq: p.mediaSequence + i }));
        let next: typeof segs = [];
        let disc = false;
        if (segs.length > 0) {
          const newest = segs.at(-1)!.seq;
          if (last === null) next = segs.slice(-START_SEGMENTS);
          else if (newest < last) {
            // the provider's sequence went back (encoder restart, reset to 0): a new start at its live edge
            next = segs.slice(-START_SEGMENTS);
            disc = true;
          } else {
            next = segs.filter((s) => s.seq > last!);
            if (next.length > 0 && next[0]!.seq > last + 1) {
              // segments were missed (skipped by the provider or gone during an outage)
              next = next.slice(-START_SEGMENTS);
              disc = true;
            }
          }
        }
        for (const s of next) {
          if (ctx.signal.aborted) break;
          await take(s, pl.base, disc);
          disc = false;
        }
        ctx.back();
        wait = Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, p.targetDuration / 2)) * 1000;
      } catch (e) {
        if (ctx.signal.aborted) break;
        if (e instanceof FetchError && FATAL.has(e.code)) { ctx.fail(e.code); return; }
        media = null;
        wait = ctx.lost();
      }
      if (!(await ctx.sleep(wait))) break;
    }
  };
}
