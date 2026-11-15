// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { LOCALES, setLocale, tr } from '#lib/i18n';
import { FOOTER_COLUMNS, HEADER_TABS, LIVE_HEADER, LIVE_HEADERS, LIVE_RAIL, LIVE_RAILS, MENU_LINKS, REC_HEADER, REC_RAIL, TV_RAIL, activeTab, groupLinks, isRailTop, isTabActive, libraryTabs, linksFor, liveTabs, navLabel } from './menu';
import { ALL_AREAS, ALL_CAPS, ALL_FEATURES, linkShown } from './capabilities';

describe('menu', () => {
  it('every account link stays reachable on /me (grouped)', () => {
    const all = groupLinks(linksFor(true)).flatMap((g) => g.items.map((l) => l[0]));
    for (const [href] of MENU_LINKS) expect(all).toContain(href);
    expect(all).toContain('/downloads');
    expect(groupLinks(linksFor(false)).flatMap((g) => g.items.map((l) => l[0]))).not.toContain('/downloads');
  });
  it('footer only links to pages that exist in the account menu or header', () => {
    const known = new Set([...MENU_LINKS.map((l) => l[0]), ...HEADER_TABS.map((t) => t[0]), '/me']);
    for (const [href] of FOOTER_COLUMNS.flat()) expect(known.has(href)).toBe(true);
  });
  it('header tab activity', () => {
    expect(isTabActive('/', '/')).toBe(true);
    expect(isTabActive('/', '/new')).toBe(false);
    expect(isTabActive('/browse/series', '/browse/series')).toBe(true);
    expect(isTabActive('/new', '/newsletter')).toBe(false);
    expect(isTabActive('/watchlist', '/watchlist')).toBe(true);
  });
});

describe('navLabel (the new-titles entry reads "Neu" without a request service)', () => {
  it('only the new entry changes, and only while requests are off', () => {
    expect(navLabel('shell.nav.new', true)).toBe('shell.nav.new');
    expect(navLabel('shell.nav.new', false)).toBe('shell.nav.newOnly');
    expect(navLabel('shell.nav.series', false)).toBe('shell.nav.series');
  });
  it('every language words both: the short one is shorter, and neither is a key', async () => {
    for (const { code } of LOCALES) {
      await setLocale(code);
      const full = tr(navLabel('shell.nav.new', true)), short = tr(navLabel('shell.nav.new', false));
      expect(full, code).not.toMatch(/^shell\./);
      expect(short, code).not.toMatch(/^shell\./);
      expect(short.length, code).toBeLessThan(full.length);
      expect(tr('shell.tabs.newOnly'), code).not.toMatch(/^shell\./);
      expect(tr('home.new.titleOnly').length, code).toBeLessThan(tr('home.new.title').length);
    }
    await setLocale('de');
    expect([tr('shell.nav.new'), tr('shell.nav.newOnly'), tr('shell.tabs.newOnly'), tr('home.new.titleOnly')]).toEqual(['Neu & demnächst', 'Neu', 'Neu', 'Neu']);
  });
});

describe('isRailTop (TV: Back opens the rail)', () => {
  it('only the rail destinations themselves, without a filter', () => {
    for (const p of ['/', '/search', '/browse/series', '/browse/movies', '/new', '/watchlist']) expect(isRailTop(p, '')).toBe(true);
    expect(isRailTop('/new', '?type=series')).toBe(true); // the new page's filter is a view, not a drill-down
    expect(isRailTop('/browse/movies', '?type=series')).toBe(false);
    expect(isRailTop('/browse/movies', '?genre=Drama')).toBe(false);
    expect(isRailTop('/browse/series/x', '')).toBe(false);
    expect(isRailTop('/me', '')).toBe(false);
    expect(isRailTop('/search', '?q=dawn')).toBe(false);
  });
  it('app hints in the URL (LG app start, TV preview) do not count as a filter', () => {
    expect(isRailTop('/', '?ff_app=webos')).toBe(true);
    expect(isRailTop('/watchlist', '?tv=1')).toBe(true);
    expect(isRailTop('/browse/movies', '?ff_app=webos&genre=Drama')).toBe(false);
  });
});

describe('liveTabs (the Live-TV entry only while the feature is on)', () => {
  it('goes after Filme in the header and the TV rail', () => {
    expect(liveTabs(HEADER_TABS, LIVE_HEADER, true).map((t) => t[0])).toEqual(['/', '/browse/series', '/browse/movies', '/live', '/new', '/watchlist']);
    expect(liveTabs(TV_RAIL, LIVE_RAIL, true).map((t) => t[0])).toEqual(['/search', '/', '/browse/series', '/browse/movies', '/live', '/new', '/watchlist']);
    expect(LIVE_HEADER).toEqual(['/live', 'shell.nav.live']);
    expect(LIVE_RAIL).toEqual(['/live', 'shell.nav.live', 'tv']);
  });
  it('off: the very same entries, no copy of a different order', () => {
    expect(liveTabs(HEADER_TABS, LIVE_HEADER, false)).toEqual(HEADER_TABS);
    expect(liveTabs(TV_RAIL, LIVE_RAIL, false).map((t) => t[0])).not.toContain('/live');
  });
  it('does not change its input and does not add the entry twice', () => {
    const before = HEADER_TABS.map((t) => t[0]);
    const once = liveTabs(HEADER_TABS, LIVE_HEADER, true);
    expect(HEADER_TABS.map((t) => t[0])).toEqual(before);
    expect(liveTabs(once, LIVE_HEADER, true)).toEqual(once);
  });
  it('without a Filme entry it goes last', () => {
    expect(liveTabs([['/a', 'shell.nav.home']], LIVE_HEADER, true).map((t) => t[0])).toEqual(['/a', '/live']);
  });
  it('the page is a rail destination for the TV Back key, and the nav is active on it', () => {
    expect(isRailTop('/live', '')).toBe(true);
    expect(isRailTop('/live', '?play=last')).toBe(false);
    expect(isTabActive('/live', '/live/watch/abc')).toBe(true);
  });
});

