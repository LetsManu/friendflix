// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { accountsWithout } from './rights.js';

/**
 * open party sockets per account (session id, close as revoked, close as refused), so a revoked session/device or a switched-off
 * `party` loses its socket at once
 */
export const sockets = new Map<string, Set<{ sid: string; close: () => void; forbid: () => void }>>();
/**
 * Closes the party sockets of these sessions: `revoked` (4401; revokeSessions: device removed/unapproved, account locked, sign-out
 * elsewhere) or `forbidden` (4403 'party_forbidden'; their profile became a kids profile).
 */
export function dropPartyPeers(userId: string, sids: Set<string>, mode: 'revoked' | 'forbidden' = 'revoked') {
  for (const p of [...(sockets.get(userId) ?? [])]) if (sids.has(p.sid)) (mode === 'forbidden' ? p.forbid() : p.close());
}
/** Closes every party socket of the account with 4403 'party_forbidden' (the client shows the refusal, not a sign-out). */
export function dropPartyUser(userId: string) {
  for (const p of [...(sockets.get(userId) ?? [])]) p.forbid();
}
/**
 * After a rights write that changed `party` (a person's override, a role's switch): closes the open sockets of the accounts whose switch
 * is now off; `userIds` limits it to these accounts (default: every account with an open socket). Call after the write invalidated the
 * rights caches.
 */
export async function dropPartyDenied(ctx: Pick<Ctx, 'db' | 'roles'>, userIds?: string[]): Promise<void> {
  const ids = (userIds ?? [...sockets.keys()]).filter((id) => sockets.has(id));
  if (!ids.length) return;
  const denied = new Set(await accountsWithout(ctx, 'party'));
  for (const id of ids) if (denied.has(id)) dropPartyUser(id);
}

