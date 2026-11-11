// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { secToTicks } from '#lib/api';
import { episodeOf, joinedAsk, joinedAt, joinedLength } from './joined';

const items = [
  { itemId: 'ep1', title: 'First', season: 1, episode: 1, start: 0, duration: 2832 },
  { itemId: 'ep2', title: 'Second', season: 1, episode: 2, start: 2832, duration: 2700 },
  { itemId: 'ep3', title: 'Third', season: 1, episode: 3, start: 5532, duration: 2600 },
];

describe('joinedAt', () => {
  it('inside an episode: its index and the offset in it', () => {
    expect(joinedAt(items, 0)).toEqual({ index: 0, offset: 0 });
    expect(joinedAt(items, 100)).toEqual({ index: 0, offset: 100 });
    expect(joinedAt(items, 2900)).toEqual({ index: 1, offset: 68 });
    expect(joinedAt(items, 6000)).toEqual({ index: 2, offset: 468 });
  });
  it('a position exactly on a boundary belongs to the later episode', () => {
    expect(joinedAt(items, 2832)).toEqual({ index: 1, offset: 0 });
    expect(joinedAt(items, 5532)).toEqual({ index: 2, offset: 0 });
  });
  it('past the end: the last episode, at its end; before the start or not a number: the first, at 0', () => {
    expect(joinedAt(items, 9000)).toEqual({ index: 2, offset: 2600 });
    expect(joinedAt(items, -5)).toEqual({ index: 0, offset: 0 });
    expect(joinedAt(items, Number.NaN)).toEqual({ index: 0, offset: 0 });
  });
  it('no items: the position as it is', () => {
    expect(joinedAt([], 42)).toEqual({ index: 0, offset: 42 });
  });
});

describe('joinedLength', () => {
  it('is the last episode\'s end, else the token\'s runtime', () => {
    expect(joinedLength(items)).toBe(8132);
    expect(joinedLength([], secToTicks(100))).toBe(100);
    expect(joinedLength([])).toBe(0);
  });
});

describe('joinedAsk', () => {
  it('a re-mint starts at the episode and offset; `left` counts that episode and the ones after it in this stream', () => {
    expect(joinedAsk(items, 2900)).toEqual({ itemId: 'ep2', offset: 68, left: 2 });
    expect(joinedAsk(items, 10)).toEqual({ itemId: 'ep1', offset: 10, left: 3 });
    expect(joinedAsk(items, 9000)).toEqual({ itemId: 'ep3', offset: 2600, left: 1 });
  });
});

describe('episodeOf', () => {
  it('the bar\'s two lines of an episode of the stream (series name, then code and name)', () => {
    expect(episodeOf('Bright Valley', items[1]!)).toEqual({ title: 'Bright Valley', sub: 'S1:F2 Second' });
    expect(episodeOf('Bright Valley', { itemId: 'x', title: 'Pilot', start: 0, duration: 1 })).toEqual({ title: 'Bright Valley', sub: 'Pilot' });
  });
});
