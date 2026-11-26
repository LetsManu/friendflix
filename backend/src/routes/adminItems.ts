// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { REFRESH_MODES } from '../media/types.js';
import { requireAdmin } from '../session.js';
import { id32 } from './_shared.js';

/** the kinds *Neu einlesen* takes (an episode is read in with its season) */
const REFRESHABLE: ReadonlySet<string> = new Set(['Movie', 'Series', 'Season']);
/** per admin and minute; counted in the KV like the hygiene refresh, so every replica shares it */
export const ITEM_REFRESH_PER_MIN = 10;
const refreshBody = z.object({ mode: z.enum(REFRESH_MODES) }).strict();

/**
 * *Neu einlesen* on the detail page (admin on the owner profile; the managed Ferrofin has no dashboard of its own): asks the media
 * server to read one film, series or season in again (scan / missing / replace, media/types.ts RefreshMode). The server works on it
 * in the background; nothing here waits for it or polls. Unsupported server (capabilities.itemRefresh off): 501.
 */
export function adminItemRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.post('/api/admin/items/:id/refresh', admin, async (req, reply) => {
    const id = id32.parse((req.params as { id: string }).id);
    const { mode } = refreshBody.parse(req.body ?? {});
    const ms = ctx.jf;
    if (!ms.capabilities.itemRefresh || typeof ms.itemKind !== 'function' || typeof ms.refreshItem !== 'function') return reply.code(501).send({ error: 'unsupported' });
    if ((await ctx.kv.incr(`rl:item-refresh:${req.user!.id}`, 60)) > ITEM_REFRESH_PER_MIN) return reply.code(429).send({ error: 'rate_limited' });
    // never pass the server's message on (it may carry a URL)
    let type: string | null;
    try { type = await ms.itemKind(id); } catch { return reply.code(502).send({ error: 'refresh_failed' }); }
    if (!type) return reply.code(404).send({ error: 'not_found' });
    if (!REFRESHABLE.has(type)) return reply.code(400).send({ error: 'unsupported_type' });
    try {
      await ms.refreshItem(id, mode);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return reply.code(404).send({ error: 'not_found' });
      return reply.code(502).send({ error: 'refresh_failed' });
    }
    await audit(ctx, req.user!.id, 'media.item_refresh', id, { mode, type });
    return { ok: true };
  });
}
