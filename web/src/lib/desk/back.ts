// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How many history entries of this app session lie behind the current page (the root layout feeds every navigation in).
 * The desktop detail page's "‹ Back" goes back in the browser history only when there is an in-app entry to go back to;
 * after a deep link or a reload it goes home instead of leaving the app.
 */
let depth = 0;

export function trackNav(n: { type: string; delta?: number | null }): void {
  if (n.type === 'enter') depth = 0;
  else if (n.type === 'popstate') depth = Math.max(0, depth + (n.delta ?? -1));
  else depth++;
}

export const canGoBack = (): boolean => depth > 0;

/** a fresh session (tests) */
export function resetBack(): void { depth = 0; }
