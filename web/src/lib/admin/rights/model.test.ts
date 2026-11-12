// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import {
  cellName, cellText, reviewLines, stageBodies, stageCounts, stageSet, summaryLine, visibleFields,
  type MatrixField, type MatrixRole, type RoleMatrix, type Stage,
} from './model';

afterEach(async () => { await setLocale('de'); });

const F = (key: string, kind: MatrixField['kind'], extra: Partial<MatrixField> = {}): MatrixField => ({ key, group: 'access', kind, ...extra });
const fields: MatrixField[] = [
  F('libraries', 'libraries'), F('maxParentalRating', 'rating', { options: [null, 0, 6, 12, 16, 18] }), F('maxStreams', 'int', { group: 'playback' }),
  F('maxBitrate', 'bitrate', { group: 'playback' }), F('maxHeight', 'height', { group: 'playback' }), F('download', 'bool', { group: 'downloads' }),
  F('requests', 'bool', { group: 'requests', requires: 'requests' }), F('party', 'bool', { group: 'together' }),
  F('liveTv', 'bool', { group: 'livetv', requires: 'livetv' }),
];
const role = (key: string, label: string | null, accounts: number, profiles: number, values: Record<string, unknown>): MatrixRole => ({
  key, label, builtinLabel: true, base: 'guest', origin: 'code', invitable: true, position: 0, accounts, profiles, kidsProfiles: 0, values,
  sources: {}, missingLibraries: [],
});
const matrix = (features = { requests: false, cast: false, livetv: false }): RoleMatrix => ({
  fields, features, libraries: [{ id: 'l1', name: 'Filme' }, { id: 'l2', name: 'Serien' }, { id: 'l3', name: 'Musik' }],
  roles: [
    role('guest', 'Gast', 4, 5, { libraries: 'all', maxParentalRating: 12, maxStreams: 1, maxBitrate: 8_000_000, maxHeight: 1080, download: false, requests: true, party: false, liveTv: false }),
    role('friend', 'Freund', 7, 9, { libraries: ['Filme'], maxParentalRating: null, maxStreams: 2, maxBitrate: 20_000_000, maxHeight: null, download: true, requests: true, party: true, liveTv: false }),
  ],
});

describe('cellText', () => {
  const m = matrix();
  const f = (k: string) => fields.find((x) => x.key === k)!;
  it.each([
    ['download', true, '✓'], ['download', false, '–'], ['maxStreams', 2, '2'],
    ['maxBitrate', 8_000_000, '8 Mbit/s'], ['maxBitrate', 1_500_000, '1,5 Mbit/s'], ['maxBitrate', 20_000_000, '20 Mbit/s'],
    ['maxHeight', 1080, '1080p'], ['maxHeight', null, 'alle'], ['maxParentalRating', 12, 'ab 12'], ['maxParentalRating', null, 'alle'],
    ['libraries', 'all', 'alle'], ['libraries', ['a', 'b', 'c'], '3 Bibliotheken'], ['libraries', ['a'], '1 Bibliothek'],
  ])('%s %j -> %s', (k, v, out) => { expect(cellText(f(k), v, m.libraries.length)).toBe(out); });
  it('english', async () => {
    await setLocale('en');
    expect(cellText(f('maxBitrate'), 1_500_000, 3)).toBe('1.5 Mbit/s');
    expect(cellText(f('maxParentalRating'), 16, 3)).toBe('from 16');
  });
});

describe('cellName', () => {
  it('accessible name with the changed marker', () => {
    const f = fields.find((x) => x.key === 'maxParentalRating')!;
    expect(cellName('Gast', f, 12, true)).toBe('Gast, Altersfreigabe: ab 12, geändert');
    expect(cellName('Gast', f, 12, false)).toBe('Gast, Altersfreigabe: ab 12');
  });
});

describe('staging', () => {
  const m = matrix();
  it('stageSet back to the loaded value clears it', () => {
    let s: Stage = stageSet({}, m, 'guest', 'maxParentalRating', 16);
    expect(s).toEqual({ guest: { maxParentalRating: 16 } });
    s = stageSet(s, m, 'guest', 'maxParentalRating', 12);
    expect(s).toEqual({});
  });
  it('does not mutate and compares library lists as sets', () => {
    const s0: Stage = {};
    stageSet(s0, m, 'guest', 'party', true);
    expect(s0).toEqual({});
    const a = stageSet({}, m, 'friend', 'libraries', ['Serien']);
    expect(stageSet(a, m, 'friend', 'libraries', ['Filme'])).toEqual({});
  });
  const s3: Stage = { guest: { maxParentalRating: 16, party: true }, friend: { maxStreams: 3 } };
  it('stageCounts', () => {
    expect(stageCounts(s3, m)).toEqual({ changes: 3, roles: 2, people: 11, profiles: 14, policy: true });
    expect(stageCounts({ guest: { party: true } }, m)).toEqual({ changes: 1, roles: 1, people: 4, profiles: 5, policy: false });
    expect(stageCounts({}, m)).toEqual({ changes: 0, roles: 0, people: 0, profiles: 0, policy: false });
  });
  it('stageBodies nests perms and writes unlimited caps as "unlimited"', () => {
    expect(stageBodies({ guest: { maxParentalRating: null, party: true, requests: false, maxStreams: 3 }, friend: { maxHeight: null, requestsPerMonth: null } })).toEqual({
      guest: { maxParentalRating: 'unlimited', maxStreams: 3, perms: { party: true, requests: false } },
      friend: { maxHeight: 'unlimited', requestsPerMonth: 'unlimited' },
    });
  });
  it('reviewLines', () => {
    expect(reviewLines({ guest: { maxParentalRating: 16, download: true } }, m)).toEqual([
      { role: 'Gast', field: 'Altersfreigabe', from: 'ab 12', to: 'ab 16' },
      { role: 'Gast', field: 'Downloads erlaubt', from: '–', to: '✓' },
    ]);
  });
});

describe('visibleFields', () => {
  it('hides requests without the service and Live TV always', () => {
    expect(visibleFields(matrix()).map((f) => f.key)).toEqual(['libraries', 'maxParentalRating', 'maxStreams', 'maxBitrate', 'maxHeight', 'download', 'party']);
    expect(visibleFields(matrix({ requests: true, cast: true, livetv: false })).map((f) => f.key)).toContain('requests');
    expect(visibleFields(matrix({ requests: true, cast: true, livetv: false })).map((f) => f.key)).not.toContain('liveTv');
  });
});

describe('summaryLine', () => {
  const r = matrix().roles[0]!;
  it('de', () => { expect(summaryLine(r)).toBe('1 Stream · 8 Mbit/s · ab 12 · Downloads aus'); });
  it('en', async () => {
    await setLocale('en');
    expect(summaryLine({ ...r, values: { ...r.values, maxStreams: 2, maxBitrate: 20_000_000, download: true } })).toBe('2 streams · 20 Mbit/s · from 12 · Downloads on');
  });
});
