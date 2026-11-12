// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { t } from '#lib/i18n';
import { clock, type LiveChannel, type Prog } from './api';

/** the programme's bounds in ms, or null when a timestamp does not parse or the programme has no length */
function span(p: Prog): { start: number; end: number } | null {
  const start = new Date(p.start).getTime(), end = new Date(p.end).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

const MINUTE = 60_000;

/** Where `now` is inside the programme, 0 to 1. It moves in whole minutes (the seconds of `now` do not count), so a bar never creeps. */
export function progressAt(p: Prog, now: Date): number {
  const s = span(p);
  if (!s) return 0;
  const at = Math.floor(now.getTime() / MINUTE) * MINUTE;
  return Math.min(1, Math.max(0, (at - s.start) / (s.end - s.start)));
}

export type TimeLeft = { key: 'live.timeLeft'; n: number } | { key: 'live.timeLeftLong'; h: number; m: number } | { key: 'live.endingNow' };

/**
 * The time left of the running programme (spec §12.1): minutes rounded up, "1 Std. 20 Min." from 60 minutes, "endet gleich" under one
 * minute, nothing without a programme. Never shown on list rows.
 */
export function timeLeft(p: Prog | undefined, now: Date): TimeLeft | null {
  const s = p ? span(p) : null;
  if (!s) return null;
  const ms = s.end - now.getTime();
  if (ms < MINUTE) return { key: 'live.endingNow' };
  const n = Math.ceil(ms / MINUTE);
  return n >= 60 ? { key: 'live.timeLeftLong', h: Math.floor(n / 60), m: n % 60 } : { key: 'live.timeLeft', n };
}

/** the words of a time left (the caller renders them in a slot of reserved width) */
export function timeLeftText(left: TimeLeft | null): string {
  if (!left) return '';
  const tr = get(t);
  if (left.key === 'live.timeLeft') return tr(left.key, { n: left.n });
  if (left.key === 'live.timeLeftLong') return tr(left.key, { h: left.h, m: left.m });
  return tr(left.key);
}

/** where a channel plays (the live player page) */
export const watchPath = (id: string): string => `/live/watch/${encodeURIComponent(id)}`;

/** The one accessible name of a row or tile (spec §21): "{number} {name}, jetzt: {title}, bis {time}"; without a running programme just number and name. */
export function rowName(c: LiveChannel, now: Date): string {
  const head = `${c.number} ${c.name}`;
  const p = c.now;
  if (!p || c.receiving === false || c.epg !== 'ok') return head;
  const s = span(p);
  if (!s || s.end <= now.getTime()) return head;
  return get(t)('live.rowName', { number: c.number, name: c.name, title: p.title, time: clock(p.end) });
}
