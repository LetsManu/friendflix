// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { initPicker, SEARCH_FROM, setAll, shiftLabel, shownGroups, skipList, stepShift, toggle, totals, type PickerState } from './picker';

const GROUPS = [
  { name: 'DE | Sport', channels: 42 },
  { name: 'DE | Nachrichten', channels: 30 },
  { name: 'AT | Sport', channels: 12 },
  { name: 'Kinder', channels: 100 },
  { name: 'Natur & Tiere', channels: 228 },
];
const fresh = (skip: string[] = []): PickerState => initPicker(GROUPS, skip);

afterEach(async () => { await setLocale('de'); });

describe('initPicker', () => {
  it('ticks everything on first use', () => {
    const s = fresh();
    expect(s.skipped.size).toBe(0);
    expect(s.q).toBe('');
    expect(s.groups).toEqual(GROUPS);
  });
  it('drops skip names that are no longer in the list', () => {
    const s = fresh(['Kinder', 'Erwachsene']);
    expect([...s.skipped]).toEqual(['Kinder']);
  });
  it('shows the search field from 12 groups on', () => {
    expect(SEARCH_FROM).toBe(12);
  });
});

describe('shownGroups', () => {
  it('finds a substring of a name, ignoring case', () => {
    expect(shownGroups({ ...fresh(), q: 'sport' }).map((g) => g.name)).toEqual(['DE | Sport', 'AT | Sport']);
    expect(shownGroups({ ...fresh(), q: ' SPORT ' }).map((g) => g.name)).toEqual(['DE | Sport', 'AT | Sport']);
  });
  it('shows everything without a query, in list order', () => {
    expect(shownGroups(fresh()).map((g) => g.name)).toEqual(GROUPS.map((g) => g.name));
    expect(shownGroups({ ...fresh(), q: 'zzz' })).toEqual([]);
  });
});

describe('setAll and toggle', () => {
  it('Keine with a query unticks only the shown groups', () => {
    const s = setAll({ ...fresh(), q: 'sport' }, false);
    expect(skipList(s)).toEqual(['DE | Sport', 'AT | Sport']);
  });
  it('Alle with a query ticks only the shown groups', () => {
    const s = setAll({ ...fresh(['DE | Sport', 'Kinder', 'AT | Sport']), q: 'sport' }, true);
    expect(skipList(s)).toEqual(['Kinder']);
  });
  it('does not change its input', () => {
    const s = fresh();
    setAll(s, false);
    toggle(s, 'Kinder');
    expect(s.skipped.size).toBe(0);
  });
  it('toggle flips one group', () => {
    const a = toggle(fresh(), 'Kinder');
    expect(skipList(a)).toEqual(['Kinder']);
    expect(skipList(toggle(a, 'Kinder'))).toEqual([]);
  });
  it('toggle ignores an unknown name', () => {
    expect(skipList(toggle(fresh(), 'Erwachsene'))).toEqual([]);
  });
});

describe('totals and skipList', () => {
  it('counts the channels of the ticked groups', () => {
    expect(totals(fresh())).toEqual({ picked: 412, total: 412 });
    expect(totals(fresh(['Kinder']))).toEqual({ picked: 312, total: 412 });
    expect(totals({ ...fresh(['Kinder']), q: 'sport' })).toEqual({ picked: 312, total: 412 });
  });
  it('lists the skipped groups in list order, whatever the order they were unticked in', () => {
    const s = toggle(toggle(toggle(fresh(), 'Natur & Tiere'), 'DE | Sport'), 'Kinder');
    expect(skipList(s)).toEqual(['DE | Sport', 'Kinder', 'Natur & Tiere']);
  });
});

describe('shiftLabel and stepShift', () => {
  it('writes the offset in hours with its sign', () => {
    expect(shiftLabel(90)).toBe('+1,5 Std.');
    expect(shiftLabel(-120)).toBe('−2 Std.');
    expect(shiftLabel(30)).toBe('+0,5 Std.');
    expect(shiftLabel(840)).toBe('+14 Std.');
    expect(shiftLabel(-720)).toBe('−12 Std.');
    expect(shiftLabel(0)).toBe('0');
  });
  it('follows the language', async () => {
    await setLocale('en');
    expect(shiftLabel(90)).toBe('+1.5 h');
    expect(shiftLabel(-120)).toBe('−2 h');
  });
  it('steps by 30 minutes and stays inside −12…+14 h', () => {
    expect(stepShift(0, 1)).toBe(30);
    expect(stepShift(0, -1)).toBe(-30);
    expect(stepShift(840, 1)).toBe(840);
    expect(stepShift(-720, -1)).toBe(-720);
    expect(stepShift(810, 1)).toBe(840);
  });
});
