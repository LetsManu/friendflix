// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { decrypt, encrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';

export type SourceName = 'tmdb' | 'omdb';
export const SOURCES: readonly SourceName[] = ['tmdb', 'omdb'];

export const PAUSE_KEY = (name: SourceName) => `src:pause:${name}`;
export const INVALID_KEY = (name: SourceName) => `src:invalid:${name}`;
export const CACHE_PREFIX = (name: SourceName) => `ext:${name}:`;
/** hash of the file/env key last seen at startup (never the key itself) */
export const FILE_FP_KEY = (name: SourceName) => `src:fp:${name}`;
const FILE_FP_TTL = 400 * 86_400;
const FAIL_MARK = '{"f":1}';
export const OMDB_COUNT_KEY = (dayUtc: string) => `src:omdb:calls:${dayUtc}`;
export const OMDB_DAILY_BUDGET = 900;

export interface SourceStatus {
  name: SourceName;
  set: boolean;
  last4: string | null;
  from: 'db' | 'file' | null;
  invalid: boolean;
  usedToday?: number;
  budget?: number;
}

type KeyCtx = Pick<Ctx, 'db' | 'cfg' | 'encKey' | 'settings'>;
interface Stored { enc: string | null; last4: string | null }

/** the key's row in the settings table (Block 25; before migration 39 it was app_settings 'source.<name>') */
const settingKey = (name: SourceName) => (name === 'tmdb' ? 'TMDB_API_KEY' : 'OMDB_API_KEY');
const storedKey = async (ctx: Pick<Ctx, 'db'>, name: SourceName): Promise<Stored | undefined> =>
  (await ctx.db.query<Stored>('select enc, last4 from settings where key=$1', [settingKey(name)])).rows[0];
/** the key from the environment / a secret file: ctx.cfg also holds a key saved in the database, so the source decides */
const fileKey = (ctx: Pick<Ctx, 'cfg' | 'settings'>, name: SourceName): string | undefined =>
  ctx.settings.sources()[settingKey(name)] === 'env' ? (name === 'tmdb' ? ctx.cfg.TMDB_API_KEY : ctx.cfg.OMDB_API_KEY) || undefined : undefined;

const CACHE_MS = 30_000;
// per database handle, so separate app instances (tests) never share a cache
const caches = new WeakMap<object, Map<SourceName, { at: number; key: string | null }>>();
const cacheOf = (ctx: Pick<Ctx, 'db'>) => {
  let m = caches.get(ctx.db);
  if (!m) caches.set(ctx.db, (m = new Map()));
  return m;
};

async function dbKey(ctx: KeyCtx, name: SourceName): Promise<string | null> {
  const cache = cacheOf(ctx);
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.key;
  let key: string | null = null;
  const enc = (await storedKey(ctx, name))?.enc;
  if (enc) {
    try { key = decrypt(ctx.encKey, enc); } catch { key = null; } // wrong APP_ENC_KEY: treat as not set, never log
  }
  cache.set(name, { at: Date.now(), key });
  return key;
}

/** The effective key: a file/env value wins over the one saved in the database. */
export async function getSourceKey(ctx: KeyCtx, name: SourceName): Promise<{ key: string; from: 'db' | 'file' } | null> {
  const file = fileKey(ctx, name);
  if (file) return { key: file, from: 'file' };
  const key = await dbKey(ctx, name);
  return key ? { key, from: 'db' } : null;
}

/** Saved through the settings store (encrypted, last4, a new revision that the other instances reload). */
export async function setSourceKey(ctx: KeyCtx, name: SourceName, key: string, actor: string | null = null): Promise<void> {
  await ctx.settings.save({ [settingKey(name)]: key }, actor);
  cacheOf(ctx).delete(name);
}

export async function removeSourceKey(ctx: KeyCtx, name: SourceName, actor: string | null = null): Promise<void> {
  await ctx.settings.save({ [settingKey(name)]: null }, actor);
  cacheOf(ctx).delete(name);
}

/** Drops the cached database key, so a key saved elsewhere (Admin -> Settings) is read at once on this instance. */
export function forgetSourceKey(ctx: Pick<Ctx, 'db'>, name: SourceName): void {
  cacheOf(ctx).delete(name);
}

/** A key change must work at once: drop the 401 pause, the invalid flag and every cached (failure) answer. */
export async function resetSourceState(ctx: Pick<Ctx, 'kv'>, name: SourceName): Promise<void> {
  await ctx.kv.del(PAUSE_KEY(name));
  await ctx.kv.del(INVALID_KEY(name));
  for (const k of await ctx.kv.keys(CACHE_PREFIX(name))) await ctx.kv.del(k);
}

/** After a key got better (a successful Test, a new file key): drop the 401 pause, the invalid flag and the cached failures; answers stay. */
export async function clearSourceFailures(ctx: Pick<Ctx, 'kv'>, name: SourceName): Promise<void> {
  await ctx.kv.del(PAUSE_KEY(name));
  await ctx.kv.del(INVALID_KEY(name));
  for (const k of await ctx.kv.keys(CACHE_PREFIX(name))) if ((await ctx.kv.get(k)) === FAIL_MARK) await ctx.kv.del(k);
}

/** the last seen file key, stored encrypted with APP_ENC_KEY (no hash: a short key could be brute-forced from a kv dump) */
const sameKey = (encKey: Buffer, stored: string | null, key: string) => {
  if (!stored) return !key;
  try { return decrypt(encKey, stored) === key; } catch { return false; }
};

/**
 * At startup: a file/env key that differs from the one seen last time (replaced secret file, restart) clears the source's failure state,
 * so the new key works at once instead of after the 1 h pause.
 */
export async function syncFileKeys(ctx: Pick<Ctx, 'cfg' | 'settings' | 'kv' | 'encKey'>): Promise<void> {
  for (const name of SOURCES) {
    const file = fileKey(ctx, name);
    if (sameKey(ctx.encKey, await ctx.kv.get(FILE_FP_KEY(name)), file ?? '')) continue;
    await clearSourceFailures(ctx, name);
    if (file) await ctx.kv.set(FILE_FP_KEY(name), encrypt(ctx.encKey, file), FILE_FP_TTL);
    else await ctx.kv.del(FILE_FP_KEY(name));
  }
}

export async function sourceStatus(ctx: Ctx, name: SourceName): Promise<SourceStatus> {
  const file = fileKey(ctx, name);
  let last4: string | null = null;
  let from: 'db' | 'file' | null = null;
  let undecryptable = false;
  if (file) { last4 = file.slice(-4); from = 'file'; }
  else {
    const v = await storedKey(ctx, name);
    if (v?.enc && (await dbKey(ctx, name)) !== null) { last4 = v.last4 ?? null; from = 'db'; } // undecryptable (APP_ENC_KEY changed) counts as not usable
    else if (v?.enc) undecryptable = true;
  }
  const s: SourceStatus = { name, set: from !== null, last4, from, invalid: undecryptable || (from !== null && (await ctx.kv.get(INVALID_KEY(name))) !== null) };
  if (name === 'omdb') {
    s.usedToday = Number((await ctx.kv.get(OMDB_COUNT_KEY(new Date().toISOString().slice(0, 10)))) ?? 0) || 0;
    s.budget = OMDB_DAILY_BUDGET;
  }
  return s;
}
