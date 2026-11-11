// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasKey } from '#lib/i18n';
import { SUGGEST_FIELDS, loadSuggestStats, suggestHint, type SuggestStats } from './suggestions';

const stats = (over: Partial<SuggestStats> = {}): SuggestStats => ({ anchors: 5, seeds: 8, seedsWithoutTmdb: 1, seedsFoundByName: 1, recommendations: 40, inLibrary: 10, inLibraryByTvdb: 2, lookupFailures: 0, seedSearchFailures: 0, ageFiltered: 3, final: 27, ...over });
afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('suggestHint', () => {
  it('says nothing for a healthy build', () => expect(suggestHint(stats())).toBeNull());
  it('no seeds beats everything', () => expect(suggestHint(stats({ seeds: 0, recommendations: 0 }))).toBe('noSeeds'));
  it('nearly all recommendations already in the library', () => {
    expect(suggestHint(stats({ recommendations: 40, inLibrary: 38 }))).toBe('inLibrary');
    expect(suggestHint(stats({ recommendations: 40, inLibrary: 40 }))).toBe('inLibrary');
    expect(suggestHint(stats({ recommendations: 40, inLibrary: 30 }))).toBeNull();
  });
  it('no recommendations at all is not "everything is in the library"', () => expect(suggestHint(stats({ recommendations: 0, inLibrary: 0 }))).toBeNull());
});

describe('loadSuggestStats', () => {
  it('returns the counts of the admin', async () => {
    answer(200, { items: [], quota: null, debug: stats() });
    await expect(loadSuggestStats('series')).resolves.toEqual({ state: 'ok', stats: stats() });
    expect(String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe('/api/library/request-suggestions?type=series');
  });
  it('no debug (not the owner profile) or a kids profile: owner', async () => {
    answer(200, { items: [], quota: null });
    await expect(loadSuggestStats('movie')).resolves.toEqual({ state: 'owner' });
    answer(403, { error: 'kids_profile' });
    await expect(loadSuggestStats('movie')).resolves.toEqual({ state: 'owner' });
  });
  it('no request service: off; anything else: failed', async () => {
    answer(404, { error: 'requests_disabled' });
    await expect(loadSuggestStats('movie')).resolves.toEqual({ state: 'off' });
    answer(500, { error: 'boom' });
    await expect(loadSuggestStats('movie')).resolves.toEqual({ state: 'failed' });
  });
});

describe('texts', () => {
  it('every row and hint has a text', () => {
    for (const k of SUGGEST_FIELDS) expect(hasKey(`adminContent.status.sug.f.${k}`), k).toBe(true);
    for (const k of ['title', 'intro', 'owner', 'off', 'failed', 'hint.inLibrary', 'hint.noSeeds']) expect(hasKey(`adminContent.status.sug.${k}`), k).toBe(true);
  });
});
