// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Scroll-spy for the settings page's side navigation (glass spec §6). */

/** a section counts as "in view" once its top is this many px below the top of the window (under the top bar) */
export const SPY_OFFSET = 120;

/**
 * The index of the section in view: the last one whose top (document coordinates, ascending) is at most `scrollY + offset`;
 * 0 before the first; the last one when the page is scrolled to the bottom (a short last section never reaches the line);
 * −1 without sections. A `held` section (one the user clicked, `clickHold`) wins while its scroll runs and after it stops:
 * a short section near the end may never reach the line, and the bottom rule would mark the one after it.
 */
export function currentSection(tops: number[], scrollY: number, offset = SPY_OFFSET, atBottom = false, held = -1): number {
  if (!tops.length) return -1;
  if (held >= 0 && held < tops.length) return held;
  if (atBottom) return tops.length - 1;
  let at = 0;
  tops.forEach((top, i) => { if (top <= scrollY + offset) at = i; });
  return at;
}

/** the click's scroll counts as settled once no scroll event came for this long */
export const SETTLE_MS = 200;

/**
 * Keeps a clicked section marked (`held`) while the scroll it started runs; the first scroll event after that scroll
 * settled is the user's own and ends the hold. Call `scrolled()` on every scroll event.
 */
export function clickHold(setT: typeof setTimeout = setTimeout, clearT: typeof clearTimeout = clearTimeout) {
  let held = -1, settling = false, t: ReturnType<typeof setTimeout> | undefined;
  const settle = () => { if (t !== undefined) clearT(t); t = setT(() => { settling = false; t = undefined; }, SETTLE_MS); };
  return {
    get held() { return held; },
    hold(i: number) { held = i; settling = true; settle(); },
    scrolled() { if (held < 0) return; if (settling) settle(); else held = -1; },
    clear() { if (t !== undefined) clearT(t); t = undefined; held = -1; settling = false; },
  };
}
