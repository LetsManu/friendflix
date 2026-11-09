// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Item } from '#lib/api';
import { AMB_PEAK, contrast, DARK_BASE, frostComposite, SCRIM_SAFE, type RGB } from '#lib/glass/tone';
import { cascadeKey, DIM_A, DIM_RGB, GENRE_N, hitIds, MARK_CSS, MARK_RGB, marks, nextId, PEOPLE_N, POSTER_N, SEL_A, sheetModel, TOP_N, type Person, type SearchResult } from './searchSheet';

const item = (id: string, type = 'Movie'): Item => ({ id, name: `T${id}`, type, genres: [], image: true, backdrop: true, logo: false, played: false, favorite: false, positionTicks: 0 });
const items = (n: number, p: string, type?: string) => Array.from({ length: n }, (_, i) => item(`${p}${i}`, type));
const people = (n: number): Person[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, image: false }));
const res = (o: Partial<SearchResult> = {}): SearchResult => ({ q: 'har', titles: [], episodes: [], people: [], genres: [], partial: false, ...o });
const idle = { recent: ['nolan', 'dahl'], popular: items(9, 'pop'), genres: Array.from({ length: 12 }, (_, i) => `G${i}`) };

describe('marks', () => {
  it('highlights the first case- and accent-insensitive match', () => {
    expect(marks('Harbour Lights', 'har')).toEqual([{ t: 'Har', m: true }, { t: 'bour Lights', m: false }]);
    expect(marks('Der Bär', 'bar')).toEqual([{ t: 'Der ', m: false }, { t: 'Bär', m: true }]);
    expect(marks('X', '')).toEqual([{ t: 'X', m: false }]);
    expect(marks('X', '   ')).toEqual([{ t: 'X', m: false }]);
    expect(marks('Inkwell', 'zz')).toEqual([{ t: 'Inkwell', m: false }]);
  });
  it('marks a match in the middle, at the end and of the whole text; the query is trimmed and folded too', () => {
    expect(marks('The Harvest Room', ' HAR ')).toEqual([{ t: 'The ', m: false }, { t: 'Har', m: true }, { t: 'vest Room', m: false }]);
    expect(marks('Pulse Harbor', 'harbor')).toEqual([{ t: 'Pulse ', m: false }, { t: 'Harbor', m: true }]);
    expect(marks('Café', 'cafe')).toEqual([{ t: 'Café', m: true }]);
    expect(marks('Cafe', 'café')).toEqual([{ t: 'Cafe', m: true }]);
  });
  it('maps decomposed text and characters outside the BMP back to their original indices', () => {
    const dec = 'Ba\u0308r'; // "Bär" with a combining diaeresis
    expect(marks(`x ${dec}`, 'bar')).toEqual([{ t: 'x ', m: false }, { t: dec, m: true }]);
    expect(marks('🎬 Har', 'har')).toEqual([{ t: '🎬 ', m: false }, { t: 'Har', m: true }]);
  });
});

describe('sheetModel', () => {
  it('idle below two characters and before results', () => {
    const r = res({ titles: items(2, 't') });
    for (const m of [sheetModel('', r, idle), sheetModel('h ', r, idle), sheetModel('har', null, idle)]) {
      expect(m.kind).toBe('idle');
      if (m.kind !== 'idle') continue;
      expect(m.recent).toEqual(['nolan', 'dahl']);
      expect(m.popular.map((i) => i.id)).toEqual(idle.popular.slice(0, POSTER_N).map((i) => i.id));
      expect(m.genres).toHaveLength(GENRE_N);
    }
  });
  it('results: top 3 of titles then episodes, 6 posters, 4 people, 8 genres', () => {
    const m = sheetModel('har', res({ titles: items(2, 't'), episodes: items(4, 'e', 'Episode'), people: people(7), genres: idle.genres }), idle);
    expect(m.kind).toBe('results');
    if (m.kind !== 'results') return;
    expect(m.top.map((i) => i.id)).toEqual(['t0', 't1', 'e0']);
    expect(m.top).toHaveLength(TOP_N);
    expect(m.posters.map((i) => i.id)).toEqual(['t0', 't1']);
    expect(m.people).toHaveLength(PEOPLE_N);
    expect(m.genres).toHaveLength(GENRE_N);
    expect(m.empty).toBe(false);
    const many = sheetModel('har', res({ titles: items(10, 't') }), idle);
    expect(many.kind === 'results' && many.posters.length).toBe(POSTER_N);
    expect(many.kind === 'results' && many.top.map((i) => i.id)).toEqual(['t0', 't1', 't2']);
  });
  it('empty', () => {
    const m = sheetModel('zzz', res(), idle);
    expect(m).toEqual({ kind: 'results', top: [], people: [], posters: [], genres: [], empty: true });
    expect(sheetModel('dra', res({ genres: ['Drama'] }), idle)).toMatchObject({ empty: false });
    expect(sheetModel('nol', res({ people: people(1) }), idle)).toMatchObject({ empty: false });
  });
});

