// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from './crypto.js';
import type { Ctx } from './ctx.js';
import { getUserById } from './users.js';
import { jfUserFor, resolveProfile } from './profiles.js';
import type { JfUser, ProfileRow, UserRow } from './types.js';

export interface Session {
  userId: string;
  /** epoch ms; absolute lifetime is enforced from here (older sessions without it fall back to the kv ttl) */
  createdAt?: number;
  /** epoch ms of the last ttl refresh (sliding idle timeout) */
  touchedAt?: number;
  csrf: string;
  deviceId?: string;
  deviceApproved: boolean;
  /** absolute lifetime / idle timeout in seconds; defaults come from the config (TV sessions are longer) */
  ttl?: number;
  idle?: number;
  /** active profile of the account (absent on older sessions = owner profile) */
  profileId?: string;
  /** epoch ms of the last re-authentication at the IdP (see reauth.ts) */
  reauthAt?: number;
}

export const COOKIE = 'ff_sid';
export const rand = () => randomBytes(32).toString('base64url');

/**
 * Sessions at rest: Redis writes its append-only file to disk (redis-data volume), so a session is stored under the SHA-256 of its
 * id (`sess:<64 hex>`), never under the cookie value: a copied volume holds no usable session id. The cookie is unchanged. Keys of
 * older builds (`sess:<raw id>`) are moved to the hashed name on their first use (loadSession) and removed by every revoke.
 */
export const SESSION_PREFIX = 'sess:';
const HASH_RE = /^[0-9a-f]{64}$/;
/** the id a session is known by at rest and in memory (gateway memo, socket sets): sha256 hex of the cookie value */
export const sessionHash = (sid: string) => sha256(sid);
export const sessionKey = (sid: string) => `${SESSION_PREFIX}${sessionHash(sid)}`;
/** a key listed by keys('sess:') -> its session hash (a legacy key still carries the raw id: hashed here) */
export function hashOfSessionKey(key: string): string {
  const rest = key.slice(SESSION_PREFIX.length);
  return HASH_RE.test(rest) ? rest : sha256(rest);
}
/** the key an older build stored the session under; none for a cookie that looks like a hash (it would name a hashed key) */
const legacyKey = (sid: string) => (HASH_RE.test(sid) ? null : `${SESSION_PREFIX}${sid}`);
/** the kv ttl of a session (idle, capped by the absolute lifetime) */
export const sessionTtl = (ctx: Pick<Ctx, 'cfg'>, s: Session) => Math.min(s.idle ?? ctx.cfg.SESSION_IDLE_SECONDS, s.ttl ?? ctx.cfg.SESSION_TTL_SECONDS);
/** Ends a session: its hashed key and a legacy raw one. */
export async function deleteSession(ctx: Pick<Ctx, 'kv'>, sid: string): Promise<void> {
  await ctx.kv.del(sessionKey(sid));
  const legacy = legacyKey(sid);
  if (legacy) await ctx.kv.del(legacy);
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    /** active profile (watchlist/thumbs/bookmarks/viewing prefs are per profile) */
    profile?: ProfileRow;
    /** the Jellyfin identity to act as: the account's own row for the owner profile, else the profile's hidden Jellyfin user */
    jfUser?: JfUser;
    session?: Session;
    sid?: string;
  }
}

/** Stores a session with the idle ttl (it is refreshed on use, see `touch`). */
export async function saveSession(ctx: Ctx, sid: string, s: Session, onlyIfExists = false): Promise<boolean> {
  const ttl = sessionTtl(ctx, s);
  if (onlyIfExists) return ctx.kv.replace(sessionKey(sid), JSON.stringify(s), ttl); // never resurrects a session revoked meanwhile
  await ctx.kv.set(sessionKey(sid), JSON.stringify(s), ttl);
  return true;
}

export function newSession(s: Omit<Session, 'createdAt' | 'touchedAt'>): Session {
  const now = Date.now();
  return { ...s, createdAt: now, touchedAt: now };
}

