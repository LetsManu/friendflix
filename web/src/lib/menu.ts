/** Link groups of the account menu: used by the desktop dropdown and the /me page. */
export type MenuLink = [href: string, label: string, icon: string];

export const MENU_LINKS: MenuLink[] = [
  ['/tonight', 'Heute Abend', 'star'], ['/favorites', 'Favoriten', 'heart'], ['/lists', 'Listen', 'list'], ['/history', 'Verlauf', 'calendar'], ['/match', 'Gruppen-Matcher', 'users'], ['/collections', 'Sammlungen', 'film'], ['/upcoming', 'Demnächst', 'calendar'], ['/requests', 'Wünsche', 'gift'], ['/party', 'Watch-Party', 'users'], ['/vote', 'Filmabend', 'vote'],
  ['/now', 'Läuft gerade', 'monitor'], ['/calendar', 'Kalender', 'calendar'], ['/stats', 'Wrapped', 'bar-chart'], ['/remote', 'Fernbedienung', 'tv'], ['/settings', 'Einstellungen', 'settings'], ['/devices', 'Geräte', 'monitor'],
];
export const DOWNLOADS_LINK: MenuLink = ['/downloads', 'Downloads', 'download'];

export const GROUPS: Array<{ title: string; hrefs: string[] }> = [
  { title: 'Entdecken', hrefs: ['/tonight', '/collections', '/upcoming', '/match', '/party', '/vote', '/now', '/calendar'] },
  { title: 'Meine Sachen', hrefs: ['/favorites', '/lists', '/history', '/downloads', '/requests', '/stats'] },
  { title: 'Konto & Einstellungen', hrefs: ['/remote', '/settings', '/devices'] },
];

/** links for a user (Downloads only when allowed, placed after "Verlauf"/the first three) */
export const linksFor = (canDownload: boolean): MenuLink[] => (canDownload ? [...MENU_LINKS.slice(0, 3), DOWNLOADS_LINK, ...MENU_LINKS.slice(3)] : MENU_LINKS);

/** every entry lands in exactly one group (unknown ones fall back to "Meine Sachen"), ordered as in GROUPS */
export function groupLinks(links: MenuLink[]): Array<{ title: string; items: MenuLink[] }> {
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
  [['/me', 'Mein FriendFlix', 'user'], ['/watchlist', 'Meine Liste', 'plus'], ['/lists', 'Listen', 'list'], ['/history', 'Verlauf', 'calendar']],
  [['/party', 'Watch-Party', 'users'], ['/vote', 'Filmabend', 'vote'], ['/match', 'Gruppen-Matcher', 'users'], ['/tonight', 'Heute Abend', 'star']],
  [['/calendar', 'Kalender', 'calendar'], ['/upcoming', 'Demnächst', 'calendar'], ['/requests', 'Wünsche', 'gift'], ['/stats', 'Wrapped', 'bar-chart']],
  [['/settings', 'Konto & Einstellungen', 'settings'], ['/devices', 'Geräte', 'monitor'], ['/remote', 'Fernbedienung', 'tv'], ['/collections', 'Sammlungen', 'film']],
];

/** Slim desktop header (Netflix-like): everything else sits in the avatar menu, the footer and on /me. */
export const HEADER_TABS: Array<[href: string, label: string]> = [['/', 'Start'], ['/browse/series', 'Serien'], ['/browse/movies', 'Filme'], ['/new', 'Neu & beliebt'], ['/watchlist', 'Meine Liste']];

/** true when `href` is the current section (Start only on "/") */
export const isTabActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/') || path.startsWith(href + '?'));
