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

/** the bytes livetv answered, or null when they are not a logo (type, size) */
async function fetchBytes(ctx: Ctx, url: string, allowLan: boolean): Promise<{ mime: string; bytes: Buffer } | null> {
  const r = await livetvStream(ctx, '/v1/fetch/logo', { url, allowLan }, { timeoutMs: TIMEOUT_MS });
  const mime = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  let bytes: Buffer;
  try { bytes = Buffer.from(await r.arrayBuffer()); } catch { throw new LivetvError(null, 'unreachable'); }
  if (!MIMES.includes(mime) || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  return { mime, bytes };
}

/**
 * The stored logo hash for `url`, fetching it through livetv unless a fetch in the last 7 days found it (ruling 28). null = no logo:
 * the provider refused it (remembered a day) or livetv was not reached (not remembered, the next refresh tries again).
 */
export async function importLogo(ctx: Ctx, url: string, allowLan: boolean): Promise<string | null> {
  const key = memoKey(url);
  const memo = await ctx.kv.get(key);
  if (memo === MISS) return null;
  if (memo && HASH_RE.test(memo)) {
    // the daily prune drops logos no channel uses: a remembered hash counts only while its bytes are still there
    const has = await ctx.db.query('select 1 from livetv_logos where hash = $1', [memo]);
    if (has.rowCount) return memo;
  }
  let got: { mime: string; bytes: Buffer } | null;
  try {
    got = await fetchBytes(ctx, url, allowLan);
  } catch (e) {
    if (e instanceof LivetvError && e.status !== null) { await ctx.kv.set(key, MISS, MISS_TTL_S); return null; }
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
      const h = await importLogo(ctx, u, allowLan);
      if (h) out.set(u, h);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return out;
}
