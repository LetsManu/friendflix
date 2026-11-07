// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TV list windows (detail sub-screens): a box that clips its content vertically and glides it (spring, transform only) when
 * the focus walks past its edge, so the page itself never scrolls. The first child is the moving strip; a focused element
 * is measured by its nearest `[data-follow]` ancestor (a grid row item, an episode row), so its own focus scale does not count.
 * The window gets the classes `above` / `below` while there is more content on that side (for edge fades).
 */
import { animateTo } from '#lib/tv/motion';

/** where the strip has to be (px it is moved up) so the item [top, top + h] is in view with a peek of its neighbours */
export function followShift(o: { shift: number; view: number; total: number; top: number; h: number; peek: number }): number {
  let s = o.shift;
  if (o.top - o.peek < s) s = o.top - o.peek;
  else if (o.top + o.h + o.peek > s + o.view) s = o.top + o.h + o.peek - o.view;
  return Math.max(0, Math.min(Math.max(0, o.total - o.view), s));
}

/** the window's content height (its padding is room for the focus scale, not for content) */
function inner(el: HTMLElement) {
  const cs = getComputedStyle(el);
  return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
}

type Opts = { /** share of the item's height its neighbours keep showing (default .6) */ peek?: number; /** a new value glides back to the top */ key?: unknown };

/** Svelte action: `<div class="win" use:followFocus={{ key: season }}><div class="strip">…</div></div>` */
export function followFocus(win: HTMLElement, opts: Opts = {}) {
  let o = opts, shift = 0;
  const strip = () => win.firstElementChild as HTMLElement | null;
  const edges = () => {
    const st = strip();
    const total = st?.offsetHeight ?? 0, view = inner(win);
    win.classList.toggle('above', shift > 1);
    win.classList.toggle('below', shift + view < total - 1);
  };
  const to = (s: number) => {
    const st = strip();
    if (!st) return;
    if (Math.abs(s - shift) >= 1) { shift = s; animateTo(st, 'y', -s); }
    edges();
  };
  function onFocus(e: FocusEvent) {
    const st = strip(), el = e.target as HTMLElement | null;
    if (!st || !el || !st.contains(el)) return;
    const item = el.closest<HTMLElement>('[data-follow]') ?? el;
    // both rects carry the strip's (possibly animating) transform: their difference is the layout offset inside the strip
    const sr = st.getBoundingClientRect(), r = item.getBoundingClientRect();
    const h = r.height;
    to(followShift({ shift, view: inner(win), total: st.offsetHeight, top: r.top - sr.top, h, peek: h * (o.peek ?? 0.6) }));
  }
  win.addEventListener('focusin', onFocus);
  // the content grows while it loads (lists, cast, ratings): keep the edge fades honest
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => edges()) : null;
  const watch = () => { ro?.disconnect(); ro?.observe(win); const st = strip(); if (st) ro?.observe(st); };
  watch();
  edges();
  return {
    update(next: Opts = {}) {
      const reset = next.key !== o.key;
      o = next;
      watch();
      if (reset) { shift = 0; const st = strip(); if (st) animateTo(st, 'y', 0); edges(); }
    },
    destroy() { win.removeEventListener('focusin', onFocus); ro?.disconnect(); },
  };
}
