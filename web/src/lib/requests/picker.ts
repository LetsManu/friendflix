// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The season picker and the collection sheet: what can be chosen, what starts chosen, and the promise-based way to open them.
 * One <RequestSheetHost/> in the root layout renders the open sheet (lib/requests/RequestSheetHost.svelte); any page asks
 *
 *   const r = await pickSeasons({ tmdbId, title });          // WishResult, or null when the person closed the picker
 *   const c = await requestCollection({ tmdbId, title });    // { requested: tmdbIds }, or null
 *
 * One sheet at a time: a second open while one is shown answers null at once (as does any open without a mounted host).
 */
import { writable, type Readable } from 'svelte/store';
import type { PartResult, WishResult } from './wish';

// ---- seasons ----
/** what the request service and the library say about one season (GET /api/seerr/tv/:id/seasons) */
export type SeasonState = 'available' | 'partial' | 'processing' | 'requested' | 'declined' | 'none';
export interface Season { number: number; name?: string; episodes?: number; airDate?: string; state: SeasonState }

/** a season nobody asked for yet, or one that was declined, can be chosen */
export const seasonOpen = (s: Season): boolean => s.state === 'none' || s.state === 'declined';
const regularOpen = (list: Season[]) => list.filter((s) => s.number > 0 && seasonOpen(s)).map((s) => s.number);

/** starts chosen: every open regular season; the specials (season 0) stay off */
export const defaultSeasons = (list: Season[]): Set<number> => new Set(regularOpen(list));

/** the "Alle Staffeln" switch over the open regular seasons (the specials do not count) */
export function allState(list: Season[], chosen: Set<number>): 'all' | 'some' | 'none' {
  const open = regularOpen(list);
  const n = open.filter((x) => chosen.has(x)).length;
  return n === 0 ? 'none' : n === open.length ? 'all' : 'some';
}

/** the switch: all open regular seasons on or off; the specials keep their choice; a closed season is never left chosen */
export function toggleAll(list: Season[], chosen: Set<number>, on: boolean): Set<number> {
  const open = new Set(list.filter(seasonOpen).map((s) => s.number));
  const next = new Set([...chosen].filter((n) => open.has(n) && n === 0));
  if (on) for (const n of regularOpen(list)) next.add(n);
  return next;
}

/** season numbers as short ranges: [1, 2, 3, 5] -> "1–3, 5" */
export function seasonRanges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(j > i ? `${s[i]}–${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(', ');
}

// ---- collection parts ----
/** in the library, in progress, asked for, declined, requestable, not released yet (GET /api/seerr/movie/:id/collection) */
export type PartState = 'available' | 'processing' | 'requested' | 'declined' | 'none' | 'unreleased';
export interface Part { tmdbId: number; title: string; year?: string; releaseDate?: string; poster?: string; state: PartState }
export interface Collection { id: number; name: string; poster?: string; parts: Part[] }

export const partOpen = (p: Part): boolean => p.state === 'none' || p.state === 'declined';
/** starts checked: every part nobody asked for; a declined part only on purpose (an admin said no to it once) */
export const defaultParts = (parts: Part[]): Set<number> => new Set(parts.filter((p) => p.state === 'none').map((p) => p.tmdbId));
/** "Alle" on: every requestable part; off: none */
export const toggleParts = (parts: Part[], on: boolean): Set<number> => new Set(on ? parts.filter(partOpen).map((p) => p.tmdbId) : []);

export function batchSummary(results: PartResult[]): { total: number; requested: number; exists: number; limit: number; failed: number } {
  const n = (k: PartResult['result']) => results.filter((r) => r.result === k).length;
  return { total: results.length, requested: n('requested'), exists: n('exists'), limit: n('limit'), failed: n('failed') };
}

// ---- the open sheet ----
export interface CollectionOutcome { requested: number[] }
interface Base { id: number; tmdbId: number }
export type SheetRequest =
  | (Base & { kind: 'seasons'; title: string })
  | (Base & { kind: 'collection'; title?: string; owned?: number[] });
type Pending = { req: SheetRequest; resolve: (v: any) => void };

const cur = writable<SheetRequest | null>(null);
let active: Pending | null = null, hosts = 0, seq = 0;

function open<T>(req: Omit<SheetRequest, 'id'>): Promise<T | null> {
  if (!hosts || active) return Promise.resolve(null);
  return new Promise((resolve) => {
    active = { req: { ...req, id: ++seq } as SheetRequest, resolve };
    cur.set(active.req);
  });
}

/** opens the season picker of a series; it makes the wish itself and answers its result (null: closed without a wish) */
export const pickSeasons = (o: { tmdbId: number; title: string }): Promise<WishResult | null> => open<WishResult>({ kind: 'seasons', ...o });
/**
 * opens the collection sheet of the movie's collection; answers the tmdb ids that are now asked for (null: closed at once).
 * `owned`: parts the library already has (the detail page knows them even when the request service does not).
 */
export const requestCollection = (o: { tmdbId: number; title?: string; owned?: number[] }): Promise<CollectionOutcome | null> =>
  open<CollectionOutcome>({ kind: 'collection', ...o });

/** the host's answer for the open sheet (null = closed without a result) */
export function closeSheet(v: WishResult | CollectionOutcome | null): void {
  if (!active) return;
  const a = active;
  active = null;
  cur.set(null);
  a.resolve(v);
}

/** The host registers itself (so the sheets can open); returns the unregister function. */
export function registerSheetHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    if (!hosts) closeSheet(null);
  };
}

export const sheetRequest: Readable<SheetRequest | null> = { subscribe: cur.subscribe };
