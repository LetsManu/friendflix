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

export type WishResult = { kind: 'requested' } | { kind: 'exists' } | { kind: 'limit'; resetsAt: string } | { kind: 'failed'; disabled?: boolean };

/** POST /api/requests. 409 = somebody (maybe you) asked already: that counts as requested. 429 = the quota is used up. */
export async function submitWish(mediaType: 'movie' | 'tv', tmdbId: number): Promise<WishResult> {
  try {
    await api('/api/requests', { method: 'POST', body: { mediaType, tmdbId } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 429 && e.body?.error === 'request_limit') {
      const resetsAt = String(e.body.resetsAt ?? get(quota)?.resetsAt ?? '');
      quota.update((q) => ({ limit: Number(e.body.limit ?? q?.limit ?? e.body.used ?? 0), used: Number(e.body.used ?? e.body.limit ?? q?.used ?? 0), resetsAt }));
      return { kind: 'limit', resetsAt };
    }
    if (e instanceof ApiError && e.status === 409) { markWished(mediaType, tmdbId); return { kind: 'exists' }; }
    return { kind: 'failed', disabled: e instanceof ApiError && e.body?.error === 'requests_disabled' };
  }
  markWished(mediaType, tmdbId);
  quota.update((q) => (q ? { ...q, used: q.used + 1 } : q));
  void loadMine();
  return { kind: 'requested' };
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
