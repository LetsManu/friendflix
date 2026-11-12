// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { activeChips, emptyFilters, fromQuery, toQuery, type UserFilters } from './userFilters';

afterEach(async () => { await setLocale('de'); });

const full: UserFilters = { q: 'anna', role: 'friend', status: 'expiring', lastActive: '90+', overrides: true, kids: true, noMfa: true, perm: { key: 'cast', on: false } };

describe('toQuery / fromQuery', () => {
  it('an empty filter set has no parameters', () => {
    expect(toQuery(emptyFilters()).toString()).toBe('');
    expect(fromQuery(new URLSearchParams())).toEqual(emptyFilters());
  });
  it('writes the backend parameters (overrides=1, kids=1, mfa=off, perm=key:on|off)', () => {
    const p = toQuery(full);
    expect(p.get('q')).toBe('anna');
    expect(p.get('role')).toBe('friend');
    expect(p.get('status')).toBe('expiring');
    expect(p.get('lastActive')).toBe('90+');
    expect(p.get('overrides')).toBe('1');
    expect(p.get('kids')).toBe('1');
    expect(p.get('mfa')).toBe('off');
    expect(p.get('perm')).toBe('cast:off');
    expect(toQuery({ ...emptyFilters(), perm: { key: 'liveTv', on: true } }).get('perm')).toBe('liveTv:on');
  });
  it('round-trips, including perm=cast:off and a "90+" value', () => {
    expect(fromQuery(toQuery(full))).toEqual(full);
    expect(fromQuery(new URLSearchParams('perm=cast:off')).perm).toEqual({ key: 'cast', on: false });
    expect(fromQuery(new URLSearchParams('perm=partySchedule:on')).perm).toEqual({ key: 'partySchedule', on: true });
  });
  it('drops what the backend would refuse', () => {
    const f = fromQuery(new URLSearchParams('perm=nope:off&status=bogus&lastActive=5&overrides=0&kids=2&mfa=on&perm2=x'));
    expect(f).toEqual(emptyFilters());
    expect(fromQuery(new URLSearchParams('perm=cast:maybe')).perm).toBeNull();
    expect(fromQuery(new URLSearchParams('perm=cast')).perm).toBeNull();
  });
});

describe('activeChips', () => {
  it('lists nothing for no filters, and never the search text', () => {
    expect(activeChips(emptyFilters())).toEqual([]);
    expect(activeChips({ ...emptyFilters(), q: 'anna' })).toEqual([]);
  });
  it('one chip per active filter, in the order of the row, with readable labels', () => {
    expect(activeChips(full)).toEqual([
      { id: 'role', label: 'friend' }, { id: 'status', label: 'Läuft in 7 Tagen ab' }, { id: 'lastActive', label: 'Seit 90+ Tagen inaktiv' },
      { id: 'overrides', label: 'Mit Ausnahmen' }, { id: 'kids', label: 'Mit Kinderprofil' }, { id: 'noMfa', label: 'Ohne 2FA' },
      { id: 'perm', label: 'Auf Fernseher übertragen: nein' },
    ]);
  });
  it('role names come from the caller', () => {
    expect(activeChips({ ...emptyFilters(), role: 'friend' }, (k) => (k === 'friend' ? 'Freund' : k))).toEqual([{ id: 'role', label: 'Freund' }]);
  });
  it('follows the locale', async () => {
    await setLocale('en');
    expect(activeChips({ ...emptyFilters(), overrides: true, perm: { key: 'party', on: true } }).map((c) => c.label)).toEqual(['With exceptions', 'Watch parties: yes']);
  });
});
