// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import type { Areas } from '#lib/capabilities';
import { AREA_KEYS, areaDisabled, areaSummary, areasOf, fieldsOfArea, hasLibrary, stageArea, stagedAreas, stagedValues, stageField } from './areas';
import { stageSet, type MatrixField, type MatrixRole, type RoleMatrix, type Stage } from './model';

// Roles redesign Task 9: the areas on the web (spec §2.1-§2.4). areasOf is the backend's twin: both follow test-vectors/areas.json.
const vectors = JSON.parse(readFileSync(new URL('../../../../../test-vectors/areas.json', import.meta.url), 'utf8')) as {
  rows: Array<{ name: string; values: Record<string, unknown>; areas: Areas }>;
};

afterEach(async () => { await setLocale('de'); });

const F = (key: string, kind: MatrixField['kind'], area: MatrixField['area'], extra: Partial<MatrixField> = {}): MatrixField => ({ key, group: 'access', kind, area, ...extra });
/** backend MATRIX_FIELDS in order, with their areas */
const fields: MatrixField[] = [
  F('libraries', 'libraries', 'library'), F('maxParentalRating', 'rating', 'library', { options: [null, 0, 6, 12, 16, 18] }), F('maxStreams', 'int', 'general', { min: 1, max: 50 }),
  F('maxBitrate', 'bitrate', 'library'), F('remoteMaxBitrate', 'bitrate', 'library'), F('transcoding', 'bool', 'library'), F('maxHeight', 'height', 'library'),
  F('download', 'bool', 'downloads'), F('maxDownloads', 'int', 'downloads'), F('downloadMaxHeight', 'height', 'downloads'), F('downloadDays', 'int', 'downloads'),
  F('requests', 'bool', 'requests', { requires: 'requests' }), F('requestsPerMonth', 'int', 'requests', { requires: 'requests', options: [null] }),
  F('party', 'bool', 'together'), F('partySchedule', 'bool', 'together'), F('comments', 'bool', 'together'), F('cast', 'bool', 'general', { requires: 'cast' }),
  F('liveTv', 'bool', 'livetv', { requires: 'livetv' }), F('liveRecord', 'bool', 'livetv', { requires: 'livetv', planned: 'recordings' }),
];
const FULL = {
  libraries: 'all', maxParentalRating: null, maxStreams: 2, maxBitrate: 20_000_000, remoteMaxBitrate: 8_000_000, transcoding: true, maxHeight: null,
  download: true, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30, requests: true, requestsPerMonth: 2, party: true, partySchedule: true, comments: true,
  cast: true, liveTv: true, liveRecord: true,
};
const role = (key: string, values: Record<string, unknown>, extra: Partial<MatrixRole> = {}): MatrixRole => ({
  key, label: key, builtinLabel: false, base: 'friend', origin: 'admin', invitable: true, position: 0, accounts: 1, profiles: 1, kidsProfiles: 0,
  values, sources: {}, defaults: { ...values }, envGone: false, stored: true, missingLibraries: [], areas: areasOf(values), livetvGroups: [], livetvGroupIds: [], ...extra,
});
const matrix = (): RoleMatrix => ({
  fields, features: { requests: true, cast: true, livetv: true }, libraries: [{ id: 'l1', name: 'Filme' }, { id: 'l2', name: 'Serien' }],
  roles: [
    role('friend', { ...FULL }),
    role('admin', { ...FULL }, { base: 'admin' }),
    // saved without a library; its default (the base's) has two
    role('liveonly', { ...FULL, libraries: [], download: false, requests: false, party: false, partySchedule: false, comments: false }, { defaults: { ...FULL, libraries: ['Filme', 'Serien'] } }),
    role('bare', { ...FULL, libraries: [], download: false, requests: false, party: false, partySchedule: false, comments: false, liveTv: false }, { defaults: { ...FULL, libraries: [] } }),
    role('quiet', { ...FULL, party: false, partySchedule: true, comments: false }),
  ],
  livetv: { groups: [], pending: 0 }, templates: [],
});
const R = (m: RoleMatrix, key: string) => m.roles.find((r) => r.key === key)!;

describe('areasOf', () => {
  it('matches test-vectors/areas.json', () => {
    expect(vectors.rows.length).toBeGreaterThanOrEqual(7);
    for (const row of vectors.rows) {
      expect(Object.keys(row.areas), row.name).toEqual([...AREA_KEYS]);
      expect(areasOf(row.values), row.name).toEqual(row.areas);
    }
  });
  it('hasLibrary: all or a non-empty list', () => {
    expect([hasLibrary('all'), hasLibrary(['Filme']), hasLibrary([]), hasLibrary(null), hasLibrary(undefined)]).toEqual([true, true, false, false, false]);
  });
});

