// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AREA_KEYS, areasOf, hasLibrary, type Areas } from '../src/areas.js';
import { DEFAULT_PERMS, MATRIX_FIELDS } from '../src/perms.js';
import { defaultLimit } from '../src/requestlimit.js';
import { DEFAULT_ROLES } from '../src/roles.js';

// Roles redesign Task 1: the areas (Mediathek, Live-TV, Wünsche, Gemeinsam, Downloads) are a pure function of the effective values
// (spec §2.1, §2.2); the table is shared with the web test.
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/areas.json', import.meta.url), 'utf8')) as {
  rows: Array<{ name: string; role?: 'family' | 'friend' | 'guest'; values: Record<string, unknown>; areas: Areas }>;
};

/** the code defaults of a built-in role, keyed like the matrix values */
const codeDefaults = (role: 'admin' | 'family' | 'friend' | 'guest'): Record<string, unknown> => {
  const { label: _label, ...template } = DEFAULT_ROLES[role]!;
  return { ...template, ...DEFAULT_PERMS[role], requestsPerMonth: defaultLimit(role) };
};

describe('areas registry', () => {
  it('every MATRIX_FIELDS row has an area and none is planned (liveRecord is visible since Stage 4)', () => {
    const areaOf = Object.fromEntries(MATRIX_FIELDS.map((f) => [f.key, f.area]));
    expect(areaOf).toEqual({
      libraries: 'library', maxParentalRating: 'library', maxBitrate: 'library', remoteMaxBitrate: 'library', transcoding: 'library', maxHeight: 'library',
      liveTv: 'livetv', liveRecord: 'livetv',
      requests: 'requests', requestsPerMonth: 'requests',
      party: 'together', partySchedule: 'together', comments: 'together',
      download: 'downloads', maxDownloads: 'downloads', downloadMaxHeight: 'downloads', downloadDays: 'downloads',
      maxStreams: 'general', cast: 'general',
    });
    expect(MATRIX_FIELDS.filter((f) => f.planned).map((f) => [f.key, f.planned])).toEqual([]);
  });

  it('areasOf follows test-vectors/areas.json', () => {
    expect(vectors.rows.length).toBeGreaterThanOrEqual(7);
    for (const row of vectors.rows) {
      expect(Object.keys(row.areas), row.name).toEqual([...AREA_KEYS]);
      expect(areasOf(row.values), row.name).toEqual(row.areas);
    }
  });

  it('the defaults rows of the table are the code defaults', () => {
    for (const row of vectors.rows.filter((r) => r.role)) expect(row.values, row.name).toEqual(codeDefaults(row.role!));
  });

  it('every built-in role has the Mediathek by default (nobody loses access on upgrade)', () => {
    for (const role of ['admin', 'family', 'friend', 'guest'] as const) expect(areasOf(codeDefaults(role)).library, role).toBe(true);
  });

  it('hasLibrary: all or a non-empty list', () => {
    expect(hasLibrary('all') && hasLibrary(['Filme']) && !hasLibrary([]) && !hasLibrary(null)).toBe(true);
    expect(hasLibrary(undefined)).toBe(false);
    expect(hasLibrary('Filme')).toBe(false);
  });
});
