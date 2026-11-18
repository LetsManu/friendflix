// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Swipe to remove (a row of the notifications center, touch only): the row follows the finger to the left (transform and opacity
 * only). Let go past 40 % of its width, or flung to the left, and it slides out and `remove` runs (the caller clears it with the
 * usual undo toast); a shorter drag springs back. The direction locks after a few pixels: a mostly vertical move is left to the
 * scroll (the row has `touch-action: pan-y`, so the browser scrolls and cancels the pointer), a horizontal one never scrolls. With
 * reduced motion (the OS setting or the app's calm mode, `html.m-still`) nothing animates: the row goes or comes back at once.
 *   <li use:swipeToRemove={{ remove: () => dispatch('hide', id) }}>
 */
export interface SwipeOptions {
  remove: () => void;
  /** false: the row does not follow the finger (a row without ✕) */
  enabled?: boolean;
}

/** px the finger moves before the direction is decided */
export const LOCK_PX = 10;
/** past this share of the row's width the row goes */
export const REMOVE_SHARE = 0.4;
/** a fling: at least this fast to the left (px per ms, over the last 100 ms) */
export const FLING_PX_MS = 0.5;
const FLING_WINDOW_MS = 100;
const OUT_MS = 180;
const BACK_MS = 260;
/** a slight overshoot: the spring back */
const SPRING = 'cubic-bezier(.3, 1.4, .5, 1)';

const still = () =>
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) ||
  (typeof document !== 'undefined' && document.documentElement.classList.contains('m-still'));

type Phase = 'idle' | 'pending' | 'drag';

export function swipeToRemove(node: HTMLElement, options: SwipeOptions) {
  let opts = options;
  let phase: Phase = 'idle';
  let pointer = -1, x0 = 0, y0 = 0, dx = 0, width = 1;
  let samples: Array<{ x: number; t: number }> = [];
  let outTimer: ReturnType<typeof setTimeout> | undefined;

  const paint = (x: number, transition: string) => {
    node.style.transition = transition;
    node.style.transform = x ? `translateX(${x}px)` : '';
    node.style.opacity = x ? String(Math.max(0.2, 1 - (-x / width) * 0.8)) : '';
  };
  /** the click a drag would end with must not open or follow the row */
  const swallowClick = () => {
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    node.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => node.removeEventListener('click', stop, { capture: true }), 0);
  };
  const back = () => paint(0, still() ? 'none' : `transform ${BACK_MS}ms ${SPRING}, opacity ${BACK_MS}ms linear`);
  /** the row is gone once `remove` ran; one that stays (nothing was removed) comes back */
  const gone = () => {
    opts.remove();
    outTimer = setTimeout(() => { if (node.isConnected) paint(0, 'none'); }, 0);
  };
  const out = () => {
    if (still()) { gone(); return; }
    paint(-width, `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms linear`);
    outTimer = setTimeout(gone, OUT_MS);
  };
  /** px per ms over the last 100 ms (negative: to the left) */
  const speed = (t: number) => {
    const from = samples.find((s) => t - s.t <= FLING_WINDOW_MS) ?? samples[samples.length - 1];
    return from && t > from.t ? (dx - from.x) / (t - from.t) : 0;
  };

  const down = (e: PointerEvent) => {
    if (opts.enabled === false || e.pointerType !== 'touch' || !e.isPrimary || phase !== 'idle') return;
    phase = 'pending';
    pointer = e.pointerId;
    x0 = e.clientX; y0 = e.clientY; dx = 0;
    samples = [{ x: 0, t: e.timeStamp }];
  };
  const move = (e: PointerEvent) => {
    if (phase === 'idle' || e.pointerId !== pointer) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (phase === 'pending') {
      if (Math.max(Math.abs(mx), Math.abs(my)) < LOCK_PX) return;
      if (Math.abs(my) >= Math.abs(mx) || mx > 0) { phase = 'idle'; return; } // a scroll, or a swipe to the right: not ours
      phase = 'drag';
      width = node.getBoundingClientRect().width || 1;
    }
    dx = Math.min(0, mx);
    samples.push({ x: dx, t: e.timeStamp });
    if (samples.length > 12) samples.shift();
    paint(dx, 'none');
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const was = phase;
    phase = 'idle';
    if (was !== 'drag') return;
    swallowClick();
    if (-dx >= width * REMOVE_SHARE || (speed(e.timeStamp) <= -FLING_PX_MS && dx <= -LOCK_PX)) out();
    else back();
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const was = phase;
    phase = 'idle';
    if (was === 'drag') back();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  return {
    update(o: SwipeOptions) { opts = o; },
    destroy() {
      clearTimeout(outTimer);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
    },
  };
}
