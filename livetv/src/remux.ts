// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FetchError, type GuardDeps } from './fetch.js';
import { AUDIO_BITRATE, SEGMENT_SECONDS, audioFor, ffmpegArgs, videoBitrate } from './ffmpeg.js';
import { AudioUnavailable, openInput, type OpenedInput, type Resume } from './inputs.js';
import type { Log } from './log.js';
import { PlaylistRefused, type FetchFn } from './passthrough.js';
import { START_PROBE_MS, probe, type ProbeDeps, type ProbeResult, type StreamInput } from './probe.js';
import type { Run } from './run.js';
import type { IngestReader } from './srtingest.js';
import type { Driver, Mode } from './streams.js';

/**
 * The remux and transcode driver (spec §3.3, §7.4; plan rulings 3 and 23). It probes the input once at the start (a stop during
 * the probe aborts it and ends the driver at once); a requested `transcode` whose probe says the video can be copied runs as
 * `remux` and reports so (spec §7.4 step 4: the backend then releases the budget slot). ffmpeg writes `<dir>/<n>.ts` and reports
 * each finished segment as a CSV line on stdout; each line becomes a window entry with `pdt` = its arrival − the segment's
 * duration (ruling 47). When ffmpeg ends while the stream lives (input gone, provider restart) it is started again after the
 * shared backoff (2, 4, 8, 15, 30 s, then 30 s; a run that delivered a segment resets it); the first segment of the new run is a
 * discontinuity and local numbering continues. A run that delivers no segment line for STALL_MS (a hung ffmpeg, or one that keeps
 * reading input without writing segments) is aborted by the stall watchdog and restarted the same way; the stream itself lives
 * on. A `{ push }` input (Task 29) is its feed's ring on ffmpeg's stdin. Logs: channel id and fixed texts only; ffmpeg's stderr
 * goes through run.ts (`scrubLine`), never through here.
 */
export interface RemuxDeps {
  run: Run;
  guard: GuardDeps;
  /** replaces `guardedFetch` (tests) */
  fetch?: FetchFn;
  /** replaces the Task 14 probe (tests); `signal` aborts when the stream stops */
  probe?: (input: StreamInput, signal: AbortSignal, o?: ProbeOptions) => Promise<ProbeResult>;
  /** where ffmpeg's scrubbed stderr goes */
  log?: Log;
  /** the size of a written segment (default: the file's size, 0 when it is missing) */
  size?: (path: string) => Promise<number>;
  now?: () => number;
  /** the SRT push ingest (Task 29): `{ push }` inputs read their feed's ring */
  ingest?: IngestReader;
}

/** the stall watchdog: about 3 segment durations + 20 s without a segment line ends the run */
export const STALL_MS = 3 * SEGMENT_SECONDS * 1000 + 20_000;
const FOREVER_MS = 2 ** 31 - 1;
const FATAL = new Set(['address_refused', 'scheme']);
const MAX_SEGMENT_S = 120;
const MAX_PENDING = 4096;
const CSV_RE = /^(?:.*[\\/])?(0|[1-9]\d{0,9})\.ts,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const PROBE_FAILED: ProbeResult = { ok: false, needs: 'transcode' };
/**
 * A separate audio rendition the driver blames (inputs.ts `audioFault`, or it could not be opened) this many runs in a row is left
 * out; a refused or encrypted one at once. The count starts again only after a run with it delivered AUDIO_HEALTHY_SEGMENTS.
 */
export const AUDIO_TRIES = 2;
export const AUDIO_HEALTHY_SEGMENTS = 5;
/** ... and so is one blamed AUDIO_FAULTS times within AUDIO_FAULT_WINDOW_MS, however many segments came between (a flapping one) */
export const AUDIO_FAULTS = 4;
export const AUDIO_FAULT_WINDOW_MS = 10 * 60_000;
/** a left-out rendition is tried again after 3, 6, 12, … min, at most 30 min (the video-only run is ended for it) */
export const AUDIO_RETRY_MS = 3 * 60_000;
export const AUDIO_RETRY_MAX_MS = 30 * 60_000;
type ProbeOptions = Pick<ProbeDeps, 'maxBitrate' | 'budgetMs' | 'onSeparateAudio'>;

