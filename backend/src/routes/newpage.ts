// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { NEW_EPISODE_DAYS } from '../fresh.js';
import { FOR_YOU_DAYS, newEpisodes, newForYou } from '../newpage.js';
import { requireGrownUp } from '../kids.js';
import { quota } from '../requestlimit.js';
import { cachedSuggestionStats, requestSuggestionsDetailed } from '../requestSuggestions.js';
import { requireUser } from '../session.js';
import { perSession } from './discover.js';
import { wrap } from './_shared.js';

/** Routes of the "Neu & demnächst" page (the other sections come from the existing library, trending and request routes). */
export function newPageRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  /**
   * "Neue Folgen": series the profile follows (watched an episode, or on the Merkliste) with an episode added in the last 7 days.
   * One entry per series, newest first, at most 30. Library permissions and the kids age cap apply (the viewer's own media-server identity).
   */
  app.get('/api/library/new-episodes', { ...pre, config: perSession(60) }, wrap(async (req) => ({
    windowDays: NEW_EPISODE_DAYS,
    items: await newEpisodes(ctx, req.jfUser!, req.profile!.id),
  })));

  /**
   * "Für dich neu": titles added in the last 14 days, ranked for the profile by the v2 recommendation engine, each with its reason
   * ({ seed, traits }, worded by the client). `?type=movie|series` filters. Without engine v2 the newest titles come without reasons
   * (`engine: 'v1'`, `reason: null`). Kids profiles get it too, from the non-social sources and within their age cap.
   */
  app.get('/api/library/new-for-you', pre, wrap(async (req) => {
    const { type } = z.object({ type: z.enum(['movie', 'series']).optional() }).parse(req.query);
    return { windowDays: FOR_YOU_DAYS, ...(await newForYou(ctx, req.jfUser!, req.profile!.id, type)) };
  }, { zod: 'plain' }));

  /**
   * "Noch nicht bei uns": titles the profile might like that are not in the library, from the request service's recommendations for a few
   * of the profile's seed titles, with the wish state and the account's request quota. `?type=movie|series`. Grown-ups only (kids profiles:
   * 403 kids_profile); without a request service 404 requests_disabled. The quota is the one of POST /api/requests (null if it cannot be read). The admin (its owner profile) also gets `debug`: the counts of the build behind the list.
   * `&debug=cached` (Admin → Status): only the counts of the last cached build, nothing is built or fetched: `{ debug: counts | null, builtAt }`
   * (null = no build in the cache); anyone but the admin on the owner profile gets `{}`.
   */
  app.get('/api/library/request-suggestions', { preHandler: requireGrownUp(ctx), config: perSession(30) }, wrap(async (req) => {
    const { type, debug } = z.object({ type: z.enum(['movie', 'series']).default('movie'), debug: z.literal('cached').optional() }).parse(req.query);
    const owner = req.user!.role === 'admin' && req.profile!.is_owner;
    if (debug) {
      if (!owner) return {};
      const c = await cachedSuggestionStats(ctx, req.user!, req.profile!.id, type);
      return { debug: c.stats, builtAt: c.builtAt };
    }
    const { items, stats, fresh } = await requestSuggestionsDetailed(ctx, req.jfUser!, req.user!, req.profile!.id, type);
    if (fresh && stats) req.log.info({ type, ...stats }, 'request suggestions built'); // counts only: why a list is empty
    const q = await quota(ctx, req.user!).then(({ limit, used, resetsAt }) => ({ limit, used, resetsAt }), () => null);
    return { items, quota: q, ...(owner && stats ? { debug: stats } : {}) };
  }, { zod: 'plain', seerr: true }));
}
