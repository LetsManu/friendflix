// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { requireAdmin } from '../session.js';
import { requestLines } from '../syscheck/checks/proxy.js';
import { countLines, getSystemcheck, sortLines } from '../syscheck/engine.js';
import type { SystemcheckResult } from '../syscheck/types.js';

const REFRESH_PER_MIN = 6;
const query = z.object({ refresh: z.enum(['1', '0', 'true', 'false']).optional() });

/** The Systemcheck (Admin → Status): cached server lines plus the request-scoped proxy lines; `?refresh=1` is Jetzt prüfen. Admin only. */
export function systemcheckRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/admin/systemcheck', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const q = query.parse(req.query);
    const refresh = q.refresh === '1' || q.refresh === 'true';
    // without kv (Redis down) the limit cannot be counted: the run itself is still single flight
    if (refresh && (await ctx.kv.incr(`syscheck:refresh:${req.sid}`, 60).catch(() => 0)) > REFRESH_PER_MIN) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    const r = await getSystemcheck(ctx, { refresh });
    const extra = requestLines(req, ctx);
    if (!extra.length) return r;
    const ids = new Set(extra.map((l) => l.id));
    const lines = sortLines([...r.lines.filter((l) => !ids.has(l.id)), ...extra]);
    return { at: r.at, lines, counts: countLines(lines) } satisfies SystemcheckResult;
  });
}