/** a segment list line (`<n>.ts,<start>,<end>`) → its number and duration; anything else null */
export function csvLine(line: string): { n: number; duration: number } | null {
  const m = CSV_RE.exec(line.trim());
  if (!m) return null;
  const duration = Math.round((Number(m[3]) - Number(m[2])) * 1000) / 1000;
  if (!(duration > 0 && duration <= MAX_SEGMENT_S)) return null;
  return { n: Number(m[1]), duration };
}

/** what runs: a transcode the probe found copyable becomes a remux; a failed probe never downgrades */
export function chooseMode(requested: Mode, facts: ProbeResult): 'remux' | 'transcode' {
  return requested === 'transcode' && !(facts.ok && facts.needs !== 'transcode') ? 'transcode' : 'remux';
}

/** `p`'s value, or null as soon as `signal` aborts (whatever `p` still does is no longer waited for) */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    void p.then((v) => {
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    });
  });
}

const fileSize = (p: string): Promise<number> => stat(p).then((s) => s.size, () => 0);

const probeOf = (d: RemuxDeps) => d.probe
  ?? ((input: StreamInput, signal: AbortSignal, o: ProbeOptions = {}) => probe(input, { run: d.run, guard: d.guard, signal, ...(d.ingest ? { ingest: d.ingest } : {}), ...o }));

/** a media driver that can take the probe facts a caller already has (then it does not probe again) */
export type MediaDriver = (ctx: Parameters<Driver>[0], known?: ProbeResult) => Promise<void>;

/**
 * The passthrough driver behind a probe: an HLS channel is passed through only when a browser can play its audio and that audio
 * is in the variant itself. The probe runs once, first, on the variant the stream will play (`maxBitrate`), with START_PROBE_MS
 * (5 s) as its budget: its time is added to the first segment of a passthrough start, inside the backend's 15-s wait, so it must
 * leave that wait room for the first segment. `needs: remux` (audio a browser cannot play, or audio in a playlist of its own)
 * runs the media driver as `remux` with these facts. A probe that failed after the master showed a separate audio rendition runs
 * the remux too, without facts (the audio becomes AAC): passthrough would play that source silent. Anything else, also any other
 * failed probe or a `transcode` verdict (non-H264 HLS: as before, no slot was taken for it), runs the passthrough driver, so a
 * probe outage never breaks a working channel.
 */
export function probedPassthrough(d: RemuxDeps, media: MediaDriver, pass: Driver): Driver {
  const probeFn = probeOf(d);
  return async (ctx) => {
    let separateAudio = false;
    const o: ProbeOptions = { maxBitrate: ctx.maxBitrate, budgetMs: START_PROBE_MS, onSeparateAudio: () => { separateAudio = true; } };
    const facts = await untilAbort(probeFn(ctx.input, ctx.signal, o).catch(() => PROBE_FAILED), ctx.signal);
    if (facts === null || ctx.signal.aborted) return;
    if (facts.ok && facts.needs === 'remux') return media(ctx, facts);
    // A failed start probe is said once, in fixed words (its code only). The backend's stored verdict is already in the requested
    // mode: a stored remux verdict starts the remux driver directly, so a passthrough start here had none against it.
    if (!facts.ok) ctx.log(`start probe failed (${facts.error ?? 'error'}), ${separateAudio ? 'remuxing: separate audio rendition' : 'passing through'}`);
    if (!facts.ok && separateAudio) return media(ctx, PROBE_FAILED);
    return pass(ctx);
  };
}

