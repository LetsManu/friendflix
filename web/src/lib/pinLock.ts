// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The profile picker's text for a locked PIN (429 `pin_locked`). A lock longer than the 15-minute window (`retryAfter` in seconds, the
 * server's escalating lockout) says "later"; it names "Forgot PIN?" only where that button is shown.
 */

/** the picker shows "Forgot PIN?" for the owner's own PIN, never for the owner PIN that leaves a kids profile or on a kid-locked device */
export const forgotPinShown = (o: { isOwner?: boolean; pinOwner: boolean; kidsLock: string | null }): boolean => Boolean(o.isOwner) && !o.pinOwner && !o.kidsLock;

export function pinLockedKey(retryAfter: unknown, forgotShown: boolean) {
  if (!(Number(retryAfter) > 900)) return 'account.profiles.pinLocked' as const;
  return forgotShown ? 'account.profiles.pinLockedLaterForgot' as const : 'account.profiles.pinLockedLater' as const;
}
