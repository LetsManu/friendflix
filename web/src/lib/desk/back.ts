// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How many history entries of this app session lie behind the current page (the root layout feeds every navigation in).
 * The desktop detail page's "‹ Back" goes back in the browser history only when there is an in-app entry to go back to;
 * after a deep link or a reload it goes home instead of leaving the app.
 *
 * The router keeps a history index in `history.state`: depth = index now - index at the session's first page. A navigation
 * that replaced the entry (`goto(…, { replaceState: true })`, redirects) keeps the index, so it adds nothing. Without an index
 * (another router version) the navigations are counted instead.
 */
let depth = 0, base: number | null = null;

/** the router's history index in a `history.state` object (SvelteKit 2 and 3 layouts), null when there is none */
export function historyIndex(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  const meta = s['sveltekit:metadata'] as { historyIndex?: unknown } | undefined;
  const v = meta && typeof meta === 'object' ? meta.historyIndex : s['sveltekit:history'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function trackNav(n: { type: string; delta?: number | null; index?: number | null }): void {
  const index = n.index ?? null;
  if (n.type === 'enter') { depth = 0; base = index; return; }
  if (index !== null && base !== null) { depth = Math.max(0, index - base); return; }
  if (n.type === 'popstate') depth = Math.max(0, depth + (n.delta ?? -1));
  else depth++;
}

export const canGoBack = (): boolean => depth > 0;

/** a fresh session (tests) */
export function resetBack(): void { depth = 0; base = null; }
