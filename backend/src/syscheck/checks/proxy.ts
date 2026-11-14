// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../ctx.js';
import type { CheckLine } from '../types.js';

/**
 * The proxy lines the backend sees on this very request (proxy.forwardedProto, proxy.peer): computed per request and merged into the
 * answer, never cached. None yet (Stage 3, Task 8).
 */
export function requestLines(_req: FastifyRequest, _ctx: Ctx): CheckLine[] {
  return [];
}
