// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { anchorMoved, MENU_MARGIN, placeMenu } from '#lib/popover';

export interface MenuPlaceOpts {
  /** the menu's button; null / undefined: the action does nothing (e.g. the same element as a phone sheet) */
  trigger: HTMLElement | null | undefined;
  /** prefer opening above the button */
  up?: boolean;
  /** the menu is at least as wide as its button (a row-wide picker) */
  wide?: boolean;
  /** the button moved (a scroll outside the menu, a layout shift): the owner closes the menu */
  onMoved?: () => void;
}

/**
 * Svelte action for a `position: fixed` desktop menu: on mount it measures the menu's own size and places it next to its button
 * inside the window (`placeMenu`), synchronously, before the intro transition reads the box; it places again when the window
 * resizes or the menu's size changes (content loaded), on the side it opened on (it never flips while open: the height is capped
 * and the box shifts instead). A scroll outside the menu that moves the button more than 2 px calls
 * `onMoved` (the menu does not follow its button through the page).
 *   <div class="pop gm frost frost-menu" use:menuPlace={{ trigger: btn, up, onMoved: () => close(false) }}>
 */
export function menuPlace(node: HTMLElement, opts: MenuPlaceOpts) {
  let o = opts;
  let anchor: { left: number; top: number } | null = null;
  let vw = 0, vh = 0;
  let side: 'up' | 'down' | undefined; // the side chosen at open: a later re-placement keeps it (no flip under the pointer)

  function place() {
    const t = o.trigger;
    if (!t || !t.isConnected) return;
    const r = t.getBoundingClientRect();
    anchor = { left: r.left, top: r.top };
    vw = window.innerWidth; vh = window.innerHeight;
    if (o.wide) node.style.minWidth = `${Math.round(Math.min(r.width, vw - 2 * MENU_MARGIN))}px`;
    node.style.removeProperty('max-height'); // its natural height
    const p = placeMenu(r, { w: node.offsetWidth, h: node.offsetHeight }, { w: vw, h: vh }, { up: o.up, side });
    side = p.up ? 'up' : 'down';
    node.style.setProperty('left', `${p.left}px`);
    node.style.setProperty('top', `${p.top}px`);
    node.style.setProperty('max-height', `${p.maxHeight}px`);
  }
  function onScroll(e: Event) {
    if (!anchor || !o.trigger) return;
    if (e.target instanceof Node && node.contains(e.target)) return; // the menu's own list scrolls
    if (window.innerWidth !== vw || window.innerHeight !== vh) { place(); return; } // a resize clamped the page's scroll
    if (anchorMoved(anchor, o.trigger.getBoundingClientRect())) o.onMoved?.();
  }

  place();
  const ro = typeof ResizeObserver !== 'undefined' && o.trigger ? new ResizeObserver(() => place()) : null;
  ro?.observe(node);
  window.addEventListener('resize', place);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return {
    update(next: MenuPlaceOpts) { o = next; },
    destroy() {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', onScroll, { capture: true });
    },
  };
}
