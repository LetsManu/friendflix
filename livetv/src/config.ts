// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { parseSrtPorts } from './system.js';

export interface LivetvConfig {
  port: number;
  /** the signing key (32 bytes): HMAC-SHA256(INTERNAL_SECRET, 'friendflix-livetv/v1'), written by the `bootstrap` service */
  key: Buffer;
  /** DVR segments and previews (the `livetv-cache` volume) */
  cacheDir: string;
  /** LIVETV_CACHE_MAX_GB in bytes */
  cacheMaxBytes: number;
  /** LIVETV_SRT_PORTS, parsed: livetv listens on exactly these (spec §3.5) */
  srtPorts: number[];
  version: string | null;
}

const GB = 1024 ** 3;
export const KEY_FILE = '/run/friendflix-livetv/livetv_key';

/**
 * The signing key, never INTERNAL_SECRET itself (spec §3.1 ruling, 1b review I1): the `bootstrap` init container derives
 * HMAC-SHA256(INTERNAL_SECRET, 'friendflix-livetv/v1') and writes it as 64 hex into the `bootstrap-livetv` volume, which only
 * livetv mounts (read-only at /run/friendflix-livetv). INTERNAL_SECRET is the key to the backend's /internal/* routes (the media
 * server token among them); livetv parses provider input with ffmpeg and must not hold it. LIVETV_KEY_FILE only moves the file
 * (tests). Without the file livetv does not start; error texts name the file, never its content.
 */
function key(env: NodeJS.ProcessEnv): Buffer {
  const file = env.LIVETV_KEY_FILE || KEY_FILE;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`missing key file ${file}: run docker compose up -d once (the bootstrap service writes it)`, { cause: err });
    throw new Error(`key file ${file} is not readable (${code})`, { cause: err });
  }
  const v = raw.replace(/(\r?\n)+$/, ''); // the bootstrap volume's contract (backend/src/volumeValue.ts): trailing newlines only
  if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`key file ${file} does not hold a 64-hex key: run docker compose up -d once (the bootstrap service rewrites it)`);
  return Buffer.from(v, 'hex');
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
    key: key(env),
    cacheDir: '/cache',
    cacheMaxBytes: Math.floor(gb * GB),
    srtPorts: parseSrtPorts(env.LIVETV_SRT_PORTS),
    version: env.APP_VERSION && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(env.APP_VERSION) ? env.APP_VERSION : null,
  };
}
