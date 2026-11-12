// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FetchError, type GuardDeps } from './fetch.js';
import { AUDIO_BITRATE, audioFor, ffmpegArgs, videoBitrate } from './ffmpeg.js';
import { openInput, type OpenedInput } from './inputs.js';
import type { Log } from './log.js';
import { PlaylistRefused, type FetchFn } from './passthrough.js';
import { probe, type ProbeResult, type StreamInput } from './probe.js';
import type { Run } from './run.js';
import type { Driver, Mode } from './streams.js';

/**
 * The remux and transcode driver (spec §3.3, §7.4; plan rulings 3 and 23). It probes the input once at the start (a stop during
 * the probe aborts it and ends the driver at once); a requested `transcode` whose probe says the video can be copied runs as
 * `remux` and reports so (spec §7.4 step 4: the backend then releases the budget slot). ffmpeg writes `<dir>/<n>.ts` and reports
 * each finished segment as a CSV line on stdout; each line becomes a window entry with `pdt` = its arrival − the segment's
 * duration (ruling 47). When ffmpeg ends while the stream lives (input gone, provider restart) it is started again after the
 * shared backoff (2, 4, 8, 15, 30 s, then 30 s; a run that delivered a segment resets it); the first segment of the new run is a
 * discontinuity and local numbering continues. Logs: channel id and fixed texts only; ffmpeg's stderr goes through run.ts
 * (`scrubLine`), never through here.
 */
export interface RemuxDeps {
  run: Run;
  guard: GuardDeps;
  /** replaces `guardedFetch` (tests) */
  fetch?: FetchFn;
  /** replaces the Task 14 probe (tests); `signal` aborts when the stream stops */
  probe?: (input: StreamInput, signal: AbortSignal) => Promise<ProbeResult>;
  /** where ffmpeg's scrubbed stderr goes */
  log?: Log;
  /** the size of a written segment (default: the file's size, 0 when it is missing) */
  size?: (path: string) => Promise<number>;
  now?: () => number;
}

const FOREVER_MS = 2 ** 31 - 1;
const FATAL = new Set(['address_refused', 'scheme']);
const MAX_SEGMENT_S = 120;
const MAX_PENDING = 4096;
const CSV_RE = /^(?:.*[\\/])?(0|[1-9]\d{0,9})\.ts,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const PROBE_FAILED: ProbeResult = { ok: false, needs: 'transcode' };

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

export function remuxDriver(d: RemuxDeps): Driver {
  const probeFn = d.probe ?? ((input: StreamInput, signal: AbortSignal) => probe(input, { run: d.run, guard: d.guard, signal }));
  const size = d.size ?? fileSize;
  const log: Log = d.log ?? (() => {});
  const now = d.now ?? Date.now;
  return async (ctx) => {
    const input = ctx.input;
    if ('push' in input) { ctx.fail('invalid'); return; }
    const facts = await untilAbort(probeFn(input, ctx.signal).catch(() => PROBE_FAILED), ctx.signal);
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

    while (!ctx.signal.aborted) {
      let opened: OpenedInput;
      try {
        opened = await openInput(input, { guard: d.guard, ...(d.fetch ? { fetch: d.fetch } : {}), signal: ctx.signal, maxBitrate: ctx.maxBitrate });
      } catch (e) {
        if (ctx.signal.aborted) break;
        if (e instanceof FetchError && FATAL.has(e.code)) { ctx.fail(e.code); return; }
        if (e instanceof PlaylistRefused) { ctx.fail(e.code); return; }
        disc = true;
        if (!(await ctx.sleep(ctx.lost()))) break;
        continue;
      }
      const ff = opened.ffInput;
      const args = ffmpegArgs({
        mode, input: ff.kind === 'pipe' ? { kind: 'pipe' } : { kind: 'srt', url: ff.url }, encoder: ctx.encoder, audio, srcHeight, dir: ctx.dir, startNumber: next,
      });
      let chain: Promise<void> = Promise.resolve();
      let pending = '';
      let first = true;
      const take = (l: string) => {
        const c = csvLine(l);
        if (!c || c.n < next) return;
        next = c.n + 1;
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
      try {
        await d.run('ffmpeg', args, {
          timeoutMs: FOREVER_MS,
          signal: ctx.signal,
          ...(ff.kind === 'pipe' ? { stdin: ff.stdin } : {}),
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
        opened.close();
      }
      if (ctx.signal.aborted) break;
      // ffmpeg ended while the stream lives: the input is lost until a new run delivers a segment
      disc = true;
      if (!(await ctx.sleep(ctx.lost()))) break;
    }
  };
}
