// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { gridKey, moveCell } from './gridKeys';

describe('moveCell', () => {
  const at = (r: number, c: number) => ({ r, c });
  it('arrows move one cell', () => {
    expect(moveCell(at(1, 1), 'ArrowRight', 4, 3)).toEqual(at(1, 2));
    expect(moveCell(at(1, 1), 'ArrowLeft', 4, 3)).toEqual(at(1, 0));
    expect(moveCell(at(1, 1), 'ArrowDown', 4, 3)).toEqual(at(2, 1));
    expect(moveCell(at(1, 1), 'ArrowUp', 4, 3)).toEqual(at(0, 1));
  });
  it('stops at the edges (no wrap, the key is still the grid\'s)', () => {
    expect(moveCell(at(0, 0), 'ArrowLeft', 4, 3)).toEqual(at(0, 0));
    expect(moveCell(at(0, 0), 'ArrowUp', 4, 3)).toEqual(at(0, 0));
    expect(moveCell(at(3, 2), 'ArrowRight', 4, 3)).toEqual(at(3, 2));
    expect(moveCell(at(3, 2), 'ArrowDown', 4, 3)).toEqual(at(3, 2));
  });
  it('Home / End go to the row\'s first / last cell, Ctrl+Home / Ctrl+End to the grid\'s', () => {
    expect(moveCell(at(2, 1), 'Home', 4, 3)).toEqual(at(2, 0));
    expect(moveCell(at(2, 1), 'End', 4, 3)).toEqual(at(2, 2));
    expect(moveCell(at(2, 1), 'Ctrl+Home', 4, 3)).toEqual(at(0, 0));
    expect(moveCell(at(2, 1), 'Ctrl+End', 4, 3)).toEqual(at(3, 2));
  });
  it('a position outside the grid is pulled in; other keys and an empty grid are not the grid\'s', () => {
    expect(moveCell(at(9, 9), 'ArrowUp', 4, 3)).toEqual(at(2, 2));
    expect(moveCell(at(1, 1), 'Enter', 4, 3)).toBeNull();
    expect(moveCell(at(1, 1), 'a', 4, 3)).toBeNull();
    expect(moveCell(at(0, 0), 'ArrowDown', 0, 3)).toBeNull();
    expect(moveCell(at(0, 0), 'ArrowDown', 4, 0)).toBeNull();
  });
});

describe('gridKey', () => {
  it('names the key with Ctrl (or Cmd) in front', () => {
    expect(gridKey({ key: 'Home', ctrlKey: true, metaKey: false })).toBe('Ctrl+Home');
    expect(gridKey({ key: 'End', ctrlKey: false, metaKey: true })).toBe('Ctrl+End');
    expect(gridKey({ key: 'ArrowUp', ctrlKey: false, metaKey: false })).toBe('ArrowUp');
  });
});
