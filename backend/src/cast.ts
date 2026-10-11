import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { jfUserFor, getProfile } from './profiles.js';
import { effectiveRole } from './roles.js';
import { getUserById } from './users.js';

/**
 * Chromecast tokens ("ct"): opaque, short-lived, scoped credentials that live in the receiver's URL path
 * (/media/c/<ct>/...), because the Default Media Receiver cannot send cookies or headers.
 *
 * - The raw token only ever exists in the response of POST /api/cast/session and in the gateway's request path.
 *   Redis stores sha256(ct) only, so a Redis dump does not yield usable tokens.
 * - Each token is scoped to ONE item + media source + play session of ONE profile on ONE approved device.
 * - It must never be logged, put into metrics labels or error messages, or forwarded to Jellyfin.
 */
export const CAST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_CAST_TOKENS = 2;
const MIN_TTL = 3600;
const MAX_TTL = 6 * 3600;

export interface CastRecord {
  userId: string;
  profileId: string;
  deviceId: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  maxBitrate: number;
  /** epoch ms */
  exp: number;
  createdAt: number;
}

export interface CastAuth {
  userId: string;
  token: string;
  deviceId: string;
  maxBitrate: number;
  scope: { itemId: string; mediaSourceId: string; playSessionId: string };
}

export const hashToken = (ct: string) => createHash('sha256').update(ct).digest('hex');
const dataKey = (hash: string) => `cast:${hash}`;
const idxKey = (userId: string, castId: string) => `castidx:${userId}:${castId}`;
/** public, non-secret handle of a token (cannot be turned back into the token) */
const castIdOf = (hash: string) => hash.slice(0, 32);

export const castEnabled = (ctx: Ctx) => ctx.cfg.CAST_ENABLED === 'true' && ctx.cfg.PUBLIC_URL.startsWith('https://');

/** 5 s memo of resolved tokens (keyed by hash): keeps per-segment auth cheap. Cleared on every revoke. */
const memo = new Map<string, { exp: number; v: CastAuth | null }>();

export const castTtlSeconds = (runtimeTicks: number | undefined, startTicks: number) => {
  const remaining = runtimeTicks ? Math.max(0, runtimeTicks - startTicks) / 10_000_000 : 0;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Math.ceil(remaining) + 3600));
};

async function dropByHash(ctx: Ctx, userId: string, hash: string) {
  await ctx.kv.del(dataKey(hash));
  await ctx.kv.del(idxKey(userId, castIdOf(hash)));
}

/** Creates a token, revoking the account's oldest ones so at most MAX_CAST_TOKENS stay active. Returns the raw token (once). */
export async function createCast(ctx: Ctx, rec: Omit<CastRecord, 'exp' | 'createdAt'>, ttlSeconds: number): Promise<{ ct: string; castId: string; expiresAt: number }> {
  const now = Date.now();
  const active: Array<{ key: string; hash: string; createdAt: number }> = [];
  for (const k of await ctx.kv.keys(`castidx:${rec.userId}:`)) {
    const raw = await ctx.kv.get(k);
    if (!raw) continue;
    const i = JSON.parse(raw) as { hash: string; createdAt: number };
    active.push({ key: k, ...i });
  }
  active.sort((a, b) => a.createdAt - b.createdAt);
  while (active.length >= MAX_CAST_TOKENS) {
    const old = active.shift()!;
    await dropByHash(ctx, rec.userId, old.hash);
  }
  const ct = randomBytes(32).toString('base64url');
  const hash = hashToken(ct);
  const exp = now + ttlSeconds * 1000;
  await ctx.kv.set(dataKey(hash), JSON.stringify({ ...rec, exp, createdAt: now } satisfies CastRecord), ttlSeconds);
  await ctx.kv.set(idxKey(rec.userId, castIdOf(hash)), JSON.stringify({ hash, createdAt: now, deviceId: rec.deviceId }), ttlSeconds);
  memo.clear();
  return { ct, castId: castIdOf(hash), expiresAt: exp };
}

/** Revokes one token of an account by its public handle. */
export async function revokeCast(ctx: Ctx, userId: string, castId: string): Promise<boolean> {
  const raw = await ctx.kv.get(idxKey(userId, castId));
  if (!raw) return false;
  await dropByHash(ctx, userId, (JSON.parse(raw) as { hash: string }).hash);
  memo.clear();
  return true;
}

/** Revokes all tokens of an account, or only those created from one device. Called by revokeSessions. */
export async function revokeCasts(ctx: Ctx, userId: string, deviceId?: string): Promise<number> {
  let n = 0;
  for (const k of await ctx.kv.keys(`castidx:${userId}:`)) {
    const raw = await ctx.kv.get(k);
    if (!raw) continue;
    const i = JSON.parse(raw) as { hash: string; deviceId?: string };
    if (deviceId && i.deviceId !== deviceId) continue;
    await dropByHash(ctx, userId, i.hash);
    n++;
  }
  memo.clear();
  return n;
}

/**
 * Token -> Jellyfin credentials + scope, or null. Re-validates on every (memoised, 5 s) call:
 * token exists and not expired, user exists and is enabled, role known, profile still belongs to the account, sender device still approved.
 */
export async function resolveCast(ctx: Ctx, ct: string): Promise<CastAuth | null> {
  if (!CAST_TOKEN_RE.test(ct) || !castEnabled(ctx)) return null;
  const hash = hashToken(ct);
  const hit = memo.get(hash);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v: CastAuth | null = null;
  const raw = await ctx.kv.get(dataKey(hash));
  const rec = raw ? (JSON.parse(raw) as CastRecord) : null;
  if (rec && rec.exp > Date.now()) {
    const user = await getUserById(ctx, rec.userId);
    const role = user && !user.disabled ? await effectiveRole(ctx, user.role) : undefined;
    const prof = role ? await getProfile(ctx, rec.userId, rec.profileId) : null;
    const dev = prof ? await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [rec.userId, rec.deviceId]) : null;
    if (user && role && prof && dev?.rows[0]?.approved) {
      const jfUser = jfUserFor(user, prof);
      v = {
        userId: user.id,
        token: await ctx.jf.token(jfUser),
        deviceId: ctx.jf.deviceId(jfUser),
        maxBitrate: Math.min(role.maxBitrate, rec.maxBitrate),
        scope: { itemId: rec.itemId, mediaSourceId: rec.mediaSourceId, playSessionId: rec.playSessionId },
      };
    }
  }
  memo.set(hash, { exp: Date.now() + (v ? 5_000 : 2_000), v });
  if (memo.size > 5000) memo.clear();
  return v;
}
