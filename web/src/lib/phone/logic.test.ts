// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Item } from '#lib/api';
import { carouselPicks, chipsTucked, phoneTabs, swipeTarget } from './logic';

const it_ = (id: string, image = true): Item => ({ id, name: id, type: 'Movie', image }) as unknown as Item;
const ids = (l: Item[]) => l.map((i) => i.id);
const none = () => null;

describe('carouselPicks', () => {
  it('puts the hero first', () => {
    expect(ids(carouselPicks({ hero: it_('h'), candidates: [it_('a')], fresh: none }))).toEqual(['h', 'a']);
  });
  it('puts fresh-labelled before others', () => {
    const r = carouselPicks({ hero: it_('h'), candidates: [it_('a'), it_('b'), it_('c')], fresh: (id) => (id === 'c' ? 'new' : null) });
    expect(ids(r)).toEqual(['h', 'c', 'a', 'b']);
  });
  it('dedupes the hero in candidates', () => {
    expect(ids(carouselPicks({ hero: it_('h'), candidates: [it_('h'), it_('a')], fresh: none }))).toEqual(['h', 'a']);
  });
  it('caps at 5', () => {
    const c = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((i) => it_(i));
    expect(carouselPicks({ hero: it_('h'), candidates: c, fresh: none })).toHaveLength(5);
  });
  it('skips items without a poster', () => {
    expect(ids(carouselPicks({ hero: it_('h', false), candidates: [it_('a', false), it_('b')], fresh: none }))).toEqual(['b']);
  });
  it('returns [] with no hero and no candidates', () => {
    expect(carouselPicks({ hero: null, candidates: [], fresh: none })).toEqual([]);
  });
});

describe('swipeTarget', () => {
  it('goes next on a left swipe', () => expect(swipeTarget({ index: 1, count: 4, dx: -60, vx: 0 })).toBe(2));
  it('goes back on a right swipe', () => expect(swipeTarget({ index: 1, count: 4, dx: 60, vx: 0 })).toBe(0));
  it('goes next on a left flick', () => expect(swipeTarget({ index: 1, count: 4, dx: -20, vx: -0.8 })).toBe(2));
  it('stays on a short slow drag', () => expect(swipeTarget({ index: 1, count: 4, dx: -20, vx: 0 })).toBe(1));
  it('clamps at the ends', () => {
    expect(swipeTarget({ index: 0, count: 4, dx: 60, vx: 0 })).toBe(0);
    expect(swipeTarget({ index: 3, count: 4, dx: -60, vx: 0 })).toBe(3);
  });
});

describe('chipsTucked', () => {
  it('never tucks near the top', () => expect(chipsTucked({ y: 50, lastY: 0, tucked: true })).toBe(false));
  it('tucks when scrolling down', () => expect(chipsTucked({ y: 200, lastY: 100, tucked: false })).toBe(true));
  it('shows when scrolling up', () => expect(chipsTucked({ y: 150, lastY: 200, tucked: true })).toBe(false));
  it('keeps state on jitter', () => expect(chipsTucked({ y: 200, lastY: 202, tucked: true })).toBe(true));
});

describe('phoneTabs', () => {
  it('has four tabs with downloads', () => {
    expect(phoneTabs(true).map((t) => t.href)).toEqual(['/', '/new', '/watchlist', '/downloads']);
  });
  it('has three tabs without', () => {
    expect(phoneTabs(false).map((t) => t.href)).toEqual(['/', '/new', '/watchlist']);
  });
});
