import type { FastifyInstance, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { dropRemotePeers } from './tv.js';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { COOKIE, loadSession, newSession, rand, requireUser, saveSession } from '../session.js';
import { registerDevice } from '../devices.js';
import { claimInvite, deleteAuthentikInvitation, enrollFlowUrl, lookupInvite, releaseInvite, type InviteRow } from '../invites.js';
import { accountJellyfinIds, listProfiles, publicProfile } from '../profiles.js';
import { applyRole, getUserBySub, provisionUser } from '../users.js';

const OIDC_COOKIE = 'ff_oidc';
/** sign-up incl. MFA setup takes longer than a plain login */
const ENROLL_TTL = 1800;

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.cfg.PUBLIC_URL.startsWith('https://');

  /** Starts an OIDC login; the invite (if any) travels in the server-side state to /auth/callback. */
  async function startLogin(reply: FastifyReply, invite: string | undefined, ttl: number) {
    const s = await ctx.oidc.start();
    await ctx.kv.set(`oidc:${s.state}`, JSON.stringify({ state: s.state, nonce: s.nonce, codeVerifier: s.codeVerifier, invite }), ttl);
    reply.setCookie(OIDC_COOKIE, s.state, { httpOnly: true, secure, sameSite: 'lax', path: '/auth', maxAge: ttl }); // binds the flow to this browser
    return s.url;
  }

  app.get('/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const invite = (req.query as Record<string, string | undefined>).invite;
    if (invite && !(await lookupInvite(ctx, invite))) return reply.code(410).send({ error: 'invite_invalid' });
    return reply.redirect(await startLogin(reply, invite, 600));
  });

  // Invite with Authentik enrollment: start the portal login first, then run the enrollment flow with
  // `next` = that authorize request. After sign-up (incl. MFA setup) Authentik continues the authorize
  // request and lands on /auth/callback with the invite in the state: account + portal access in one pass.
  app.get('/auth/enroll', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const invite = (req.query as Record<string, string | undefined>).invite;
    const inv = invite ? await lookupInvite(ctx, invite) : null;
    if (!invite || !inv) return reply.code(410).send({ error: 'invite_invalid' });
    if (!inv.authentik_invite || !enrollFlowUrl(ctx.cfg, inv.authentik_invite)) return reply.redirect(`/auth/login?invite=${encodeURIComponent(invite)}`);
    const authorize = await startLogin(reply, invite, ENROLL_TTL);
    return reply.redirect(enrollFlowUrl(ctx.cfg, inv.authentik_invite, authorize)!);
  });

  app.get('/auth/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const state = (req.query as Record<string, string | undefined>).state;
    const raw = state ? await ctx.kv.get(`oidc:${state}`) : null;
    const bound = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    if (!state || !raw || !bound || bound.length !== state.length || !timingSafeEqual(Buffer.from(bound), Buffer.from(state))) return reply.code(400).send({ error: 'invalid_state' });
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
        if (claimed) {
          await ctx.db.query('update invites set used_by=$1 where id=$2', [user.id, claimed.id]);
          void deleteAuthentikInvitation(ctx, claimed.authentik_invite, req.log); // redeemed: the enrollment link must not create more accounts
        }
      } else if (user.disabled) {
        return reply.code(403).send({ error: 'disabled' });
      } else if (isAdmin && user.role !== 'admin') {
        await ctx.db.query("update users set role='admin' where id=$1", [user.id]);
        const owned = await accountJellyfinIds(ctx, user.id);
        for (const jid of owned) await applyRole(ctx, jid, 'admin', false, jid === user.jellyfin_user_id ? {} : { IsHidden: true });
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

  app.get('/api/me', { preHandler: requireUser(ctx, { allowPendingDevice: true, allowNoProfile: true }) }, async (req) => {
    const u = req.user!;
    const profileCount = (await listProfiles(ctx, u.id)).length;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      roleLabel: ctx.roles[u.role]?.label ?? u.role,
      isAdmin: u.role === 'admin',
      csrfToken: req.session!.csrf,
      deviceApproved: req.session!.deviceApproved,
      /** this session belongs to a paired television (device ids of paired TVs start with "tv-") */
      tv: Boolean(req.session!.deviceId?.startsWith('tv-')),
      limits: ctx.roles[u.role],
      profile: req.profile ? publicProfile(req.profile) : null,
      /** true: the client must send the user to the profile picker first (owner profile has a PIN and none was chosen) */
      profileRequired: !req.profile,
      profileCount,
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
    dropRemotePeers(s.userId, new Set([sid]));
    reply.clearCookie(COOKIE, { path: '/' });
    return { status: 'ok' };
  });
}