describe('cascadeKey', () => {
  it('changes only with what is shown', () => {
    const a = sheetModel('har', res({ titles: items(2, 't'), people: people(1) }), idle);
    // a longer query with the same answer: the same key (no new cascade)
    expect(cascadeKey(sheetModel('harb', res({ titles: items(2, 't'), people: people(1) }), idle))).toBe(cascadeKey(a));
    // what the API returns beyond what is shown does not count either
    expect(cascadeKey(sheetModel('har', res({ titles: items(2, 't'), people: [...people(1)], partial: true }), idle))).toBe(cascadeKey(a));
    expect(cascadeKey(sheetModel('har', res({ titles: items(3, 't'), people: people(1) }), idle))).not.toBe(cascadeKey(a));
    expect(cascadeKey(sheetModel('har', res({ titles: items(2, 't'), people: people(2) }), idle))).not.toBe(cascadeKey(a));
    expect(cascadeKey(sheetModel('har', res({ titles: items(2, 't'), people: people(1), genres: ['Drama'] }), idle))).not.toBe(cascadeKey(a));
    // idle: the same for any short query; a change in the recent searches is a change
    const i0 = cascadeKey(sheetModel('', null, idle));
    expect(cascadeKey(sheetModel('h', null, idle))).toBe(i0);
    expect(cascadeKey(sheetModel('', null, { ...idle, recent: ['x'] }))).not.toBe(i0);
    expect(i0).not.toBe(cascadeKey(a));
    expect(cascadeKey(sheetModel('zzz', res(), idle))).toBe(cascadeKey(sheetModel('zz', res(), idle)));
  });
});

describe('keyboard order', () => {
  it('hitIds: the top results, then All results; nothing when idle or empty', () => {
    expect(hitIds(sheetModel('har', res({ titles: items(2, 't') }), idle))).toEqual(['ds-hit-0', 'ds-hit-1', 'ds-all']);
    expect(hitIds(sheetModel('nol', res({ people: people(1) }), idle))).toEqual(['ds-all']);
    expect(hitIds(sheetModel('', null, idle))).toEqual([]);
    expect(hitIds(sheetModel('zzz', res(), idle))).toEqual([]);
  });
  it('nextId: ↓ from nothing is the first, ↑ the last; both wrap; an unknown id starts over', () => {
    const ids = ['ds-hit-0', 'ds-hit-1', 'ds-all'];
    expect(nextId(ids, null, 1)).toBe('ds-hit-0');
    expect(nextId(ids, null, -1)).toBe('ds-all');
    expect(nextId(ids, 'ds-hit-0', 1)).toBe('ds-hit-1');
    expect(nextId(ids, 'ds-all', 1)).toBe('ds-hit-0');
    expect(nextId(ids, 'ds-hit-0', -1)).toBe('ds-all');
    expect(nextId(ids, 'ds-hit-9', 1)).toBe('ds-hit-0');
    expect(nextId([], null, 1)).toBeNull();
  });
});

describe('mark colour', () => {
  const over = (b: RGB, t: RGB, a: number): RGB => [0, 1, 2].map((i) => Math.round(b[i]! * (1 - a) + t[i]! * a)) as RGB;
  it('passes AA on the sheet and on its selected row over the dimmed page (dark base and the ambient peak)', () => {
    for (const page of [DARK_BASE, AMB_PEAK]) {
      const sheet = frostComposite(over(page, DIM_RGB, DIM_A), SCRIM_SAFE);
      const selected = over(sheet, [255, 255, 255], SEL_A);
      expect(contrast(MARK_RGB, sheet)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(MARK_RGB, selected)).toBeGreaterThanOrEqual(4.5);
      // the plain brand coral does not (why the mark is lighter)
      expect(contrast([255, 79, 109], selected)).toBeLessThan(4.5);
    }
    expect(MARK_CSS).toBe('rgb(255, 195, 205)');
  });
});
