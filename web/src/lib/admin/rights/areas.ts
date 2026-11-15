// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The areas of a role on the web (roles redesign spec §2): Mediathek, Live-TV, Wünsche, Gemeinsam, Downloads. An area is derived
 * from the effective values (`areasOf`, the twin of backend/src/areas.ts; both follow test-vectors/areas.json) and switching one
 * stages the underlying fields (§2.3) into the same `Stage` as every other edit, so review, discard and save stay as they are.
 *
 * The coupling (§2.3): Wünsche, Gemeinsam and Downloads need the Mediathek. `areasOf` does not apply it (like the backend); the
 * role page does: `stageArea` and `stageField` never stage one of them on without a library, switching the Mediathek off (or
 * unticking the last library) stages them off with it, and `stagedAreas` shows them off while the Mediathek is off.
 */
import type { AreaKey, Areas } from '#lib/capabilities';
import { tr } from '#lib/i18n';
import { stageSet, visibleFields, type Feature, type MatrixField, type MatrixRole, type RoleMatrix, type Stage } from './model';

export const AREA_KEYS = ['library', 'livetv', 'requests', 'together', 'downloads'] as const satisfies readonly AreaKey[];
export type { AreaKey, Areas };

/** a library list that shows anything: 'all' or a non-empty list of names */
export const hasLibrary = (libraries: unknown): boolean => libraries === 'all' || (Array.isArray(libraries) && libraries.length > 0);

/** the areas of a set of effective values (MatrixField keys → value), §2.1; no coupling (see `withCoupling`) */
export function areasOf(v: Record<string, unknown>): Areas {
  return {
    library: hasLibrary(v.libraries),
    livetv: v.liveTv === true,
    requests: v.requests === true,
    together: v.party === true || v.comments === true,
    downloads: v.download === true,
  };
}

/** the areas that need the Mediathek */
export const NEEDS_LIBRARY: ReadonlySet<AreaKey> = new Set<AreaKey>(['requests', 'together', 'downloads']);
/** the switches those areas consist of: none of them goes on without a library */
const COUPLED_FIELDS: ReadonlySet<string> = new Set(['requests', 'party', 'partySchedule', 'comments', 'download']);
/** the field that is an area's own switch (its card): not listed again in the area's section */
const AREA_SWITCH: ReadonlySet<string> = new Set(['liveTv', 'requests', 'download']);

/** what switching an area off stages (§2.3) */
const OFF: Record<AreaKey, Record<string, unknown>> = {
  library: { libraries: [], requests: false, party: false, partySchedule: false, comments: false, download: false },
  livetv: { liveTv: false },
  requests: { requests: false },
  together: { party: false, partySchedule: false, comments: false },
  downloads: { download: false },
};
/** what switching it on stages for a role saved with the area off (the Mediathek's libraries come from the role's defaults) */
const ON: Record<Exclude<AreaKey, 'library'>, Record<string, unknown>> = {
  livetv: { liveTv: true },
  requests: { requests: true },
  together: { party: true, comments: true },
  downloads: { download: true },
};

/** the areas as the app offers them: without the Mediathek, Wünsche, Gemeinsam and Downloads are off (as /api/me.areas ANDs them) */
export const withCoupling = (a: Areas): Areas => (a.library ? a : { ...a, requests: false, together: false, downloads: false });

/** the role's values with its staged ones on top (what saving would leave) */
export const stagedValues = (s: Stage, r: MatrixRole): Record<string, unknown> => ({ ...r.values, ...s[r.key] });

/** the areas as the role page shows them: the staged values, coupled */
export const stagedAreas = (s: Stage, r: MatrixRole): Areas => withCoupling(areasOf(stagedValues(s, r)));

/** the staged entries `keys` of a role dropped: back to the loaded values */
function unstage(s: Stage, role: string, keys: readonly string[]): Stage {
  const cur = s[role];
  if (!cur || !keys.some((k) => Object.hasOwn(cur, k))) return s;
  const { [role]: _drop, ...others } = s;
  const rest = Object.fromEntries(Object.entries(cur).filter(([k]) => !keys.includes(k)));
  return Object.keys(rest).length ? { ...others, [role]: rest } : others;
}

