// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Ctx } from './ctx.js';
import { PERM_KEYS, type PermKey, type Perms } from './perms.js';
import { effectiveRights } from './rights.js';

/**
 * Server-side enforcement of the role switches (spec §2.2). The rights of the acting account with the active profile's kids overlay
 * (effectiveRights: role ← override ← kids; admin's switches locked on), resolved once per request.
 */
const memo = new WeakMap<FastifyRequest, Promise<Perms>>();

/** fail closed: an account without a resolvable role (or none signed in) has no switch on */
const NONE: Perms = Object.fromEntries(PERM_KEYS.map((k) => [k, false])) as Perms;

/** The effective switches of the request's account and active profile (kids overlay applied); call after the sign-in checks. */
export function permsOf(ctx: Ctx, req: FastifyRequest): Promise<Perms> {
  let p = memo.get(req);
  if (!p) {
    const user = req.user;
    p = user
      ? effectiveRights(ctx, user, req.profile ?? null).then((r) => (r ? { ...r.perms } : { ...NONE }))
      : Promise.resolve({ ...NONE });
    // a failed lookup is not remembered: the route answers 500 and a retry resolves again
    p.catch(() => memo.delete(req));
    memo.set(req, p);
  }
  return p.then((v) => ({ ...v }));
}

/**
 * preHandler after the existing sign-in pre-handlers: 403 `{ error: code }` without the switch. It answers before the route looks
 * anything up, so a refusal says nothing about the object behind the URL.
 */
export function requirePerm(ctx: Ctx, perm: PermKey, code: 'party_forbidden' | 'cast_forbidden' | 'requests_forbidden'): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (reply.sent) return reply;
    if (!req.user) return reply.code(401).send({ error: 'unauthenticated' }); // never reached behind requireUser; fail closed anyway
    if (!(await permsOf(ctx, req))[perm]) return reply.code(403).send({ error: code });
  };
}
