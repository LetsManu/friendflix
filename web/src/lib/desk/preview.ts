// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

export const HOVER_DELAY_MS = 500;
export const HOVER_CLOSE_MS = 150;
export const HOVER_MIN_WIDTH = 1100;

export function hoverAllowed(o: { width: number; coarse: boolean; scrolling: boolean }): boolean {
  return o.width >= HOVER_MIN_WIDTH && !o.coarse && !o.scrolling;
}

/** Hover preview box: 2.5x the card, anchored on its left edge (flipped to the right edge near the viewport edge), kept inside the viewport. */
export function wideBox(
  card: { left: number; top: number; width: number; height: number },
  vp: { w: number; h: number },
  margin = 12
): { left: number; top: number; width: number; height: number; origin: 'left' | 'right' | 'center' } {
  const width = card.width * 2.5;
  const height = ((width * 9) / 16) * 0.62;
  let left = card.left;
  let origin: 'left' | 'right' | 'center' = 'left';
  if (left + width > vp.w - margin) {
    left = Math.min(card.left + card.width, vp.w - margin) - width;
    origin = 'right';
  }
  if (left < margin) {
    // Anchoring right ran off the left edge: clamp; centre only if the right side overflows too.
    left = margin;
    if (origin === 'right' && left + width > vp.w - margin) origin = 'center';
    else origin = 'left';
  }
  let top = card.top - 0.08 * height;
  top = Math.min(top, vp.h - margin - height);
  top = Math.max(top, margin);
  return { left, top, width, height, origin };
}
