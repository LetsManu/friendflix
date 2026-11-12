// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { requireUser } from '../session.js';
import { readLogo } from './logos.js';

/** a logo never changes under its hash (sha256 of the bytes): the browser keeps it a week without asking again */
const LOGO_CACHE = 'private, max-age=604800, immutable';

/**
 * The user side of Live TV (spec §10, `requireUser`; kids profiles allowed unless a route says otherwise). Task 19 adds the logos;
 * the channel list, watching, favourites and the last channel follow with PR 1d.
 */
export function livetvRoutes(app: FastifyInstance, ctx: Ctx) {
  const user = { preHandler: requireUser(ctx) };

  // channel logos by hash (provider, XMLTV or an admin's upload); an unknown or malformed hash is a 404
  app.get('/api/livetv/logos/:hash', user, async (req, reply) => {
    const logo = await readLogo(ctx, String((req.params as { hash?: string }).hash ?? ''));
    if (!logo) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', logo.mime).header('cache-control', LOGO_CACHE).header('content-security-policy', "default-src 'none'").send(logo.bytes);
  });
}
