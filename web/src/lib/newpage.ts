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
/**
 * How long the page waits for "Noch nicht bei uns". A list that is not cached is built by the server from the taste profile, a few media
 * server lookups and the request service (up to 15 s per call), far beyond the 4 s of the quick sections; giving up early would show
 * the filler although the server finishes (and caches) the list a moment later. The skeleton keeps the slot meanwhile.
 */
export const SUGGEST_TIMEOUT_MS = 20_000;

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

// ---- tabs ----
/** the three views of the page: picks for you, what was added to the library, wishes and announced titles */
export type NewTab = 'foryou' | 'library' | 'wishes';
/** query parameter that holds the tab (absent = Für dich) */
export const TAB_PARAM = 'tab';
const TAB_URL: Record<NewTab, string> = { foryou: '', library: 'neu', wishes: 'wuensche' };

/**
 * The tabs a profile gets. The third one (wishes and announced titles) needs a request service and a grown-up profile: without
 * a service, and for kids, there are two tabs and nothing that could ask the service.
 */
export const availableTabs = (o: { requests: boolean }): NewTab[] => (o.requests ? ['foryou', 'library', 'wishes'] : ['foryou', 'library']);

/** the tab in a URL value; an unknown one, or one this profile does not have (`?tab=wuensche` for a kid), counts as Für dich */
export function parseTab(v: string | null | undefined, o: { requests: boolean }): NewTab {
  const tab = (Object.keys(TAB_URL) as NewTab[]).find((k) => TAB_URL[k] !== '' && TAB_URL[k] === v);
  return tab && availableTabs(o).includes(tab) ? tab : 'foryou';
}
/** the query string for a tab and a filter ('' for Für dich + Alles, so the plain page keeps a plain URL) */
export function pageSearch(tab: NewTab, f: NewFilter): string {
  const q = new URLSearchParams();
  if (TAB_URL[tab]) q.set(TAB_PARAM, TAB_URL[tab]);
  if (f !== 'all') q.set(FILTER_PARAM, f);
  const s = q.toString();
  return s ? `?${s}` : '';
}
/** the tab after a key on the tab list (Left / Right wrap, Home / End jump), or null for other keys */
export function tabKeyTarget(key: string, current: NewTab, tabs: readonly NewTab[]): NewTab | null {
  const i = tabs.indexOf(current), n = tabs.length;
  if (i < 0) return null;
  if (key === 'ArrowRight') return tabs[(i + 1) % n]!;
  if (key === 'ArrowLeft') return tabs[(i + n - 1) % n]!;
  if (key === 'Home') return tabs[0]!;
  if (key === 'End') return tabs[n - 1]!;
  return null;
}

/** "Für dich neu" exists only for the v2 engine (picks with reasons); under v1, or when the call failed, the row stays out */
export const forYouItems = (r: { engine?: string; items?: Item[] } | null | undefined): Item[] => (r?.engine === 'v2' ? r.items ?? [] : []);

// ---- suggestions from outside the library ("Noch nicht bei uns") ----
export type WishState = 'none' | 'requested' | 'processing' | 'available';
/** one entry of GET /api/library/request-suggestions */
export interface Suggestion {
  tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: number | null; poster: string | null; releaseDate?: string;
  reason: { seed: string }; request: { state: WishState };
}
/** the monthly wish quota (`limit: null` = unlimited) */
export interface Quota { limit: number | null; used: number; resetsAt: string }
/** wishes left; null = unlimited (or unknown) */
export const quotaLeft = (q: Quota | null | undefined): number | null => (q && q.limit !== null ? Math.max(0, q.limit - q.used) : null);
/** the quota is used up; an unlimited or unknown quota never is */
export const quotaExhausted = (q: Quota | null | undefined): boolean => quotaLeft(q) === 0;

/**
 * The films and the series suggestions arrive separately (a cached list is quick, a cold one is not) and the cards on screen must not move when the
 * second one comes. The first to arrive shows at most half of the slots (rounded up), the other slots stay placeholders ...
 */
export const earlySuggestions = (first: readonly Suggestion[], slots: number): Suggestion[] => first.slice(0, Math.ceil(slots / 2));
/** ... and the late half goes behind what is shown, then the rest of the early one (an empty or failed half leaves its slots to the other); a title that came twice stays once, at most `max`. */
export function completeSuggestions(shown: readonly Suggestion[], first: readonly Suggestion[], late: readonly Suggestion[], max = 12): Suggestion[] {
  const out: Suggestion[] = [], seen = new Set<string>();
  for (const s of [...shown, ...late, ...first]) {
    const k = `${s.mediaType}:${s.tmdbId}`;
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out.slice(0, max);
}

/** the wish state of a search result or request (the request service's status words) as the button knows it */
export function wishStateOf(status: string | undefined): WishState {
  switch (status) {
    case 'angefragt': return 'requested';
    case 'in_arbeit': case 'teilweise': return 'processing';
    case 'verfuegbar': return 'available';
    default: return 'none'; // nicht_angefragt, abgelehnt (a declined title may be asked for again), unknown
  }
}

/** the own requests that are not done yet (what the badge of the wishes tab counts): asked for, in progress, partly there */
const OPEN_STATES = new Set(['angefragt', 'in_arbeit', 'teilweise']);
export const openRequests = <T extends { status: string }>(mine: readonly T[] | null | undefined): T[] => (mine ?? []).filter((m) => OPEN_STATES.has(m.status));

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
  week: Item[] | null; upcoming: Up[] | null; suggest?: Suggestion[] | null;
}
export interface NewPlan {
  forYou: Item[]; newSeries: Item[]; episodes: NewEpisode[]; newMovies: Item[]; week: Item[]; upcoming: Up[];
  /** everything added lately, series and films together, newest first (the "Neu in der Bibliothek" tab) */
  library: Item[];
  /** titles that are not in the library yet, with their wish state (only with a request service) */
  suggestions: Suggestion[];
  /** none of the four "new" sections has anything: the page shows the empty state (the sections below it may still show) */
  empty: boolean;
}

/**
 * What every section shows for a filter. A section without titles is empty and the page leaves it out. Without a request
 * service there is no "Demnächst" and no suggestions from outside the library.
 */
export function planSections(d: NewData, filter: NewFilter, o: { requests: boolean }): NewPlan {
  const forYou = filterItems(d.forYou ?? [], filter);
  const newSeries = filter === 'movie' ? [] : filterItems(d.newSeries ?? [], 'series');
  const newMovies = filter === 'series' ? [] : filterItems(d.newMovies ?? [], 'movie');
  const episodes = filter === 'movie' ? [] : d.episodes ?? [];
  const week = filterItems(d.week ?? [], filter);
  const upcoming = o.requests ? (d.upcoming ?? []).filter((u) => matchesFilter(filter, u.mediaType)) : [];
  const suggestions = o.requests ? (d.suggest ?? []).filter((s) => matchesFilter(filter, s.mediaType)) : [];
  const at = (i: Item) => Date.parse(i.dateCreated ?? '') || 0;
  const library = [...newSeries, ...newMovies].sort((a, b) => at(b) - at(a));
  return { forYou, newSeries, episodes, newMovies, week, upcoming, library, suggestions, empty: !forYou.length && !newSeries.length && !episodes.length && !newMovies.length };
}
