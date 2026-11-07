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
