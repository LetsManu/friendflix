// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { LOCALES, setLocale, tr } from '#lib/i18n';
import { FOOTER_COLUMNS, HEADER_TABS, MENU_LINKS, groupLinks, isRailTop, isTabActive, linksFor, navLabel } from './menu';

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
    for (const p of ['/', '/search', '/browse/series', '/browse/movies', '/watchlist']) expect(isRailTop(p, '')).toBe(true);
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
