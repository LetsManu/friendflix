// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { publicOrigin } from '../config.js';
import type { Ctx } from '../ctx.js';
import { requireOwner } from '../session.js';
import { isMailAddress } from './address.js';
import { isAdminMailType, MAIL_PREF_TYPES, readMailPrefs, setMailPref, visibleMailPrefs } from './people.js';
import { mailConfigured } from './transport.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';

/**
 * Mail for people (plan "E-mail, stage B", Controller's calls 1, 2, 7, 11):
 * - the account page's switches (`/api/account/mail`, owner profile only: a kids profile has none, mail is account level). The admin
 *   alert switches (stage C, Controller's call 1) are listed for an admin only (`admin: true`); a non-admin's PUT of one answers 403
 *   admin_only and writes nothing;
 * - the public unsubscribe route. `POST /api/public/mail/unsubscribe?t=` is the RFC 8058 one-click target of `List-Unsubscribe`: no
 *   session, no CSRF token (app.ts CSRF_EXEMPT), the form or multipart body `List-Unsubscribe=One-Click` is accepted and ignored, the
 *   token is the only authorisation. The confirm page posts `{ t, on }` as JSON (the token in the body, not the URL), also to switch
 *   back on. A GET on the same URL (link scanners, previews, a client opening the header URL in a browser) never changes anything: it
 *   answers 303 to the confirm page.
 * The token never reaches a log (app.ts redacts `t=` in the request log, the route is in SENSITIVE_BODY) or an audit row. An invalid
 * token answers 400 invalid_token; a valid one for an account that no longer exists answers like any valid one and writes nothing.
 */
const PUBLIC_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } };
/** what the GET passes on to the confirm page: the token's own alphabet, nothing that could leave the path or split the header */
const PASS_ON = /^[A-Za-z0-9._-]{1,200}$/;
/** the confirm page's JSON body (unknown keys ignored); a form or multipart body arrives here as {} */
const pageBody = z.object({ t: z.unknown().optional(), on: z.boolean().optional() });
const putBody = z.object({ type: z.enum(MAIL_PREF_TYPES), on: z.boolean() });

export function mailPersonRoutes(app: FastifyInstance, ctx: Ctx) {
  const owner = { preHandler: requireOwner(ctx) };

  app.get('/api/account/mail', owner, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const userId = req.user!.id;
    const email = (await ctx.db.query<{ email: string | null }>('select email from users where id = $1', [userId])).rows[0]?.email;
    const admin = req.user!.role === 'admin';
    return {
      configured: mailConfigured(ctx.cfg) && publicOrigin(ctx.cfg) !== null,
      // no address in the answer: the account page has it from /api/account
      hasAddress: !!email && isMailAddress(email),
      admin,
      prefs: visibleMailPrefs(await readMailPrefs(ctx, userId), admin),
    };
  });

  app.put('/api/account/mail', { ...owner, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { type, on } = putBody.parse(req.body);
    const userId = req.user!.id;
    const admin = req.user!.role === 'admin';
    if (isAdminMailType(type) && !admin) return reply.code(403).send({ error: 'admin_only' });
    const prefs = await setMailPref(ctx, userId, type, on);
    await audit(ctx, userId, 'mail.pref', undefined, { type, on, via: 'account' });
    return { prefs: visibleMailPrefs(prefs, admin) };
  });

  app.get('/api/public/mail/unsubscribe', { config: PUBLIC_LIMIT }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const t = (req.query as Record<string, unknown>).t;
    return reply.redirect(typeof t === 'string' && PASS_ON.test(t) ? `/mail/unsubscribe?t=${t}` : '/mail/unsubscribe', 303);
  });

  // encapsulated: the form and multipart parsers (RFC 8058 one-click bodies, read and dropped) exist for this route only
  void app.register(async (scope) => {
    scope.addContentTypeParser(['application/x-www-form-urlencoded', 'multipart/form-data'], { parseAs: 'buffer', bodyLimit: 4096 },
      (_req, _body, done) => done(null, {}));

    scope.post('/api/public/mail/unsubscribe', { config: PUBLIC_LIMIT }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      // no body, or a one-click form/multipart body (parsed to {} above): the token comes from the query
      const body = pageBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });
      const fromBody = body.data.t !== undefined;
      const t = fromBody ? body.data.t : (req.query as Record<string, unknown>).t;
      const hit = typeof t === 'string' ? verifyUnsubscribeToken(ctx.encKey, t) : null;
      if (!hit) return reply.code(400).send({ error: 'invalid_token' });
      const on = body.data.on ?? false;
      const known = (await ctx.db.query('select 1 from users where id = $1', [hit.userId])).rowCount === 1;
      if (known) {
        try {
          await setMailPref(ctx, hit.userId, hit.type, on);
          await audit(ctx, hit.userId, 'mail.pref', undefined, { type: hit.type, on, via: fromBody ? 'page' : 'one_click' });
        } catch (e) {
          // the account was deleted between the check and the write (user_prefs' foreign key): the same answer as for a deleted one
          if ((e as { code?: unknown }).code !== '23503') throw e;
        }
      }
      return { ok: true, type: hit.type, on };
    });
  });
}