/**
 * An area switched on or off (§2.3), as staged values. Off stages the area's fields off (the Mediathek takes the three areas
 * that need it along). On first drops what an earlier off staged, so off and on again in one session leaves the loaded values;
 * only a role saved with the area off gets the on values (the Mediathek: the role's default libraries, else all). An area that
 * needs the Mediathek does not go on without it, and the admin role's areas are locked: the stage comes back unchanged.
 */
export function stageArea(s: Stage, m: RoleMatrix, r: MatrixRole, area: AreaKey, on: boolean): Stage {
  if (r.base === 'admin') return s;
  if (on && NEEDS_LIBRARY.has(area) && !stagedAreas(s, r).library) return s;
  if (!on) return Object.entries(OFF[area]).reduce((acc, [k, v]) => stageSet(acc, m, r.key, k, v), s);
  const next = unstage(s, r.key, Object.keys(OFF[area]));
  if (areasOf(r.values)[area]) return next;
  if (area === 'library') return stageSet(next, m, r.key, 'libraries', hasLibrary(r.defaults.libraries) ? r.defaults.libraries : 'all');
  return Object.entries(ON[area]).reduce((acc, [k, v]) => stageSet(acc, m, r.key, k, v), next);
}

/**
 * One field edited on the role page, coupled: no library left is the Mediathek switched off (with what needs it), and a switch
 * of Wünsche, Gemeinsam or Downloads does not go on while the Mediathek is off. Everything else is a plain `stageSet`.
 */
export function stageField(s: Stage, m: RoleMatrix, r: MatrixRole, key: string, v: unknown): Stage {
  if (v === true && COUPLED_FIELDS.has(key) && !stagedAreas(s, r).library) return s;
  // the admin role keeps a library (the server refuses none, admin_library_required); its areas are locked
  if (key === 'libraries' && !hasLibrary(v) && r.base !== 'admin') return stageArea(s, m, r, 'library', false);
  return stageSet(s, m, r.key, key, v);
}

/** why an area's switch is locked: the admin role (always everything), or the Mediathek is off; null = it can be switched */
export function areaDisabled(r: Pick<MatrixRole, 'base'>, area: AreaKey, staged: Areas): 'needsLibrary' | 'admin' | null {
  if (r.base === 'admin') return 'admin';
  if (NEEDS_LIBRARY.has(area) && !staged.library) return 'needsLibrary';
  return null;
}

/** the areas this server has: Wünsche only with a request service, Live-TV only while it is installed (as the matrix rows' `requires`) */
export const shownAreas = (features: Record<Feature, boolean>): AreaKey[] =>
  AREA_KEYS.filter((k) => (k === 'requests' ? features.requests : k === 'livetv' ? features.livetv : true));

export const areaLabel = (k: AreaKey): string => tr(`adminPeople.roles.areas.${k}`);

/** the list's line: "Mediathek · Live-TV · Wünsche", "Nur Live-TV", "Nichts freigegeben" (coupled, only the areas this server has) */
export function areaSummary(areas: Areas, features: Record<Feature, boolean>): string {
  const a = withCoupling(areas);
  const on = shownAreas(features).filter((k) => a[k]);
  if (!on.length) return tr('adminPeople.roles.summary.none');
  if (on.length === 1) return tr('adminPeople.roles.summary.only', { area: areaLabel(on[0]!) });
  return on.map(areaLabel).join(' · ');
}

/** the detail fields of an area's section (its own switch is the area card), or of *Allgemein*; planned and feature-less fields are not listed */
export const fieldsOfArea = (m: RoleMatrix, area: AreaKey | 'general'): MatrixField[] =>
  visibleFields(m).filter((f) => f.area === area && !AREA_SWITCH.has(f.key));
