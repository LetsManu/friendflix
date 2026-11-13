// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { t } from '#lib/i18n';
import type { LiveChannel } from './api';
import { groupPosition } from './order';

/** time without a digit after which the typed number switches (the caller owns the timer) */
export const NUMBER_TIMEOUT_MS = 2000;
export const NUMBER_MAX_DIGITS = 5;

export interface NumberState {
  digits: string;
  /** the channel with exactly this number (the lowest group position when several share it) */
  match: LiveChannel | null;
  /** exactly one channel has this number */
  unique: boolean;
  /** exactly "0" so far: a lone 0 means the last channel */
  zero: boolean;
}

/** Leading zeros are ignored ("05" = 5). Channels count 1 to 99 999, so 0 matches nothing. */
function lookup(digits: string, list: LiveChannel[]): { match: LiveChannel | null; unique: boolean } {
  const n = Number(digits);
  if (!digits || n < 1) return { match: null, unique: false };
  let match: LiveChannel | null = null;
  let best = 0;
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].number !== n) continue;
    count++;
    const g = groupPosition(list[i], i);
    if (!match || g < best) { match = list[i]; best = g; }
  }
  return { match, unique: count === 1 };
}

export function typeDigit(s: NumberState, d: number, list: LiveChannel[]): NumberState {
  if (s.digits.length >= NUMBER_MAX_DIGITS || !Number.isInteger(d) || d < 0 || d > 9) return s;
  const digits = s.digits + d;
  return { digits, ...lookup(digits, list), zero: digits === '0' };
}

/** What OK / Enter / the 2-s timeout does with the typed number. */
export function commitNumber(s: NumberState, list: LiveChannel[]): { kind: 'channel'; channel: LiveChannel } | { kind: 'last' } | { kind: 'none'; text: string } {
  if (s.digits === '0') return { kind: 'last' };
  const { match } = lookup(s.digits, list);
  if (match) return { kind: 'channel', channel: match };
  // the typed number as a plain string: never grouped by the locale ("1001", not "1.001"; bughunt M3)
  return { kind: 'none', text: s.digits ? get(t)('live.player.noChannel', { n: String(Number(s.digits)) }) : '' };
}
