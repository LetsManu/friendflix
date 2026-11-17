// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Wishes (requests for titles that are not in the library): the shared state behind every "Wünschen" button of the page - the
 * monthly quota, the titles wished during this visit and the account's own requests - and the one call that makes a wish.
 * The buttons show a wish as made only after the server said yes (never optimistically); a 429 updates the quota for all of them.
 */
import { get, writable } from 'svelte/store';
import { api, ApiError } from '#lib/api';
import type { Quota, WishState } from '#lib/newpage';

/** the monthly quota; null = not loaded (or the call failed): nothing is blocked on a guess */
export const quota = writable<Quota | null>(null);
/** `mediaType:tmdbId` of the titles wished in this visit: every button for the same title agrees */
export const wished = writable<Set<string>>(new Set());
/** one of the account's own requests (GET /api/requests/mine) */
export interface Mine { title: string; mediaType: string; status: string; createdAt: string; tmdbId?: number }
/** the account's own requests; null = not loaded yet */
export const mine = writable<Mine[] | null>(null);

export const wishKey = (mediaType: string, tmdbId: number) => `${mediaType}:${tmdbId}`;

export async function loadQuota(): Promise<void> {
  try {
    const q = await api<{ limit: number | null; used: number; resetsAt: string }>('/api/requests/quota');
    quota.set({ limit: q.limit, used: q.used, resetsAt: q.resetsAt });
  } catch { /* optional: without it no button is blocked */ }
}
export async function loadMine(): Promise<boolean> {
  try { mine.set((await api<{ requests: Mine[] }>('/api/requests/mine')).requests); return true; } catch { return false; }
}

export type WishResult =
  | { kind: 'requested'; seasons?: number[]; collection?: { id: number; name: string } }
  | { kind: 'exists' } | { kind: 'limit'; resetsAt: string } | { kind: 'failed'; disabled?: boolean };

/** a 429 request_limit answer: the quota is used up for every button; returns the reset date */
function limitHit(body: any): string {
  const resetsAt = String(body.resetsAt ?? get(quota)?.resetsAt ?? '');
  quota.update((q) => ({ limit: Number(body.limit ?? q?.limit ?? body.used ?? 0), used: Number(body.used ?? body.limit ?? q?.used ?? 0), resetsAt }));
  return resetsAt;
}
const isDisabled = (e: unknown) => e instanceof ApiError && e.body?.error === 'requests_disabled';

/**
 * POST /api/requests. 409 = somebody (maybe you) asked already: that counts as requested. 429 = the quota is used up.
 * `seasons` (series only): the chosen seasons; the server asks only for the ones still open and says which (`seasons`). A movie's
 * answer names its collection, if it belongs to one (`collection`), so the page can offer the whole series.
 */
export async function submitWish(mediaType: 'movie' | 'tv', tmdbId: number, seasons?: number[]): Promise<WishResult> {
  let r: { seasons?: unknown; collection?: { id?: unknown; name?: unknown } | null } | undefined;
  try {
    r = await api('/api/requests', { method: 'POST', body: { mediaType, tmdbId, ...(seasons ? { seasons } : {}) } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 429 && e.body?.error === 'request_limit') return { kind: 'limit', resetsAt: limitHit(e.body) };
    if (e instanceof ApiError && e.status === 409) { markWished(mediaType, tmdbId); return { kind: 'exists' }; }
    return { kind: 'failed', disabled: isDisabled(e) };
  }
  markWished(mediaType, tmdbId);
  quota.update((q) => (q ? { ...q, used: q.used + 1 } : q));
  void loadMine();
  const sent = Array.isArray(r?.seasons) ? r.seasons.filter((n): n is number => Number.isInteger(n)) : undefined;
  const col = r?.collection && typeof r.collection.id === 'number' ? { id: r.collection.id, name: String(r.collection.name ?? '') } : undefined;
  return { kind: 'requested', ...(sent ? { seasons: sent } : {}), ...(col ? { collection: col } : {}) };
}

/** one part's outcome of POST /api/requests/batch */
/** `skipped`: not sent (the server's time budget ran out, or the service stopped answering): can be tried again */
export interface PartResult { tmdbId: number; result: 'requested' | 'exists' | 'limit' | 'failed' | 'skipped' }
export type BatchResult = { kind: 'done'; results: PartResult[]; resetsAt: string } | { kind: 'failed'; disabled?: boolean };

/**
 * POST /api/requests/batch: the chosen parts of a collection as single movie wishes (the server goes one by one and stops at the
 * quota). Requested and already asked parts count as wished; the quota is taken from the answer. `collectionId` lets the server
 * drop its cached copy of the collection, so the next look shows the new states.
 */
export async function submitBatch(tmdbIds: number[], collectionId?: number): Promise<BatchResult> {
  let r: { results?: PartResult[]; quota?: { limit: number | null; used: number; resetsAt: string } };
  try {
    r = await api('/api/requests/batch', { method: 'POST', body: { items: tmdbIds.map((tmdbId) => ({ mediaType: 'movie', tmdbId })), ...(collectionId ? { collectionId } : {}) } });
  } catch (e) {
    return { kind: 'failed', disabled: isDisabled(e) };
  }
  const results = Array.isArray(r?.results) ? r.results : [];
  for (const x of results) if (x.result === 'requested' || x.result === 'exists') markWished('movie', x.tmdbId);
  if (r?.quota) quota.set({ limit: r.quota.limit, used: r.quota.used, resetsAt: r.quota.resetsAt });
  if (results.some((x) => x.result === 'requested')) void loadMine();
  return { kind: 'done', results, resetsAt: get(quota)?.resetsAt ?? '' };
}
function markWished(mediaType: string, tmdbId: number) {
  wished.update((s) => new Set(s).add(wishKey(mediaType, tmdbId)));
}

// ---- what the button shows ----
export type WishView = 'none' | 'pending' | 'requested' | 'processing' | 'available' | 'exhausted' | 'error';
/**
 * The state of one button. In flight beats everything; a title wished in this visit counts as requested; otherwise the server's
 * state wins; only a title that can still be wished is blocked by a used-up quota or shows the last failure.
 */
export function wishView(o: { server: WishState; local: 'idle' | 'pending' | 'error'; wished: boolean; exhausted: boolean }): WishView {
  if (o.local === 'pending') return 'pending';
  if (o.wished) return 'requested';
  if (o.server !== 'none') return o.server;
  if (o.exhausted) return 'exhausted';
  return o.local === 'error' ? 'error' : 'none';
}
