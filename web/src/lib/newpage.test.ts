// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { Item } from '#lib/api';
import { LOCALES, setLocale, tr } from '#lib/i18n';
import { reasonText } from './reason';
import {
  daysSince, episodeItem, filterItems, filterKeyTarget, filterSearch, freshText, kindOf, matchesFilter, NEW_TITLE_DAYS, parseFilter, planSections, withinDays,
  type NewData, type NewEpisode, type Up,
} from './newpage';

const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime(); // 10 Nov 2026, local afternoon
const ago = (days: number, hour = 9) => new Date(2026, 10, 10 - days, hour, 0, 0).toISOString();
const item = (id: string, name: string, type: 'Movie' | 'Series' | 'Episode', extra: Partial<Item> = {}) => ({ id, name, type, genres: [], image: true, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0, ...extra }) as Item;
const ep = (id: string, series: string, days: number): NewEpisode => ({ seriesId: `s-${series}`, seriesName: series, newCount: 1, episode: { id, name: 'Pilot', season: 2, episode: 4, addedAt: ago(days), image: true } });
const up = (title: string, mediaType: 'movie' | 'tv', releaseDate = '2026-11-21T00:00:00Z'): Up => ({ tmdbId: title.length, mediaType, title, releaseDate, status: 'nicht_angefragt' });
const EMPTY: NewData = { forYou: [], newSeries: [], newMovies: [], episodes: [], week: [], upcoming: [] };

afterEach(async () => { await setLocale('de'); });

describe('filter', () => {
  it('reads the URL value; anything unknown is Alles, and Alles keeps a plain URL', () => {
    expect(parseFilter('series')).toBe('series');
    expect(parseFilter('movie')).toBe('movie');
    for (const v of [null, undefined, '', 'all', 'movies', 'SERIES', '../x']) expect(parseFilter(v)).toBe('all');
    expect(filterSearch('all')).toBe('');
    expect(filterSearch('series')).toBe('?type=series');
    expect(filterSearch('movie')).toBe('?type=movie');
    for (const f of ['all', 'series', 'movie'] as const) expect(parseFilter(new URLSearchParams(filterSearch(f)).get('type'))).toBe(f);
  });
  it('episodes and seasons belong to their series, the request service names tv and movie', () => {
    expect([kindOf('Series'), kindOf('Episode'), kindOf('Season'), kindOf('tv')]).toEqual(['series', 'series', 'series', 'series']);
    expect([kindOf('Movie'), kindOf('movie')]).toEqual(['movie', 'movie']);
    expect([kindOf('BoxSet'), kindOf(undefined)]).toEqual([null, null]);
    expect(matchesFilter('all', 'BoxSet')).toBe(true);
    expect(matchesFilter('series', 'Movie')).toBe(false);
    expect(matchesFilter('movie', 'movie')).toBe(true);
  });
  it('filters a list by type and keeps its order', () => {
    const l = [item('1', 'A', 'Movie'), item('2', 'B', 'Series'), item('3', 'C', 'Movie')];
    expect(filterItems(l, 'all')).toHaveLength(3);
    expect(filterItems(l, 'movie').map((i) => i.id)).toEqual(['1', '3']);
    expect(filterItems(l, 'series').map((i) => i.id)).toEqual(['2']);
  });
  it('arrow keys wrap, Home / End jump, Up / Down stay with the page', () => {
    expect(filterKeyTarget('ArrowRight', 'all')).toBe('series');
    expect(filterKeyTarget('ArrowRight', 'movie')).toBe('all');
    expect(filterKeyTarget('ArrowLeft', 'all')).toBe('movie');
    expect(filterKeyTarget('Home', 'movie')).toBe('all');
    expect(filterKeyTarget('End', 'all')).toBe('movie');
    expect(filterKeyTarget('ArrowDown', 'all')).toBeNull();
    expect(filterKeyTarget('a', 'all')).toBeNull();
  });
});

