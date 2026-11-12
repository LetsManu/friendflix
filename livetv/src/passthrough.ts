// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import { FetchError, guardedFetch, type FetchOptions, type GuardDeps, type GuardedResponse } from './fetch.js';
import { PLAYLIST_MAX_BYTES, SEGMENT_MAX_BYTES, pickVariant } from './probe.js';
import type { Driver } from './streams.js';
import { initName, type SegmentExt, type SegmentWindow } from './window.js';

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
/** this many segments in a row gone (404) while the playlist still loads count as an outage (`input_lost`, backoff) */
export const SKIP_OUTAGE = 3;
const FATAL = new Set(['address_refused', 'scheme']);

export interface MediaSegment { uri: string; duration: number; pdt?: number; discontinuity: boolean; map: string | null }
export interface MediaPlaylist { targetDuration: number; mediaSequence: number; segments: MediaSegment[] }

/** a playlist that may work on the next poll (an error page, a broken line): an outage */
class Invalid extends Error {
  constructor() { super('invalid'); }
}
/** a playlist passthrough can never serve (encrypted, byte ranges): the stream fails, no retry */
export class PlaylistRefused extends Error {
  constructor(readonly code: 'encrypted' | 'invalid') { super(code); }
}

const int = (s: string): number | null => (/^\d{1,15}$/.test(s) ? Number(s) : null);

/**
 * A media playlist's facts; null when it is not one (no `#EXTM3U`, a broken duration). A segment without its own date-time
 * follows on from the previous one's (HLS), never across a discontinuity. Throws `PlaylistRefused`: `encrypted` for an
 * `#EXT-X-KEY` with a METHOD other than NONE (livetv cannot pass keys on), `invalid` for byte ranges (`#EXT-X-BYTERANGE`, a MAP
 * with BYTERANGE): segments are whole files here.
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
    else if (l.startsWith('#EXT-X-KEY:')) {
      if ((/\bMETHOD=([^,]*)/.exec(l)?.[1] ?? '') !== 'NONE') throw new PlaylistRefused('encrypted');
    } else if (l.startsWith('#EXT-X-BYTERANGE')) throw new PlaylistRefused('invalid');
    else if (l.startsWith('#EXT-X-MAP:')) {
      if (/\bBYTERANGE=/.test(l)) throw new PlaylistRefused('invalid');
      map = /\bURI="([^"]+)"/.exec(l)?.[1] ?? null;
    }
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
  // a reduce, not Math.max(...spread): a provider playlist may list more segments than a call's argument limit
  const longest = Math.ceil(segs.reduce((m, s) => Math.max(m, s.duration), 0));
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
    /** the provider URL of the newest stored init and its version (`init-<n>.mp4`, immutable once written; ruling R16) */
    let initUrl: string | null = null;
    let initN = -1;
    /** whether a segment of `init-<initN>.mp4` reached the window (else a newer init makes it an orphan, removed at once) */
    let initUsed = false;
    let win: SegmentWindow | null = null;
    let n = 0;
    let variantRate: number | null = null;
    /**
     * the next segment taken starts a discontinuity (a jump, a gap, a skipped 404); kept across polls next to `last`, cleared
     * only when a segment is really taken
     */
    let pendingDisc = false;
    /** consecutive segments skipped as gone (404); SKIP_OUTAGE of them while playlists still load is an outage */
    let skipped = 0;

    /** fetches and stores one segment; a segment that already left the provider's window (404) is skipped */
    const take = async (s: MediaSegment & { seq: number }, base: string): Promise<void> => {
      win ??= ctx.window({ ext: extOf(s), init: s.map !== null });
      let discontinuity = pendingDisc || s.discontinuity;
      if (win.init) {
        // a segment without a MAP in an fMP4 window keeps the init in use (M-5: a MAP appearing later is not handled)
        const url = s.map ? resolve(s.map, base) : initUrl;
        if (url !== initUrl && url !== null) {
          const r = await get(url, SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS);
          await ctx.store.write(join(ctx.dir, initName(initN + 1)), r.body);
          // the version before never got a segment: nothing will ever drop it, so it goes now
          if (initN >= 0 && !initUsed) await ctx.store.remove(join(ctx.dir, initName(initN))).catch(() => {});
          initN++;
          initUsed = false;
          // a new init (another encoder setup) is a discontinuity
          if (initUrl !== null) discontinuity = true;
          initUrl = url;
        }
      }
      let r;
      try {
        r = await get(resolve(s.uri, base), SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS);
      } catch (e) {
        if (!(e instanceof FetchError && e.code === 'not_found')) throw e;
        // gone at the provider during a slow poll: a gap, so the next segment taken starts a discontinuity
        last = s.seq;
        pendingDisc = true;
        if (++skipped >= SKIP_OUTAGE) throw e;
        return;
      }
      const file = `${n++}.${win.ext}`;
      const bytes = await ctx.store.write(join(ctx.dir, file), r.body);
      if (ctx.signal.aborted) return;
      await ctx.segment({ file, duration: s.duration, bytes, discontinuity, ...(s.pdt !== undefined ? { pdt: s.pdt } : {}), ...(win.init ? { init: initN } : {}) });
      if (variantRate === null) ctx.bitrate(Math.round((bytes * 8) / s.duration));
      last = s.seq;
      pendingDisc = false;
      skipped = 0;
      initUsed = true;
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
        if (segs.length > 0) {
          const newest = segs.at(-1)!.seq;
          if (last === null) next = segs.slice(-START_SEGMENTS);
          else if (newest < last) {
            // the provider's sequence went back (encoder restart, reset to 0): a new start at its live edge
            next = segs.slice(-START_SEGMENTS);
            pendingDisc = true;
          } else {
            next = segs.filter((s) => s.seq > last!);
            if (next.length > 0 && next[0]!.seq > last + 1) {
              // segments were missed (skipped by the provider or gone during an outage)
              next = next.slice(-START_SEGMENTS);
              pendingDisc = true;
            }
          }
        }
        for (const s of next) {
          if (ctx.signal.aborted) break;
          await take(s, pl.base);
        }
        ctx.back();
        wait = Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, p.targetDuration / 2)) * 1000;
      } catch (e) {
        if (ctx.signal.aborted) break;
        if (e instanceof FetchError && FATAL.has(e.code)) { ctx.fail(e.code); return; }
        if (e instanceof PlaylistRefused) { ctx.fail(e.code); return; }
        media = null;
        wait = ctx.lost();
      }
      if (!(await ctx.sleep(wait))) break;
    }
  };
}
