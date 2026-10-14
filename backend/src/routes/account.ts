// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-service account page (/me/account): the person's own name, avatar, 2FA state. Owner profile only.
 * The e-mail is shown read-only (its change needs Authentik's verification flow, a later phase).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { akMfaState, akUpdateUser, akUserSettingsUrl } from '../authentik.js';
import type { Ctx } from '../ctx.js';
import { recentlyAuthenticated, REAUTH_WINDOW_S } from '../reauth.js';
import { requireOwner } from '../session.js';

/** a FriendFlix avatar key (the preset swatches), validated like the profile avatar */
const avatarKey = z.string().regex(/^[a-z0-9-]{1,20}$/);
/** the owner profile carries the account name cut to the profile name length, as provisioning does */
const profileName = (name: string) => name.slice(0, 20).trim() || 'Profil';
const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

export function accountRoutes(app: FastifyInstance, ctx: Ctx) {
  const owner = { preHandler: requireOwner(ctx) };

  /** Never the Authentik sub or pk, nor any media server credential. */
  const view = async (req: FastifyRequest) => {
    const u = (await ctx.db.query<{ name: string; email: string | null; avatar: string | null; authentik_sub: string }>(
      'select name, email, avatar, authentik_sub from users where id=$1', [req.user!.id])).rows[0]!;
    const s = req.session!;
    return {
      name: u.name,
      email: u.email,
      avatar: u.avatar ?? req.profile!.avatar,
      mfa: await akMfaState(ctx, u.authentik_sub).catch(() => null), // Authentik down: shown like "no Authentik API"
      manageUrl: akUserSettingsUrl(ctx.cfg),
      /** epoch ms until which sensitive actions need no new sign-in */
      reauthUntil: recentlyAuthenticated(s) ? s.reauthAt! + REAUTH_WINDOW_S * 1000 : null,
    };
  };

  app.get('/api/account', owner, async (req) => view(req));

  /**
   * Name and/or avatar. The name goes to Authentik first (when its API is configured), so an Authentik refusal leaves FriendFlix
   * unchanged; then users + the owner profile in one transaction. Without the API the change is local only. The avatar is
   * FriendFlix-only. A name another profile of the account already has is refused before Authentik is touched.
   */
  app.patch('/api/account/profile', owner, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), avatar: avatarKey.optional() }).strict()
      .refine((x) => x.name !== undefined || x.avatar !== undefined, { path: ['name'] }).parse(req.body);
    const user = req.user!, pid = req.profile!.id;
    if (b.name !== undefined) {
      const clash = await ctx.db.query('select 1 from profiles where user_id=$1 and lower(name)=lower($2) and id<>$3', [user.id, profileName(b.name), pid]);
      if (clash.rowCount) return reply.code(409).send({ error: 'name_taken' });
      if (ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_API_TOKEN) await akUpdateUser(ctx, user.authentik_sub, { name: b.name });
    }
    const c = await (ctx.db as pg.Pool).connect();
    try {
      await c.query('begin');
      await c.query('update users set name=coalesce($2, name), avatar=coalesce($3, avatar) where id=$1', [user.id, b.name ?? null, b.avatar ?? null]);
      await c.query('update profiles set name=coalesce($2, name), avatar=coalesce($3, avatar) where id=$1',
        [pid, b.name === undefined ? null : profileName(b.name), b.avatar ?? null]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'name_taken' }); // a concurrent profile rename
      throw e;
    } finally {
      c.release();
    }
    // self-service audits name the changed fields only, never the values
    await audit(ctx, user.id, 'account.profile', user.id, { fields: [...(b.name !== undefined ? ['name'] : []), ...(b.avatar !== undefined ? ['avatar'] : [])] });
    req.profile = { ...req.profile!, avatar: b.avatar ?? req.profile!.avatar };
    return view(req);
  });
}
