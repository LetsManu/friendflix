// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { FetchError, guardedFetch, type GuardDeps, type GuardedResponse } from './fetch.js';
import { checkUrl, ipLiteralUrl, resolveChecked } from './netguard.js';
import { PLAYLIST_TIMEOUT_MS, PlaylistRefused, SEGMENT_TIMEOUT_MS, START_SEGMENTS, follow, parseMedia, type FetchFn, type MediaPlaylist, type MediaSegment } from './passthrough.js';
import { segmentFormat, urlFormat, type PipeFormat } from './ffmpeg.js';
import { DEFAULT_MAX_BITRATE, PLAYLIST_MAX_BYTES, SEGMENT_MAX_BYTES, pickVariant, type StreamInput } from './probe.js';
import type { IngestReader } from './srtingest.js';

/**
 * What ffmpeg reads for a remux or transcode (plan ruling 3): never a provider URL. HTTP(S) inputs are fetched by livetv
 * (`guardedFetch`) and handed over as a byte stream for ffmpeg's stdin: an MPEG-TS stream as it arrives, an HLS playlist as its
 * segments one after the other (polled like passthrough). An SRT caller input keeps its URL with the host replaced by the
 * checked IP literal. A `{ push }` input (Task 29) is its feed's ring in the ingest hub on stdin, from the oldest of the last 4 s
 * on; a feed that is not receiving fails like an unreachable input (the driver's reconnect waits for it).
 */
export type FfmpegInput =
  | {
    kind: 'pipe'; format: PipeFormat; stdin: AsyncIterable<Uint8Array>;
    /**
     * a separate HLS audio rendition (descriptor 3), started at the same media time as the video (alignStart); `shift`: seconds
     * its timestamps are moved against the video's (an alignment by program date-time; ffmpegArgs `audioInput.shift`)
     */
    audio?: { format: PipeFormat; stdin: AsyncIterable<Uint8Array>; shift?: number };
  }
  | { kind: 'srt'; url: string };
export interface OpenedInput {
  ffInput: FfmpegInput;
  /** ends every fetch of this input (an unread body included) */
  close(): void;
  /**
   * with a separate audio rendition: whether the audio side ended this run, read once the run is over. True when the audio failed
   * on its own (a fetch or playlist error, a skip that broke the lockstep; not an abort because the video failed first), or when
   * the run `stalled` (no segment for the watchdog's time) while the audio had given nothing and the video had (ffmpeg waits
   * for both). A video failure, a video stall or a quick ffmpeg exit is never the audio's fault.
   */
  audioFault?(stalled: boolean): boolean;
}
export interface InputDeps {
  guard: GuardDeps; fetch?: FetchFn; signal?: AbortSignal; maxBitrate?: number; ingest?: IngestReader;
  /** leave a separate audio rendition out (the driver's fallback when it cannot be read): the video with its own audio, if any */
  noAudio?: boolean;
  /** fixed texts only (no URL): how a separate audio rendition was aligned or why it restarts */
  log?: (m: string) => void;
}

/**
 * The separate audio rendition of an HLS input could not be opened (its playlist failed, was refused or is encrypted); the video
 * could. `fatal`: retrying cannot help (a refused address or scheme, an encrypted or byte-range playlist). The driver decides
 * whether to retry or to go on without it.
 */
export class AudioUnavailable extends Error {
  constructor(readonly fatal: boolean) { super('audio_unavailable'); }
}

/**
 * Why an HLS input ended its run by itself (fixed codes; the driver logs them): `restart` the provider's sequence went back
 * (follow), `gap` segments were missed, `discontinuity` one rendition of a pair has one the other does not carry (these three in
 * a strict pair only: a single playlist starts again at the edge, ffmpeg smooths its timestamps), `segments_failed`
 * SEGMENT_FAILS segments in a row could not be loaded, `not_advancing` the playlist showed nothing new for advanceTimeoutMs.
 */
