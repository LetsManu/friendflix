// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { FetchError, createPool, guardedFetch, type GuardDeps, type GuardedResponse } from './fetch.js';
import { checkUrl, ipLiteralUrl, resolveChecked } from './netguard.js';
import { PLAYLIST_TIMEOUT_MS, PlaylistRefused, SEGMENT_TIMEOUT_MS, START_SEGMENTS, follow, parseMedia, type FetchFn, type MediaPlaylist, type MediaSegment } from './passthrough.js';
import { segmentFormat, urlFormat, type PipeFormat } from './ffmpeg.js';
import { DEFAULT_MAX_BITRATE, PLAYLIST_MAX_BYTES, SEGMENT_MAX_BYTES, pickVariant, type StreamInput } from './probe.js';
import type { IngestReader } from './srtingest.js';
import { TsClock, ptsDelta } from './tsclock.js';

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
     * its timestamps are moved against the video's (measured from the first timestamps of both, or by program date-time;
     * ffmpegArgs `audioInput.shift`)
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
  /**
   * why an HLS input ended the run by itself, read once the run is over: a fixed code (InputEnd, FetchError), with the rendition
   * in a pair (`audio not_advancing`); null when it did not (a stop, ffmpeg ending on its own). The driver logs it (item 6).
   */
  endReason?(): string | null;
}
export interface InputDeps {
  guard: GuardDeps; fetch?: FetchFn; signal?: AbortSignal; maxBitrate?: number; ingest?: IngestReader;
  /** leave a separate audio rendition out (the driver's fallback when it cannot be read): the video with its own audio, if any */
  noAudio?: boolean;
  /** fixed texts only (no URL): how a separate audio rendition was aligned or why it restarts */
  log?: (m: string) => void;
  /**
   * the driver's resume points, kept across its runs (item 3): the provider number of the last segment each rendition delivered.
   * openInput starts after them while the provider still lists them, and moves them on as segments are delivered.
   */
  resume?: Resume;
}
export interface Resume { video: number | null; audio: number | null }

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
  /** `side`: the rendition of a pair it came from, when it ended openInput itself (while the first timestamps were read) */
  constructor(readonly code: InputEndCode, readonly side?: 'video' | 'audio') { super(code); }
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
  /** the first segment starts to load (once): openInput's measuring deadline starts when both renditions got there (review I2) */
  onLoading?: () => void;
  /** a segment was delivered (its last bytes handed on) or skipped: a restart resumes after it */
  onTaken?: (seq: number) => void;
  /** every playlist read (parsed and numbered), for the other rendition's `peerDisc` */
  onPlaylist?: (segs: Numbered[]) => void;
  /** fixed texts only */
  log?: (m: string) => void;
}

const codeOf = (e: unknown): string => (e instanceof FetchError ? e.code : 'unreachable');
/** the fixed code of what ended an input (never its message: that may hold provider text) */
const endCode = (e: unknown): string => (e instanceof InputEnd || e instanceof FetchError ? e.code : e instanceof PlaylistRefused ? e.code : 'error');
/** a playlist's segments with their provider numbers */
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
  let loading = false;
  /** when the playlist last gave a new segment (taken or skipped), for advanceTimeoutMs */
  let progress = Date.now();
  const side = o.side ? `${o.side} ` : '';
  const end = (code: InputEndCode) => new InputEnd(code);
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
    const segs = number(p);
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
      if (!loading) { loading = true; o.onLoading?.(); }
      const r = await load(resolveRef(s.uri, pl.base));
      if ('failed' in r) {
        failed++;
        hole += s.duration;
        if (failed >= SEGMENT_FAILS || (o.strict && hole > MAX_HOLE_S)) throw end('segments_failed');
        o.log?.(`${side}segment skipped after a retry (${r.failed})`);
        last = s.seq;
        o.onTaken?.(s.seq);
        progress = Date.now();
        continue;
      }
      failed = 0;
      hole = 0;
      // one chunk ahead: the segment counts as delivered (`onTaken`, a restart resumes after it) as its last bytes are handed on
      const it = r.body[Symbol.asyncIterator]();
      try {
        let cur = await it.next();
        if (cur.done) { last = s.seq; o.onTaken?.(s.seq); }
        while (!cur.done) {
          const nx = await it.next();
          if (nx.done) { last = s.seq; o.onTaken?.(s.seq); }
          yield cur.value;
          cur = nx;
        }
      } finally {
        await Promise.resolve(it.return?.()).catch(() => {});
      }
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
  /** by sequence although only one side carries a date-time (they could not be checked against each other): logged as a code */
  note?: 'pdt_one_sided';
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
 * `after` (a restart that resumes, item 3): the first number each rendition may start at (right after what the run before
 * delivered). By sequence both start at the later of the two, which may be one the providers have not listed yet (both wait for
 * it); by date-time at the first pair at or after them. A discontinuity in between is no reason to skip ahead then: the run goes
 * on across one that both renditions carry.
 */
