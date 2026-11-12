// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TKey } from '#lib/i18n';

/** Link groups of the account menu: used by the desktop dropdown and the /me page. Labels are i18n keys (render with $t). */
export type MenuLink = [href: string, label: TKey, icon: string];

export const MENU_LINKS: MenuLink[] = [
  ['/tonight', 'shell.menu.tonight', 'star'], ['/favorites', 'shell.menu.favorites', 'heart'], ['/lists', 'shell.menu.lists', 'list'], ['/history', 'shell.menu.history', 'calendar'], ['/match', 'shell.menu.match', 'users'], ['/collections', 'shell.menu.collections', 'film'], ['/upcoming', 'shell.menu.upcoming', 'calendar'], ['/requests', 'shell.menu.requests', 'gift'], ['/party', 'shell.menu.party', 'users'], ['/vote', 'shell.menu.vote', 'vote'],
  ['/now', 'shell.menu.now', 'monitor'], ['/calendar', 'shell.menu.calendar', 'calendar'], ['/stats', 'shell.menu.stats', 'bar-chart'], ['/remote', 'shell.menu.remote', 'tv'], ['/settings', 'shell.menu.settings', 'settings'], ['/devices', 'shell.menu.devices', 'monitor'],
];
export const DOWNLOADS_LINK: MenuLink = ['/downloads', 'shell.menu.downloads', 'download'];

export const GROUPS: Array<{ title: TKey; hrefs: string[] }> = [
  { title: 'shell.menu.groups.discover', hrefs: ['/tonight', '/collections', '/upcoming', '/match', '/party', '/vote', '/now', '/calendar'] },
  { title: 'shell.menu.groups.mine', hrefs: ['/favorites', '/lists', '/history', '/downloads', '/requests', '/stats'] },
  { title: 'shell.menu.groups.account', hrefs: ['/remote', '/settings', '/devices'] },
];

/** links for a user (Downloads only when allowed, placed after "Verlauf"/the first three) */
export const linksFor = (canDownload: boolean): MenuLink[] => (canDownload ? [...MENU_LINKS.slice(0, 3), DOWNLOADS_LINK, ...MENU_LINKS.slice(3)] : MENU_LINKS);

/** every entry lands in exactly one group (unknown ones fall back to "Meine Sachen"), ordered as in GROUPS */
export function groupLinks(links: MenuLink[]): Array<{ title: TKey; items: MenuLink[] }> {
  const groups = GROUPS.map((g) => ({ title: g.title, items: [] as MenuLink[] }));
  for (const l of links) (groups.find((_, i) => GROUPS[i]!.hrefs.includes(l[0])) ?? groups[1]!).items.push(l);
  groups.forEach((g, i) => {
    const order = GROUPS[i]!.hrefs;
    const rank = (h: string) => { const x = order.indexOf(h); return x < 0 ? 99 : x; };
    g.items.sort((a, b) => rank(a[0]) - rank(b[0]));
  });
  return groups;
}

/** Small desktop footer (links in four columns; everything also lives on /me). */
export const FOOTER_COLUMNS: MenuLink[][] = [
  [['/me', 'shell.menu.me', 'user'], ['/watchlist', 'shell.menu.myList', 'plus'], ['/lists', 'shell.menu.lists', 'list'], ['/history', 'shell.menu.history', 'calendar']],
  [['/party', 'shell.menu.party', 'users'], ['/vote', 'shell.menu.vote', 'vote'], ['/match', 'shell.menu.match', 'users'], ['/tonight', 'shell.menu.tonight', 'star']],
  [['/calendar', 'shell.menu.calendar', 'calendar'], ['/upcoming', 'shell.menu.upcoming', 'calendar'], ['/requests', 'shell.menu.requests', 'gift'], ['/stats', 'shell.menu.stats', 'bar-chart']],
  [['/settings', 'shell.menu.accountSettings', 'settings'], ['/devices', 'shell.menu.devices', 'monitor'], ['/remote', 'shell.menu.remote', 'tv'], ['/collections', 'shell.menu.collections', 'film']],
];

/** Slim desktop header: everything else sits in the avatar menu, the footer and on /me. */
export const HEADER_TABS: Array<[href: string, label: TKey]> = [['/', 'shell.nav.home'], ['/browse/series', 'shell.nav.series'], ['/browse/movies', 'shell.nav.movies'], ['/new', 'shell.nav.new'], ['/watchlist', 'shell.nav.myList']];

/** The Live-TV entries (spec §11): they join the header and the TV rail only through `liveTabs`, i.e. while `features.livetv` is on. */
export const LIVE_HEADER: [href: string, label: TKey] = ['/live', 'shell.nav.live'];
export const LIVE_RAIL: [href: string, label: TKey, icon: string] = ['/live', 'shell.nav.live', 'tv'];

/** `tabs` with `entry` after *Filme* (last when there is no such entry) while `on`; the input is never changed, an entry already there is not added twice */
export function liveTabs<T extends [string, ...unknown[]]>(tabs: T[], entry: T, on: boolean): T[] {
  if (!on || tabs.some((t) => t[0] === entry[0])) return tabs;
  const at = tabs.findIndex((t) => t[0] === '/browse/movies');
  return at < 0 ? [...tabs, entry] : [...tabs.slice(0, at + 1), entry, ...tabs.slice(at + 1)];
}

/**
 * The label of a nav entry: the new-titles page is "Neu & demnächst" only while a request service gives it a "Demnächst" part
 * (`features.requests`); without one it is just "Neu". Every surface (desktop bar, phone tab bar, TV side bar) asks here.
 */
export const navLabel = (label: TKey, requests: boolean): TKey => (label === 'shell.nav.new' && !requests ? 'shell.nav.newOnly' : label);

/** true when `href` is the current section (Start only on "/") */
export const isTabActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/') || path.startsWith(href + '?'));

/** TV side-bar rail: search, home, series, movies, new, my list (the profile avatar is added by the rail itself) */
export const TV_RAIL: Array<[href: string, label: TKey, icon: string]> = [
  ['/search', 'shell.mobile.search', 'search'], ['/', 'shell.nav.home', 'home'], ['/browse/series', 'shell.nav.series', 'tv'], ['/browse/movies', 'shell.nav.movies', 'film'], ['/new', 'shell.nav.new', 'star'], ['/watchlist', 'shell.nav.myList', 'list'],
];

/** app-level hints in the URL (LG app start, TV preview), not a filter: they do not make a page a drill-down */
const APP_PARAMS = new Set(['ff_app', 'tv']);
/**
 * TV: the page is one of the rail's own destinations (Back opens the rail there). Only the exact path counts and without a
 * filter in the query: a genre page from the home categories row (`/browse/movies?genre=…`) is a drill-down where Back goes back.
 * The Alles / Serien / Filme filter of the new-titles page (`/new?type=series`) is a view of the same page, not a drill-down.
 */
export const isRailTop = (path: string, search: string): boolean =>
  (path === LIVE_RAIL[0] || TV_RAIL.some(([h]) => h === path)) && [...new URLSearchParams(search).keys()].every((k) => APP_PARAMS.has(k) || (path === '/new' && k === 'type'));
