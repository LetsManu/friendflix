// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LiveChannel } from './api';

/** 'all', the person's favourites, the recently watched, or a group id */
export type LiveFilter = 'all' | 'fav' | 'recent' | string;

/** position of a channel's group; the list position stands in when the channel does not carry one */
export const groupPosition = (c: LiveChannel, index: number): number => c.groupPos ?? index;

/** a channel without a number (an own feed) sorts after every numbered one, like the backend's list */
const numKey = (c: LiveChannel): number => c.number ?? Number.MAX_SAFE_INTEGER;

/** by number; two channels with the same number go by their group position (then by list position, so the order is stable) */
export function byNumber(list: LiveChannel[]): LiveChannel[] {
  return list
    .map((c, i) => ({ c, i, g: groupPosition(c, i) }))
    .sort((a, b) => numKey(a.c) - numKey(b.c) || a.g - b.g || a.i - b.i)
    .map((x) => x.c);
}

function pick(list: LiveChannel[], ids: string[]): LiveChannel[] {
  const byId = new Map(list.map((c) => [c.id, c] as const));
  const out: LiveChannel[] = [];
  for (const id of ids) { const c = byId.get(id); if (c) out.push(c); }
  return out;
}

/**
 * The channels of a filter in zapping order: groups and `all` by number, `fav` in the person's order, `recent` in the order of
 * `recent` (the caller passes the snapshot taken when the filter was chosen, so zapping does not reshuffle it).
 */
export function channelOrder(list: LiveChannel[], filter: LiveFilter, favourites: string[], recent: string[]): LiveChannel[] {
  if (filter === 'all') return byNumber(list);
  if (filter === 'fav') return pick(list, favourites);
  if (filter === 'recent') return pick(list, recent);
  return byNumber(list.filter((c) => c.groupId === filter));
}

/** The next (dir 1) or previous (dir -1) channel of an ordered list, wrapping around. An unknown id lands on the first or last channel. */
export function neighbour(list: LiveChannel[], id: string, dir: 1 | -1): LiveChannel {
  if (!list.length) throw new RangeError('empty channel list');
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return dir === 1 ? list[0] : list[list.length - 1];
  return list[(i + dir + list.length) % list.length];
}
