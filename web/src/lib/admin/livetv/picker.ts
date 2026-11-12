// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The group picker of the source sheet (spec §9.1, plan ruling 40): the provider's groups after *Prüfen*, all ticked on first use. The
 * selection is a skip list: the unticked groups go into the source's `skipGroups`, so a group the provider adds later still imports
 * (unreleased). The functions are pure; every one answers a new state and never changes its input. Also the EPG offset's label and
 * steps (30 minutes, −12…+14 h) for the import options.
 */
import { tr } from '#lib/i18n';

export interface PickerState {
  /** the provider's groups in list order (`POST /sources/test` → `groups`) */
  groups: Array<{ name: string; channels: number }>;
  /** the unticked group names */
  skipped: Set<string>;
  /** the search text */
  q: string;
}

/** the search field appears from this many groups on */
export const SEARCH_FROM = 12;
/** the EPG offset: −12…+14 h in 30-minute steps (`epgShiftMin`) */
export const SHIFT_MIN = -720;
export const SHIFT_MAX = 840;
export const SHIFT_STEP = 30;

/** a fresh picker: names of `skipGroups` that the list no longer has are dropped */
export function initPicker(groups: PickerState['groups'], skipGroups: string[]): PickerState {
  const known = new Set(groups.map((g) => g.name));
  return { groups, skipped: new Set(skipGroups.filter((n) => known.has(n))), q: '' };
}

/** the groups whose name contains the search text (case-insensitive), in list order */
export function shownGroups(s: PickerState): PickerState['groups'] {
  const q = s.q.trim().toLowerCase();
  return q ? s.groups.filter((g) => g.name.toLowerCase().includes(q)) : s.groups;
}

/** *Alle* / *Keine*: ticks or unticks the groups that are shown, never the hidden ones */
export function setAll(s: PickerState, on: boolean): PickerState {
  const skipped = new Set(s.skipped);
  for (const g of shownGroups(s)) { if (on) skipped.delete(g.name); else skipped.add(g.name); }
  return { ...s, skipped };
}

export function toggle(s: PickerState, name: string): PickerState {
  if (!s.groups.some((g) => g.name === name)) return s;
  const skipped = new Set(s.skipped);
  if (!skipped.delete(name)) skipped.add(name);
  return { ...s, skipped };
}

/** channels of the ticked groups against all listed channels (the search does not matter) */
export function totals(s: PickerState): { picked: number; total: number } {
  let picked = 0, total = 0;
  for (const g of s.groups) { total += g.channels; if (!s.skipped.has(g.name)) picked += g.channels; }
  return { picked, total };
}

/** the `skipGroups` to save, in list order */
export function skipList(s: PickerState): string[] {
  return s.groups.filter((g) => s.skipped.has(g.name)).map((g) => g.name);
}

/** "+1,5 Std.", "−2 Std.", "0" (the number and the unit follow the language) */
export function shiftLabel(min: number): string {
  if (!min) return '0';
  return `${min > 0 ? '+' : '−'}${tr('adminLive.src.hours', { n: Math.abs(min) / 60 })}`;
}

/** one step of the offset stepper, kept inside its range */
export function stepShift(min: number, dir: 1 | -1): number {
  return Math.min(SHIFT_MAX, Math.max(SHIFT_MIN, min + dir * SHIFT_STEP));
}
