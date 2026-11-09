// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';

/** Desktop UI shell: only when not TV, not phone and not kids. */
export function deskUi(o: { tv: boolean; mobile: boolean; kids: boolean }): boolean {
  return !o.tv && !o.mobile && !o.kids;
}

export const PILL_SOLID_AT = 24;

/** The top bar pill is see-through only at the very top of a hero page. */
export function pillSolid(scrollY: number, heroPage: boolean): boolean {
  return !heroPage || scrollY > PILL_SOLID_AT;
}

/** The root layout's `deskUi` answer, for code outside components (openModal): desktop opens titles as the full page. */
export const deskActive = writable(false);

/** the bar's scroll shade fades in over this long (DeskBar `.desk > .scrim`): the glass keeps the safe scrim until it is in */
export const SHADE_MS = 240;

/**
 * the alpha of a CSS colour in `rgb()`/`rgba()` or hex (#rgb, #rgba, #rrggbb, #rrggbbaa; the build writes the tokens as hex),
 * to the hundredth (a hex alpha cannot hold .13 exactly); for the `--fr-sel` token as the tab fill's group opacity. null if
 * unreadable.
 */
export function alphaOf(css: string): number | null {
  const v = css.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 6) return 1;
    if (hex.length === 4) return Math.round((parseInt(hex[3]!.repeat(2), 16) / 255) * 100) / 100;
    if (hex.length === 8) return Math.round((parseInt(hex.slice(6), 16) / 255) * 100) / 100;
    return null;
  }
  const m = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length === 3) return 1;
  if (parts.length !== 4) return null;
  const p = parts[3]!;
  const a = p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
  return Number.isFinite(a) ? Math.round(Math.min(1, Math.max(0, a)) * 100) / 100 : null;
}
