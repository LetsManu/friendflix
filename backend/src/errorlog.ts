import { createHash } from 'node:crypto';
import { scrub } from './clientErrors.js';
import type { Ctx } from './ctx.js';

/**
 * Block 22: aggregated error log for the admin health page. Fingerprints, not events: one entry per source + code (+ item)
 * with a count, first/last time, release and one scrubbed sample.
 *
 * Storage differs by source (privacy, see docs/monitoring.md "Datenschutz"):
 * - `server` (responses >= 500, keyed by route pattern) and `job` (background job failures) carry no personal data and live
 *   in Redis: `errlog:<source>:<hash>` (7 days), per-minute counters `errlog:b:<source>:<minute>` (2 h).
 * - `client` and `playback` (browser reports) are counted in this process's memory only: 24 h window, lost on restart, never
 *   written to Redis or Postgres. No user id, IP or user agent is ever part of an entry.
 * Each store holds at most 300 fingerprints; beyond that only an overflow counter grows. Recording never throws.
 */
export type ErrorSource = 'server' | 'client' | 'playback' | 'job';
export const ERROR_SOURCES = ['server', 'client', 'playback', 'job'] as const;

export interface ErrorEntry {
  source: ErrorSource;
  code: string;
  count: number;
  firstAt: string;
  lastAt: string;
  release?: string;
  sample?: string;
  itemId?: string;
}

export interface ErrorInput { source: ErrorSource; code: string; sample?: string; itemId?: string; release?: string }

/** cfg is optional: index ticks run with a narrower ctx (the release is then left out) */
type KvCtx = Pick<Ctx, 'kv'> & Partial<Pick<Ctx, 'cfg'>>;

const ENTRY_TTL = 7 * 86400; // 604800
const BUCKET_TTL = 2 * 3600;
const MAX_FINGERPRINTS = 300;
const MEMORY_WINDOW_MS = 24 * 3600_000;
const COUNT_CACHE_MS = 60_000;
const ITEM_ID = /^[0-9a-f]{32}$/;

const isMemory = (s: ErrorSource) => s === 'client' || s === 'playback';
const minuteOf = (ms: number) => Math.floor(ms / 60_000);
const fingerprint = (code: string, itemId?: string) => createHash('sha1').update(code + (itemId ?? '')).digest('hex').slice(0, 16);
const clean = (s: string, max: number) => scrub(s).replace(/\s+/g, ' ').trim().slice(0, max);

function releaseOf(cfg: KvCtx['cfg']): string | undefined {
  if (!cfg) return undefined;
  return cfg.APP_VERSION ?? (cfg.GIT_SHA ? cfg.GIT_SHA.slice(0, 7) : undefined);
}

// ---- memory store (client + playback) ----
const mem = new Map<string, ErrorEntry & { lastMs: number }>();
const memBuckets = new Map<string, number>(); // `${source}:${minute}` -> n
const memOverflow: number[] = []; // timestamps of dropped reports (24 h)

function pruneMemory(now: number) {
  for (const [k, e] of mem) if (now - e.lastMs > MEMORY_WINDOW_MS) mem.delete(k);
  const oldest = minuteOf(now) - BUCKET_TTL / 60;
  for (const k of memBuckets.keys()) if (Number(k.split(':')[1]) < oldest) memBuckets.delete(k);
  while (memOverflow.length && now - memOverflow[0]! > MEMORY_WINDOW_MS) memOverflow.shift();
}

/** Tests only: forget everything kept in memory (and the cached Redis fingerprint count). */
export function resetErrorLogForTests() {
  mem.clear();
  memBuckets.clear();
  memOverflow.length = 0;
  keyCount = null;
}

// ---- Redis store (server + job) ----
let keyCount: { n: number; at: number } | null = null;
const STORED_KEY = /^errlog:(server|job):/;

async function storedCount(ctx: KvCtx, now: number): Promise<number> {
  if (!keyCount || now - keyCount.at > COUNT_CACHE_MS) {
    const keys = await ctx.kv.keys('errlog:');
    keyCount = { n: keys.filter((k) => STORED_KEY.test(k)).length, at: now };
  }
  return keyCount.n;
}

function normalise(ctx: KvCtx, e: ErrorInput) {
  const code = clean(e.code, 120) || 'unknown';
  const sample = e.sample ? clean(e.sample, 300) : undefined;
  const itemId = e.itemId && ITEM_ID.test(e.itemId) ? e.itemId : undefined;
  const release = e.release ? clean(e.release, 40) : releaseOf(ctx.cfg);
  return { code, sample, itemId, release };
}

