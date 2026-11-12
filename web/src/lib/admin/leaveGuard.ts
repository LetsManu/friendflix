// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The unsaved-changes guard of staged rights (Rollen & Rechte, the person's *Rechte* tab): any navigation away while something is
 * staged asks first; an unload leaves the question to the browser. After *Verwerfen* the same kind of navigation runs again, so
 * history behaves exactly as without the guard:
 *   - Back/Forward (popstate, which SvelteKit has undone by cancelling it) goes the same `delta` through history;
 *   - a same-route change (a tab switch: `?tab=`, which replaces its entry everywhere in admin) replaces the entry again;
 *   - anything else (a link, a goto to another page) pushes, as the link would have.
 * Call it during component init (it registers beforeNavigate/afterNavigate).
 *
 *   leaveGuard(() => changes > 0, () => ({ title: …, body: …, danger: true, confirmLabel: … }));
 */
import { afterNavigate, beforeNavigate, goto, type BeforeNavigate } from '$app/navigation';
import { confirm, type ConfirmOptions } from '#lib/ui/confirm';

/** how a confirmed navigation runs again: `go` through history, or a goto with these options (null: nothing to run) */
export type Rerun = { go: number } | { url: URL; replace: boolean } | null;

/** the navigation to run again after *Verwerfen* (pure; exported for the unit test) */
export function rerunOf(nav: Pick<BeforeNavigate, 'type' | 'from' | 'to' | 'willUnload'> & { delta?: number | null }): Rerun {
  if (nav.willUnload || !nav.to) return null;
  if (nav.type === 'popstate') return { go: nav.delta ?? -1 };
  return { url: nav.to.url, replace: nav.from !== null && nav.from.url.pathname === nav.to.url.pathname };
}

export function leaveGuard(dirty: () => boolean, ask: () => ConfirmOptions): void {
  let leaving = false;
  // a same-route navigation keeps the page: the guard watches again once it has landed
  afterNavigate(() => { leaving = false; });
  beforeNavigate((nav) => {
    if (leaving || !dirty()) return;
    nav.cancel(); // unload: the browser asks itself
    const again = rerunOf(nav);
    if (!again) return;
    void confirm(ask()).then((ok) => {
      if (!ok) return;
      leaving = true;
      if ('go' in again) history.go(again.go);
      else void goto(again.url, again.replace ? { replace: true, reset: false } : {});
    });
  });
}
