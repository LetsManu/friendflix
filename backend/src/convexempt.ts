// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';

/**
 * Leaf helpers shared by convbudget.ts, hevcenc.ts and previews.ts. This module imports none of them (type imports only), so the
 * three never form an import cycle.
 */

export const CONV_EXEMPT_TTL_S = 900;
export const CONV_EXEMPT_PREFIX = 'conv:exempt:';

/** Resolves with the promise's value, or undefined after `ms` / on a throw. */
export async function within<T>(fn: () => Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<undefined>((res) => { timer = setTimeout(() => res(undefined), ms); })]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A conversion of FriendFlix's own housekeeping (preview clip, HEVC probe, benchmark): not counted by the budget for 15 min. Never throws. */
export async function markConvExempt(ctx: Pick<Ctx, 'kv'>, playSessionId: string): Promise<void> {
  await ctx.kv.set(`${CONV_EXEMPT_PREFIX}${playSessionId}`, '1', CONV_EXEMPT_TTL_S).catch(() => undefined);
}