describe('stageArea (spec §2.3)', () => {
  const m = matrix();
  it('library off stages libraries [], requests/party/partySchedule/comments/download false', () => {
    expect(stageArea({}, m, R(m, 'friend'), 'library', false)).toEqual({
      friend: { libraries: [], requests: false, party: false, partySchedule: false, comments: false, download: false },
    });
  });
  it('library on again in the same session unstages everything it staged', () => {
    const off = stageArea({}, m, R(m, 'friend'), 'library', false);
    expect(stageArea(off, m, R(m, 'friend'), 'library', true)).toEqual({});
    // another role's staged values stay
    const two = stageSet(off, m, 'quiet', 'maxStreams', 5);
    expect(stageArea(two, m, R(m, 'friend'), 'library', true)).toEqual({ quiet: { maxStreams: 5 } });
  });
  it('library on for a role saved with [] stages defaults.libraries or \'all\'', () => {
    expect(stageArea({}, m, R(m, 'liveonly'), 'library', true)).toEqual({ liveonly: { libraries: ['Filme', 'Serien'] } });
    expect(stageArea({}, m, R(m, 'bare'), 'library', true)).toEqual({ bare: { libraries: 'all' } });
  });
  it('together on stages party and comments true, leaves partySchedule', () => {
    expect(stageArea({}, m, R(m, 'quiet'), 'together', true)).toEqual({ quiet: { party: true, comments: true } });
    const off = stageArea({}, m, R(m, 'friend'), 'together', false);
    expect(off).toEqual({ friend: { party: false, partySchedule: false, comments: false } });
    expect(stageArea(off, m, R(m, 'friend'), 'together', true)).toEqual({});
  });
  it('the single-switch areas stage their switch', () => {
    expect(stageArea({}, m, R(m, 'friend'), 'livetv', false)).toEqual({ friend: { liveTv: false } });
    expect(stageArea({}, m, R(m, 'friend'), 'requests', false)).toEqual({ friend: { requests: false } });
    expect(stageArea({}, m, R(m, 'friend'), 'downloads', false)).toEqual({ friend: { download: false } });
    expect(stageArea({}, m, R(m, 'bare'), 'livetv', true)).toEqual({ bare: { liveTv: true } });
  });
  it('an area that needs the Mediathek cannot be switched on while it is off', () => {
    const off = stageArea({}, m, R(m, 'friend'), 'library', false);
    for (const a of ['requests', 'together', 'downloads'] as const) expect(stageArea(off, m, R(m, 'friend'), a, true), a).toBe(off);
    expect(stageArea({}, m, R(m, 'liveonly'), 'downloads', true)).toEqual({});
  });
  it('the admin role\'s areas are locked: nothing stages', () => {
    expect(stageArea({}, m, R(m, 'admin'), 'library', false)).toEqual({});
  });
});

describe('stageField keeps the coupling', () => {
  const m = matrix();
  it('no library ticked is the Mediathek switched off', () => {
    expect(stageField({}, m, R(m, 'friend'), 'libraries', [])).toEqual(stageArea({}, m, R(m, 'friend'), 'library', false));
    expect(stageField({}, m, R(m, 'friend'), 'libraries', ['Filme'])).toEqual({ friend: { libraries: ['Filme'] } });
  });
  it('a coupled switch cannot go on without the Mediathek', () => {
    const off = stageArea({}, m, R(m, 'friend'), 'library', false);
    for (const k of ['requests', 'party', 'partySchedule', 'comments', 'download']) expect(stageField(off, m, R(m, 'friend'), k, true), k).toBe(off);
    expect(stageField(off, m, R(m, 'friend'), 'maxStreams', 4)).toEqual({ friend: { ...off.friend, maxStreams: 4 } });
  });
});