export function remuxDriver(d: RemuxDeps): MediaDriver {
  const probeFn = probeOf(d);
  const size = d.size ?? fileSize;
  const log: Log = d.log ?? (() => {});
  const now = d.now ?? Date.now;
  return async (ctx, known) => {
    const input = ctx.input;
    const facts = known ?? (await untilAbort(probeFn(input, ctx.signal, { maxBitrate: ctx.maxBitrate }).catch(() => PROBE_FAILED), ctx.signal));
    if (facts === null || ctx.signal.aborted) return;
    const mode = chooseMode(ctx.mode, facts);
    if (mode !== ctx.mode) ctx.runsAs(mode);
    const audio = audioFor(facts.audio?.codec);
    const srcHeight = facts.video?.height || null;
    let rated = false;
    if (mode === 'transcode') {
      ctx.bitrate(videoBitrate(srcHeight) + (audio === 'aac' ? AUDIO_BITRATE : 0));
      rated = true;
    }
    ctx.window({ ext: 'ts' });
    /** the next segment number ffmpeg writes */
    let next = 0;
    /** the next segment taken starts a discontinuity (after a restart) */
    let disc = false;
    /**
     * A separate audio rendition that keeps failing is left out (the video with its own audio, if any, made AAC): a broken rendition
     * must not take the picture down with it. Only failures of the audio side count (it could not be opened, inputs.ts
     * `audioFault`), never the video's. Left out: after AUDIO_TRIES blamed runs in a row (the count starts again after a run with
     * AUDIO_HEALTHY_SEGMENTS), after AUDIO_FAULTS within AUDIO_FAULT_WINDOW_MS, or at once when refused or encrypted. It is tried
     * again at `retryAt` (3, 6, 12, … ≤ 30 min, the video-only run is ended then), once: failing again leaves it out for longer.
     */
    let audioFails = 0;
    let faults: number[] = [];
    let drops = 0;
    let retryAt: number | null = null;
    const audioFailed = (fatal: boolean) => {
      const t = now();
      faults = [...faults.filter((f) => t - f < AUDIO_FAULT_WINDOW_MS), t];
      audioFails = fatal ? AUDIO_TRIES : audioFails + 1;
      if (audioFails < AUDIO_TRIES && faults.length < AUDIO_FAULTS) return;
      const wait = Math.min(AUDIO_RETRY_MS * 2 ** drops, AUDIO_RETRY_MAX_MS);
      drops++;
      retryAt = t + wait;
      audioFails = 0;
      faults = [];
      ctx.log(`separate audio rendition unavailable, playing the video without it; trying it again in ${wait / 60_000} min`);
    };
    // fixed texts from openInput; the same one again in a row (each restart of a source that cannot be aligned) is said once
    /** where each rendition's next run starts: after the last segment it delivered (inputs.ts `resume`, no replay on a restart) */
    const resume: Resume = { video: null, audio: null };
    let lastInputLog = '';
    const inputLog = (m: string) => { if (m !== lastInputLog) { lastInputLog = m; ctx.log(m); } };

    while (!ctx.signal.aborted) {
      let opened: OpenedInput;
      if (retryAt !== null && now() >= retryAt) {
        // one try: failing again leaves it out at once, for longer
        retryAt = null;
        audioFails = AUDIO_TRIES - 1;
        ctx.log('separate audio: trying the rendition again');
      }
      const noAudio = retryAt !== null;
      try {
        opened = await openInput(input, {
          guard: d.guard, ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.ingest ? { ingest: d.ingest } : {}), signal: ctx.signal, maxBitrate: ctx.maxBitrate,
          log: inputLog, resume, ...(noAudio ? { noAudio: true } : {}),
        });
      } catch (e) {
        if (ctx.signal.aborted) break;
        if (e instanceof AudioUnavailable) {
          audioFailed(e.fatal);
          // left out now: without it at once, the video works
          if (retryAt !== null) continue;
        } else {
          if (e instanceof FetchError && FATAL.has(e.code)) { ctx.fail(e.code); return; }
          if (e instanceof PlaylistRefused) { ctx.fail(e.code); return; }
        }
        disc = true;
        if (!(await ctx.sleep(ctx.lost()))) break;
        continue;
      }
      const ff = opened.ffInput;
      const withAudio = ff.kind === 'pipe' && ff.audio !== undefined;
      const args = ffmpegArgs({
        mode, input: ff.kind === 'pipe' ? { kind: 'pipe', format: ff.format } : { kind: 'srt', url: ff.url },
        ...(ff.kind === 'pipe' && ff.audio ? { audioInput: { format: ff.audio.format, ...(ff.audio.shift ? { shift: ff.audio.shift } : {}) } } : {}),
        // left without its rendition: the variant's own audio is of unknown codec (the facts describe the rendition), so AAC
        encoder: ctx.encoder, audio: noAudio ? 'aac' : audio, srcHeight, dir: ctx.dir, startNumber: next,
      });
      let delivered = 0;
      let stalled = false;
      /** the video-only run ends when the left-out rendition is due again */
      let retryDue = false;
      // this run alone: a stop aborts it, and so does the stall watchdog (the stream then lives on and the loop restarts ffmpeg)
      const runAc = new AbortController();
      const endRun = () => runAc.abort();
      if (ctx.signal.aborted) runAc.abort();
      else ctx.signal.addEventListener('abort', endRun, { once: true });
      let stall: NodeJS.Timeout | undefined;
      const watch = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          ctx.log(`stalled: no segment for ${STALL_MS / 1000} s, restarting ffmpeg`);
          stalled = true;
          runAc.abort();
        }, STALL_MS);
      };
      let chain: Promise<void> = Promise.resolve();
      let pending = '';
      let first = true;
      const take = (l: string) => {
        const c = csvLine(l);
        if (!c || c.n < next) return;
        next = c.n + 1;
        delivered++;
        watch();
        const pdt = Math.round(now() - c.duration * 1000);
        const discontinuity = disc;
        disc = false;
        chain = chain.then(async () => {
          if (ctx.signal.aborted) return;
          // the input works: an outage ends here and the backoff starts again from 2 s
          if (first) { first = false; ctx.back(); }
          const file = `${c.n}.ts`;
          const bytes = await size(join(ctx.dir, file));
          await ctx.segment({ file, duration: c.duration, bytes, discontinuity, pdt });
          if (!rated && bytes > 0) { rated = true; ctx.bitrate(Math.round((bytes * 8) / c.duration)); }
        }).catch(() => {});
      };
      const retry = retryAt === null ? undefined : setTimeout(() => { retryDue = true; runAc.abort(); }, Math.max(0, retryAt - now()));
      try {
        watch();
        await d.run('ffmpeg', args, {
          timeoutMs: FOREVER_MS,
          signal: runAc.signal,
          ...(ff.kind === 'pipe' ? { stdin: ff.stdin, ...(ff.audio ? { audioStdin: ff.audio.stdin } : {}) } : {}),
          onStdout: (chunk) => {
            pending += chunk.toString('utf8');
            const lines = pending.split('\n');
            pending = lines.pop()!;
            if (pending.length > MAX_PENDING) pending = '';
            for (const l of lines) take(l);
          },
          stderrLog: { channelId: ctx.channelId, log },
        });
        if (pending) take(pending);
        await chain;
      } finally {
        clearTimeout(stall);
        clearTimeout(retry);
        ctx.signal.removeEventListener('abort', endRun);
        opened.close();
      }
      if (ctx.signal.aborted) break;
      if (withAudio) {
        if (delivered >= AUDIO_HEALTHY_SEGMENTS) { audioFails = 0; drops = 0; }
        if (opened.audioFault?.(stalled)) audioFailed(false);
      }
      disc = true;
      // ended on purpose to try the rendition again: no outage, no backoff (and due now, whatever the clock's rounding)
      if (retryDue) { retryAt = now(); continue; }
      // ffmpeg ended (or was cut) while the stream lives: the input is lost until a new run delivers a segment
      if (!(await ctx.sleep(ctx.lost()))) break;
    }
  };
}
