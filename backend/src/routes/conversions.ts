// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { conversionsView, startBenchmark } from '../convbench.js';
import type { Ctx } from '../ctx.js';
import { requireAdmin } from '../session.js';

/**
 * Admin -> Betrieb -> Wiedergabe-Check, card *Umwandlungen* (spec §5.6): GET the budget view (limit, what converts, measurements);
 * POST *Neu messen*: refused at once while someone watches or a measurement runs, else 202 and the benchmark runs in the background
 * (the page polls GET until `measure.running` is false). At most 6 per 10 minutes for the whole portal, audited. The budget values
 * themselves are written through PUT /api/admin/settings (CONVERSION_SLOTS, CONVERSION_PRIORITY).
 */
export function conversionRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/conversions', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return conversionsView(ctx);
  });

  // hook preHandler: the limiter runs after requireAdmin, so nobody but an admin can use up the portal-wide budget
  app.post('/api/admin/conversions/benchmark', { ...admin, config: { rateLimit: { max: 6, timeWindow: '10 minutes', keyGenerator: () => 'conv-bench', hook: 'preHandler' } } }, async (req, reply) => {
    const r = await startBenchmark(ctx, 'admin');
    if (!r.ok) return reply.code(409).send(r.why === 'busy' ? { error: 'busy', reason: r.reason } : { error: 'running' });
    await audit(ctx, req.user!.id, 'conversions.benchmark');
    return reply.code(202).send({ started: true });
  });
}
