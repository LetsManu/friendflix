// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-season and per-part states for the season picker and the collection sheet, read from the request service's answers
 * (media status 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available; request status 1 pending, 2 approved,
 * 3 declined). Pure functions: the routes in routes/seerr.ts feed them the service's JSON.
 */

/** available > partial > processing > requested > declined > none; only `none` and `declined` can be requested */
export type SeasonState = 'available' | 'partial' | 'processing' | 'requested' | 'declined' | 'none';
export interface SeasonView { number: number; name?: string; episodes?: number; airDate?: string; state: SeasonState }

const RANK: Record<SeasonState, number> = { none: 0, declined: 1, requested: 2, processing: 3, partial: 4, available: 5 };
const seasonNo = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const date = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);

export const seasonRequestable = (s: SeasonState): boolean => s === 'none' || s === 'declined';

/** Every season of a series (TMDB's list plus any the service knows only from its media record), in season order, with its state. */
export function seasonStates(details: unknown): SeasonView[] {
  const d = obj(details) ?? {};
  const out = new Map<number, SeasonView>();
  for (const s of list(d.seasons)) {
    const o = obj(s), n = seasonNo(o?.seasonNumber);
    if (n === null || out.has(n)) continue;
    out.set(n, {
      number: n, ...(typeof o!.name === 'string' && o!.name ? { name: o!.name } : {}),
      ...(typeof o!.episodeCount === 'number' ? { episodes: o!.episodeCount } : {}), ...(date(o!.airDate) ? { airDate: date(o!.airDate) } : {}), state: 'none',
    });
  }
  const raise = (n: number, st: SeasonState) => {
    const cur = out.get(n) ?? { number: n, state: 'none' as SeasonState };
    if (RANK[st] > RANK[cur.state]) cur.state = st;
    out.set(n, cur);
  };
  const info = obj(d.mediaInfo);
  for (const s of list(info?.seasons)) {
    const o = obj(s), n = seasonNo(o?.seasonNumber);
    if (n === null) continue;
    const st = o!.status;
    if (st === 5) raise(n, 'available');
    else if (st === 4) raise(n, 'partial');
    else if (st === 3) raise(n, 'processing');
    else if (st === 2) raise(n, 'requested');
  }
  for (const r of list(info?.requests)) {
    const req = obj(r);
    if (!req) continue;
    for (const s of list(req.seasons)) {
      const o = obj(s), n = seasonNo(o?.seasonNumber);
      if (n === null) continue;
      // a season's own request status wins over its request's (the service declines seasons one by one, too)
      const st = typeof o!.status === 'number' ? o!.status : req.status;
      raise(n, st === 3 ? 'declined' : st === 2 ? 'processing' : 'requested');
    }
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

/** in the library (fully or partly), in progress, asked for, declined, requestable, or not released yet (no date or a later one) */
export type PartState = 'available' | 'processing' | 'requested' | 'declined' | 'none' | 'unreleased';

/** State of one movie from its media record; `today` is YYYY-MM-DD. What the service already has or works on wins over the date. */
export function partState(mediaInfo: unknown, releaseDate: string | undefined, today: string): PartState {
  const m = obj(mediaInfo);
  const reqs = list(m?.requests).map(obj).filter((x): x is Record<string, any> => x !== null);
  const st = m?.status;
  if (st === 5 || st === 4) return 'available';
  if (st === 3 || reqs.some((r) => r.status === 2)) return 'processing';
  if (st === 2 || reqs.some((r) => r.status === 1)) return 'requested';
  const rd = date(releaseDate);
  if (!rd || rd > today) return 'unreleased';
  if (reqs.some((r) => r.status === 3)) return 'declined';
  return 'none';
}
export const partRequestable = (s: PartState): boolean => s === 'none' || s === 'declined';

/** The TMDB collection a movie belongs to (`collection`, or TMDB's own `belongsToCollection`); null without a valid one. */
export function collectionOf(details: unknown): { id: number; name: string } | null {
  const d = obj(details);
  const c = obj(d?.collection) ?? obj(d?.belongsToCollection);
  if (!c || typeof c.id !== 'number' || !Number.isInteger(c.id) || c.id <= 0) return null;
  return { id: c.id, name: typeof c.name === 'string' ? c.name : '' };
}
