// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import type { ServerSession } from './media/types.js';

/**
 * Leaf helpers shared by convbudget.ts, hevcenc.ts, previews.ts and the playback routes. This module imports none of them (type
 * imports only), so they never form an import cycle.
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

/** One bounded read of the media server's session list; undefined = late (past its bound) or failed. */
export type SessionRead = () => Promise<ServerSession[] | undefined>;

/**
 * The session-list read of one request, shared by its gates (the HEVC gate and the conversion budget both need it): the first asker
 * starts it, later askers get the same answer, so a slow list costs its bound (`ms`) once per request, never once per gate.
 * Starts nothing until asked (a direct-play answer never reads the list). null: the media server has no session list.
 */
export function sharedSessionRead(ctx: Pick<Ctx, 'jf'>, ms: number): SessionRead | null {
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  if (!list) return null;
  let p: Promise<ServerSession[] | undefined> | undefined;
  return () => (p ??= within(list, ms));
}

/** A conversion of FriendFlix's own housekeeping (preview clip, HEVC probe, benchmark): not counted by the budget for 15 min. Never throws. */
export async function markConvExempt(ctx: Pick<Ctx, 'kv'>, playSessionId: string): Promise<void> {
  await ctx.kv.set(`${CONV_EXEMPT_PREFIX}${playSessionId}`, '1', CONV_EXEMPT_TTL_S).catch(() => undefined);
}

/**
 * A download preparation's own job state for the budget (spec §5.1 "its job state"): `conv:dl:<jobId>` = { ps, label?, user? } while its
 * transcode runs unpaused. The preparer writes it when a pass starts or leaves a pause and refreshes it every CONV_DL_BEAT_MS; a pause,
 * the end of a pass (finish, failure, cancel) deletes it, and a crashed backend's mark ends with its 30-s TTL. It counts the download
 * whether or not the media server lists its session (a transcode nobody reports as playing may not be listed).
 */
export const CONV_DL_PREFIX = 'conv:dl:';
export const CONV_DL_TTL_S = 30;
export const CONV_DL_BEAT_MS = 10_000;
export interface DownloadMark { ps: string; label?: string; user?: string }
/** never throws (a failed write leaves the last mark to its TTL) */
export async function markDownloadConv(ctx: Pick<Ctx, 'kv'>, jobId: string, m: DownloadMark): Promise<void> {
  await ctx.kv.set(`${CONV_DL_PREFIX}${jobId}`, JSON.stringify(m), CONV_DL_TTL_S).catch(() => undefined);
}
export async function clearDownloadConv(ctx: Pick<Ctx, 'kv'>, jobId: string): Promise<void> {
  await ctx.kv.del(`${CONV_DL_PREFIX}${jobId}`).catch(() => undefined);
}
