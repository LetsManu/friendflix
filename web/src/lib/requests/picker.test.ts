// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import {
  allState, batchSummary, closeSheet, defaultParts, defaultSeasons, partOpen, pickSeasons, registerSheetHost, requestCollection, seasonOpen,
  seasonRanges, sheetRequest, toggleAll, toggleParts, type Part, type Season,
} from './picker';

const S = (number: number, state: Season['state']): Season => ({ number, state });
const NORDLICHT: Season[] = [S(0, 'none'), S(1, 'available'), S(2, 'partial'), S(3, 'requested'), S(4, 'declined'), S(5, 'none'), S(6, 'processing')];
const P = (tmdbId: number, state: Part['state']): Part => ({ tmdbId, title: `Sternwarte 24 #${tmdbId}`, state });

describe('seasons', () => {
  it('only seasons nobody asked for (or that were declined) can be chosen', () => {
    expect(NORDLICHT.filter(seasonOpen).map((s) => s.number)).toEqual([0, 4, 5]);
  });
  it('default: every open regular season, specials off', () => {
    expect([...defaultSeasons(NORDLICHT)]).toEqual([4, 5]);
    expect([...defaultSeasons([S(0, 'none')])]).toEqual([]);
  });
  it('"Alle Staffeln": all / some / none of the open regular seasons; specials do not count', () => {
    expect(allState(NORDLICHT, new Set([4, 5]))).toBe('all');
    expect(allState(NORDLICHT, new Set([4, 5, 0]))).toBe('all');
    expect(allState(NORDLICHT, new Set([5]))).toBe('some');
    expect(allState(NORDLICHT, new Set([0]))).toBe('none');
    expect(allState([S(0, 'none'), S(1, 'available')], new Set())).toBe('none');
  });
  it('the toggle sets or clears the open regular seasons and keeps the specials choice', () => {
    expect([...toggleAll(NORDLICHT, new Set([0]), true)].sort()).toEqual([0, 4, 5]);
    expect([...toggleAll(NORDLICHT, new Set([0, 4, 5]), false)]).toEqual([0]);
    expect([...toggleAll(NORDLICHT, new Set([3]), true)].sort()).toEqual([4, 5]); // a closed season never stays chosen
  });
  it('season lists read as ranges', () => {
    expect(seasonRanges([1])).toBe('1');
    expect(seasonRanges([3, 1, 2, 5, 7, 8])).toBe('1–3, 5, 7–8');
    expect(seasonRanges([2, 2, 3])).toBe('2–3');
    expect(seasonRanges([])).toBe('');
  });
});

describe('collection parts', () => {
  const parts = [P(1, 'available'), P(2, 'none'), P(3, 'requested'), P(4, 'declined'), P(5, 'unreleased'), P(6, 'processing'), P(7, 'none')];
  it('requestable: open or declined; pre-checked: only the open ones', () => {
    expect(parts.filter(partOpen).map((p) => p.tmdbId)).toEqual([2, 4, 7]);
    expect([...defaultParts(parts)]).toEqual([2, 7]);
  });
  it('toggle all: every requestable part on, or none', () => {
    expect([...toggleParts(parts, true)]).toEqual([2, 4, 7]);
    expect([...toggleParts(parts, false)]).toEqual([]);
  });
  it('batch summary counts each outcome', () => {
    expect(batchSummary([{ tmdbId: 1, result: 'requested' }, { tmdbId: 2, result: 'exists' }, { tmdbId: 3, result: 'limit' }, { tmdbId: 4, result: 'limit' }, { tmdbId: 5, result: 'failed' }]))
      .toEqual({ total: 5, requested: 1, exists: 1, limit: 2, failed: 1 });
  });
});

describe('sheet host', () => {
  it('without a host nothing opens: the picker answers null at once', async () => {
    expect(await pickSeasons({ tmdbId: 7001, title: 'Nordlicht' })).toBeNull();
    expect(await requestCollection({ tmdbId: 8001 })).toBeNull();
    expect(get(sheetRequest)).toBeNull();
  });
  it('one sheet at a time; the answer resolves the caller; a second open while one is shown answers null', async () => {
    const off = registerSheetHost();
    const a = pickSeasons({ tmdbId: 7001, title: 'Nordlicht' });
    const req = get(sheetRequest)!;
    expect(req).toMatchObject({ kind: 'seasons', tmdbId: 7001, title: 'Nordlicht' });
    expect(await requestCollection({ tmdbId: 8001, title: 'Sternwarte 24', owned: [8001] })).toBeNull();
    closeSheet({ kind: 'requested' });
    expect(await a).toEqual({ kind: 'requested' });
    expect(get(sheetRequest)).toBeNull();
    const b = requestCollection({ tmdbId: 8001, title: 'Sternwarte 24', owned: [8001] });
    expect(get(sheetRequest)).toMatchObject({ kind: 'collection', tmdbId: 8001, owned: [8001] });
    closeSheet({ requested: [8002] });
    expect(await b).toEqual({ requested: [8002] });
    closeSheet(null); // nothing open: no throw
    // the host goes away while a sheet is open: the caller gets null
    const c = pickSeasons({ tmdbId: 7002, title: 'Hafenkanal' });
    off();
    expect(await c).toBeNull();
    expect(get(sheetRequest)).toBeNull();
  });
});
