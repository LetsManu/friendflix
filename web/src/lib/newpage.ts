// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Helpers of the "New & upcoming" page: the Alles / Serien / Filme filter (kept in the URL), the freshness text ("Neu seit gestern"),
 * the 14-day window of new titles, the episode entries of GET /api/library/new-episodes as cards, and which sections the page shows.
 * Pure functions: the page owns the loading, nothing here touches the network.
 */
import type { Item } from '#lib/api';
import type { TFn } from '#lib/i18n';

const DAY = 86_400_000;
/** "new" for series and films: added to the library at most this many days ago (the window of the fresh badges, backend fresh.ts) */
export const NEW_TITLE_DAYS = 14;

// ---- filter ----
export type NewFilter = 'all' | 'series' | 'movie';
export const NEW_FILTERS: readonly NewFilter[] = ['all', 'series', 'movie'];
/** query parameter that holds the filter (absent = Alles) */
export const FILTER_PARAM = 'type';

/** the filter in a URL value; anything unknown counts as Alles */
export const parseFilter = (v: string | null | undefined): NewFilter => (v === 'series' || v === 'movie' ? v : 'all');
/** the query string for a filter ('' for Alles, so the plain page keeps a plain URL) */
export const filterSearch = (f: NewFilter): string => (f === 'all' ? '' : `?${FILTER_PARAM}=${f}`);

/** which side of the filter a title falls on: episodes and seasons belong to their series; unknown types to neither */
export function kindOf(type: string | undefined): 'series' | 'movie' | null {
  switch (type) {
    case 'Series': case 'Episode': case 'Season': case 'tv': return 'series';
    case 'Movie': case 'movie': return 'movie';
    default: return null;
  }
}
export const matchesFilter = (f: NewFilter, type: string | undefined): boolean => f === 'all' || kindOf(type) === f;
export const filterItems = <T extends { type: string }>(list: readonly T[], f: NewFilter): T[] => list.filter((i) => matchesFilter(f, i.type));

/** the filter after a key on the segmented control (Left / Right wrap, Home / End jump; Up / Down stay with the page scroll), or null for other keys */
export function filterKeyTarget(key: string, current: NewFilter): NewFilter | null {
  const i = NEW_FILTERS.indexOf(current), n = NEW_FILTERS.length;
  if (key === 'ArrowRight') return NEW_FILTERS[(i + 1) % n]!;
  if (key === 'ArrowLeft') return NEW_FILTERS[(i + n - 1) % n]!;
  if (key === 'Home') return NEW_FILTERS[0]!;
  if (key === 'End') return NEW_FILTERS[n - 1]!;
  return null;
}

// ---- freshness ----
/** whole calendar days between `iso` and `now` (0 = today); null for a missing or unreadable date; a date in the future counts as today */
export function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const day = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  return Math.max(0, Math.round((day(now) - day(at)) / DAY));
}

/** "Neu heute" / "Neu seit gestern" / "Neu seit 3 Tagen" (plural rules per language); '' without a usable date */
export function freshText(iso: string | undefined, now: number, t: TFn): string {
  const d = daysSince(iso, now);
  if (d === null) return '';
  if (d === 0) return t('home.new.freshToday');
  if (d === 1) return t('home.new.freshYesterday');
  return t('home.new.freshDays', { n: d });
}

/** the titles added within the last `days` days (by `dateCreated`), in their order; no date, an unreadable one or one in the future is left out */
export function withinDays<T extends { dateCreated?: string }>(list: readonly T[], days: number, now: number): T[] {
  return list.filter((i) => {
    const at = i.dateCreated ? Date.parse(i.dateCreated) : NaN;
    return !Number.isNaN(at) && at <= now + DAY && now - at <= days * DAY;
  });
}

// ---- new episodes ----
/** one entry of GET /api/library/new-episodes */
export interface NewEpisode {
  seriesId: string;
  seriesName: string;
  newCount: number;
  episode: { id: string; name: string; season: number; episode: number; addedAt: string; image: boolean; imageTags?: Record<string, string> };
}

/** the newest new episode of a show as a card item (opens the player, like every episode card) */
export function episodeItem(e: NewEpisode): Item {
  return {
    id: e.episode.id, name: e.episode.name, type: 'Episode', seriesId: e.seriesId, seriesName: e.seriesName,
    parentIndexNumber: e.episode.season, indexNumber: e.episode.episode, genres: [],
    image: e.episode.image, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0,
  } as Item;
}

// ---- page plan ----
export interface Up { tmdbId: number; mediaType: string; title: string; releaseDate?: string; overview?: string; poster?: string; status: string }
/** what the sections loaded; null = still loading, [] = nothing or failed (a failed section is simply absent) */
export interface NewData {
  forYou: Item[] | null; newSeries: Item[] | null; newMovies: Item[] | null; episodes: NewEpisode[] | null;
  week: Item[] | null; upcoming: Up[] | null;
}
export interface NewPlan {
  forYou: Item[]; newSeries: Item[]; episodes: NewEpisode[]; newMovies: Item[]; week: Item[]; upcoming: Up[];
  /** none of the four "new" sections has anything: the page shows the empty state (the sections below it may still show) */
  empty: boolean;
}

/**
 * What every section shows for a filter. A section without titles is empty and the page leaves it out. A title the "For you" row
 * already shows is not repeated in "Neue Serien" / "Neue Filme". Without a request service there is no "Demnächst".
 */
export function planSections(d: NewData, filter: NewFilter, o: { requests: boolean }): NewPlan {
  const forYouAll = d.forYou ?? [];
  const taken = new Set(forYouAll.map((i) => i.id));
  const forYou = filterItems(forYouAll, filter);
  const newSeries = filter === 'movie' ? [] : filterItems(d.newSeries ?? [], 'series').filter((i) => !taken.has(i.id));
  const newMovies = filter === 'series' ? [] : filterItems(d.newMovies ?? [], 'movie').filter((i) => !taken.has(i.id));
  const episodes = filter === 'movie' ? [] : d.episodes ?? [];
  const week = filterItems(d.week ?? [], filter);
  const upcoming = o.requests ? (d.upcoming ?? []).filter((u) => matchesFilter(filter, u.mediaType)) : [];
  return { forYou, newSeries, episodes, newMovies, week, upcoming, empty: !forYou.length && !newSeries.length && !episodes.length && !newMovies.length };
}
