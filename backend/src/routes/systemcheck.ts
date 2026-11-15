// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicOrigin } from '../config.js';
import type { Ctx } from '../ctx.js';
import { authenticate, requireAdmin } from '../session.js';
import { requestLines } from '../syscheck/checks/proxy.js';
import { bounded } from '../health.js';
import { cleanLine, countLines, getSystemcheck, sortLines } from '../syscheck/engine.js';
import type { SystemcheckResult } from '../syscheck/types.js';

const REFRESH_PER_MIN = 6;
/** like the other websocket routes; a refused upgrade reads as close 1006 in the browser, which asks a plain GET (404, or this 429) why */
const WS_PER_MIN = 30;
const KV_MS = 1_000;
const query = z.object({ refresh: z.enum(['1', '0', 'true', 'false']).optional() });

/** The Systemcheck (Admin → Status): cached server lines plus the request-scoped proxy lines; `?refresh=1` is Jetzt prüfen. Admin only. */
export function systemcheckRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/admin/systemcheck', { preHandler: requireAdmin(ctx) }, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const q = query.parse(req.query);
    const refresh = q.refresh === '1' || q.refresh === 'true';
    // without kv (Redis down or hanging) the limit cannot be counted: the run itself is still single flight
    if (refresh) {
      const n = await bounded(() => ctx.kv.incr(`syscheck:refresh:${req.sid}`, 60), KV_MS);
      if (n.ok && n.v > REFRESH_PER_MIN) return reply.code(429).send({ error: 'rate_limited' });
    }
    const r = await getSystemcheck(ctx, { refresh });
    // request-scoped lines are cleaned like every other line, and only the proxy group's ids may come from them
    const extra = requestLines(req, ctx).filter((l) => l?.id?.startsWith('proxy.')).map((l) => cleanLine(ctx, l));
    if (!extra.length) return r;
    const ids = new Set(extra.map((l) => l.id));
    const lines = sortLines([...r.lines.filter((l) => !ids.has(l.id)), ...extra]);
    return { at: r.at, lines, counts: countLines(lines) } satisfies SystemcheckResult;
  });

  /**
   * The websocket probe (browser line proxy.websocket): does an upgrade through the proxy reach the backend? An admin of this portal's
   * origin gets `{"ok":true}` and a normal close; anyone else a close code only (4401 no session or another origin, 4403 not an admin).
   * Nothing is read from the socket.
   */
  app.get('/ws/syscheck', { websocket: true, config: { rateLimit: { max: WS_PER_MIN, timeWindow: '1 minute' } } }, async (socket, req) => {
    if (req.headers.origin !== publicOrigin(ctx.cfg) || !(await authenticate(ctx, req)) || !req.session!.deviceApproved) return socket.close(4401, 'unauthorized');
    if (req.user!.role !== 'admin' || !req.profile?.is_owner) return socket.close(4403, 'forbidden');
    socket.send('{"ok":true}');
    socket.close(1000, 'ok');
  });
}
