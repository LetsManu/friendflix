// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { menuGroups } from './menuGroups';

type It = { id: string; danger?: boolean; tail?: boolean };
const ids = (g: It[][]) => g.map((x) => x.map((i) => i.id));

describe('menuGroups', () => {
  it('no tail: one group', () => {
    expect(ids(menuGroups<It>([{ id: 'a' }, { id: 'b' }]))).toEqual([['a', 'b']]);
  });
  it('danger rows go last, after the others', () => {
    expect(ids(menuGroups<It>([{ id: 'del', danger: true }, { id: 'a' }, { id: 'b' }]))).toEqual([['a', 'b'], ['del']]);
  });
  it('tail rows without danger come before danger rows', () => {
    const g = menuGroups<It>([{ id: 'x', danger: true }, { id: 'a' }, { id: 'rm', tail: true }, { id: 'y', danger: true, tail: true }, { id: 'b' }]);
    expect(ids(g)).toEqual([['a', 'b'], ['rm', 'x', 'y']]);
  });
  it('only tail rows: one group', () => {
    expect(ids(menuGroups<It>([{ id: 'rm', tail: true }, { id: 'del', danger: true }]))).toEqual([['rm', 'del']]);
  });
  it('empty: no groups', () => {
    expect(menuGroups<It>([])).toEqual([]);
  });
});
