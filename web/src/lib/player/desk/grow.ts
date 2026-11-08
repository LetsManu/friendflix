// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop player panels: a card grows out of its button (scale from the button's corner, slight overshoot). */
import { motionAllowed } from '#lib/preview';

/** the shared spring curve (`--m-spring` in app.css): settles with a slight overshoot */
export const SPRING = 'cubic-bezier(.2,.9,.25,1.15)';
export const GROW_MS = 300;
/** the card is fully opaque after this long; the scale keeps going */
export const GROW_FADE_MS = 120;

/**
 * Svelte transition: scale 0.6 → 1 from `origin` (a CSS transform-origin, e.g. 'bottom right') over 300 ms on the spring
 * curve, opacity 0 → 1 in the first 120 ms. `on: false` (not the desktop layout) or reduced motion / calm mode: no animation.
 */
export function grow(node: Element, o: { origin: string; on?: boolean }): { duration: number; css: (t: number) => string } {
  const duration = o.on === false || !motionAllowed() ? 0 : GROW_MS;
  if (o.on !== false && node instanceof HTMLElement) node.style.transformOrigin = o.origin;
  const fadeShare = GROW_FADE_MS / GROW_MS;
  return {
    duration,
    // `t` runs linearly (no easing): the scale follows the spring curve, so it overshoots 1 a little before settling
    css: (t: number) => `transform: scale(${0.6 + 0.4 * springAt(t)}); opacity: ${Math.min(1, t / fadeShare)}`,
  };
}

/** y of the cubic-bezier(.2,.9,.25,1.15) curve at progress x (solved by bisection on the x polynomial) */
export function springAt(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = [0.2, 0.9, 0.25, 1.15];
  const bez = (s: number, a: number, b: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0, hi = 1, s = x;
  for (let i = 0; i < 24; i++) {
    s = (lo + hi) / 2;
    if (bez(s, x1, x2) < x) lo = s; else hi = s;
  }
  return bez(s, y1, y2);
}
