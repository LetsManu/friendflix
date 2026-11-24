// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { MediaError } from './client.js';
import type { MovePhase } from './store.js';

/**
 * The backend's half of a move from an existing Jellyfin to the managed Ferrofin (docs/superpowers/specs/2026-11-24-mediaserver-stage2-
 * migration-design.md "The move", "After the move"). POST /api/admin/mediaserver/move starts the updater's copy job and records
 * `media_managed.move` in phase `copying` (routes/adminMediaserver.ts); the phases after it (`nfo`, `verify`, `switch`, `requests`) and
 * the way back live here.
 */

/** the phases in which a move is under way: no second move starts */
export const ACTIVE_PHASES: readonly MovePhase[] = ['copying', 'nfo', 'verify', 'switch', 'requests'];
/** the phases from which FriendFlix uses the new server (or is about to): an abort would take away the server in use */
export const SWITCHED_PHASES: readonly MovePhase[] = ['switch', 'requests', 'done'];

export type BackError = MediaError | 'jellyfin_unreachable' | 'not_available';

/**
 * The way back to the Jellyfin a move came from (spec "After the move"): start the old container, check that it answers with the saved
 * key, restore the saved address and key, point the request service back, stop the managed Ferrofin, repair the users.
 *
 * Contract with POST /api/admin/mediaserver/back: the route calls it after re-authentication, only while a move is recorded
 * (`migrated_from`) and the managed server is in use; `ok` only once FriendFlix uses the old Jellyfin again (the route then audits
 * `mediaserver.back`); a refusal leaves FriendFlix unchanged and answers its code. The way back is built with plan Task 8; until then
 * every call is refused with `not_available` and nothing changes.
 */
export async function goBack(_ctx: Ctx, _actor: string | null): Promise<{ ok: true } | { ok: false; error: BackError }> {
  return { ok: false, error: 'not_available' };
}
