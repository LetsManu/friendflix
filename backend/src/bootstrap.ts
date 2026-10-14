// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The `bootstrap` init container (compose): generates every secret needed before the database can be read into the `bootstrap`
// volume, and the gateway's copy of INTERNAL_SECRET into `bootstrap-gateway`. Runs as root without any capability but CHOWN, on a
// read-only root fs without network, then exits; every other service waits for it (service_completed_successfully).
// Dependency-free on purpose (node: modules only): it must not load the app, its config or its database code.
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** volume file -> the legacy env variable that wins over it (existing installs keep their .env values) */
const SECRETS = [
  { file: 'postgres_password', env: 'POSTGRES_PASSWORD', make: () => randomBytes(32).toString('hex') },
  { file: 'redis_password', env: 'REDIS_PASSWORD', make: () => randomBytes(32).toString('hex') },
  { file: 'app_enc_key', env: 'APP_ENC_KEY', make: () => randomBytes(32).toString('base64') },
  { file: 'internal_secret', env: 'INTERNAL_SECRET', make: () => randomBytes(32).toString('hex') },
] as const;

export interface BootstrapOptions {
  dir: string;
  gatewayDir: string;
  env: NodeJS.ProcessEnv;
  /** the group that may read the files (FF_SECRETS_GID, 10001): services that need them get it via group_add */
  gid: number;
  chown: (path: string, uid: number, gid: number) => void;
  /** file names and actions only, never values */
  log: (line: string) => void;
}

/** A redis.conf argument: plain when redis reads it back verbatim, else double-quoted with escapes (a legacy password may be anything). */
function redisArg(v: string): string {
  if (/^[\x21-\x7e]+$/.test(v) && !/["'\\]/.test(v)) return v;
  const esc = [...Buffer.from(v, 'utf8')].map((b) => {
    if (b === 0x22) return '\\"';
    if (b === 0x5c) return '\\\\';
    return b >= 0x20 && b <= 0x7e && b !== 0x27 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
  });
  return `"${esc.join('')}"`;
}

const readOr = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/**
 * Creates the volume layout (idempotent): per secret, a non-empty env value is written (env wins on every run), else an existing
 * non-empty file is kept, else a new value is generated. redis.conf and the gateway copy follow their source. Directories end up
 * 0750, files 0440, all owned by root and `gid`. Writes are atomic (temp file + rename).
 */
export function runBootstrap(opts: BootstrapOptions): void {
  const { dir, gatewayDir, env, gid, chown, log } = opts;
  for (const d of [dir, gatewayDir]) {
    mkdirSync(d, { recursive: true });
    chown(d, 0, gid);
    chmodSync(d, 0o750);
  }

  /** writes `content` when it differs from what is there; always (re)applies owner and mode */
  const put = (path: string, content: string): 'kept' | 'written' => {
    if (readOr(path) === content) {
      chown(path, 0, gid);
      chmodSync(path, 0o440);
      return 'kept';
    }
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true }); // a leftover 0440 temp file could not be reopened for writing without CAP_DAC_OVERRIDE
    writeFileSync(tmp, content, { mode: 0o600 });
    chown(tmp, 0, gid);
    chmodSync(tmp, 0o440);
    renameSync(tmp, path);
    return 'written';
  };

  const values: Record<string, string> = {};
  for (const s of SECRETS) {
    const path = join(dir, s.file);
    const fromEnv = env[s.env];
    const existing = readOr(path);
    let action: string;
    if (fromEnv) {
      values[s.file] = fromEnv;
      action = 'from environment';
    } else if (existing) {
      values[s.file] = existing;
      action = 'kept';
    } else {
      values[s.file] = s.make();
      action = 'generated';
    }
    put(path, values[s.file]!);
    log(`${s.file}: ${action}`);
  }

  const conf = join(dir, 'redis.conf');
  const confExisted = existsSync(conf);
  const confAction = put(conf, `requirepass ${redisArg(values.redis_password!)}\n`);
  log(`redis.conf: ${confAction === 'kept' ? 'kept' : confExisted ? 'updated' : 'generated'}`);

  // the gateway only ever sees INTERNAL_SECRET: never the database password or the encryption key
  const gw = join(gatewayDir, 'internal_secret');
  const gwExisted = existsSync(gw);
  const gwAction = put(gw, values.internal_secret!);
  log(`gateway internal_secret: ${gwAction === 'kept' ? 'kept' : gwExisted ? 'updated' : 'generated'}`);
}

// entry point of the init container: node backend/dist/bootstrap.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runBootstrap({ dir: '/run/friendflix', gatewayDir: '/run/friendflix-gateway', env: process.env, gid: 10001, chown: chownSync, log: (l) => console.log(`bootstrap: ${l}`) });
  } catch (err) {
    // fs errors name the path and the code, never file contents
    console.error(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
