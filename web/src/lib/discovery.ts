/** Pure helpers for browse / search discovery (URL state, API query, removable filter chips, recent searches). */

export const SORTS = ['SortName', 'DateCreated', 'PremiereDate', 'CommunityRating'] as const;
export const FILTERS = ['', 'unplayed', 'played', 'favorites'] as const;
export const RATINGS = [6, 7, 8] as const;
const DESC_SORTS = new Set<string>(['DateCreated', 'CommunityRating', 'PremiereDate']);

export interface BrowseState {
  genre: string;
  studio: string;
  sort: (typeof SORTS)[number];
  filter: (typeof FILTERS)[number];
  decade: number | null;
  year: number | null;
  minRating: number | null;
  person: string | null;
}

const intOf = (v: string | null): number | null => (v !== null && /^\d{1,4}$/.test(v.trim()) ? Number(v) : null);

export function isYear(q: string): boolean {
  const t = q.trim();
  return /^\d{4}$/.test(t) && Number(t) >= 1900 && Number(t) <= 2100;
}

export function parseBrowse(sp: Pick<URLSearchParams, 'get'>): BrowseState {
  const sort = sp.get('sort') ?? '';
  const filter = sp.get('filter') ?? '';
  const y = intOf(sp.get('year'));
  const year = y !== null && y >= 1900 && y <= 2100 ? y : null;
  const d = intOf(sp.get('decade'));
  const decade = year === null && d !== null && d % 10 === 0 && d >= 1900 && d <= 2090 ? d : null; // a year wins over a decade
  const r = Number(sp.get('minRating'));
  const person = (sp.get('person') ?? '').trim().toLowerCase();
  return {
    genre: (sp.get('genre') ?? '').trim(),
    studio: (sp.get('studio') ?? '').trim(),
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as BrowseState['sort']) : 'SortName',
    filter: (FILTERS as readonly string[]).includes(filter) ? (filter as BrowseState['filter']) : '',
    decade,
    year,
    minRating: (RATINGS as readonly number[]).includes(r) ? r : null,
    person: /^[0-9a-f]{32}$/.test(person) ? person : null,
  };
}

/** Query string for GET /api/library/items. */
export function browseQuery(s: BrowseState, kind: string, start: number, limit: number): URLSearchParams {
  const p = new URLSearchParams({ types: kind, sort: s.sort, limit: String(limit), start: String(start) });
  if (DESC_SORTS.has(s.sort)) p.set('desc', 'true');
  if (s.genre) p.set('genre', s.genre);
  if (s.studio) p.set('studio', s.studio);
  if (s.filter) p.set('filter', s.filter);
  if (s.year !== null) p.set('year', String(s.year));
  else if (s.decade !== null) p.set('decade', String(s.decade));
  if (s.minRating !== null) p.set('minRating', String(s.minRating));
  if (s.person) p.set('person', s.person);
  return p;
}

const FILTER_LABEL: Record<string, string> = { unplayed: 'Ungesehen', played: 'Gesehen', favorites: 'Favoriten' };

/** Removable filter chips; `key` is the URL parameter to drop. `labels.person` overrides the person label. */
export function activeChips(s: BrowseState, labels: { person?: string } = {}): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  if (s.genre) out.push({ key: 'genre', label: s.genre });
  if (s.studio) out.push({ key: 'studio', label: s.studio });
  if (s.year !== null) out.push({ key: 'year', label: String(s.year) });
  if (s.decade !== null) out.push({ key: 'decade', label: `${s.decade}er` });
  if (s.minRating !== null) out.push({ key: 'minRating', label: `ab ${s.minRating} Sterne` });
  if (s.person) out.push({ key: 'person', label: labels.person || 'Person' });
  if (s.filter) out.push({ key: 'filter', label: FILTER_LABEL[s.filter] ?? s.filter });
  return out;
}

// ---- recent searches (per browser; storage may be unavailable) ----
const RECENT_KEY = 'ff-recent-search';
const RECENT_MAX = 8;
/** Per-profile key; without a known profile id nothing is read or stored (a kid profile must not see an adult's searches). */
const recentKey = (profileId: string | null | undefined): string | null => (profileId ? `${RECENT_KEY}:${profileId}` : null);

export function loadRecent(profileId: string | null | undefined): string[] {
  const key = recentKey(profileId);
  if (!key) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function pushRecent(profileId: string | null | undefined, q: string): string[] {
  const key = recentKey(profileId);
  const t = q.trim();
  if (!key || t.length < 2) return loadRecent(profileId);
  const next = [t, ...loadRecent(profileId).filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

export function clearRecent(profileId: string | null | undefined): void {
  const key = recentKey(profileId);
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}
