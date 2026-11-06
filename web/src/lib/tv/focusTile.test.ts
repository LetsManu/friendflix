// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '#lib/api';
import { setLocale, tr } from '#lib/i18n';
import { reasonText } from '#lib/reason';
import { createSettle, tileInfo, trailerAllowed, TILE_DELAY_MS, TILE_TRAILER_MS } from './focusTile';

const mk = (o: Partial<Item>) => ({ id: '1', name: 'X', type: 'Movie', genres: [], image: false, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0, ...o }) as Item;

describe('createSettle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('constants', () => { expect(TILE_DELAY_MS).toBe(300); expect(TILE_TRAILER_MS).toBe(1500); });
  it('fires once with the last value after the delay', () => {
    const fn = vi.fn();
    const s = createSettle<string>(300, fn);
    s.push('a'); vi.advanceTimersByTime(200);
    s.push('b'); vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });
  it('the same value pushed again does not restart the timer', () => {
    const fn = vi.fn();
    const s = createSettle<string>(300, fn);
    s.push('a'); vi.advanceTimersByTime(200);
    s.push('a'); vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('a');
  });
  it('cancel drops the pending value', () => {
    const fn = vi.fn();
    const s = createSettle<string>(300, fn);
    s.push('a'); s.cancel(); vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('tileInfo', () => {
  it('bare movie', async () => {
    await setLocale('en');
    expect(tileInfo(mk({}), tr)).toEqual({ title: 'X', logoId: null, backdropId: null, meta: [], synopsis: '', labels: [], reason: '', resume: '' });
  });
  it('series with year, seasons, rating and reason', async () => {
    await setLocale('en');
    const reason = { seed: { id: 'y', name: 'Y' }, traits: [] };
    const i = tileInfo(mk({ type: 'Series', year: 2024, childCount: 2, rating: 'FSK 12', reason, logo: true, backdrop: true, overview: 'Hi' }), tr);
    expect(i.meta).toEqual(['2024', tr('home.meta.seasons', { n: 2 }), 'FSK 12']);
    expect(i.reason).toBe(reasonText(reason, tr));
    expect(i.logoId).toBe('1'); expect(i.backdropId).toBe('1'); expect(i.synopsis).toBe('Hi');
  });
  it('genre first, movie length', async () => {
    await setLocale('en');
    expect(tileInfo(mk({ genres: ['Drama', 'War'], year: 2020, runtimeTicks: 95 * 600_000_000 }), tr).meta).toEqual(['Drama', '2020', tr('common.duration.hm', { h: 1, m: 35 })]);
  });
  it('continue-watching episode shows S/E and minutes left', async () => {
    await setLocale('en');
    const i = tileInfo(mk({ type: 'Episode', parentIndexNumber: 2, indexNumber: 4, runtimeTicks: 53 * 600_000_000, positionTicks: 30 * 600_000_000 }), tr);
    expect(i.resume).toBe(`${tr('detail.view.episodeCode', { s: '2', e: '4' })} · ${tr('detail.format.remaining', { d: tr('common.duration.m', { m: 23 }) })}`);
  });
  it('fresh badge becomes a label', async () => {
    await setLocale('en');
    expect(tileInfo(mk({}), tr, { fresh: 'new' }).labels).toEqual([tr('fresh.label.new')]);
  });
});

describe('trailerAllowed', () => {
  const ok = { hoverTrailers: true, autoplay: true, hidden: false, saveData: false };
  it('allows when everything permits', () => expect(trailerAllowed(ok)).toBe(true));
  it('hidden tab, save-data, pref off and calm/reduced motion block it', () => {
    expect(trailerAllowed({ ...ok, hidden: true })).toBe(false);
    expect(trailerAllowed({ ...ok, saveData: true })).toBe(false);
    expect(trailerAllowed({ ...ok, hoverTrailers: false })).toBe(false);
    expect(trailerAllowed({ ...ok, autoplay: false })).toBe(false);
  });
});
