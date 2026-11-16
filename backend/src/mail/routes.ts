// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { userLanguage } from '../i18n.js';
import { requireAdmin } from '../session.js';
import { isMailAddress } from './address.js';
import { enqueueMail, mailStatus } from './outbox.js';
import { mailConfigured } from './transport.js';
import { deliverNow } from './worker.js';

/**
 * Admin -> E-Mail (spec "Admin surface"): the status line and the test mail. The test goes only to the signed-in admin's own
 * address, so the button can never mail a third party. Answers and audit rows carry codes only, never an address or a server text.
 */
const TEST_LIMIT = 3;
const TEST_WINDOW_S = 600;

export function mailRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/mail/status', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const { oldestQueuedAt: _oldest, ...status } = await mailStatus(ctx);
    return status;
  });

  app.post('/api/admin/mail/test', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!mailConfigured(ctx.cfg)) return reply.code(400).send({ error: 'mail_not_configured' });
    const userId = req.user!.id;
    const row = (await ctx.db.query<{ email: string | null }>('select email from users where id = $1', [userId])).rows[0];
    if (!row?.email || !isMailAddress(row.email)) return reply.code(400).send({ error: 'no_address' });
    if ((await ctx.kv.incr(`mail:test:${userId}`, TEST_WINDOW_S)) > TEST_LIMIT) return reply.code(429).send({ error: 'rate_limited' });
    const id = await enqueueMail(ctx, { kind: 'test', to: row.email, userId, lang: await userLanguage(ctx, userId) });
    // no dedupe key: a row always comes back
    const r = await deliverNow(ctx, id!, { log: req.log });
    await audit(ctx, userId, 'mail.test', undefined, { state: r.state, ...(r.code ? { code: r.code } : {}) });
    return r;
  });
}