describe('freshness', () => {
  it('counts calendar days, not 24-hour spans', () => {
    expect(daysSince(ago(0, 1), NOW)).toBe(0);
    expect(daysSince(new Date(2026, 10, 9, 23, 59).toISOString(), new Date(2026, 10, 10, 0, 5).getTime())).toBe(1);
    expect(daysSince(ago(3), NOW)).toBe(3);
    expect(daysSince(ago(-2), NOW)).toBe(0); // a date in the future counts as today
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince('not a date', NOW)).toBeNull();
  });
  it('German: heute, gestern, N Tagen', async () => {
    await setLocale('de');
    expect(freshText(ago(0), NOW, tr)).toBe('Neu heute');
    expect(freshText(ago(1), NOW, tr)).toBe('Neu seit gestern');
    expect(freshText(ago(2), NOW, tr)).toBe('Neu seit 2 Tagen');
    expect(freshText(ago(13), NOW, tr)).toBe('Neu seit 13 Tagen');
    expect(freshText(undefined, NOW, tr)).toBe('');
  });
  it('plural rules per language (Polish has four forms)', async () => {
    await setLocale('en');
    expect(freshText(ago(1), NOW, tr)).toBe('Added yesterday');
    expect(freshText(ago(5), NOW, tr)).toBe('Added 5 days ago');
    await setLocale('pl');
    expect(freshText(ago(2), NOW, tr)).toBe('Nowe od 2 dni');
    expect(freshText(ago(5), NOW, tr)).toBe('Nowe od 5 dni');
    expect(freshText(ago(12), NOW, tr)).toBe('Nowe od 12 dni');
    await setLocale('fr');
    expect(freshText(ago(3), NOW, tr)).toBe('Nouveau depuis 3 jours');
  });
  it('every language words all three states without falling back to a key', async () => {
    for (const { code } of LOCALES) {
      await setLocale(code);
      const texts = [0, 1, 2, 3, 5, 11, 14].map((d) => freshText(ago(d), NOW, tr));
      for (const t of texts) expect(t, code).not.toMatch(/home\.new|^$/);
      expect(new Set(texts).size, code).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('window of new titles', () => {
  it('keeps what was added within 14 days, drops older, undated, unreadable and future-dated ones', () => {
    const l = [
      item('a', 'A', 'Movie', { dateCreated: ago(1) }), item('b', 'B', 'Movie', { dateCreated: ago(14, 15) }), item('c', 'C', 'Movie', { dateCreated: ago(15) }),
      item('d', 'D', 'Movie'), item('e', 'E', 'Movie', { dateCreated: 'soon' }), item('f', 'F', 'Movie', { dateCreated: ago(-9) }),
    ];
    expect(withinDays(l, NEW_TITLE_DAYS, NOW).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('new episodes as cards', () => {
  it('an episode card carries the show, season and number and opens the player', () => {
    const e = episodeItem(ep('e1', 'Bright Valley', 1));
    expect(e).toMatchObject({ id: 'e1', type: 'Episode', seriesId: 's-Bright Valley', seriesName: 'Bright Valley', parentIndexNumber: 2, indexNumber: 4, image: true });
  });
});

describe('page plan', () => {
  const data = (): NewData => ({
    forYou: [item('f1', 'Kestrel', 'Series'), item('f2', 'Cedar Falls', 'Movie')],
    newSeries: [item('f1', 'Kestrel', 'Series'), item('s2', 'Hollow Pines', 'Series')],
    newMovies: [item('m1', 'Meridian', 'Movie'), item('f2', 'Cedar Falls', 'Movie')],
    episodes: [ep('e1', 'Inkwell', 1)],
    week: [item('w1', 'Interlace', 'Movie'), item('w2', 'Dunmoor', 'Series')],
    upcoming: [up('Vesper Bay', 'movie'), up('Nightingale Road', 'tv')],
  });
  const ids = (l: Array<{ id: string }>) => l.map((i) => i.id);

  it('Alles shows every section; a title the For-you row shows is not repeated below', () => {
    const p = planSections(data(), 'all', { requests: true });
    expect(ids(p.forYou)).toEqual(['f1', 'f2']);
    expect(ids(p.newSeries)).toEqual(['s2']);
    expect(ids(p.newMovies)).toEqual(['m1']);
    expect(p.episodes).toHaveLength(1);
    expect(ids(p.week)).toEqual(['w1', 'w2']);
    expect(p.upcoming).toHaveLength(2);
    expect(p.empty).toBe(false);
  });
  it('Serien: no films anywhere, new episodes stay; Filme: no series and no new episodes', () => {
    const s = planSections(data(), 'series', { requests: true });
    expect(ids(s.forYou)).toEqual(['f1']);
    expect(s.newMovies).toEqual([]);
    expect(s.episodes).toHaveLength(1);
    expect(ids(s.week)).toEqual(['w2']);
    expect(s.upcoming.map((u) => u.title)).toEqual(['Nightingale Road']);
    const m = planSections(data(), 'movie', { requests: true });
    expect(ids(m.forYou)).toEqual(['f2']);
    expect(m.newSeries).toEqual([]);
    expect(m.episodes).toEqual([]);
    expect(ids(m.week)).toEqual(['w1']);
    expect(m.upcoming.map((u) => u.title)).toEqual(['Vesper Bay']);
  });
  it('without a request service there is no Demnächst, whatever was loaded', () => {
    expect(planSections(data(), 'all', { requests: false }).upcoming).toEqual([]);
  });
  it('sections still loading (null) count as empty, a failed one does not hide the others', () => {
    const p = planSections({ ...EMPTY, forYou: null, newMovies: [item('m1', 'Meridian', 'Movie')] }, 'all', { requests: true });
    expect(p.forYou).toEqual([]);
    expect(ids(p.newMovies)).toEqual(['m1']);
    expect(p.empty).toBe(false);
  });
  it('the empty state is for "nothing new at all"; this week and Demnächst may still show below it', () => {
    const p = planSections({ ...EMPTY, week: [item('w1', 'Interlace', 'Movie')], upcoming: [up('Vesper Bay', 'movie')] }, 'all', { requests: true });
    expect(p.empty).toBe(true);
    expect(p.week).toHaveLength(1);
    expect(p.upcoming).toHaveLength(1);
    // a filter can empty the page too: only films are new, the Serien filter shows nothing
    const onlyFilms = planSections({ ...EMPTY, newMovies: [item('m1', 'Meridian', 'Movie')] }, 'series', { requests: true });
    expect(onlyFilms.empty).toBe(true);
  });
});

describe('reason lines on the page', () => {
  it('use the wording of the recommendation rows; no reason shows no line', async () => {
    await setLocale('de');
    expect(reasonText({ seed: { id: 'x', name: 'Inkwell' }, traits: ['director'] }, tr)).toBe('Weil du „Inkwell“ gesehen hast · gleiche Regie');
    expect(reasonText({ seed: null, traits: ['genre:Mystery'] }, tr)).toContain('Mystery');
    expect(reasonText(null, tr)).toBe('');
    expect(reasonText(undefined, tr)).toBe('');
  });
});
