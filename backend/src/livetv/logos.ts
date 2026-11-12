// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { LivetvError, livetvStream } from './client.js';

/**
 * Channel logos (spec §6.1 `livetv_logos`, ruling 28). A logo URL from a provider list or an XMLTV `<icon>` is fetched through livetv
 * (`POST /v1/fetch/logo`, which guards the address and sniffs the image), stored by the sha256 of its bytes, and remembered for 7 days
 * as `ltvlogo:<sha256(url)>` -> hash. The URL itself is never stored, logged or answered (it may carry provider credentials).
 */
const MEMO_TTL_S = 7 * 24 * 3600;
/** a logo the provider refused (404, not an image, too big) is asked for again a day later, not on every refresh */
const MISS_TTL_S = 24 * 3600;
const MISS = '-';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 512 * 1024;
const MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const memoKey = (url: string) => `ltvlogo:${sha256(url)}`;

/** the answer's bytes, null when they exceed MAX_BYTES (read no further than that; livetv caps logos too, this keeps the bound local) */
async function readCapped(r: Response): Promise<Buffer | null> {
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) { await r.body?.cancel().catch(() => undefined); return null; }
  if (!r.body) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n > MAX_BYTES) { await reader.cancel().catch(() => undefined); return null; }
  }
  return Buffer.concat(parts);
}

/** the bytes livetv answered, or null when they are not a logo (type, size) */
async function fetchBytes(ctx: Ctx, url: string, allowLan: boolean): Promise<{ mime: string; bytes: Buffer } | null> {
  const r = await livetvStream(ctx, '/v1/fetch/logo', { url, allowLan }, { timeoutMs: TIMEOUT_MS });
  const mime = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  let bytes: Buffer | null;
  try { bytes = await readCapped(r); } catch { throw new LivetvError(null, 'unreachable'); }
  if (!MIMES.includes(mime) || !bytes || bytes.length === 0) return null;
  return { mime, bytes };
}

/**
 * Fetches the logo through livetv and stores it; the memo records the hash (7 days) or a refusal (a day). A refusal is a 4xx answer
 * (the provider's logo: not found, not an image, too big) or bytes that are no logo; livetv not reached or failing itself (5xx) is not
 * remembered, the next refresh tries again.
 */
async function fetchAndStore(ctx: Ctx, url: string, allowLan: boolean): Promise<string | null> {
  const key = memoKey(url);
  let got: { mime: string; bytes: Buffer } | null;
  try {
    got = await fetchBytes(ctx, url, allowLan);
  } catch (e) {
    if (e instanceof LivetvError && e.status !== null && e.status >= 400 && e.status < 500) { await ctx.kv.set(key, MISS, MISS_TTL_S); return null; }
    if (e instanceof LivetvError) return null;
    throw e;
  }
  if (!got) { await ctx.kv.set(key, MISS, MISS_TTL_S); return null; }
  const hash = sha256(got.bytes);
  await ctx.db.query('insert into livetv_logos(hash, mime, bytes) values ($1, $2, $3) on conflict do nothing', [hash, got.mime, got.bytes]);
  await ctx.kv.set(key, hash, MEMO_TTL_S);
  return hash;
}

/**
 * The stored logo hash for `url`, fetching it through livetv unless a fetch in the last 7 days found it (ruling 28). null = no logo:
 * the provider refused it (remembered a day) or livetv was not reached or failed (not remembered, the next refresh tries again).
 */
export async function importLogo(ctx: Ctx, url: string, allowLan: boolean): Promise<string | null> {
  const memo = await ctx.kv.get(memoKey(url));
  if (memo === MISS) return null;
  if (memo && HASH_RE.test(memo)) {
    // the daily prune drops logos no channel uses: a remembered hash counts only while its bytes are still there
    const has = await ctx.db.query('select 1 from livetv_logos where hash = $1', [memo]);
    if (has.rowCount) return memo;
  }
  return fetchAndStore(ctx, url, allowLan);
}

/**
 * The hashes of many logo URLs (a refresh): the remembered ones in one KV round trip and one query per 500, the rest fetched a few at a
 * time until `deadline` (epoch ms). A URL missing from the answer was not resolved this time (refused, unreachable, out of time).
 */
export async function importLogos(ctx: Ctx, urls: readonly string[], allowLan: boolean, deadline: number, parallel = 4): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo: string[] = [];
  const unique = [...new Set(urls)];
  for (let i = 0; i < unique.length; i += 500) {
    const part = unique.slice(i, i + 500);
    const memos = await ctx.kv.mget(part.map(memoKey));
    const hashes = [...new Set(memos.filter((h): h is string => !!h && HASH_RE.test(h)))];
    const have = new Set(hashes.length
      ? (await ctx.db.query<{ hash: string }>('select hash from livetv_logos where hash = any($1::text[])', [hashes])).rows.map((r) => r.hash)
      : []);
    part.forEach((u, j) => {
      const h = memos[j];
      if (h === MISS) return;
      if (h && have.has(h)) out.set(u, h);
      else todo.push(u);
    });
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const u = todo[next++]!;
      const h = await fetchAndStore(ctx, u, allowLan); // the memo was read above
      if (h) out.set(u, h);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return out;
}

// ---- own uploads (ruling 32) and serving ----

export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** the image type by its magic bytes (PNG signature, JPEG SOI + marker, RIFF….WEBP); null = none of the three */
export function sniffImage(b: Uint8Array): LogoMime | null {
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/**
 * Stores checked logo bytes by their sha256 (the caller sniffed them) and answers the hash. An existing row is touched (`fetched_at`),
 * which also locks it, so the daily prune cannot drop it before the caller's transaction references it.
 */
export async function storeLogo(db: Pick<Ctx, 'db'>['db'], mime: LogoMime, bytes: Buffer): Promise<string> {
  const hash = sha256(bytes);
  await db.query('insert into livetv_logos(hash, mime, bytes) values ($1, $2, $3) on conflict (hash) do update set fetched_at = now()', [hash, mime, bytes]);
  return hash;
}

/** a stored logo; null for a malformed or unknown hash */
export async function readLogo(ctx: Pick<Ctx, 'db'>, hash: string): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!HASH_RE.test(hash)) return null;
  return (await ctx.db.query<{ mime: string; bytes: Buffer }>('select mime, bytes from livetv_logos where hash = $1', [hash])).rows[0] ?? null;
}
