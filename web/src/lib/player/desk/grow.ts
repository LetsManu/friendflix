// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop player panels: a card slides 8 px toward its place out of its button while it fades in (text never scales, no overshoot). */
import { motionAllowed } from '#lib/preview';
import { GROW_IN_MS, emphOut } from '#lib/glass/fx';

/**
 * Svelte transition: translateY 8 px → 0 and opacity 0 → 1 over GROW_IN_MS on emphOut. `origin` says which corner the card
 * grows from (kept for the callers; it no longer scales, so it only picks the side of the slide). `on: false` (not the desktop
 * layout) or reduced motion / calm mode: no animation.
 */
export function grow(_node: Element, o: { origin: string; on?: boolean }): { duration: number; easing: (t: number) => number; css: (t: number) => string } {
  const duration = o.on === false || !motionAllowed() ? 0 : GROW_IN_MS;
  const dy = o.origin.startsWith('top') ? -8 : 8;
  return {
    duration,
    easing: emphOut,
    css: (t: number) => `transform: translateY(${Math.round(dy * (1 - t) * 10) / 10 + 0}px); opacity: ${Math.min(1, Math.max(0, t))}`,
  };
}
