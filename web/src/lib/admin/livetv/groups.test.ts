// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '#lib/api';
import { setLocale } from '#lib/i18n';
import { chipsText, exceptionsOf, groupError, kidsLine, loadExceptions, pendingFirst, rolesFor, type GroupView } from './groups';

vi.mock('#lib/api', () => ({ api: vi.fn(), apiCode: () => undefined }));

const g = (id: string, name: string, over: Partial<GroupView> = {}): GroupView => ({
  id, name, kidFriendly: false, roles: [], released: true, position: 0, channels: 10, providerGroups: [], ...over,
});

afterEach(async () => { await setLocale('de'); });

describe('chipsText', () => {
  it('shows the first two names and counts the rest', () => {
    expect(chipsText(['Sport', 'Nachrichten', 'Natur', 'Kinder'])).toBe('Sport, Nachrichten +2');
    expect(chipsText(['Sport', 'Nachrichten', 'Natur'])).toBe('Sport, Nachrichten +1');
  });
  it('shows few names whole and nothing for none', () => {
    expect(chipsText(['Sport', 'Nachrichten'])).toBe('Sport, Nachrichten');
    expect(chipsText(['Sport'])).toBe('Sport');
    expect(chipsText([])).toBe('');
  });
  it('takes another maximum', () => {
    expect(chipsText(['A', 'B', 'C', 'D'], 3)).toBe('A, B, C +1');
    expect(chipsText(['A', 'B', 'C', 'D'], 0)).toBe('+4');
  });
});

describe('kidsLine', () => {
  it('names the released kid-friendly groups that a role grants, with their channels', () => {
    const rows = [
      g('1', 'Sport', { roles: ['family'] }),
      g('2', 'Kinderinsel', { kidFriendly: true, roles: ['family', 'friend'], channels: 11, position: 2 }),
      g('3', 'Natur & Tiere', { kidFriendly: true, roles: ['family'], channels: 12, position: 3 }),
    ];
    expect(kidsLine(rows)).toBe('Kinderprofile sehen: Kinderinsel, Natur & Tiere (23 Sender)');
  });
  it('leaves out unreleased groups and groups no role sees', () => {
    const rows = [
      g('1', 'Kinderinsel', { kidFriendly: true, roles: ['family'], channels: 11 }),
      g('2', 'Neu', { kidFriendly: true, roles: ['family'], released: false, channels: 5 }),
      g('3', 'Ohne Rolle', { kidFriendly: true, roles: [], channels: 7 }),
    ];
    expect(kidsLine(rows)).toBe('Kinderprofile sehen: Kinderinsel (11 Sender)');
  });
  it('says so when no group is left', () => {
    expect(kidsLine([g('1', 'Sport', { roles: ['family'] })])).toBe('Kinderprofile sehen noch keine Gruppe.');
  });
  it('is written in the language of the page', async () => {
    await setLocale('en');
    expect(kidsLine([g('1', 'Kinderinsel', { kidFriendly: true, roles: ['family'], channels: 11 })])).toBe('Kids profiles see: Kinderinsel (11 channels)');
  });
});

describe('pendingFirst', () => {
  const rows = [
    g('a', 'Sport', { position: 0 }),
    g('b', 'Kino', { position: 3, released: false }),
    g('c', 'Natur', { position: 1 }),
    g('d', 'Musik', { position: 1, released: false }),
  ];
  it('lists the unreleased groups first, then by position', () => {
    expect(pendingFirst(rows, false).map((x) => x.id)).toEqual(['d', 'b', 'a', 'c']);
  });
  it('keeps only the unreleased ones for "Nur diese zeigen"', () => {
    expect(pendingFirst(rows, true).map((x) => x.id)).toEqual(['d', 'b']);
  });
  it('does not change the given list', () => {
    const before = rows.map((x) => x.id);
    pendingFirst(rows, false);
    expect(rows.map((x) => x.id)).toEqual(before);
  });
});

