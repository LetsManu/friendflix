// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { hwArgs, videoArgs } from '../ffmpeg.js';
import type { Log } from '../log.js';
import { TIMEOUT_CODE, type Run } from '../run.js';
import type { Answer, Route } from '../server.js';
import { ENCODERS, type Encoder } from '../system.js';

/**
 * `POST /v1/benchmark { encoder }` (spec §5.4, plan R3: livetv's part): 20 s of a 1080p25 test picture through the transcode video
 * options of `encoder`, into nothing; `speed` = 20 / wall seconds (2 decimals). One at a time (`409 busy`), 120 s timeout. A
 * failed run answers a fixed code, never ffmpeg's output.
 */
export const BENCH_SECONDS = 20;
export const BENCH_TIMEOUT_MS = 120_000;

export function benchmarkArgs(encoder: Encoder): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', ...hwArgs(encoder),
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25', '-t', String(BENCH_SECONDS),
    ...videoArgs(encoder, 1080), '-an', '-f', 'null', '-',
  ];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const invalid = (field: string): Answer => ({ status: 400, json: { error: 'invalid', field } });

export interface BenchmarkDeps {
  run: Run;
  now?: () => number;
  /** the encoders `/v1/system` lists; one outside it is `400 encoder_unavailable` */
  encoders?: () => Promise<Encoder[]>;
  log?: Log;
}

export function benchmarkRoutes(deps: BenchmarkDeps): Route[] {
  const now = deps.now ?? Date.now;
  let busy = false;
  return [{
    method: 'POST', path: '/v1/benchmark',
    handle: async (c) => {
      const b = c.json;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return invalid('body');
      const encoder = (b as Record<string, unknown>).encoder;
      if (!(ENCODERS as readonly unknown[]).includes(encoder)) return invalid('encoder');
      const enc = encoder as Encoder;
      if (busy) return { status: 409, json: { error: 'busy' } };
      busy = true;
      try {
        if (deps.encoders && !(await deps.encoders()).includes(enc)) return { status: 400, json: { error: 'encoder_unavailable' } };
        const t0 = now();
        const r = await deps.run('ffmpeg', benchmarkArgs(enc), {
          timeoutMs: BENCH_TIMEOUT_MS, ...(deps.log ? { stderrLog: { channelId: 'benchmark', log: deps.log } } : {}),
        });
        const wall = (now() - t0) / 1000;
        if (r.code === TIMEOUT_CODE) return { status: 504, json: { error: 'timeout' } };
        if (r.code !== 0 || !(wall > 0)) return { status: 502, json: { error: 'encoder_failed' } };
        return { status: 200, json: { speed: round2(BENCH_SECONDS / wall), encoder: enc, seconds: round2(wall) } };
      } finally {
        busy = false;
      }
    },
  }];
}
