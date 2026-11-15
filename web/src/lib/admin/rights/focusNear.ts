// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the focus goes when the control that had it disappears (the role page: a press removed its own section) and the place it
 * should go to is locked (an area card that waits for the Mediathek, the admin role's cards): never the locked control, but the
 * nearest unlocked one in reading order, the next before the previous at the same distance (WCAG 2.4.3).
 */

/** controls that cannot be used: disabled, aria-disabled, or inside an inert subtree */
export const LOCKED = ':disabled, [aria-disabled="true"], [inert], [inert] *';
/** what can take the focus by Tab */
export const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** the index of the nearest entry that is not locked, from `at` outwards; -1 when none is (or `at` is outside the list) */
export function nearestOpen(locked: readonly boolean[], at: number): number {
  if (at < 0 || at >= locked.length) return -1;
  for (let d = 0; d < locked.length; d++) {
    if (at + d < locked.length && !locked[at + d]) return at + d;
    if (d > 0 && at - d >= 0 && !locked[at - d]) return at - d;
  }
  return -1;
}

export interface Focusable { focus(options?: FocusOptions): void; matches(selector: string): boolean }

/** focuses `target`, or the nearest unlocked entry of `list` (the page's focusable controls in DOM order) when it is locked */
export function focusNearest<T extends Focusable>(list: readonly T[], target: T): T | null {
  const i = nearestOpen(list.map((el) => el.matches(LOCKED)), list.indexOf(target));
  const el = i < 0 ? null : list[i]!;
  el?.focus();
  return el;
}