/** Records one error occurrence. `now` exists for tests. Never throws. */
export async function recordError(ctx: KvCtx, e: ErrorInput, now = Date.now()): Promise<void> {
  try {
    const { code, sample, itemId, release } = normalise(ctx, e);
    const hash = fingerprint(code, itemId);
    const at = new Date(now).toISOString();
    if (isMemory(e.source)) {
      pruneMemory(now);
      const key = `${e.source}:${hash}`;
      const cur = mem.get(key);
      if (!cur && mem.size >= MAX_FINGERPRINTS) {
        memOverflow.push(now);
        return;
      }
      const bucket = `${e.source}:${minuteOf(now)}`;
      memBuckets.set(bucket, (memBuckets.get(bucket) ?? 0) + 1);
      if (cur) {
        cur.count++;
        if (now >= cur.lastMs) Object.assign(cur, { lastAt: at, lastMs: now, ...(release ? { release } : {}), ...(sample ? { sample } : {}) });
      } else {
        mem.set(key, { source: e.source, code, count: 1, firstAt: at, lastAt: at, lastMs: now, ...(release ? { release } : {}), ...(sample ? { sample } : {}), ...(itemId ? { itemId } : {}) });
      }
      return;
    }
    const key = `errlog:${e.source}:${hash}`;
    const raw = await ctx.kv.get(key);
    if (!raw && (await storedCount(ctx, now)) >= MAX_FINGERPRINTS) {
      await ctx.kv.incr('errlog:overflow', ENTRY_TTL);
      return;
    }
    await ctx.kv.incr(`errlog:b:${e.source}:${minuteOf(now)}`, BUCKET_TTL);
    let entry: ErrorEntry;
    if (raw) {
      const prev = JSON.parse(raw) as ErrorEntry;
      const newer = at >= prev.lastAt;
      entry = { ...prev, count: prev.count + 1, ...(newer ? { lastAt: at, ...(release ? { release } : {}), ...(sample ? { sample } : {}) } : {}) };
    } else {
      entry = { source: e.source, code, count: 1, firstAt: at, lastAt: at, ...(release ? { release } : {}), ...(sample ? { sample } : {}), ...(itemId ? { itemId } : {}) };
      if (keyCount) keyCount.n++;
    }
    await ctx.kv.set(key, JSON.stringify(entry), ENTRY_TTL);
  } catch {
    // the error log must never cause an error of its own
  }
}

/** Entries (newest first) of all or one source, optionally only those seen since a date. */
export async function listErrors(ctx: KvCtx, opts: { since?: Date; source?: ErrorSource; limit?: number }): Promise<{ entries: ErrorEntry[]; overflow: number }> {
  const now = Date.now();
  pruneMemory(now);
  const since = opts.since?.toISOString() ?? '';
  const wantStored = !opts.source || !isMemory(opts.source);
  const wantMemory = !opts.source || isMemory(opts.source);
  const out: ErrorEntry[] = [];
  let overflow = 0;
  if (wantStored) {
    const keys = (await ctx.kv.keys('errlog:')).filter((k) => STORED_KEY.test(k) && (!opts.source || k.startsWith(`errlog:${opts.source}:`)));
    const vals = await ctx.kv.mget(keys);
    for (const v of vals) {
      if (!v) continue;
      try { out.push(JSON.parse(v) as ErrorEntry); } catch { /* skip a broken entry */ }
    }
    overflow += Number((await ctx.kv.get('errlog:overflow')) ?? 0);
  }
  if (wantMemory) {
    for (const e of mem.values()) {
      if (opts.source && e.source !== opts.source) continue;
      const { lastMs: _lastMs, ...entry } = e;
      out.push({ ...entry });
    }
    overflow += memOverflow.length;
  }
  const entries = out.filter((e) => e.lastAt >= since).sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  return { entries: entries.slice(0, opts.limit ?? 200), overflow };
}

/** Occurrences of one source in the last 15 or 60 minutes (per-minute counters). */
export async function recentCount(ctx: KvCtx, source: ErrorSource, minutes: 15 | 60, now = Date.now()): Promise<number> {
  const cur = minuteOf(now);
  const minutesList = Array.from({ length: minutes }, (_, i) => cur - i);
  if (isMemory(source)) return minutesList.reduce((n, m) => n + (memBuckets.get(`${source}:${m}`) ?? 0), 0);
  try {
    const vals = await ctx.kv.mget(minutesList.map((m) => `errlog:b:${source}:${m}`));
    return vals.reduce((n, v) => n + Number(v ?? 0), 0);
  } catch {
    return 0;
  }
}

/** catch handler for background jobs: keeps the existing log line and records a `job` error with the job's name. */
export function jobFailed(ctx: KvCtx, log: { warn: (obj: unknown, msg?: string) => void }, job: string, msg: string) {
  return (e: unknown) => {
    log.warn({ e }, msg);
    void recordError(ctx, { source: 'job', code: job });
  };
}