export type InputEndCode = 'restart' | 'gap' | 'discontinuity' | 'segments_failed' | 'not_advancing';
/** ends of a run that are the provider's doing, not a broken rendition: the separate audio is not blamed for them (audioFault) */
const NOT_A_FAULT: ReadonlySet<InputEndCode> = new Set(['restart', 'discontinuity']);
export class InputEnd extends Error {
  constructor(readonly code: InputEndCode) { super(code); }
}

/** an MPEG-TS stream that delivers nothing for this long ends (ffmpeg sees EOF, the driver reconnects) */
export const STREAM_IDLE_MS = 20_000;
/** the largest timer Node accepts: an endless body has no whole-fetch budget, the idle watchdog guards it instead */
const FOREVER_MS = 2 ** 31 - 1;
const MIN_POLL_S = 1;
const MAX_POLL_S = 15;

function resolveRef(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    throw new FetchError('unreachable');
  }
}

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const onAbort = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `body`, ended when no chunk arrives for `ms` (then `onIdle` aborts the fetch, so the pending read fails and the socket closes) */
async function* watched(body: AsyncIterable<Uint8Array>, ms: number, onIdle: () => void): AsyncGenerator<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  let idle = false;
  try {
    for (;;) {
      let t: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((r) => { t = setTimeout(() => r(null), ms); });
      const r = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(t));
      if (r === null) { idle = true; onIdle(); return; }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    if (idle) void Promise.resolve(it.return?.()).catch(() => {});
    else await Promise.resolve(it.return?.()).catch(() => {});
  }
}

type Get = (url: string, maxBytes: number, timeoutMs: number) => Promise<GuardedResponse>;
type Numbered = MediaSegment & { seq: number };

/** a segment that failed to load is asked for once more after this long; failing again, it is skipped (a gap in the input) */
export const SEGMENT_RETRY_MS = 250;
/** this many segments in a row skipped end the run (the provider is gone, the driver's backoff takes over) */
export const SEGMENT_FAILS = 3;
/**
 * In a pair, the time skipped in a row stays at or under this many seconds. ffmpeg closes a timestamp hole of more than 10 s
 * (its `dts_delta_threshold`) in the one input that has it, which would move that rendition against the other for the rest of
 * the run; a shorter hole stays a hole in both timelines, so the two stay together.
 */
export const MAX_HOLE_S = 8;

/**
 * A playlist that showed nothing new for this long ends its input (H2): 3 target durations, at least 12 s, at most 20 s. In a pair
 * ffmpeg reads both renditions in lockstep, so one that stops advancing holds the whole output (and blocks the other's pipe);
 * ending the run here is well before the driver's stall watchdog (STALL_MS, 32 s), and the restart resumes where it was.
 */
export const advanceTimeoutMs = (targetDuration: number): number => Math.min(20_000, Math.max(12_000, 3 * targetDuration * 1000));

interface Follow {
  /** the media sequence to start at (an aligned start, alignStart); null or missing: the newest START_SEGMENTS */
  from?: number | null;
  /**
   * one of two paired renditions (video and a separate audio): a sequence that went back, missed segments, or a discontinuity the
   * other rendition does not carry (`peerDisc`) ends this input instead of jumping on, so the pair never drifts apart: `linked`
   * ends the sibling, ffmpeg restarts and alignStart lines both up again. A skipped segment is allowed while the hole stays short.
   */
  strict?: boolean;
  /** which rendition, for the log ('video' / 'audio'); none for a single playlist */
  side?: 'video' | 'audio';
  /** whether the other rendition of the pair carries the discontinuity at `s` too (then the run goes on) */
  peerDisc?: (s: Numbered) => Promise<boolean>;
  /** every playlist read (parsed and numbered), for the other rendition's `peerDisc` */
  onPlaylist?: (segs: Numbered[]) => void;
  onSkip?: () => void;
  /** fixed texts only */
  log?: (m: string) => void;
}

