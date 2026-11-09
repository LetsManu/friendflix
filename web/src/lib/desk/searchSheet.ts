// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The desktop search sheet (glass spec §2): what it shows for a query (the sheet model), the matched letters of a title, the
 * cascade's key and timing (§8.6) and the keyboard order of its hits. Pure functions; SearchSheet.svelte renders them.
 */
import type { Item } from '#lib/api';

/** a person hit of /api/search */
export interface Person { id: string; name: string; image: boolean }
/** GET /api/search?q= (also the /search page's result) */
export interface SearchResult { q: string; titles: Item[]; episodes: Item[]; people: Person[]; genres: string[]; partial: boolean }

export const TOP_N = 3;
export const POSTER_N = 6;
export const PEOPLE_N = 4;
export const GENRE_N = 8;
/** below this many characters the sheet shows its idle content (recent, popular, genres) */
export const MIN_Q = 2;

/**
 * The matched letters' colour: the brand coral lightened (mixed toward white) until it passes AA (4.5:1) on the sheet's
 * selected row (--fr-sel, white at .13) where the sheet sits over the dimmed page at the ambient background's brightest point;
 * plain coral (#ff4f6d) gives about 3:1 there. Accessibility over the mockup's exact colour (controller ruling).
 */
export const MARK_RGB: [number, number, number] = [255, 195, 205];
export const MARK_CSS = `rgb(${MARK_RGB.join(', ')})`;
/** the page dim behind the sheet (app.css .frost-dim) and the selected row's light (--fr-sel): for the contrast check */
export const DIM_RGB: [number, number, number] = [8, 7, 11];
export const DIM_A = 0.45;
export const SEL_A = 0.13;

/** a part of a title: `m` = matched letters (drawn in MARK_RGB) */
export type Mark = { t: string; m: boolean };

/** case- and accent-insensitive form of a string (NFD, marks stripped, lower case) */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** splits `text` around the first case- and accent-insensitive match of `q` (at most three parts) */
export function marks(text: string, q: string): Mark[] {
  const needle = fold(q.trim());
  if (!needle) return [{ t: text, m: false }];
  // the folded text with, for each of its characters, where the original character starts and ends
  let folded = '';
  const from: number[] = [], to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + ch.length); }
    folded += f;
    i += ch.length;
  }
  const at = folded.indexOf(needle);
  if (at < 0) return [{ t: text, m: false }];
  const a = from[at]!, b = to[at + needle.length - 1]!;
  const out: Mark[] = [];
  if (a > 0) out.push({ t: text.slice(0, a), m: false });
  out.push({ t: text.slice(a, b), m: true });
  if (b < text.length) out.push({ t: text.slice(b), m: false });
  return out;
}

export type SheetModel =
  | { kind: 'idle'; recent: string[]; popular: Item[]; genres: string[] }
  | { kind: 'results'; top: Item[]; people: Person[]; posters: Item[]; genres: string[]; empty: boolean };

/** what the sheet shows: the idle content until there are two characters and an answer, else the results */
export function sheetModel(q: string, r: SearchResult | null, idle: { recent: string[]; popular: Item[]; genres: string[] }): SheetModel {
  if (q.trim().length < MIN_Q || r === null) return { kind: 'idle', recent: idle.recent, popular: idle.popular.slice(0, POSTER_N), genres: idle.genres.slice(0, GENRE_N) };
  const top = [...r.titles, ...r.episodes].slice(0, TOP_N);
  const posters = r.titles.slice(0, POSTER_N);
  const people = r.people.slice(0, PEOPLE_N);
  const genres = r.genres.slice(0, GENRE_N);
  return { kind: 'results', top, people, posters, genres, empty: !top.length && !posters.length && !people.length && !genres.length };
}

/** the cascade (§8.6): each item's length and the gap between two items */
export const CASCADE_MS = 320;
export const CASCADE_GAP = 45;

/** what the sheet shows, as one string: the cascade runs only when it changes */
export function cascadeKey(m: SheetModel): string {
  const ids = (l: Array<{ id: string }>) => l.map((x) => x.id).join(',');
  if (m.kind === 'idle') return ['idle', m.recent.join(','), ids(m.popular), m.genres.join(',')].join('|');
  return ['results', ids(m.top), ids(m.people), ids(m.posters), m.genres.join(','), m.empty ? 'empty' : ''].join('|');
}

/** the keyboard order of the sheet's hits: the top results, then All results (only with results) */
export function hitIds(m: SheetModel): string[] {
  if (m.kind !== 'results' || m.empty) return [];
  return [...m.top.map((_, i) => `ds-hit-${i}`), 'ds-all'];
}

/** ↓ (dir 1) / ↑ (dir −1) from the active id, wrapping around; null when there is nothing to move to */
export function nextId(ids: string[], cur: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = cur === null ? -1 : ids.indexOf(cur);
  if (i < 0) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + dir + ids.length) % ids.length]!;
}
