// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The Rechte tab of a person (GET/PUT /api/admin/users/:id/rights, backend userRights.ts): row shapes, the three-way state, the PUT patch. */
import { tr } from '#lib/i18n';

export type RightSource = 'default' | 'env' | 'role' | 'user' | 'kids' | 'admin';
export interface RightsRow {
  key: string;
  /** effective value (matrix encoding: null = no cap) */
  value: unknown;
  roleValue: unknown;
  /** stored exception in the PUT encoding ('unlimited' = lifted cap); null = none (an admin's switches never show one) */
  override?: unknown;
  source: RightSource;
}
export interface RightsView {
  role: string;
  note: string | null;
  rows: RightsRow[];
  profile: { id: string; name: string; kids: boolean; maxRating: number | null } | null;
  hardKids: string[];
  /** library names of the effective list the media server no longer has */
  missingLibraries: string[];
}
export type Tri = 'role' | 'allow' | 'deny';
export const NOTE_MAX = 200;

/** the three-way state of a switch row: the stored exception (none = as role) */
export const triOf = (row: Pick<RightsRow, 'override'>): Tri => (row.override === true ? 'allow' : row.override === false ? 'deny' : 'role');

const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const set = (x: unknown[]) => [...new Set(x.map((n) => String(n).toLowerCase()))].sort();
    const sa = set(a), sb = set(b);
    return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
  }
  return Object.is(a ?? null, b ?? null);
};
/** a PUT value in the effective encoding (null = no cap) */
const effective = (v: unknown): unknown => (v === 'unlimited' ? null : v);

/** the value the control shows: the staged one, else the stored exception, else the effective value; a staged null = as role */
export function stagedValue(row: RightsRow, staged: Record<string, unknown>): unknown {
  if (Object.hasOwn(staged, row.key)) return staged[row.key] === null ? row.roleValue : effective(staged[row.key]);
  return row.override === null || row.override === undefined ? row.value : effective(row.override);
}

/**
 * The PUT body: only keys that differ from the stored exception (staged null = back to the role; a value equal to the role's is no
 * exception); `note` only when it differs from the saved one (empty = cleared). null = nothing to save.
 */
export function rightsPatch(rows: RightsRow[], staged: Record<string, unknown>, note: string | null, savedNote: string | null): { overrides: Record<string, unknown>; note?: string | null } | null {
  const overrides: Record<string, unknown> = {};
  for (const r of rows) {
    if (!Object.hasOwn(staged, r.key)) continue;
    const v = staged[r.key], cur = r.override ?? null;
    if (same(v, cur)) continue;
    if (v !== null && same(effective(v), r.roleValue)) {
      // equal to the role's value: no exception; a stored one goes (null)
      if (cur !== null) overrides[r.key] = null;
      continue;
    }
    overrides[r.key] = v;
  }
  const n = (note ?? '').trim(), s = (savedNote ?? '').trim();
  const noteChanged = n !== s;
  if (!Object.keys(overrides).length && !noteChanged) return null;
  return { overrides, ...(noteChanged ? { note: n === '' ? null : n } : {}) };
}

/** the source chip text of a row */
export const sourceLabel = (s: RightSource): string => tr(`adminPeople.rights.src.${s === 'default' ? 'role' : s}` as 'adminPeople.rights.src.role');