const codeOf = (e: unknown): string => (e instanceof FetchError ? e.code : 'unreachable');
/** retrying cannot help: the stream fails (a refused address or scheme, a playlist that can never be served) */
const number = (p: MediaPlaylist): Numbered[] => p.segments.map((s, i) => ({ ...s, seq: p.mediaSequence + i }));
const isFatal = (e: unknown): boolean => e instanceof PlaylistRefused || (e instanceof FetchError && (e.code === 'address_refused' || e.code === 'scheme'));
/** retrying cannot help: the stream fails (a refused address or scheme, a playlist that can never be served) */

/**
 * An HLS input as one byte stream: the newest segments first (or from `o.from`), then every new one in order. A stale read is no
 * update (follow). A segment that fails is asked for once more, then skipped; SEGMENT_FAILS in a row (in a pair also a hole over
 * MAX_HOLE_S) end the input (`segments_failed`). A failed playlist poll is tried again at the next poll; a playlist that gives
 * nothing new for advanceTimeoutMs (failed polls and stale reads included) ends it (`not_advancing`).
 */
async function* hlsBytes(first: { text: string; base: string; url: string }, get: Get, signal: AbortSignal, o: Follow = {}): AsyncGenerator<Uint8Array> {
  let pl = { text: first.text, base: first.base };
  let last: number | null = o.from === undefined || o.from === null ? null : o.from - 1;
  let initUrl: string | null = null;
  let started = false;
  /** stale reads in a row (follow) */
  const stale = { stale: 0 };
  /** segments skipped in a row and their seconds */
  let failed = 0;
  let hole = 0;
  /** when the playlist last gave a new segment (taken or skipped), for advanceTimeoutMs */
  let progress = Date.now();
  const side = o.side ? `${o.side} ` : '';
  /** `onSkip`: the pair broke its order and is aligned again; a rendition that could not be loaded is not that */
  const end = (code: InputEndCode) => { if (code !== 'segments_failed') o.onSkip?.(); return new InputEnd(code); };
  /** the segment's response, or the code it failed with twice */
  const load = async (url: string): Promise<GuardedResponse | { failed: string }> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await get(url, SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS);
      } catch (e) {
        if (signal.aborted || isFatal(e)) throw e;
        if (attempt === 1 || !(await wait(SEGMENT_RETRY_MS, signal))) return { failed: codeOf(e) };
      }
    }
  };
  while (!signal.aborted) {
    const p = parseMedia(pl.text);
    if (!p) throw new FetchError('unreachable');
    const segs = p.segments.map((s, i) => ({ ...s, seq: p.mediaSequence + i }));
    o.onPlaylist?.(segs);
    // a stale read (a CDN node a little behind) takes nothing, in a pair too
    const f = follow(segs, last, stale);
    if (o.strict && f.jump !== 'none') throw end(f.jump);
    for (const s of f.take) {
      if (signal.aborted) return;
      if (o.strict && started && s.discontinuity && !(await (o.peerDisc?.(s) ?? Promise.resolve(false)))) throw end('discontinuity');
      if (signal.aborted) return;
      started = true;
      if (s.map) {
        const u = resolveRef(s.map, pl.base);
        if (u !== initUrl) {
          yield* (await get(u, SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS)).body;
          initUrl = u;
        }
      }
      const r = await load(resolveRef(s.uri, pl.base));
      if ('failed' in r) {
        failed++;
        hole += s.duration;
        if (failed >= SEGMENT_FAILS || (o.strict && hole > MAX_HOLE_S)) throw end('segments_failed');
        o.log?.(`${side}segment skipped after a retry (${r.failed})`);
        last = s.seq;
        progress = Date.now();
        continue;
      }
      failed = 0;
      hole = 0;
      yield* r.body;
      last = s.seq;
      progress = Date.now();
    }
    if (f.take.length === 0 && Date.now() - progress >= advanceTimeoutMs(p.targetDuration)) throw end('not_advancing');
    if (!(await wait(Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, p.targetDuration / 2)) * 1000, signal))) return;
    try {
      const r = await get(first.url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
      pl = { text: await readText(r.body), base: r.url };
    } catch (e) {
      // one failed poll is not the end: the playlist read before is looked at again (nothing new in it), then polled again
      if (signal.aborted || isFatal(e)) throw e;
    }
  }
}

