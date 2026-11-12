// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { LiveChannel } from './api';
import { channelOrder, neighbour } from './order';

const ch = (id: string, number: number, groupId: string | null = 'g1', groupPos?: number): LiveChannel =>
  ({ id, number, name: id, logo: null, groupId, running: false, epg: 'none', favourite: false, ...(groupPos === undefined ? {} : { groupPos }) });
const list = [ch('hafen', 4, 'g1'), ch('nordlicht', 1, 'g1'), ch('berg', 12, 'g2'), ch('kinder', 7, 'g2'), ch('dup', 4, 'g2', 1)];
const ids = (l: LiveChannel[]) => l.map((c) => c.id);

describe('channelOrder', () => {
  it('all: by number, a tie by group position (an explicit groupPos wins over the list position)', () => {
    expect(ids(channelOrder(list, 'all', [], []))).toEqual(['nordlicht', 'hafen', 'dup', 'kinder', 'berg']);
    expect(ids(channelOrder([ch('x', 4, 'g', 5), ch('y', 4, 'g', 2)], 'all', [], []))).toEqual(['y', 'x']);
  });
  it('a group: only its channels by number', () => {
    expect(ids(channelOrder(list, 'g2', [], []))).toEqual(['dup', 'kinder', 'berg']);
  });
  it('fav follows the given favourites order and drops unknown ids', () => {
    expect(ids(channelOrder(list, 'fav', ['berg', 'gone', 'nordlicht'], []))).toEqual(['berg', 'nordlicht']);
  });
  it('recent follows the given snapshot, not the list', () => {
    expect(ids(channelOrder(list, 'recent', [], ['kinder', 'hafen', 'berg']))).toEqual(['kinder', 'hafen', 'berg']);
  });
  it('does not change the input', () => {
    const copy = [...list];
    channelOrder(list, 'all', [], []);
    expect(list).toEqual(copy);
  });
});

describe('neighbour', () => {
  const o = channelOrder(list, 'all', [], []);
  it('steps and wraps around both ways', () => {
    expect(neighbour(o, 'hafen', 1).id).toBe('dup');
    expect(neighbour(o, 'berg', 1).id).toBe('nordlicht');
    expect(neighbour(o, 'nordlicht', -1).id).toBe('berg');
  });
  it('an unknown id lands on the first (up) or last (down) channel', () => {
    expect(neighbour(o, 'gone', 1).id).toBe('nordlicht');
    expect(neighbour(o, 'gone', -1).id).toBe('berg');
  });
  it('an empty list throws', () => { expect(() => neighbour([], 'x', 1)).toThrow(); });
});
