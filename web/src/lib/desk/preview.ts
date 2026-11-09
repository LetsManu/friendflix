// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DOMRectLike } from '#lib/glass/fx';

export const HOVER_DELAY_MS = 500;
export const HOVER_CLOSE_MS = 150;
export const HOVER_MIN_WIDTH = 1100;
/** shorter windows get no hover card: the card opens the detail page on click (glass spec §3) */
export const HOVER_MIN_HEIGHT = 600;

export function hoverAllowed(o: { width: number; height: number; coarse: boolean; scrolling: boolean }): boolean {
  return o.width >= HOVER_MIN_WIDTH && o.height >= HOVER_MIN_HEIGHT && !o.coarse && !o.scrolling;
}

/** the hover card's width: 43 % of the window, 560…720 px, never wider than the window minus the margins */
export const HOVER_W_FRAC = 0.43;
export const HOVER_W_MIN = 560;
export const HOVER_W_MAX = 720;
export const HOVER_MARGIN = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hoverWidth(vpW: number): number {
  return Math.min(clamp(Math.round(vpW * HOVER_W_FRAC), HOVER_W_MIN, HOVER_W_MAX), vpW - 2 * HOVER_MARGIN);
}

/** placed hover card: its box, the 16:9 picture height and the transform origin (the card centre inside the box) */
export type HoverBox = { left: number; top: number; width: number; picH: number; height: number; ox: number; oy: number };

/**
 * Hover card box (glass spec §3): the same width on every card, a 16:9 picture centred on the card and the text (`bodyH`) below,
 * clamped into the window with `margin` on all four sides. A short window shrinks the width (never below 560) so it all fits.
 */
export function hoverBox(card: DOMRectLike, vp: { w: number; h: number }, bodyH: number, margin = HOVER_MARGIN): HoverBox {
  let width = hoverWidth(vp.w);
  if ((width * 9) / 16 + bodyH > vp.h - 2 * margin) width = Math.max(HOVER_W_MIN, Math.floor(((vp.h - 2 * margin - bodyH) * 16) / 9));
  const picH = Math.round((width * 9) / 16);
  const height = picH + bodyH;
  const cx = card.left + card.width / 2, cy = card.top + card.height / 2;
  const left = clamp(cx - width / 2, margin, vp.w - margin - width);
  const top = clamp(cy - picH / 2, margin, Math.max(margin, vp.h - margin - height));
  return { left, top, width, picH, height, ox: clamp(cx - left, 0, width), oy: clamp(cy - top, 0, height) };
}
