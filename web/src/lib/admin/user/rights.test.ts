// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { rightsPatch, stagedValue, triOf, type RightsRow } from './rights';

const row = (key: string, value: unknown, roleValue: unknown, override: unknown = null, source: RightsRow['source'] = 'role'): RightsRow => ({ key, value, roleValue, override, source });

describe('triOf', () => {
  it('no stored switch = as role', () => expect(triOf(row('cast', true, true))).toBe('role'));
  it('a stored true / false is allow / deny', () => {
    expect(triOf(row('cast', true, false, true, 'user'))).toBe('allow');
    expect(triOf(row('cast', false, true, false, 'user'))).toBe('deny');
  });
  it('an absent override counts as role', () => expect(triOf({ key: 'cast', value: true, roleValue: true, source: 'role' } as RightsRow)).toBe('role'));
});

describe('rightsPatch', () => {
  const rows = [
    row('cast', true, true), row('party', false, true, false, 'user'), row('maxStreams', 2, 2), row('maxHeight', 1080, 1080, null),
    row('requestsPerMonth', 3, 3, 5, 'user'), row('libraries', 'all', 'all'),
  ];
  it('nothing staged, note unchanged: null', () => expect(rightsPatch(rows, {}, null, null)).toBeNull());
  it('sends only the changed keys', () => expect(rightsPatch(rows, { cast: false }, null, null)).toEqual({ overrides: { cast: false } }));
  it('back to the role sends null for a stored exception', () => expect(rightsPatch(rows, { party: null }, null, null)).toEqual({ overrides: { party: null } }));
  it('null on a field without exception is no change', () => expect(rightsPatch(rows, { cast: null }, null, null)).toBeNull());
  it('the stored value again is no change', () => expect(rightsPatch(rows, { party: false, requestsPerMonth: 5 }, null, null)).toBeNull());
  it('a value equal to the role is not an exception', () => expect(rightsPatch(rows, { maxStreams: 2 }, null, null)).toBeNull());
  it('"no cap" is spelled unlimited', () => {
    expect(rightsPatch(rows, { maxHeight: 'unlimited' }, null, null)).toEqual({ overrides: { maxHeight: 'unlimited' } });
    expect(rightsPatch([row('maxHeight', null, null)], { maxHeight: 'unlimited' }, null, null)).toBeNull();
  });
  it('a number differing from the role is sent', () => expect(rightsPatch(rows, { maxStreams: 4 }, null, null)).toEqual({ overrides: { maxStreams: 4 } }));
  it('library lists compare as sets', () => {
    const r = [row('libraries', ['A', 'B'], ['A', 'B'], ['B', 'A'], 'user')];
    expect(rightsPatch(r, { libraries: ['A', 'B'] }, null, null)).toBeNull();
    expect(rightsPatch(r, { libraries: ['A'] }, null, null)).toEqual({ overrides: { libraries: ['A'] } });
  });
  it('a changed note rides along, an unchanged one is absent', () => {
    expect(rightsPatch(rows, {}, 'Warum', null)).toEqual({ overrides: {}, note: 'Warum' });
    expect(rightsPatch(rows, { cast: false }, 'Warum', 'Warum')).toEqual({ overrides: { cast: false } });
    expect(rightsPatch(rows, {}, '  ', null)).toBeNull();
  });
  it('a cleared note is null', () => expect(rightsPatch(rows, {}, '', 'Warum')).toEqual({ overrides: {}, note: null }));
});

describe('stagedValue', () => {
  it('shows the staged value, else the stored exception, else the effective value', () => {
    const r = row('maxStreams', 2, 2, 4, 'user');
    expect(stagedValue(r, {})).toBe(4);
    expect(stagedValue(r, { maxStreams: 6 })).toBe(6);
    expect(stagedValue(r, { maxStreams: null })).toBe(2);
    expect(stagedValue(row('maxHeight', null, 1080, 'unlimited', 'user'), {})).toBeNull();
  });
});