export interface Aligned {
  /** the media sequence each rendition starts at */
  video: number;
  audio: number;
  /**
   * seconds the audio's first segment starts after the video's (negative: before); 0 by sequence. ffmpeg moves the audio by this
   * much against the video, so both meet at the same date-time
   */
  shift: number;
  by: 'sequence' | 'pdt';
}

/**
 * Where a video and its separate audio rendition start, so both begin at the same media time (ffmpeg moves each input to start
 * at 0 by itself, so the first segment of each IS the alignment):
 * - by media sequence: when both windows share sequence numbers, have the same target duration and, if both carry
 *   `#EXT-X-PROGRAM-DATE-TIME`, agree on it within half a target duration. Both start at the same number, the newest
 *   START_SEGMENTS both have (after the newest discontinuity among them, so the start holds no timestamp jump).
 * - else by program date-time, when both carry it: the video's start segment and the audio segment that starts nearest to its
 *   date-time (at most one audio segment away); the rest is `shift`.
 * - else null: the sequences do not correspond and there is no date-time to go by; each starts at its own live edge (as before).
 */
export function alignStart(v: MediaPlaylist, a: MediaPlaylist): Aligned | null {
  const vs = number(v);
  const as = number(a);
  if (vs.length === 0 || as.length === 0) return null;
  const hi = Math.min(vs.at(-1)!.seq, as.at(-1)!.seq);
  const lastDisc = (l: Numbered[], upTo: number) => l.reduce((m, s) => (s.discontinuity && s.seq <= upTo ? s.seq : m), -Infinity);
  const lo = Math.max(vs[0]!.seq, as[0]!.seq, lastDisc(vs, hi), lastDisc(as, hi));
  if (v.targetDuration === a.targetDuration && lo <= hi) {
    const from = Math.max(hi - START_SEGMENTS + 1, lo);
    const vp = vs.find((s) => s.seq === from)?.pdt;
    const ap = as.find((s) => s.seq === from)?.pdt;
    if (vp === undefined || ap === undefined || Math.abs(vp - ap) <= v.targetDuration * 500) return { video: from, audio: from, shift: 0, by: 'sequence' };
  }
  // by date-time: never before the newest discontinuity of either (a date-time does not carry across one)
  const vMin = Math.max(0, vs.findIndex((s) => s.seq === lastDisc(vs, Infinity)));
  const aMin = Math.max(0, as.findIndex((s) => s.seq === lastDisc(as, Infinity)));
  const first = Math.max(vMin, vs.length - START_SEGMENTS);
  const order: number[] = [];
  // the newest START_SEGMENTS first; older ones when the audio window lags behind; newer ones when it starts later
  for (let i = first; i >= vMin; i--) order.push(i);
  for (let i = first + 1; i < vs.length; i++) order.push(i);
  for (const i of order) {
    const t = vs[i]!.pdt;
    if (t === undefined) continue;
    let best: Numbered | null = null;
    for (let j = aMin; j < as.length; j++) {
      const p = as[j]!.pdt;
      if (p === undefined || Math.abs(p - t) >= as[j]!.duration * 1000) continue;
      if (best === null || Math.abs(p - t) < Math.abs(best.pdt! - t)) best = as[j]!;
    }
    if (best) return { video: vs[i]!.seq, audio: best.seq, shift: Math.round(best.pdt! - t) / 1000, by: 'pdt' };
  }
  return null;
}


