// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { areasOf } from './areas';
import { compareCell, compareGroups, compareHref, rowKey, rowLabel } from './compare';
import type { MatrixField, MatrixRole, RoleMatrix } from './model';

// Roles redesign Task 12: the read-only compare view (spec §1.1, §5.5): Bereiche first, then the details grouped by area; every
// cell names its role, its right and its value and links to the role page at that right; the admin role's switches are locked.

afterEach(async () => { await setLocale('de'); });

const F = (key: string, kind: MatrixField['kind'], area: MatrixField['area'], extra: Partial<MatrixField> = {}): MatrixField => ({ key, group: 'access', kind, area, ...extra });
const fields: MatrixField[] = [
  F('libraries', 'libraries', 'library'), F('maxParentalRating', 'rating', 'library'), F('maxStreams', 'int', 'general'),
  F('download', 'bool', 'downloads'), F('maxDownloads', 'int', 'downloads'),
  F('requests', 'bool', 'requests', { requires: 'requests' }), F('requestsPerMonth', 'int', 'requests', { requires: 'requests' }),
  F('party', 'bool', 'together'), F('comments', 'bool', 'together'), F('cast', 'bool', 'general', { requires: 'cast' }),
  F('liveTv', 'bool', 'livetv', { requires: 'livetv' }), F('liveRecord', 'bool', 'livetv', { requires: 'livetv' }),
];
const FULL = { libraries: 'all', maxParentalRating: 12, maxStreams: 2, download: true, maxDownloads: 5, requests: true, requestsPerMonth: 3, party: true, comments: true, cast: true, liveTv: true, liveRecord: false };
const role = (key: string, values: Record<string, unknown>, extra: Partial<MatrixRole> = {}): MatrixRole => ({
  key, label: key === 'friend' ? 'Freund' : key, builtinLabel: false, base: 'friend', origin: 'admin', invitable: true, position: 0, accounts: 1, profiles: 1, kidsProfiles: 0,
  values, sources: {}, defaults: { ...values }, envGone: false, stored: true, missingLibraries: [], areas: areasOf(values), livetvGroups: [], livetvGroupIds: [], ...extra,
});
const matrix = (features = { requests: true, cast: true, livetv: true }): RoleMatrix => ({
  fields, features, libraries: [], roles: [], livetv: features.livetv ? { groups: [], pending: 0 } : null, templates: [],
});

describe('compareGroups', () => {
  it('Bereiche first (the areas this server has), then each area\'s details without its own switch, then Allgemein; the groups row ends Live-TV', () => {
    const g = compareGroups(matrix());
    expect(g.map((x) => x.id)).toEqual(['areas', 'library', 'livetv', 'requests', 'together', 'downloads', 'general']);
    expect(g[0]!.rows.map(rowKey)).toEqual(['area:library', 'area:livetv', 'area:requests', 'area:together', 'area:downloads']);
    expect(g.find((x) => x.id === 'livetv')!.rows.map(rowKey)).toEqual(['liveRecord', 'livetvGroups']);
    expect(g.find((x) => x.id === 'downloads')!.rows.map(rowKey)).toEqual(['maxDownloads']);
    expect(g.find((x) => x.id === 'general')!.rows.map(rowKey)).toEqual(['maxStreams', 'cast']);
  });
  it('without Live TV and a request service: neither their areas nor their rows', () => {
    const g = compareGroups(matrix({ requests: false, cast: false, livetv: false }));
    expect(g.map((x) => x.id)).toEqual(['areas', 'library', 'together', 'downloads', 'general']);
    expect(g[0]!.rows.map(rowKey)).toEqual(['area:library', 'area:together', 'area:downloads']);
    expect(g.find((x) => x.id === 'general')!.rows.map(rowKey)).toEqual(['maxStreams']);
  });
  it('a group whose area has no detail rows is left out (Wünsche without its number)', () => {
    const m = { ...matrix(), fields: fields.filter((f) => f.key !== 'requestsPerMonth') };
    expect(compareGroups(m).map((x) => x.id)).not.toContain('requests');
  });
});

