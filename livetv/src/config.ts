// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSrtPorts } from './system.js';

export interface LivetvConfig {
  port: number;
  secret: string;
  /** DVR segments and previews (the `livetv-cache` volume) */
  cacheDir: string;
  /** LIVETV_CACHE_MAX_GB in bytes */
  cacheMaxBytes: number;
  /** LIVETV_SRT_PORTS, parsed: livetv listens on exactly these (spec §3.5) */
  srtPorts: number[];
  version: string | null;
}

const GB = 1024 ** 3;

/**
 * INTERNAL_SECRET: env or INTERNAL_SECRET_FILE, else the copy the `bootstrap` init container writes into the `bootstrap-gateway`
 * volume (compose mounts it read-only at /run/friendflix-gateway; it holds nothing else). Same rule as gateway/src/env.ts,
 * including FF_GATEWAY_BOOTSTRAP_DIR, which only moves it (tests). Error texts never contain the value.
 */
function secret(env: NodeJS.ProcessEnv): string {
  const f = env.INTERNAL_SECRET_FILE;
  let v = (f ? readFileSync(f, 'utf8').trim() : env.INTERNAL_SECRET) || '';
  if (!v) {
    const file = join(env.FF_GATEWAY_BOOTSTRAP_DIR || '/run/friendflix-gateway', 'internal_secret');
    try {
      v = readFileSync(file, 'utf8').replace(/(\r?\n)+$/, ''); // the volume's contract (backend/src/volumeValue.ts): trailing newlines only
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`bootstrap file ${file} is not readable (${code})`, { cause: err });
    }
    if (!v) throw new Error(`missing INTERNAL_SECRET (env, INTERNAL_SECRET_FILE or ${file}): start the stack with docker compose up (the bootstrap service creates it)`);
  }
  // the backend refuses a shorter one too (backend/src/config.ts)
  if (v.length < 16) throw new Error('INTERNAL_SECRET must be at least 16 characters');
  return v;
}

/** Every value is checked here; a wrong one stops the start with a message naming the variable. */
export function loadConfig(env: NodeJS.ProcessEnv): LivetvConfig {
  const port = Number(env.PORT || 8090);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024-65535');
  const rawGb = env.LIVETV_CACHE_MAX_GB?.trim() || '6';
  const gb = /^[0-9]{1,5}(\.[0-9]{1,3})?$/.test(rawGb) ? Number(rawGb) : NaN;
  if (!(gb > 0 && gb <= 10_000)) throw new Error('LIVETV_CACHE_MAX_GB must be a number of GB above 0 (default 6)');
  return {
    port,
    secret: secret(env),
    cacheDir: '/cache',
    cacheMaxBytes: Math.floor(gb * GB),
    srtPorts: parseSrtPorts(env.LIVETV_SRT_PORTS),
    version: env.APP_VERSION && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(env.APP_VERSION) ? env.APP_VERSION : null,
  };
}
