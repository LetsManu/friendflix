// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cancel, drop, flipOffsets, idle, insertAt, move, moveTo, pick, renumber, type DragState } from './dragOrder';

const ids = ['nordlicht', 'hafen', 'berg', 'kinder', 'stern'];
const at = (s: DragState) => s.ids.indexOf(s.picked ?? '');

describe('idle', () => {
  it('holds a copy of the order, nothing picked', () => {
    const src = ids.slice();
    const s = idle(src);
    expect(s).toEqual({ ids, picked: null, origin: -1 });
    src.reverse();
    expect(s.ids).toEqual(ids);
  });
});

describe('pick / move / drop', () => {
  it('pick lifts a row and remembers where it came from', () => {
    const s = pick(idle(ids), 'berg');
    expect(s).toEqual({ ids, picked: 'berg', origin: 2 });
  });

  it('pick of an unknown id or while another row is lifted changes nothing', () => {
    const s0 = idle(ids);
    expect(pick(s0, 'wolkenlos')).toBe(s0);
    const s1 = pick(s0, 'hafen');
    expect(pick(s1, 'berg')).toBe(s1);
    expect(pick(s1, 'hafen')).toBe(s1);
  });

  it('move steps the lifted row by one, the others close up', () => {
    let s = pick(idle(ids), 'berg');
    s = move(s, -1);
    expect(s.ids).toEqual(['nordlicht', 'berg', 'hafen', 'kinder', 'stern']);
    expect(at(s)).toBe(1);
    s = move(s, 1);
    s = move(s, 1);
    expect(s.ids).toEqual(['nordlicht', 'hafen', 'kinder', 'berg', 'stern']);
    expect(s.origin).toBe(2);
    expect(s.picked).toBe('berg');
  });

  it('move stops at both ends and returns the same state (nothing to announce)', () => {
    const top = pick(idle(ids), 'nordlicht');
    expect(move(top, -1)).toBe(top);
    const bottom = pick(idle(ids), 'stern');
    expect(move(bottom, 1)).toBe(bottom);
  });

  it('move without a lifted row changes nothing', () => {
    const s = idle(ids);
    expect(move(s, 1)).toBe(s);
  });

  it('move never mutates the state it was given', () => {
    const s = pick(idle(ids), 'hafen');
    const before = s.ids.slice();
    move(s, 1);
    expect(s.ids).toEqual(before);
  });

  it('drop keeps the new order and puts the row down', () => {
    let s = pick(idle(ids), 'nordlicht');
    s = move(move(move(s, 1), 1), 1);
    s = drop(s);
    expect(s).toEqual({ ids: ['hafen', 'berg', 'kinder', 'nordlicht', 'stern'], picked: null, origin: -1 });
  });

  it('drop without a lifted row changes nothing', () => {
    const s = idle(ids);
    expect(drop(s)).toBe(s);
  });

  it('pick, drop at once: the order is unchanged', () => {
    expect(drop(pick(idle(ids), 'kinder')).ids).toEqual(ids);
  });

  it('a second row can be picked after a drop', () => {
    let s = drop(move(pick(idle(ids), 'stern'), -1));
    s = pick(s, 'nordlicht');
    expect(s.origin).toBe(0);
    s = drop(move(s, 1));
    expect(s.ids).toEqual(['hafen', 'nordlicht', 'berg', 'stern', 'kinder']);
  });
});

describe('cancel', () => {
  it('puts the lifted row back where it was picked up', () => {
    let s = pick(idle(ids), 'hafen');
    s = move(move(move(s, 1), 1), 1);
    expect(s.ids).toEqual(['nordlicht', 'berg', 'kinder', 'stern', 'hafen']);
    s = cancel(s);
    expect(s).toEqual({ ids, picked: null, origin: -1 });
  });

  it('after moving up as well', () => {
    const s = cancel(move(move(pick(idle(ids), 'stern'), -1), -1));
    expect(s.ids).toEqual(ids);
  });

  it('keeps earlier drops (only the current move is undone)', () => {
    const dropped = drop(move(pick(idle(ids), 'nordlicht'), 1));
    const s = cancel(move(pick(dropped, 'stern'), -1));
    expect(s.ids).toEqual(['hafen', 'nordlicht', 'berg', 'kinder', 'stern']);
  });

  it('without a lifted row changes nothing', () => {
    const s = idle(ids);
    expect(cancel(s)).toBe(s);
  });
});

