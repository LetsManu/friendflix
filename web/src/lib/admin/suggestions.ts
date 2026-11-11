// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Status, card "Suggestions (not here yet)": the counts behind the request suggestions (`debug` of
 * GET /api/library/request-suggestions, only sent to the admin on the owner profile). Numbers only, no titles or ids.
 */
import { api, ApiError } from '#lib/api';

export type SuggestType = 'movie' | 'series';
/** mirror of `SuggestStats` in backend/src/requestSuggestions.ts; the order is the order of the rows */
export const SUGGEST_FIELDS = ['anchors', 'seeds', 'seedsWithoutTmdb', 'seedsFoundByName', 'recommendations', 'inLibrary', 'inLibraryByTvdb', 'lookupFailures', 'seedSearchFailures', 'ageFiltered', 'final'] as const;
export type SuggestField = (typeof SUGGEST_FIELDS)[number];
export type SuggestStats = Record<SuggestField, number>;
/** `none`: no build in the cache yet; `owner`: no counts for this profile (only the admin's owner profile gets them); `off`: no request service; `failed`: the request failed */
export type SuggestResult = { state: 'ok'; stats: SuggestStats } | { state: 'none' | 'owner' | 'off' | 'failed' };

const isStats = (d: unknown): d is SuggestStats => !!d && typeof d === 'object' && SUGGEST_FIELDS.every((k) => typeof (d as Record<string, unknown>)[k] === 'number');

/** `cached`: only what the last build left in the cache (never starts one); `build`: builds the list when it is not cached (slow when cold) */
export async function loadSuggestStats(type: SuggestType, mode: 'cached' | 'build' = 'cached'): Promise<SuggestResult> {
  try {
    const r = await api<{ debug?: unknown }>(`/api/library/request-suggestions?type=${type}${mode === 'cached' ? '&debug=cached' : ''}`);
    if (isStats(r?.debug)) return { state: 'ok', stats: r.debug };
    return mode === 'cached' && r?.debug === null ? { state: 'none' } : { state: 'owner' };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { state: 'off' };
    if (e instanceof ApiError && e.status === 403) return { state: 'owner' }; // a kids profile
    return { state: 'failed' };
  }
}

/** "inLibrary": nearly everything TMDB recommended is already here (nothing left to suggest); "noSeeds": nothing to start from */
export type SuggestHint = 'inLibrary' | 'noSeeds' | null;
export function suggestHint(s: SuggestStats): SuggestHint {
  if (s.seeds === 0) return 'noSeeds';
  if (s.recommendations > 0 && s.inLibrary >= s.recommendations * 0.9) return 'inLibrary';
  return null;
}
