// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { NEW_EPISODE_DAYS } from '../fresh.js';
import { newEpisodes } from '../newpage.js';
import { requireUser } from '../session.js';
import { wrap } from './_shared.js';

/** Routes of the "Neu & demnächst" page (the other sections come from the existing library, trending and request routes). */
export function newPageRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  /**
   * "Neue Folgen": series the profile follows (watched an episode, or on the Merkliste) with an episode added in the last 7 days.
   * One entry per series, newest first, at most 30. Library permissions and the kids age cap apply (the viewer's own media-server identity).
   */
  app.get('/api/library/new-episodes', pre, wrap(async (req) => ({
    windowDays: NEW_EPISODE_DAYS,
    items: await newEpisodes(ctx, req.jfUser!, req.profile!.id),
  })));
}