/** a push feed's ring as ffmpeg's stdin: no address, no URL; closed by the stop, by `close()` or by 20 s without data */
function openPush(channelId: string, deps: InputDeps): OpenedInput {
  // without an ingest hub a push input cannot be read at all: the driver fails the stream
  if (!deps.ingest) throw new FetchError('scheme');
  if (!deps.ingest.receiving(channelId)) throw new FetchError('unreachable');
  const it = deps.ingest.reader(channelId)[Symbol.asyncIterator]();
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    deps.signal?.removeEventListener('abort', close);
    void Promise.resolve(it.return?.()).catch(() => {});
  };
  if (deps.signal?.aborted) close();
  else deps.signal?.addEventListener('abort', close, { once: true });
  return { ffInput: { kind: 'pipe', format: 'mpegts', stdin: watched({ [Symbol.asyncIterator]: () => it }, STREAM_IDLE_MS, close) }, close };
}

/**
 * `gen`, but a failure of it ends the whole input (`end`), so its sibling pipe ends too. `onOwnFail` is told when it failed on its
 * own (the input was not already ended by the sibling or a stop); `onBytes` counts what it gave.
 */
async function* linked(gen: AsyncGenerator<Uint8Array>, end: () => void, signal: AbortSignal, o: { onOwnFail?: (e: unknown) => void; onBytes?: (n: number) => void } = {}): AsyncGenerator<Uint8Array> {
  try {
    for await (const c of gen) {
      o.onBytes?.(c.length);
      yield c;
    }
  } catch (e) {
    const own = !signal.aborted;
    end();
    if (own) o.onOwnFail?.(e);
    throw e;
  }
}

