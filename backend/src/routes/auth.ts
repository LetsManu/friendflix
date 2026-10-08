import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { COOKIE, loadSession, newSession, rand, requireUser, saveSession } from '../session.js';
import { registerDevice } from '../devices.js';
import { claimInvite, lookupInvite, releaseInvite, type InviteRow } from '../invites.js';
import { applyRole, getUserBySub, provisionUser } from '../users.js';

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.cfg.PUBLIC_URL.startsWith('https://');

  app.get('/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const invite = (req.query as Record<string, string | undefined>).invite;
    if (invite && !(await lookupInvite(ctx, invite))) return reply.code(410).send({ error: 'invite_invalid' });
    const s = await ctx.oidc.start();
    await ctx.kv.set(`oidc:${s.state}`, JSON.stringify({ state: s.state, nonce: s.nonce, codeVerifier: s.codeVerifier, invite }), 600);
    return reply.redirect(s.url);
  });

  app.get('/auth/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const state = (req.query as Record<string, string | undefined>).state;
    const raw = state ? await ctx.kv.get(`oidc:${state}`) : null;
    if (!state || !raw) return reply.code(400).send({ error: 'invalid_state' });
    await ctx.kv.del(`oidc:${state}`); // single use
    try {
      const saved = JSON.parse(raw) as { state: string; nonce: string; codeVerifier: string; invite?: string };
      const claims = await ctx.oidc.finish(new URL(req.url, ctx.cfg.PUBLIC_URL), saved);
      let user = await getUserBySub(ctx, claims.sub);
      const isAdmin = claims.groups.includes(ctx.cfg.ADMIN_GROUP);
      if (!user) {
        let claimed: InviteRow | null = null;
        if (!isAdmin) {
          claimed = saved.invite ? await claimInvite(ctx, saved.invite) : null;
          if (!claimed) return reply.code(403).send({ error: 'no_invite' });
        }
        try {
          user = await provisionUser(ctx, claims, isAdmin ? 'admin' : claimed!.role);
        } catch (e) {
          if (claimed) await releaseInvite(ctx, claimed.id); // let the person retry
          throw e;
        }
        if (claimed) await ctx.db.query('update invites set used_by=$1 where id=$2', [user.id, claimed.id]);
      } else if (isAdmin && user.role !== 'admin') {
        await ctx.db.query("update users set role='admin' where id=$1", [user.id]);
        await applyRole(ctx, user.jellyfin_user_id, 'admin');
        user.role = 'admin';
      }
      if (user.disabled) return reply.code(403).send({ error: 'disabled' });
      const sid = rand();
      const dev = await registerDevice(ctx, req, reply, user.id, secure);
      await saveSession(ctx, sid, newSession({ userId: user.id, csrf: rand(), deviceId: dev.deviceId, deviceApproved: dev.approved }));
      reply.setCookie(COOKIE, sid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ctx.cfg.SESSION_TTL_SECONDS });
      await audit(ctx, user.id, 'login', user.id, { ip: req.ip });
      return reply.redirect('/');
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed'); if (process.env.DEBUG_TEST) console.error(err);
      return reply.code(401).send({ error: 'login_failed' });
    }
  });

  app.get('/api/me', { preHandler: requireUser(ctx, { allowPendingDevice: true }) }, async (req) => {
    const u = req.user!;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      roleLabel: ctx.roles[u.role]?.label ?? u.role,
      isAdmin: u.role === 'admin',
      csrfToken: req.session!.csrf,
      deviceApproved: req.session!.deviceApproved,
      limits: ctx.roles[u.role],
    };
  });

  // State-changing: CSRF header must match the session token (also enforced globally for /api).
  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies[COOKIE];
    const s = await loadSession(ctx, sid);
    if (!s || !sid) return reply.code(401).send({ error: 'unauthenticated' });
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    const want = Buffer.from(s.csrf);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return reply.code(403).send({ error: 'csrf' });
    await ctx.kv.del(`sess:${sid}`);
    reply.clearCookie(COOKIE, { path: '/' });
    return { status: 'ok' };
  });
}