describe('row labels and links', () => {
  it('labels: the area, the field, the channel groups', () => {
    const g = compareGroups(matrix());
    expect(rowLabel(g[0]!.rows[1]!)).toBe('Live-TV');
    expect(rowLabel(g.find((x) => x.id === 'livetv')!.rows[0]!)).toBe('Darf aufnehmen');
    expect(rowLabel(g.find((x) => x.id === 'livetv')!.rows[1]!)).toBe('Kanalgruppen');
  });
  it('compareHref: the role page with ?field= (encoded)', () => {
    expect(compareHref(role('Küche Crew', FULL), 'area:downloads')).toBe('/admin/roles/K%C3%BCche%20Crew?field=area%3Adownloads');
    expect(compareHref(role('guest', FULL), 'maxParentalRating')).toBe('/admin/roles/guest?field=maxParentalRating');
  });
});

describe('compareCell', () => {
  const m = matrix();
  const g = compareGroups(m);
  const row = (key: string) => g.flatMap((x) => x.rows).find((r) => rowKey(r) === key)!;

  it('an area: coupled (no library: Wünsche reads off), ✓ / – in words, a link', () => {
    const r = role('friend', { ...FULL, libraries: [] });
    const lib = compareCell(m, r, row('area:library'));
    expect(lib).toMatchObject({ bool: true, value: false, text: '–', locked: false, href: '/admin/roles/friend?field=area%3Alibrary' });
    expect(lib.name).toBe('Freund, Mediathek: nicht erlaubt');
    expect(lib.label).toBe('Freund, Mediathek: nicht erlaubt, bearbeiten');
    expect(compareCell(m, r, row('area:requests'))).toMatchObject({ value: false, text: '–' });
    expect(compareCell(m, r, row('area:livetv'))).toMatchObject({ value: true, text: '✓', name: 'Freund, Live-TV: erlaubt' });
  });
  it('an area without the server\'s areas answer falls back to the values', () => {
    const r = role('friend', FULL, { areas: undefined });
    expect(compareCell(m, r, row('area:downloads')).value).toBe(true);
  });
  it('a field: its text, set in the role ("geändert") or from .env', () => {
    const r = role('friend', FULL, { sources: { maxParentalRating: 'role', maxStreams: 'env' } });
    const c = compareCell(m, r, row('maxParentalRating'));
    expect(c).toMatchObject({ bool: false, text: 'ab 12', src: 'role', locked: false, name: 'Freund, Altersfreigabe: ab 12, geändert' });
    expect(compareCell(m, r, row('maxStreams'))).toMatchObject({ src: 'env', name: 'Freund, Gleichzeitige Streams: 2' });
    expect(compareCell(m, r, row('liveRecord'))).toMatchObject({ bool: true, value: false, name: 'Freund, Darf aufnehmen: nicht erlaubt' });
    // coupled as the role page shows it: Darf aufnehmen reads off while Live-TV is off, the comments without a library
    const off = role('friend', { ...FULL, liveTv: false, liveRecord: true, libraries: [] });
    expect(compareCell(m, off, row('liveRecord')).value).toBe(false);
    expect(compareCell(m, off, row('comments')).value).toBe(false);
    expect(compareCell(m, role('friend', { ...FULL, liveRecord: true }), row('liveRecord')).value).toBe(true);
  });
  it('the admin role: switches and areas locked (no link), numbers link', () => {
    const a = role('admin', FULL, { base: 'admin', label: 'Admin' });
    expect(compareCell(m, a, row('party'))).toMatchObject({ locked: true, href: null, label: 'Admin, Watch-Partys: erlaubt' });
    expect(compareCell(m, a, row('area:library'))).toMatchObject({ locked: true, href: null });
    expect(compareCell(m, a, row('maxStreams'))).toMatchObject({ locked: false, href: '/admin/roles/admin?field=maxStreams' });
  });
  it('the channel groups: names (two, then +n), "Keine" without', () => {
    const r = role('friend', FULL, { livetvGroups: ['Nordlicht TV', 'Hafenkanal', 'Sport'] });
    expect(compareCell(m, r, row('livetvGroups'))).toMatchObject({ bool: false, text: 'Nordlicht TV, Hafenkanal +1', name: 'Freund, Kanalgruppen: Nordlicht TV, Hafenkanal +1', href: '/admin/roles/friend?field=livetvGroups' });
    expect(compareCell(m, role('friend', FULL, { livetvGroups: undefined }), row('livetvGroups')).text).toBe('Keine');
  });
  it('follows the language', async () => {
    await setLocale('en');
    const r = role('friend', FULL);
    expect(compareCell(m, r, row('area:library')).label).toBe('Freund, Library: allowed, edit');
  });
});