export async function openInput(input: StreamInput, deps: InputDeps): Promise<OpenedInput> {
  if ('push' in input) return openPush(input.push, deps);
  if (input.kind === 'srt') {
    const c = checkUrl(input.url, ['srt:']);
    if ('error' in c) throw new FetchError(c.error === 'host' ? 'address_refused' : c.error === 'scheme' ? 'scheme' : 'unreachable');
    const ip = await resolveChecked(c.url.hostname, input.allowLan, deps.guard);
    return { ffInput: { kind: 'srt', url: ipLiteralUrl(c.url, ip) }, close: () => {} };
  }
  const ac = new AbortController();
  const outer = () => ac.abort();
  if (deps.signal?.aborted) ac.abort();
  else deps.signal?.addEventListener('abort', outer, { once: true });
  const close = () => { deps.signal?.removeEventListener('abort', outer); ac.abort(); };
  const fetchFn: FetchFn = deps.fetch ?? ((url, o) => guardedFetch(url, o, deps.guard));
  const get: Get = (url, maxBytes, timeoutMs) =>
    fetchFn(url, { allowLan: input.allowLan, userAgent: input.userAgent, timeoutMs, maxBytes, signal: ac.signal });
  const log = (m: string) => deps.log?.(m);
  try {
    if (input.kind === 'ts') {
      const res = await get(input.url, Number.MAX_SAFE_INTEGER, FOREVER_MS);
      return { ffInput: { kind: 'pipe', format: urlFormat(new URL(input.url).pathname), stdin: watched(res.body, STREAM_IDLE_MS, close) }, close };
    }
    // HLS: the master (or media) playlist now, so an unreachable provider fails before ffmpeg starts
    const m = await get(input.url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
    let text = await readText(m.body);
    let base = m.url;
    let url = m.url;
    let audioUri: string | null = null;
    let audioList: Promise<{ text: string; url: string } | { error: unknown }> | null = null;
    const v = pickVariant(text, deps.maxBitrate ?? DEFAULT_MAX_BITRATE);
    if (v) {
      url = resolveRef(v.uri, base);
      if (v.audio && !deps.noAudio) {
        audioUri = resolveRef(v.audio.uri, m.url);
        // read at the same time as the video playlist: the closer the two reads, the likelier both show the same live edge
        audioList = get(audioUri, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS).then(
          async (r) => ({ text: await readText(r.body), url: r.url }),
        ).catch((error: unknown) => ({ error }));
      }
      const r = await get(url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
      text = await readText(r.body);
      base = r.url;
    }
    // throws PlaylistRefused (encrypted, byte ranges) now: the driver fails the stream
    const media = parseMedia(text);
    if (!media) throw new FetchError('unreachable');
    // the demuxer follows the playlist's first segment (L5, see segmentFormat)
    const first = media.segments[0];
    const format: PipeFormat = first ? segmentFormat(first.uri, first.map) : 'mpegts';
    if (audioUri === null || audioList === null) return { ffInput: { kind: 'pipe', format, stdin: hlsBytes({ text, base, url }, get, ac.signal, { log }) }, close };
    // audio in a playlist of its own: fetched and followed like the video one (same guard, same limits), as a second pipe. Either
    // one ending its run ends both (ffmpeg sees EOF, the driver backs off, restarts and aligns them again), so a stream never
    // runs video-only or out of sync unnoticed. A rendition that cannot be opened is AudioUnavailable: the driver decides.
    const ar = await audioList;
    let amedia: MediaPlaylist | null;
    try {
      if ('error' in ar) throw ar.error;
      amedia = parseMedia(ar.text);
      if (!amedia) throw new FetchError('unreachable');
    } catch (e) {
      if (ac.signal.aborted) throw e;
      throw new AudioUnavailable(isFatal(e));
    }
    const afirst = amedia.segments[0];
    const aformat: PipeFormat = afirst ? segmentFormat(afirst.uri, afirst.map) : 'mpegts';
    const al = alignStart(media, amedia);
    if (!al) log('separate audio: no common media sequence or program date-time, each rendition starts at its live edge');
    const onSkip = () => log('separate audio: a rendition skipped, both restart to align again');
    // what each rendition's playlist showed last, so the other can tell whether a discontinuity is in both
    const seen: Record<'video' | 'audio', Numbered[]> = { video: number(media), audio: number(amedia) };
    const urls = { video: url, audio: audioUri };
    const peerDisc = (side: 'video' | 'audio') => async (s: Numbered): Promise<boolean> => {
      if (!al) return false;
      const other = side === 'video' ? 'audio' : 'video';
      // the same media time: the same number in a pair aligned by sequence, the same date-time (within half a segment) by PDT
      const match = (l: Numbered[]) => (al.by === 'sequence'
        ? l.find((x) => x.seq === s.seq)
        : s.pdt === undefined ? undefined : l.find((x) => x.pdt !== undefined && Math.abs(x.pdt - s.pdt!) < x.duration * 500));
      let m = match(seen[other]);
      if (!m) {
        // the other playlist was read before this segment was listed: once more now
        try {
          const p = parseMedia(await readText((await get(urls[other], PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS)).body));
          if (p) m = match(number(p));
        } catch { /* not known: one-sided */ }
      }
      return m?.discontinuity === true;
    };
    const followOf = (side: 'video' | 'audio', from: number | null) => ({
      from, strict: true, side, onSkip, log, peerDisc: peerDisc(side), onPlaylist: (l: Numbered[]) => { seen[side] = l; },
    });
    const video = hlsBytes({ text, base, url }, get, ac.signal, followOf('video', al?.video ?? null));
    // re-polled at the rendition's own URL (a redirect target may carry a token that expires), like the video playlist
    const audio = hlsBytes({ text: ar.text, base: ar.url, url: audioUri }, get, ac.signal, followOf('audio', al?.audio ?? null));
    let videoBytes = 0;
    let audioBytes = 0;
    let audioFailed = false;
    return {
      ffInput: {
        kind: 'pipe', format, stdin: linked(video, close, ac.signal, { onBytes: (n) => { videoBytes += n; } }),
        audio: {
          format: aformat,
          // a provider event (its sequence went back, a discontinuity in this rendition only) is no fault of the rendition
          stdin: linked(audio, close, ac.signal, { onOwnFail: (e) => { if (!(e instanceof InputEnd && NOT_A_FAULT.has(e.code))) audioFailed = true; }, onBytes: (n) => { audioBytes += n; } }),
          ...(al?.shift ? { shift: al.shift } : {}),
        },
      },
      close,
      audioFault: (stalled) => audioFailed || (stalled && audioBytes === 0 && videoBytes > 0),
    };
  } catch (e) {
    close();
    throw e;
  }
}
