// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { initPicker, pickChanged, saveList, SEARCH_FROM, setAll, shiftLabel, shownGroups, skipList, stepShift, toggle, totals, type PickerState } from './picker';

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
  it('keeps skip names that the list does not have apart from the ticks', () => {
    const s = fresh(['Kinder', 'Erwachsene', 'Erwachsene']);
    expect([...s.skipped]).toEqual(['Kinder']);
    expect(s.kept).toEqual(['Erwachsene']);
    expect(fresh().kept).toEqual([]);
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

describe('saveList and pickChanged: stored skip names the list does not have', () => {
  const stored = ['Kinder', 'Erwachsene', 'Alte Gruppe'];
  it('saves the visible unticked groups plus the kept names (a union)', () => {
    const s = fresh(stored);
    expect(skipList(s)).toEqual(['Kinder']);
    expect(saveList(s)).toEqual(['Kinder', 'Erwachsene', 'Alte Gruppe']);
    expect(saveList(toggle(s, 'DE | Sport'))).toEqual(['DE | Sport', 'Kinder', 'Erwachsene', 'Alte Gruppe']);
    expect(saveList(toggle(s, 'Kinder'))).toEqual(['Erwachsene', 'Alte Gruppe']);
  });
  it('an untouched picker is not a change, the kept names never count', () => {
    expect(pickChanged(fresh(stored), stored)).toBe(false);
    expect(pickChanged(fresh(['Erwachsene']), ['Erwachsene'])).toBe(false);
    expect(pickChanged(fresh(), [])).toBe(false);
  });
  it('a toggle of a visible group is a change, and toggling it back is none', () => {
    const s = toggle(fresh(stored), 'Kinder');
    expect(pickChanged(s, stored)).toBe(true);
    expect(pickChanged(toggle(s, 'Kinder'), stored)).toBe(false);
    expect(pickChanged(toggle(fresh(stored), 'DE | Sport'), stored)).toBe(true);
  });
  it('a new check with the saved list keeps the kept names and shows the ones that came back', () => {
    const s = initPicker(GROUPS.filter((g) => g.name !== 'Kinder'), saveList(fresh(stored)));
    expect(s.kept).toEqual(['Kinder', 'Erwachsene', 'Alte Gruppe']);
    const back = initPicker(GROUPS, saveList(s));
    expect(skipList(back)).toEqual(['Kinder']);
    expect(back.kept).toEqual(['Erwachsene', 'Alte Gruppe']);
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
