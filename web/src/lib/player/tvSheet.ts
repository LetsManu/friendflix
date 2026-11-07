// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { motionAllowed } from '#lib/preview';
import { motionLevel } from '#lib/tv/motion';
/**
 * Svelte transitions for the TV player's overlays (spec 5.2): they slide up from the bottom and fade in (320 ms, emphasised
 * out) and leave the same way faster (200 ms, emphasised in). transform / opacity only. Calm mode / reduced motion: nothing
 * moves; the reduced set (frame guard): a plain fade.
 */
type T = { duration: number; easing?: (t: number) => number; css: (t: number) => string };

/** cubic-bezier(x1, y1, x2, y2) as an easing function (Newton on x, then y) */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const c = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const d = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  return (t) => {
    if (t <= 0 || t >= 1) return t;
    let s = t;
    for (let i = 0; i < 8; i++) { const dx = d(x1, x2, s); if (Math.abs(dx) < 1e-6) break; s -= (c(x1, x2, s) - t) / dx; s = Math.min(1, Math.max(0, s)); }
    return c(y1, y2, s);
  };
}
export const emphOut = bezier(0.05, 0.7, 0.1, 1);
export const emphIn = bezier(0.3, 0, 0.8, 0.15);

function slide(dist: number, duration: number, easing: (t: number) => number): T {
  if (!motionAllowed()) return { duration: 0, css: () => '' };
  if (motionLevel() === 'reduced') return { duration: 150, css: (t) => `opacity:${t}` };
  return { duration, easing, css: (t) => `opacity:${Math.min(1, t * 1.6)};transform:translate3d(0,${((1 - t) * dist).toFixed(1)}px,0)` };
}
/** entering: up 48 px + fade, 320 ms */
export const sheetIn = (_el: Element): T => slide(48, 320, emphOut);
/** leaving: down 32 px + fade, 200 ms (exits ~70 % of the entry) */
export const sheetOut = (_el: Element): T => slide(32, 200, emphIn);
