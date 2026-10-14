// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the `bootstrap` init container wrote into the bootstrap volume (src/bootstrap.ts); undefined = file missing or empty. */
export interface BootstrapFiles {
  postgresPassword?: string;
  redisPassword?: string;
  appEncKey?: string;
  internalSecret?: string;
}

export type BootstrapEnv = { DATABASE_URL: string; REDIS_URL: string; APP_ENC_KEY: string; INTERNAL_SECRET: string };

const DIR = '/run/friendflix';
const FILES: Record<keyof BootstrapFiles, string> = {
  postgresPassword: 'postgres_password', redisPassword: 'redis_password', appEncKey: 'app_enc_key', internalSecret: 'internal_secret',
};

/** Reads the bootstrap volume. A missing directory or file is not an error here (env may provide the key); an unreadable one is. */
export function readBootstrap(dir = DIR): BootstrapFiles {
  const out: BootstrapFiles = {};
  for (const [key, name] of Object.entries(FILES) as Array<[keyof BootstrapFiles, string]>) {
    const path = join(dir, name);
    let v: string;
    try {
      v = readFileSync(path, 'utf8').trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      // EACCES: the container lacks the secrets group (group_add: ["10001"]); the message names the path, never a value
      throw new Error(`bootstrap file ${path} is not readable (${code})`, { cause: err });
    }
    if (v) out[key] = v;
  }
  return out;
}

/** VAR, or the file named by VAR_FILE (which then decides alone; empty = unset), as the settings resolver's env layer reads it. */
function fromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim() || undefined;
  return env[name] || undefined;
}

const missing = (name: string) =>
  new Error(`bootstrap file ${DIR}/${name} missing: start the stack with docker compose up (the bootstrap service creates it)`);

/**
 * The four bootstrap keys: env (incl. VAR_FILE) wins, else derived from the bootstrap volume (spec Part A defaults). A file is only
 * required when env does not provide its key; a missing one is a startup error naming the file and the fix.
 */
export function bootstrapEnv(env: NodeJS.ProcessEnv, files: BootstrapFiles): BootstrapEnv {
  const need = (key: keyof BootstrapFiles) => {
    const v = files[key];
    if (!v) throw missing(FILES[key]);
    return v;
  };
  return {
    DATABASE_URL: fromEnv(env, 'DATABASE_URL') ?? `postgres://friendflix:${encodeURIComponent(need('postgresPassword'))}@postgres:5432/friendflix`,
    REDIS_URL: fromEnv(env, 'REDIS_URL') ?? `redis://:${encodeURIComponent(need('redisPassword'))}@redis:6379`,
    APP_ENC_KEY: fromEnv(env, 'APP_ENC_KEY') ?? need('appEncKey'),
    INTERNAL_SECRET: fromEnv(env, 'INTERNAL_SECRET') ?? need('internalSecret'),
  };
}
