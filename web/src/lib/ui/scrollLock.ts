// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one owner of the page's scroll lock: every dialog, sheet and overlay that stops the page from scrolling behind it goes
 * through here (ModalShell, the root layout's category overlay and preview sheet, the browse filter sheet, ItemModal, the
 * trailer), so no two writers fight over `overflow` on <html>. Ref-counted: a dialog over a sheet keeps the page locked when
 * either closes first, and the page scrolls again once the last one is gone.
 *
 * Nothing behind moves: app.css reserves the scrollbar's room (`scrollbar-gutter: stable` on <html>), so the fixed bars and the
 * content keep their width when the bar goes. Where the gutter is not in effect (an engine without it, `html.tv`, the player
 * pages) the first lock pads <html>'s right edge by the scrollbar's width instead (0 on phones and TVs, which show none).
 * The last unlock puts back the inline values from before the first lock; a `hidden` overflow found there is not kept, since
 * only a lock may hide it and no lock was held.
 *   onMount(() => lockScroll());                                  (a component mounted while open)
 *   const lock = scrollLockToggle(); $: lock(open); onDestroy(() => lock(false));   (a flag)
 */

type Held = { count: number; overflow: string; paddingRight: string };
const held = new WeakMap<Document, Held>();

const docOf = (doc?: Document): Document | undefined => doc ?? (typeof document === 'undefined' ? undefined : document);

/** the page reserves the scrollbar's room itself (app.css `scrollbar-gutter: stable` is in effect on <html>) */
function gutterHeld(win: (Window & typeof globalThis) | null | undefined, html: HTMLElement): boolean {
  const g = win?.getComputedStyle?.(html)?.scrollbarGutter ?? '';
  return g.includes('stable');
}

export function lockScroll(doc?: Document): () => void {
  const d = docOf(doc);
  if (!d) return () => undefined;
  const html = d.documentElement;
  let h = held.get(d);
  if (!h) {
    const win = d.defaultView ?? (typeof window === 'undefined' ? undefined : window);
    const bar = gutterHeld(win, html) ? 0 : Math.max(0, (win?.innerWidth ?? html.clientWidth) - html.clientWidth);
    h = { count: 0, overflow: html.style.overflow === 'hidden' ? '' : html.style.overflow, paddingRight: html.style.paddingRight };
    held.set(d, h);
    if (bar > 0) html.style.paddingRight = `${(parseFloat(h.paddingRight) || 0) + bar}px`;
    html.style.overflow = 'hidden';
  }
  h.count++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = held.get(d);
    if (!cur || --cur.count > 0) return;
    held.delete(d);
    html.style.overflow = cur.overflow;
    html.style.paddingRight = cur.paddingRight;
  };
}

/** a lock that follows a flag (a sheet's `open`): true takes one lock, false gives it back; repeated values change nothing */
export function scrollLockToggle(doc?: Document): (on: boolean) => void {
  let off: (() => void) | null = null;
  return (on) => {
    if (on && !off) off = lockScroll(doc);
    else if (!on && off) { off(); off = null; }
  };
}

/**
 * Whether this browser draws classic scrollbars that take room (a desktop with a mouse on Windows or Linux): a probe box with
 * `overflow: scroll` loses width to its bar. Overlay scrollbars (phones, macOS) and hidden ones take none; there the root layout
 * sets `html.no-gutter`, so no empty strip is reserved for a scrollbar that never takes room.
 */
export function classicScrollbar(doc?: Document): boolean {
  const d = docOf(doc);
  if (!d?.body) return false;
  const probe = d.createElement('div');
  Object.assign(probe.style, { position: 'absolute', top: '-9999px', width: '100px', height: '100px', overflow: 'scroll', visibility: 'hidden' });
  d.body.appendChild(probe);
  const bar = probe.offsetWidth - probe.clientWidth;
  d.body.removeChild(probe);
  return bar > 0;
}
