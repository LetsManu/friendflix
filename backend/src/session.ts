import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './ctx.js';
import { getUserById } from './users.js';
import type { UserRow } from './types.js';

export interface Session {
  userId: string;
  csrf: string;
  deviceId?: string;
  deviceApproved: boolean;
}

export const COOKIE = 'ff_sid';
export const rand = () => randomBytes(32).toString('base64url');

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    session?: Session;
    sid?: string;
  }
}

export async function loadSession(ctx: Ctx, sid: string | undefined): Promise<Session | null> {
  if (!sid) return null;
  const raw = await ctx.kv.get(`sess:${sid}`);
  return raw ? (JSON.parse(raw) as Session) : null;
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
  return true;
}

export function requireUser(ctx: Ctx, opts: { allowPendingDevice?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await authenticate(ctx, req))) return reply.code(401).send({ error: 'unauthenticated' });
    if (!req.session!.deviceApproved && !opts.allowPendingDevice) {
      // Re-check: the device may have been approved since the session was created.
      if (!(await refreshDevice(ctx, req))) return reply.code(403).send({ error: 'device_pending' });
    }
  };
}

export function requireAdmin(ctx: Ctx) {
  const base = requireUser(ctx);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (reply.sent) return r;
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
  };
}

/** A session created on a not-yet-approved device becomes usable as soon as the device is approved. */
export async function refreshDevice(ctx: Ctx, req: FastifyRequest): Promise<boolean> {
  const s = req.session!;
  if (!s.deviceId) return false;
  const r = await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [s.userId, s.deviceId]);
  if (!r.rows[0]?.approved) return false;
  s.deviceApproved = true;
  await ctx.kv.set(`sess:${req.sid}`, JSON.stringify(s), ctx.cfg.SESSION_TTL_SECONDS);
  return true;
}
