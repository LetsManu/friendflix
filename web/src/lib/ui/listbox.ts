// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The model behind `Select`'s desktop glass listbox (GlassListbox.svelte; WAI-ARIA listbox pattern, a select-only combobox):
 * moving among the options like a native select (no wrap, disabled options skipped), typeahead, and when to use it at all.
 */
import type { MenuMove } from './menuKeys';

export interface ListOpt { value: string; label: string; disabled?: boolean }

const enabled = (o: ListOpt | undefined): boolean => !!o && !o.disabled;

/**
 * The option after `move` from index `from` (-1: none active). next / prev skip disabled options and stop at the ends (no wrap,
 * as in a native select: the outermost enabled option stays); first / last pick the first / last enabled option. -1 when none is
 * enabled.
 */
export function nextEnabled(opts: readonly ListOpt[], from: number, move: MenuMove): number {
  const first = opts.findIndex(enabled);
  if (first < 0) return -1;
  let last = opts.length - 1;
  while (!enabled(opts[last])) last--;
  if (move === 'first') return first;
  if (move === 'last') return last;
  if (from < 0 || from >= opts.length) return move === 'next' ? first : last;
  const step = move === 'next' ? 1 : -1;
  for (let i = from + step; i >= 0 && i < opts.length; i += step) if (enabled(opts[i])) return i;
  return move === 'next' ? last : first; // at the end: the outermost enabled option
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * Typeahead: the first enabled option after `from` (wrapping, the current one last) whose label starts with `buffer`, case- and
 * accent-insensitive ("ö" finds "Österreich"). -1 when none matches.
 */
export function typeahead(opts: readonly ListOpt[], buffer: string, from: number): number {
  const n = opts.length;
  const b = fold(buffer);
  if (!n || !b) return -1;
  const start = from < 0 || from >= n ? -1 : from;
  for (let k = 1; k <= n; k++) {
    const i = (start + k + n) % n;
    if (enabled(opts[i]) && fold(opts[i]!.label).startsWith(b)) return i;
  }
  return -1;
}

/** the glass listbox replaces the system picker only on a desktop pointer: phones and TV keep the native one */
export function wantsGlassList(env: { tv: boolean; coarse: boolean; hover: boolean }): boolean {
  return !env.tv && !env.coarse && env.hover;
}
