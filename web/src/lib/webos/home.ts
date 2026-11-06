// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Change server" in the LG app. The server page cannot open the app's local file:// start page directly, so it goes back
 * through the browser history: the history length is recorded once when the app's first server page mounts, and the way back
 * is the number of entries added since.
 */
export const HIST_BASE_KEY = 'ff.histBase';

/** how the way home is taken; flipped to 'blue' only if the probe reports home=fail */
export const HOME_ROUTE: 'history' | 'blue' = 'blue'; // owner's probe (webOS 25): home=fail, history.go does not reach the file:// start page

export interface HomeWin {
  history: { length: number; go?: (delta: number) => void };
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** remember the history length of the first server page; never overwrites an earlier value */
export function recordHistoryBase(win: HomeWin = window): void {
  try {
    const s = win.sessionStorage;
    if (!s || s.getItem(HIST_BASE_KEY) !== null) return;
    s.setItem(HIST_BASE_KEY, String(win.history.length));
  } catch { /* storage blocked: Change server then falls back to the hint */ }
}

/** history steps back to the app's start page, or null when unknown */
export function stepsToAppHome(length: number, base: number | null): number | null {
  if (base === null) return null;
  const steps = -(length - base + 1);
  return steps >= 0 ? null : steps;
}

/** go back to the app's start page; false when the way is unknown */
export function goToAppHome(win: HomeWin = window): boolean {
  let base: number | null;
  try {
    const raw = win.sessionStorage?.getItem(HIST_BASE_KEY);
    const n = raw == null ? NaN : Number(raw);
    base = Number.isInteger(n) ? n : null;
  } catch { return false; }
  const steps = stepsToAppHome(win.history.length, base);
  if (steps === null) return false;
  win.history.go?.(steps);
  return true;
}

/** how long Change server waits for the page to go away before it shows the blue-key hint */
export const HOME_LEAVE_MS = 1500;

/**
 * "Change server": back to the app's start page. When the way is unknown, or the page is still there after HOME_LEAVE_MS (Chromium
 * keeps at most 50 history entries, so the start page may have been pruned and history.go() lands on a server page or nowhere),
 * `onStuck` shows the blue-key hint.
 */
export function changeServerViaHome(onStuck: () => void, win: HomeWin & { addEventListener(type: 'pagehide', fn: () => void): void; removeEventListener(type: 'pagehide', fn: () => void): void } = window, route: 'history' | 'blue' = HOME_ROUTE): void {
  if (route !== 'history' || !goToAppHome(win)) { onStuck(); return; }
  let left = false;
  const hide = () => { left = true; };
  win.addEventListener('pagehide', hide);
  setTimeout(() => { win.removeEventListener('pagehide', hide); if (!left) onStuck(); }, HOME_LEAVE_MS);
}