describe('Review Focus 5: only coupled states can be staged', () => {
  type Op = { area: (typeof AREA_KEYS)[number]; on: boolean } | { key: string; v: unknown };
  const OPS: Op[] = [
    ...AREA_KEYS.flatMap((area) => [{ area, on: true }, { area, on: false }]),
    { key: 'libraries', v: [] }, { key: 'libraries', v: ['Filme'] }, { key: 'libraries', v: 'all' },
    { key: 'party', v: true }, { key: 'comments', v: true }, { key: 'download', v: true }, { key: 'requests', v: true }, { key: 'partySchedule', v: true },
  ];
  /** Mediathek off ⇒ Wünsche, Gemeinsam, Downloads off (on the values as they would be saved) */
  const coupled = (v: Record<string, unknown>) => hasLibrary(v.libraries) || [v.requests, v.party, v.partySchedule, v.comments, v.download].every((x) => x !== true);
  it('every sequence of up to three switches and field edits from a coupled role stays coupled', () => {
    const m = matrix();
    let checked = 0;
    for (const key of ['friend', 'liveonly', 'bare', 'quiet']) {
      const r = R(m, key);
      const walk = (s: Stage, depth: number, path: string[]) => {
        const v = stagedValues(s, r);
        expect(coupled(v), `${key}: ${path.join(' → ')}`).toBe(true);
        const a = stagedAreas(s, r);
        if (!a.library) expect([a.requests, a.together, a.downloads], `${key}: ${path.join(' → ')}`).toEqual([false, false, false]);
        checked++;
        if (depth === 3) return;
        for (const op of OPS) {
          const next = 'area' in op ? stageArea(s, m, r, op.area, op.on) : stageField(s, m, r, op.key, op.v);
          walk(next, depth + 1, [...path, 'area' in op ? `${op.area} ${op.on ? 'an' : 'aus'}` : `${op.key}=${JSON.stringify(op.v)}`]);
        }
      };
      walk({}, 0, []);
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe('areaDisabled', () => {
  const m = matrix();
  it('areaDisabled(requests) is needsLibrary while library is staged off; admin areas are \'admin\'', () => {
    const f = R(m, 'friend');
    const off = stageArea({}, m, f, 'library', false);
    expect(areaDisabled(f, 'requests', stagedAreas(off, f))).toBe('needsLibrary');
    expect(areaDisabled(f, 'together', stagedAreas(off, f))).toBe('needsLibrary');
    expect(areaDisabled(f, 'downloads', stagedAreas(off, f))).toBe('needsLibrary');
    expect(areaDisabled(f, 'livetv', stagedAreas(off, f))).toBeNull();
    expect(areaDisabled(f, 'library', stagedAreas(off, f))).toBeNull();
    expect(areaDisabled(f, 'requests', stagedAreas({}, f))).toBeNull();
    for (const a of AREA_KEYS) expect(areaDisabled(R(m, 'admin'), a, stagedAreas({}, R(m, 'admin')))).toBe('admin');
  });
  it('stagedAreas shows the coupled areas off while the Mediathek is off', () => {
    const r = role('odd', { ...FULL, libraries: [] }); // e.g. from an old .env: a switch on without a library
    expect(stagedAreas({}, r)).toEqual({ library: false, livetv: true, requests: false, together: false, downloads: false });
  });
});

describe('areaSummary', () => {
  const all = { requests: true, cast: true, livetv: true };
  const A = (on: string[]): Areas => Object.fromEntries(AREA_KEYS.map((k) => [k, on.includes(k)])) as Areas;
  it('names the areas in order', () => {
    expect(areaSummary(A(['library', 'livetv', 'requests']), all)).toBe('Mediathek · Live-TV · Wünsche');
    expect(areaSummary(A([...AREA_KEYS]), all)).toBe('Mediathek · Live-TV · Wünsche · Gemeinsam · Downloads');
  });
  it('only livetv → "Nur Live-TV"; none → "Nichts freigegeben"', () => {
    expect(areaSummary(A(['livetv']), all)).toBe('Nur Live-TV');
    expect(areaSummary(A([]), all)).toBe('Nichts freigegeben');
  });
  it('requests hidden without the request feature; Live-TV hidden when it is not installed', () => {
    expect(areaSummary(A(['library', 'requests']), { ...all, requests: false })).toBe('Nur Mediathek');
    expect(areaSummary(A(['library', 'livetv']), { ...all, livetv: false })).toBe('Nur Mediathek');
    expect(areaSummary(A(['livetv']), { ...all, livetv: false })).toBe('Nichts freigegeben');
  });
  it('the coupling: without the Mediathek nothing that needs it is named', () => {
    expect(areaSummary(A(['livetv', 'requests', 'downloads']), all)).toBe('Nur Live-TV');
  });
  it('english', async () => {
    await setLocale('en');
    expect(areaSummary(A(['livetv']), all)).toBe('Only Live TV');
    expect(areaSummary(A([]), all)).toBe('Nothing shared');
    expect(areaSummary(A(['library', 'together']), all)).toBe('Library · Together');
  });
});

describe('fieldsOfArea', () => {
  const m = matrix();
  it('the detail fields of each area (its own switch is the area switch), Allgemein for the rest', () => {
    expect(fieldsOfArea(m, 'library').map((f) => f.key)).toEqual(['libraries', 'maxParentalRating', 'maxBitrate', 'remoteMaxBitrate', 'transcoding', 'maxHeight']);
    expect(fieldsOfArea(m, 'downloads').map((f) => f.key)).toEqual(['maxDownloads', 'downloadMaxHeight', 'downloadDays']);
    expect(fieldsOfArea(m, 'requests').map((f) => f.key)).toEqual(['requestsPerMonth']);
    expect(fieldsOfArea(m, 'together').map((f) => f.key)).toEqual(['party', 'partySchedule', 'comments']);
    expect(fieldsOfArea(m, 'livetv').map((f) => f.key)).toEqual([]); // liveRecord is planned: hidden
    expect(fieldsOfArea(m, 'general').map((f) => f.key)).toEqual(['maxStreams', 'cast']);
  });
  it('a field whose feature is off is not listed', () => {
    expect(fieldsOfArea({ ...m, features: { requests: false, cast: false, livetv: true } }, 'general').map((f) => f.key)).toEqual(['maxStreams']);
  });
});
