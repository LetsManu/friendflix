// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop player helpers: when the desk layout applies, when the pause screen appears, and which credits beat shows. */

/** Pause screen appears this long after the last pause or activity */
export const DESK_PAUSE_MS = 5000;
/** the "Watch credits / Next episode" chip stays this long before the corner card takes over */
export const CHIP_MS = 2000;

/** true only on a desktop browser, never on a TV or a phone */
export function deskPlayer(o: { desk: boolean; tv: boolean; phone: boolean }): boolean {
  return o.desk && !o.tv && !o.phone;
}

/**
 * true once the pause screen is due: DESK_PAUSE_MS after the later of the pause and the last activity.
 * Never while blocked (menu open, scrubbing, party guest, casting, error, reconnecting, locked).
 * Calm mode still shows the screen, only without motion, so it is not an input.
 */
export function deskPauseDue(o: { pausedAt: number; lastActive: number; now: number; blocked: boolean }): boolean {
  if (o.blocked) return false;
  return o.now - Math.max(o.pausedAt, o.lastActive) >= DESK_PAUSE_MS;
}

/** which credits UI shows: nothing, the chip right after the credits start, or the corner card */
export type CreditsBeat = 'off' | 'chip' | 'corner';

/**
 * Credits beat for the current second.
 * 'off' when blocked (party guest, casting/remote), dismissed ("Watch credits"), no next kind,
 * the credits start is unknown, or we are still before it.
 * 'chip' for CHIP_MS after entering the credits (or when the entry time is unknown), then 'corner'.
 */
export function creditsBeat(o: {
  current: number;
  start: number;
  enteredAt: number | null;
  now: number;
  dismissed: boolean;
  kind: 'episode' | 'movie' | 'none';
  blocked: boolean;
}): CreditsBeat {
  if (o.blocked || o.dismissed || o.kind === 'none') return 'off';
  if (!Number.isFinite(o.start) || o.current < o.start) return 'off';
  if (o.enteredAt === null || o.now - o.enteredAt < CHIP_MS) return 'chip';
  return 'corner';
}

/**
 * "More like this" in the credits sequence: the first post-play row that still has titles once the next episode, its series
 * and the continuation row (the next episodes, already offered as "Up next") are left out; at most five. Empty: no row.
 */
export function creditPicks(
  rows: readonly { kind: string; items: readonly { id: string; seriesId?: string }[] }[] | null,
  next: { id: string; seriesId?: string } | null,
): { id: string; seriesId?: string }[] {
  const skip = new Set([next?.id, next?.seriesId].filter((v): v is string => Boolean(v)));
  for (const r of rows ?? []) {
    if (r.kind === 'continuation') continue;
    const items = r.items.filter((i) => !skip.has(i.id) && !(i.seriesId && skip.has(i.seriesId)));
    if (items.length) return items.slice(0, 5);
  }
  return [];
}
