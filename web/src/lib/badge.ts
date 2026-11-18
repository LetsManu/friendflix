// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { kidsMode } from '#lib/kids';
import { counts } from '#lib/notifications/api';

/**
 * App icon badge (Badging API, installed PWA on phone/desktop): the number of unread notifications - new episodes of followed
 * series arrive as notifications, so one number covers both. Set from the app on load / when the app returns to the
 * foreground (exact server count) and from the service worker on every push (see lib/sw/push.ts). Everything is optional:
 * browsers without the API (Firefox, iOS Safari outside an installed PWA) do nothing.
 */
interface BadgeNav { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }

/** Sets (n > 0) or clears (n <= 0) the badge; resolves false when unsupported or refused. */
export async function setAppBadge(n: number, nav: BadgeNav | undefined = typeof navigator === 'undefined' ? undefined : (navigator as BadgeNav)): Promise<boolean> {
  try {
    if (!nav) return false;
    const count = Number.isFinite(n) ? Math.max(0, Math.min(99, Math.floor(n))) : 0;
    if (count > 0 && nav.setAppBadge) { await nav.setAppBadge(count); return true; }
    if (count === 0 && nav.clearAppBadge) { await nav.clearAppBadge(); return true; }
    if (count === 0 && nav.setAppBadge) { await nav.setAppBadge(0); return true; } // old API: 0 clears
    return false;
  } catch { return false; }
}

/** what a count dot shows (the bell, the phone avatar): at most 99+, as the app badge; accessible names keep the real number */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n));

let hooked = false;
/**
 * Reads the unread count (the notifications center's counts: every unread entry, not only the legacy list's newest 30) and shows
 * it on the app icon (at most 99). Never throws (kids profiles get 403 and a signed-out visitor 401: badge cleared).
 * The first call also re-syncs whenever the tab becomes visible again.
 */
export async function syncBadge(): Promise<void> {
  if (typeof document !== 'undefined' && !hooked) {
    hooked = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncBadge(); });
  }
  if (get(kidsMode)) { await setAppBadge(0); return; } // kids profiles have no notifications (the request would be a 403 kids_profile)
  try {
    await setAppBadge((await counts()).unread);
  } catch { await setAppBadge(0); }
}