describe('exceptionsOf', () => {
  const ref = (id: string, name: string) => ({ id, name });
  it('keeps the people with a plus or a minus, with the group names', () => {
    const out = exceptionsOf([
      { userId: 'u1', name: 'Anna Beispiel', livetvGroups: { allow: [ref('g1', 'Sport')], deny: [] } },
      { userId: 'u2', name: 'Ben Muster', livetvGroups: { allow: [], deny: [] } },
      { userId: 'u3', name: 'Carla Probe', livetvGroups: { allow: [ref('g1', 'Sport')], deny: [ref('g2', 'Kinderinsel')] } },
    ]);
    expect(out).toEqual([
      { userId: 'u1', name: 'Anna Beispiel', plus: ['Sport'], minus: [], plusOff: [], minusOff: [] },
      { userId: 'u3', name: 'Carla Probe', plus: ['Sport'], minus: ['Kinderinsel'], plusOff: [], minusOff: [] },
    ]);
  });
  it('keeps an exception on an unreleased group apart: it is not effective (ruling 39)', () => {
    const out = exceptionsOf(
      [{ userId: 'u1', name: 'Anna Beispiel', livetvGroups: { allow: [ref('g1', 'Sport'), ref('g9', 'Kinofilme')], deny: [ref('g9', 'Kinofilme')] } }],
      [g('g1', 'Sport'), g('g9', 'Kinofilme', { released: false })],
    );
    expect(out).toEqual([{ userId: 'u1', name: 'Anna Beispiel', plus: ['Sport'], minus: [], plusOff: ['Kinofilme'], minusOff: ['Kinofilme'] }]);
  });
  it('skips a row without the answer (a failed read)', () => {
    expect(exceptionsOf([{ userId: 'u1', name: 'Anna Beispiel', livetvGroups: null }])).toEqual([]);
  });
});

describe('rolesFor', () => {
  const roles: Parameters<typeof rolesFor>[0] = [
    { key: 'admin', base: 'admin', stored: true, label: 'Admin', builtinLabel: true },
    { key: 'family', base: 'family', stored: true, label: 'Familie', builtinLabel: true },
    { key: 'crew', base: 'friend', stored: false, label: 'Kombüse', builtinLabel: false },
  ];
  it('leaves out the admin (it sees every group) and marks env-only roles read-only', () => {
    expect(rolesFor(roles).map((r) => [r.key, r.readOnly])).toEqual([['family', false], ['crew', true]]);
  });
});

describe('groupError', () => {
  it('turns the backend codes into sentences and an unknown one into the generic text', () => {
    expect(groupError('name_taken')).toBe('Diesen Namen gibt es schon.');
    expect(groupError('admin_groups_locked')).toBe('Admin-Konten bekommen keine Gruppen-Ausnahmen: Sie sehen alle freigegebenen Gruppen.');
    expect(groupError('boom')).toBe('Das hat nicht geklappt.');
  });
});

describe('loadExceptions', () => {
  it('reads the rights of every non-admin account, at most four at a time (ruling R21)', async () => {
    const people = Array.from({ length: 9 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, role: 'friend' }));
    let open = 0, most = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/users?')) return { total: 11, users: [{ id: 'a', name: 'Admin', role: 'admin' }, { id: 'p', name: 'Offen', role: null, pending: true }, ...people] };
      open++; most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      const n = Number(path.split('/users/u')[1]!.slice(0, 1));
      if (n === 3) throw new Error('boom');
      return { livetvGroups: { allow: n === 1 ? [{ id: 'g', name: 'Sport' }] : [], deny: [] } };
    });
    const { rows: out, unread, capped } = await loadExceptions(4);
    expect(unread).toBe(1);
    expect(capped).toBe(false);
    expect(out.map((r) => r.userId)).toEqual(people.map((p) => p.id));
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
    expect(out[3]!.livetvGroups).toBeNull();
    expect(exceptionsOf(out).map((p) => [p.userId, p.plus])).toEqual([['u1', ['Sport']]]);
  });
});

describe('loadExceptions: a long account list', () => {
  it('says so when the list is cut at 500', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => (path.startsWith('/api/admin/users?') ? { total: 501, users: [{ id: 'u1', name: 'Anna', role: 'friend' }] } : { livetvGroups: { allow: [], deny: [] } }));
    expect((await loadExceptions(4)).capped).toBe(true);
  });
});