describe('Aufnahmen entries (DVR follow-ups: recordings reachable from every menu)', () => {
  it('Aufnahmen follows Live-TV in the header and the TV rail, only while Live TV is on', () => {
    expect(REC_HEADER).toEqual(['/live/recordings', 'shell.nav.recordings']);
    expect(REC_RAIL).toEqual(['/live/recordings', 'shell.nav.recordings', 'record']);
    expect(liveTabs(HEADER_TABS, LIVE_HEADERS, true).map((t) => t[0])).toEqual(['/', '/browse/series', '/browse/movies', '/live', '/live/recordings', '/new', '/watchlist']);
    expect(liveTabs(TV_RAIL, LIVE_RAILS, true).map((t) => t[0])).toEqual(['/search', '/', '/browse/series', '/browse/movies', '/live', '/live/recordings', '/new', '/watchlist']);
    expect(liveTabs(HEADER_TABS, LIVE_HEADERS, false)).toEqual(HEADER_TABS);
    // without the Mediathek both stay
    expect(liveTabs(libraryTabs(HEADER_TABS, false), LIVE_HEADERS, true)).toEqual([LIVE_HEADER, REC_HEADER]);
    expect(libraryTabs(liveTabs(TV_RAIL, LIVE_RAILS, true), false)).toEqual([LIVE_RAIL, REC_RAIL]);
    // a second call adds nothing twice
    const once = liveTabs(HEADER_TABS, LIVE_HEADERS, true);
    expect(liveTabs(once, LIVE_HEADERS, true)).toEqual(once);
  });
  it('one entry is active: the most specific one (Aufnahmen on its pages, Live-TV elsewhere under /live)', () => {
    const hrefs = liveTabs(HEADER_TABS, LIVE_HEADERS, true).map((t) => t[0]);
    expect(activeTab(hrefs, '/live/recordings')).toBe('/live/recordings');
    expect(activeTab(hrefs, '/live/recordings/abc')).toBe('/live/recordings');
    expect(activeTab(hrefs, '/live')).toBe('/live');
    expect(activeTab(hrefs, '/live/watch/abc')).toBe('/live');
    expect(activeTab(hrefs, '/')).toBe('/');
    expect(activeTab(hrefs, '/me')).toBeNull();
    // without the Aufnahmen entry, Live-TV stays active on its pages
    expect(activeTab(['/live'], '/live/recordings')).toBe('/live');
  });
  it('the recordings page is a rail destination for the TV Back key', () => {
    expect(isRailTop('/live/recordings', '')).toBe(true);
    expect(isRailTop('/live/recordings/abc', '')).toBe(false);
  });
  it('Mein Bereich (the phone\'s more page) lists Aufnahmen under Meine Sachen, only with Live TV', () => {
    const groups = groupLinks(linksFor(false));
    expect(groups[1]!.items.map((l) => l[0])).toContain('/live/recordings');
    expect(MENU_LINKS.find((l) => l[0] === '/live/recordings')).toEqual(['/live/recordings', 'shell.menu.recordings', 'record']);
    expect(linkShown(ALL_CAPS, '/live/recordings', { ...ALL_FEATURES, livetv: true }, undefined, ALL_AREAS)).toBe(true);
    expect(linkShown(ALL_CAPS, '/live/recordings', { ...ALL_FEATURES, livetv: false }, undefined, ALL_AREAS)).toBe(false);
    // a person without the Mediathek keeps it
    expect(linkShown(ALL_CAPS, '/live/recordings', { ...ALL_FEATURES, livetv: true }, undefined, { ...ALL_AREAS, library: false })).toBe(true);
  });
});

describe('libraryTabs (a person without libraries: Live only, roles redesign §6)', () => {
  it('drops every library entry, Live joins as before', () => {
    expect(libraryTabs(HEADER_TABS, false)).toEqual([]);
    expect(liveTabs(libraryTabs(HEADER_TABS, false), LIVE_HEADER, true).map((t) => t[0])).toEqual(['/live']);
    expect(libraryTabs(TV_RAIL, false)).toEqual([]); // search too: it searches the library
    expect(liveTabs(libraryTabs(TV_RAIL, false), LIVE_RAIL, true)).toEqual([LIVE_RAIL]);
    expect(libraryTabs(liveTabs(TV_RAIL, LIVE_RAIL, true), false)).toEqual([LIVE_RAIL]);
  });
  it('with a library: the very same entries', () => {
    expect(libraryTabs(HEADER_TABS, true)).toBe(HEADER_TABS);
    expect(libraryTabs(TV_RAIL, true)).toBe(TV_RAIL);
  });
});
