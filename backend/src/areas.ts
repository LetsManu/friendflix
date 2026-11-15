// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The areas of the app a role or a person may use (roles redesign spec §2.1): Mediathek, Live-TV, Wünsche, Gemeinsam, Downloads.
 * An area is derived from the effective values, never stored (§2.2): switching one writes the underlying fields. Pure (no imports):
 * the web has its own copy, both tested against test-vectors/areas.json. The coupling "Wünsche, Gemeinsam and Downloads need the
 * Mediathek" (§2.3) is not applied here: the role page enforces it and /api/me.areas ANDs it.
 */
export const AREA_KEYS = ['library', 'livetv', 'requests', 'together', 'downloads'] as const;
export type AreaKey = (typeof AREA_KEYS)[number];
export type Areas = Record<AreaKey, boolean>;

/** a library list that shows anything: 'all' or a non-empty list of names */
export const hasLibrary = (libraries: unknown): boolean => libraries === 'all' || (Array.isArray(libraries) && libraries.length > 0);

/** the areas of a set of effective values (MatrixField keys → value) */
export function areasOf(v: Record<string, unknown>): Areas {
  return {
    library: hasLibrary(v.libraries),
    livetv: v.liveTv === true,
    requests: v.requests === true,
    together: v.party === true || v.comments === true,
    downloads: v.download === true,
  };
}
