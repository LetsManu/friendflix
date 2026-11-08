// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Play / My list rules shared by the home billboard (Hero) and the phone home carousel. */
import type { Item } from '#lib/api';

/** where the billboard's play button leads: an explicit target, else a series' page or the player */
export const heroPlayHref = (item: Pick<Item, 'id' | 'type'>, playHref = ''): string =>
  playHref || (item.type === 'Series' ? `/item/${item.id}` : `/watch/${item.id}`);

/** a movie / episode plays in the app's native player (or on a connected TV); a series link goes to its page */
export const heroPlaysNative = (item: Pick<Item, 'id' | 'type'>, playHref: string, nativeAvailable: boolean): boolean =>
  nativeAvailable && item.type !== 'Series' && item.type !== 'BoxSet' && (!playHref || playHref.startsWith(`/watch/${item.id}`));

/** the id My list keeps for a title (episodes: their series) */
export const listIdOf = (item: Pick<Item, 'id' | 'seriesId'>): string => item.seriesId ?? item.id;