export async function loadSession(ctx: Ctx, sid: string | undefined): Promise<Session | null> {
  if (!sid) return null;
  const key = sessionKey(sid);
  let raw = await ctx.kv.get(key);
  const legacy = raw ? null : legacyKey(sid);
  if (legacy) {
    // a session from before the hashed keys: moved once with its remaining ttl (atomic; a concurrent request reads the moved one)
    await ctx.kv.move(legacy, key);
    raw = await ctx.kv.get(key);
  }
  if (!raw) return null;
  const s = JSON.parse(raw) as Session;
  // absolute lifetime, independent of activity
  if (s.createdAt && Date.now() - s.createdAt > (s.ttl ?? ctx.cfg.SESSION_TTL_SECONDS) * 1000) {
    await deleteSession(ctx, sid);
    return null;
  }
  return s;
}

/** Sliding idle timeout: refreshes the kv ttl at most once a minute. */
async function touch(ctx: Ctx, sid: string, s: Session) {
  const now = Date.now();
  if (s.touchedAt && now - s.touchedAt < 60_000) return;
  s.touchedAt = now;
  await saveSession(ctx, sid, s, true);
}

/** Resolves cookie -> session -> (fresh, non-disabled) user row. */
export async function authenticate(ctx: Ctx, req: FastifyRequest): Promise<boolean> {
  const sid = req.cookies.ff_sid;
  const s = await loadSession(ctx, sid);
  if (!s || !sid) return false;
  const user = await getUserById(ctx, s.userId);
  if (!user || user.disabled) return false;
  req.sid = sid;
  req.session = s;
  req.user = user;
  const prof = await resolveProfile(ctx, user, s);
  req.profile = prof ?? undefined;
  req.jfUser = prof ? jfUserFor(user, prof) : undefined;
  await touch(ctx, sid, s);
  return true;
}

/**
 * allowNoProfile: routes usable before a profile is picked (devices, notifications ...); all others answer 409 profile_required.
 * skipProfileHeader: /api/me and /api/profiles* (they are how a stale tab recovers). Every other route answers 409 profile_changed
 * when the request's `x-ff-profile` header (the profile the tab believes is active) differs from the session's active profile.
 */
export function requireUser(ctx: Ctx, opts: { allowPendingDevice?: boolean; allowNoProfile?: boolean; skipProfileHeader?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await authenticate(ctx, req))) return reply.code(401).send({ error: 'unauthenticated' });
    if (!req.session!.deviceApproved) {
      // Re-check: the device may have been approved since the session was created. Routes that allow a pending
      // device (/api/me is what the waiting screen polls) re-check too, or they keep answering the stale flag.
      if (!(await refreshDevice(ctx, req)) && !opts.allowPendingDevice) return reply.code(403).send({ error: 'device_pending' });
    }
    const claimed = req.headers['x-ff-profile'];
    if (!opts.skipProfileHeader && typeof claimed === 'string' && claimed && claimed !== req.profile?.id) return reply.code(409).send({ error: 'profile_changed' });
    if (!req.profile && !opts.allowNoProfile) return reply.code(409).send({ error: 'profile_required' });
  };
}

/** Account-level changes (devices, sessions) need the owner profile; no profile chosen yet -> 409 profile_required (the picker always offers the owner profile). */
export function requireOwner(ctx: Ctx) {
  const base = requireUser(ctx, { allowNoProfile: true });
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (reply.sent) return r;
    if (!req.profile) return reply.code(409).send({ error: 'profile_required' });
    if (!req.profile.is_owner) return reply.code(403).send({ error: 'owner_required' });
  };
}

export function requireAdmin(ctx: Ctx) {
  const base = requireUser(ctx);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (reply.sent) return r;
    if (req.user!.role !== 'admin' || !req.profile?.is_owner) return reply.code(403).send({ error: 'forbidden' });
  };
}

/** A session created on a not-yet-approved device becomes usable as soon as the device is approved. */
export async function refreshDevice(ctx: Ctx, req: FastifyRequest): Promise<boolean> {
  const s = req.session!;
  if (!s.deviceId) return false;
  const r = await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [s.userId, s.deviceId]);
  if (!r.rows[0]?.approved) return false;
  s.deviceApproved = true;
  return saveSession(ctx, req.sid!, s, true); // false: revoked meanwhile
}
