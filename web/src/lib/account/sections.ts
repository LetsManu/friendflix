// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Scroll-spy for the settings page's side navigation (glass spec §6). */

/** a section counts as "in view" once its top is this many px below the top of the window (under the top bar) */
export const SPY_OFFSET = 120;

/**
 * The index of the section in view: the last one whose top (document coordinates, ascending) is at most `scrollY + offset`;
 * 0 before the first; the last one when the page is scrolled to the bottom (a short last section never reaches the line);
 * −1 without sections.
 */
export function currentSection(tops: number[], scrollY: number, offset = SPY_OFFSET, atBottom = false): number {
  if (!tops.length) return -1;
  if (atBottom) return tops.length - 1;
  let at = 0;
  tops.forEach((top, i) => { if (top <= scrollY + offset) at = i; });
  return at;
}