export function alignStart(v: MediaPlaylist, a: MediaPlaylist, after: { video?: number; audio?: number } = {}): Aligned | null {
  const vs = number(v);
  const as = number(a);
  if (vs.length === 0 || as.length === 0) return null;
  const resuming = after.video !== undefined || after.audio !== undefined;
  const hi = Math.min(vs.at(-1)!.seq, as.at(-1)!.seq);
  const lastDisc = (l: Numbered[], upTo: number) => l.reduce((m, s) => (s.discontinuity && s.seq <= upTo ? s.seq : m), -Infinity);
  const lo = resuming ? Math.max(vs[0]!.seq, as[0]!.seq) : Math.max(vs[0]!.seq, as[0]!.seq, lastDisc(vs, hi), lastDisc(as, hi));
  if (v.targetDuration === a.targetDuration && lo <= hi) {
    const from = resuming ? Math.max(lo, after.video ?? -Infinity, after.audio ?? -Infinity) : Math.max(hi - START_SEGMENTS + 1, lo);
    const vp = vs.find((s) => s.seq === from)?.pdt;
    const ap = as.find((s) => s.seq === from)?.pdt;
    if (vp === undefined || ap === undefined || Math.abs(vp - ap) <= v.targetDuration * 500) {
      const oneSided = (vs.some((x) => x.pdt !== undefined)) !== (as.some((x) => x.pdt !== undefined));
      return { video: from, audio: from, shift: 0, by: 'sequence', ...(oneSided ? { note: 'pdt_one_sided' as const } : {}) };
    }
  }
  const order: number[] = [];
  let aMin: number;
  if (resuming) {
    // the first video segment at or after its resume point, then later ones; audio candidates at or after its own
    const vi = after.video === undefined ? Math.max(0, vs.length - START_SEGMENTS) : vs.findIndex((s) => s.seq >= after.video!);
    aMin = after.audio === undefined ? 0 : as.findIndex((s) => s.seq >= after.audio!);
    if (vi < 0 || aMin < 0) return null;
    for (let i = vi; i < vs.length; i++) order.push(i);
  } else {
    // by date-time: never before the newest discontinuity of either (a date-time does not carry across one)
    const vMin = Math.max(0, vs.findIndex((s) => s.seq === lastDisc(vs, Infinity)));
    aMin = Math.max(0, as.findIndex((s) => s.seq === lastDisc(as, Infinity)));
    const first = Math.max(vMin, vs.length - START_SEGMENTS);
    // the newest START_SEGMENTS first; older ones when the audio window lags behind; newer ones when it starts later
    for (let i = first; i >= vMin; i--) order.push(i);
    for (let i = first + 1; i < vs.length; i++) order.push(i);
  }
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

/** the most of a rendition's first segment held back to read its first timestamps before ffmpeg starts */
const MEASURE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * how long openInput waits for the first bytes of both renditions, counted from when both first segments began to load, before
 * it starts ffmpeg without the measured offset (the playlist alignment then): the stall watchdog only runs once ffmpeg does. A
 * resumed run that waits for its segment to be listed is bounded by advanceTimeoutMs instead (not_advancing).
 */
export const MEASURE_MS = 5_000;

/**
 * Reads `gen` (a rendition's byte stream) until `clock` knows where it starts, its first segment was all read (`firstDone`),
 * MEASURE_MAX_BYTES or `deadline`; answers whether it got there, and the same stream with the bytes read put back in front
 * (nothing is lost or reordered; a read still pending at the deadline is handed on as it arrives). Held bytes are not handed on
 * once `signal` aborted (the pair was ended meanwhile).
 */
async function measured(gen: AsyncGenerator<Uint8Array>, clock: TsClock, firstDone: () => boolean, signal: AbortSignal, deadline: Promise<'late'>): Promise<{ late: boolean; stream: AsyncGenerator<Uint8Array> }> {
  const held: Uint8Array[] = [];
  let n = 0;
  let ended = false;
  let pending: Promise<IteratorResult<Uint8Array>> | null = null;
  while (!clock.ready && !firstDone() && n < MEASURE_MAX_BYTES) {
    const next = gen.next();
    // a read that outlives the deadline is awaited later by the stream (or never, if ffmpeg never reads): no unhandled rejection
    next.catch(() => {});
    const r = await Promise.race([next, deadline]);
    if (r === 'late') { pending = next; break; }
    if (r.done) { ended = true; break; }
    held.push(r.value);
    n += r.value.length;
    clock.push(r.value);
  }
  const stream = (async function* () {
    for (const c of held) {
      if (signal.aborted) return;
      yield c;
    }
    if (ended) return;
    if (pending) {
      const r = await pending;
      if (r.done) return;
      yield r.value;
    }
    yield* gen;
  })();
  return { late: pending !== null, stream };
}

/**
 * The audio's shift against the video measured from their first timestamps (seconds, 3 decimals), when it fits what the playlists
 * say within a target duration: the expected offset is the date-time difference of the two start segments, or 0 for equal
 * sequence numbers; with no alignment at all anything within max(30 s, 3 target durations) is taken. Two encoders' clocks are
 * unrelated, so their difference is almost never that small: null then (the caller keeps the playlist alignment).
 */
function clockShift(v: { start: number | null; seg?: Numbered }, a: { start: number | null; seg?: Numbered }, al: Aligned | null, target: number): number | null | 'mismatch' {
  if (v.start === null || a.start === null) return null;
  const shift = Math.round((ptsDelta(a.start, v.start) / 90_000) * 1000) / 1000;
  let expected: number | null = null;
  if (v.seg?.pdt !== undefined && a.seg?.pdt !== undefined) expected = (a.seg.pdt - v.seg.pdt) / 1000;
  else if (al?.by === 'sequence' && v.seg && a.seg) expected = 0;
  const fits = expected === null ? Math.abs(shift) <= Math.max(30, 3 * target) : Math.abs(shift - expected) <= target;
  return fits ? shift : 'mismatch';
}

/** a resume point at most this many segments ahead of the provider's newest is a stale read away from it (review I1) */
export const RESUME_STALE_SEGMENTS = 2;
/** a resume point further behind the newest than this many seconds starts at the edge: no burst of a long window (review M6) */
export const RESUME_MAX_BEHIND_S = 60;

/**
 * `r` (the provider number of the last segment a rendition delivered in the run before) when the playlist `p` still holds the
 * one after it, at most RESUME_MAX_BEHIND_S behind its newest, or at most RESUME_STALE_SEGMENTS ahead of it (a stale read);
 * null otherwise: the run starts at the edge. A provider that really went back further than that never holds a run at a point it
 * has not reached (a run that ends with `restart` clears the points too).
 */
function resumable(p: MediaPlaylist, r: number | null | undefined): number | null {
  if (r === null || r === undefined || p.segments.length === 0) return null;
  const newest = p.mediaSequence + p.segments.length - 1;
  if (r < p.mediaSequence - 1 || r > newest + RESUME_STALE_SEGMENTS) return null;
  return (newest - r) * p.targetDuration > RESUME_MAX_BEHIND_S ? null : r;
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

/** `gen`, telling `onFail` what it failed with (not after `signal` aborted: a stop is no failure) */
async function* recorded(gen: AsyncGenerator<Uint8Array>, signal: AbortSignal, onFail: (e: unknown) => void): AsyncGenerator<Uint8Array> {
  try {
    yield* gen;
  } catch (e) {
    if (!signal.aborted) onFail(e);
    throw e;
  }
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
  // one kept-alive connection per host for this run, to the address checked once (H1 item 4: the polls stay on one CDN edge)
  const pool = createPool();
  const close = () => { deps.signal?.removeEventListener('abort', outer); ac.abort(); pool.destroy(); };
  const fetchFn: FetchFn = deps.fetch ?? ((url, o) => guardedFetch(url, o, deps.guard));
  const get: Get = (url, maxBytes, timeoutMs) =>
    fetchFn(url, { allowLan: input.allowLan, userAgent: input.userAgent, timeoutMs, maxBytes, signal: ac.signal, pool });
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
    const resume = deps.resume;
    // the provider's sequence went back: the old points mean nothing in its new numbering, the next run starts at the edge
    const forget = (e: unknown) => { if (resume && e instanceof InputEnd && e.code === 'restart') { resume.video = null; resume.audio = null; } };
    const rv = resumable(media, resume?.video);
    const onVideo = (seq: number) => { if (resume) resume.video = seq; };
    let reason: string | null = null;
    if (audioUri === null || audioList === null) {
      const one = hlsBytes({ text, base, url }, get, ac.signal, { from: rv === null ? null : rv + 1, log, onTaken: onVideo });
      return { ffInput: { kind: 'pipe', format, stdin: recorded(one, ac.signal, (e) => { reason ??= endCode(e); forget(e); }) }, close, endReason: () => reason };
    }
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
    const ra = resumable(amedia, resume?.audio);
    const al = alignStart(media, amedia, { ...(rv !== null ? { video: rv + 1 } : {}), ...(ra !== null ? { audio: ra + 1 } : {}) });
    if (!al) log('separate audio: no common media sequence or program date-time, each rendition starts at its live edge');
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
    // the first segment of each was read through (for measuring its first timestamps)
    const firstDone = { video: false, audio: false };
    // the measuring deadline starts once both first segments began to load, not before a resumed run's segment is listed (that
    // wait is bounded by the not-advancing timeout of the rendition that waits)
    const loading = { video: false, audio: false };
    let timer: NodeJS.Timeout | undefined;
    let armDeadline = () => {};
    const deadline = new Promise<'late'>((r) => { armDeadline = () => { timer ??= setTimeout(() => r('late'), MEASURE_MS); }; });
    const onLoading = (side: 'video' | 'audio') => () => { loading[side] = true; if (loading.video && loading.audio) armDeadline(); };
    const followOf = (side: 'video' | 'audio', from: number | null) => ({
      from, strict: true, side, log, peerDisc: peerDisc(side), onPlaylist: (l: Numbered[]) => { seen[side] = l; },
      onTaken: (seq: number) => { firstDone[side] = true; if (resume) resume[side] = seq; }, onLoading: onLoading(side),
    });
    /**
     * a rendition that ends while its first timestamps are read (review M10): the same rules as in the run (`linked`). Its side goes
     * with the code; a provider event (restart, discontinuity) is no fault of the audio; any other audio failure is AudioUnavailable.
     */
    const measureFailed = (e: unknown, side: 'video' | 'audio'): unknown => {
      if (ac.signal.aborted) return e;
      forget(e);
      if (e instanceof InputEnd) {
        if (side === 'audio' && !NOT_A_FAULT.has(e.code)) return new AudioUnavailable(false);
        return new InputEnd(e.code, side);
      }
      return side === 'audio' ? new AudioUnavailable(isFatal(e)) : e;
    };
    if (al?.note) log(`separate audio: aligned by sequence, date-time on one side only (${al.note})`);
    // without an alignment each starts at its own resume point, else at its own live edge
    const vFrom = al?.video ?? (rv === null ? null : rv + 1);
    const aFrom = al?.audio ?? (ra === null ? null : ra + 1);
    let video = hlsBytes({ text, base, url }, get, ac.signal, followOf('video', vFrom));
    // re-polled at the rendition's own URL (a redirect target may carry a token that expires), like the video playlist
    let audio = hlsBytes({ text: ar.text, base: ar.url, url: audioUri }, get, ac.signal, followOf('audio', aFrom));
    let shift = al?.shift ?? 0;
    if (format === 'mpegts' && aformat === 'mpegts') {
      // H1 item 5: both are MPEG-TS, so the offset is read from their first timestamps before ffmpeg starts (the playlists only
      // say which segments to start with; the encoder's clock says where they really are against each other)
      const vc = new TsClock();
      const acl = new TsClock();
      const [vm, am] = await Promise.all([
        measured(video, vc, () => firstDone.video, ac.signal, deadline).catch((e: unknown) => { throw measureFailed(e, 'video'); }),
        measured(audio, acl, () => firstDone.audio, ac.signal, deadline).catch((e: unknown) => { throw measureFailed(e, 'audio'); }),
      ]).finally(() => clearTimeout(timer));
      video = vm.stream;
      audio = am.stream;
      const segOf = (l: Numbered[], from: number | null) => l.find((x) => x.seq === (from ?? l.at(-START_SEGMENTS)?.seq));
      const c = clockShift({ start: vc.start, seg: segOf(number(media), vFrom) }, { start: acl.start, seg: segOf(number(amedia), aFrom) }, al, media.targetDuration);
      const by = al?.by ?? 'live edge';
      if (vm.late || am.late) log(`separate audio: first timestamps not read in time (timestamps_late), aligned by ${by}`);
      else if (c === 'mismatch') log(`separate audio: timestamps do not fit the playlists (clock_mismatch), aligned by ${by}`);
      else if (c === null) log(`separate audio: no timestamps in the first segments (timestamps_missing), aligned by ${by}`);
      else if (c !== null) {
        shift = c;
        log(`separate audio: aligned by timestamps, offset ${Math.round(c * 1000)} ms`);
      }
    }
    let videoBytes = 0;
    let audioBytes = 0;
    let audioFailed = false;
    let videoFailed = false;
    return {
      ffInput: {
        kind: 'pipe', format, stdin: linked(video, close, ac.signal, { onOwnFail: (e) => { videoFailed = true; reason ??= `video ${endCode(e)}`; forget(e); }, onBytes: (n) => { videoBytes += n; } }),
        audio: {
          format: aformat,
          // a provider event (its sequence went back, a discontinuity in this rendition only) is no fault of the rendition
          stdin: linked(audio, close, ac.signal, {
            onOwnFail: (e) => { reason ??= `audio ${endCode(e)}`; forget(e); if (!(e instanceof InputEnd && NOT_A_FAULT.has(e.code))) audioFailed = true; },
            onBytes: (n) => { audioBytes += n; },
          }),
          ...(shift ? { shift } : {}),
        },
      },
      close,
      audioFault: (stalled) => audioFailed || (stalled && !videoFailed && audioBytes === 0 && videoBytes > 0),
      endReason: () => reason,
    };
  } catch (e) {
    close();
    throw e;
  }
}