describe('moveTo (the pointer drag)', () => {
  it('puts the lifted row at an index, clamped to the list', () => {
    const s = pick(idle(ids), 'hafen');
    expect(moveTo(s, 3).ids).toEqual(['nordlicht', 'berg', 'kinder', 'hafen', 'stern']);
    expect(moveTo(s, 99).ids).toEqual(['nordlicht', 'berg', 'kinder', 'stern', 'hafen']);
    expect(moveTo(s, -4).ids).toEqual(['hafen', 'nordlicht', 'berg', 'kinder', 'stern']);
    expect(moveTo(s, 3).origin).toBe(1);
  });

  it('the same index, a fraction or no lifted row: the same state', () => {
    const s = pick(idle(ids), 'hafen');
    expect(moveTo(s, 1)).toBe(s);
    expect(moveTo(s, 2.6).ids).toEqual(['nordlicht', 'berg', 'kinder', 'hafen', 'stern']);
    const i = idle(ids);
    expect(moveTo(i, 2)).toBe(i);
  });

  it('a pointer drag can be cancelled like a keyboard move', () => {
    expect(cancel(moveTo(pick(idle(ids), 'kinder'), 0)).ids).toEqual(ids);
  });
});

describe('insertAt', () => {
  // the midpoints of the other rows (the lifted one left out), 56 px rows
  const mids = [28, 84, 140, 196];
  it('counts the rows whose middle lies above the lifted row\'s middle', () => {
    expect(insertAt(mids, 0)).toBe(0);
    expect(insertAt(mids, 27)).toBe(0);
    expect(insertAt(mids, 29)).toBe(1);
    expect(insertAt(mids, 150)).toBe(3);
    expect(insertAt(mids, 500)).toBe(4);
  });
  it('a middle exactly on a row\'s middle stays above it; no rows: 0', () => {
    expect(insertAt(mids, 84)).toBe(1);
    expect(insertAt([], 40)).toBe(0);
  });
});

describe('flipOffsets', () => {
  it('gives each moved row the distance from its new place back to its old one', () => {
    const before = new Map([['a', 0], ['b', 56], ['c', 112]]);
    const after = new Map([['a', 56], ['b', 0], ['c', 112]]);
    expect([...flipOffsets(before, after)]).toEqual([['a', -56], ['b', 56]]);
  });

  it('leaves out rows that did not move, moved less than half a pixel, or are missing on one side', () => {
    const before = new Map([['a', 10], ['b', 20.3], ['gone', 30]]);
    const after = new Map([['a', 10], ['b', 20], ['new', 40]]);
    expect(flipOffsets(before, after).size).toBe(0);
  });

  it('works for any order of the maps and keeps fractions', () => {
    const before = new Map([['x', 100.5], ['y', 12]]);
    const after = new Map([['y', 68], ['x', 44.25]]);
    const out = flipOffsets(before, after);
    expect(out.get('x')).toBe(56.25);
    expect(out.get('y')).toBe(-56);
  });
});

describe('renumber', () => {
  it('numbers the rows in their new order from the smallest number of the set', () => {
    const numbers = new Map<string, number | null>([['a', 4], ['b', 7], ['c', 9]]);
    expect(renumber(['c', 'a', 'b'], numbers)).toEqual([{ id: 'c', number: 4 }, { id: 'a', number: 5 }, { id: 'b', number: 6 }]);
  });

  it('rows without a number get one too; the start is the smallest number that is set', () => {
    const numbers = new Map<string, number | null>([['a', null], ['b', 12], ['c', 30]]);
    expect(renumber(['a', 'b', 'c', 'd'], numbers)).toEqual([{ id: 'a', number: 12 }, { id: 'b', number: 13 }, { id: 'c', number: 14 }, { id: 'd', number: 15 }]);
  });

  it('no number in the set: starts at 1; an empty list: nothing', () => {
    expect(renumber(['a', 'b'], new Map())).toEqual([{ id: 'a', number: 1 }, { id: 'b', number: 2 }]);
    expect(renumber([], new Map([['a', 3]]))).toEqual([]);
  });

  it('only the shown rows count for the start (numbers of other ids are ignored)', () => {
    const numbers = new Map<string, number | null>([['other', 1], ['a', 20], ['b', 21]]);
    expect(renumber(['b', 'a'], numbers)).toEqual([{ id: 'b', number: 20 }, { id: 'a', number: 21 }]);
  });
});

describe('old TV browsers (Chromium 85; Task 38 runs this on TVs)', () => {
  it('uses nothing newer than Chromium 85', () => {
    const src = readFileSync(new URL('./dragOrder.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const re of [/structuredClone/, /\.at\(/, /Object\.hasOwn/, /findLast/, /toSorted|toReversed|toSpliced|\.with\(/]) expect(src, String(re)).not.toMatch(re);
  });
});
