// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * *Rollen vergleichen*, read-only (roles redesign §1.1, §5.5): the rows of the matrix — *Bereiche* first (one ✓ / – row per area
 * this server has, coupled as the role page shows them), then each area's details (its own switch is the Bereiche row) and
 * *Allgemein*, with the channel groups at the end of Live-TV — and what each cell shows: its value, its accessible name ("Gast,
 * Altersfreigabe: ab 12, geändert") and the link to the role page at that right (`?field=<key>`, an area as `area:<key>`). The
 * admin role's switches and areas are locked: no link, the lock says why. Editing happens on the role page only, so this view can
 * never stage a state the role page forbids.
 */
import { chipsText } from '#lib/admin/livetv/groups';
import { tr } from '#lib/i18n';
import { areaLabel, areasOf, fieldsOfArea, shownAreas, withCoupling, type AreaKey } from './areas';
import { cellText, fieldLabel, PERM_SET, roleName, type MatrixField, type MatrixRole, type RoleMatrix } from './model';

export type CompareRow = { kind: 'area'; area: AreaKey } | { kind: 'field'; field: MatrixField } | { kind: 'groups' };
export interface CompareGroup { id: 'areas' | AreaKey | 'general'; rows: CompareRow[] }

/** the row groups in display order; a group without a row is left out */
export function compareGroups(m: RoleMatrix): CompareGroup[] {
  const areas = shownAreas(m.features);
  const out: CompareGroup[] = [{ id: 'areas', rows: areas.map((area) => ({ kind: 'area', area })) }];
  for (const id of [...areas, 'general' as const]) {
    const rows: CompareRow[] = fieldsOfArea(m, id).map((field) => ({ kind: 'field', field }));
    if (id === 'livetv') rows.push({ kind: 'groups' });
    if (rows.length) out.push({ id, rows });
  }
  return out;
}

/** the `?field=` of a row: the field's key, `area:<key>` for an area, `livetvGroups` for the channel groups */
export const rowKey = (r: CompareRow): string => (r.kind === 'area' ? `area:${r.area}` : r.kind === 'field' ? r.field.key : 'livetvGroups');

/** the row's heading */
export const rowLabel = (r: CompareRow): string => (r.kind === 'area' ? areaLabel(r.area) : r.kind === 'field' ? fieldLabel(r.field.key) : tr('adminLive.grp.rowLabel'));

/** the role page at a row's control */
export const compareHref = (r: Pick<MatrixRole, 'key'>, key: string): string => `/admin/roles/${encodeURIComponent(r.key)}?field=${encodeURIComponent(key)}`;

export interface CompareCell {
  value: unknown;
  /** a switch or an area: ✓ / – */
  bool: boolean;
  text: string;
  /** the admin role's switches and areas: not editable anywhere */
  locked: boolean;
  /** where the role's value was set ("geändert" / "aus .env"; the dot) */
  src: 'role' | 'env' | null;
  /** the link to the role page; null while locked */
  href: string | null;
  /** "Gast, Altersfreigabe: ab 12, geändert" */
  name: string;
  /** the link's name: "…, bearbeiten" (a locked cell: its name) */
  label: string;
}

export function compareCell(m: RoleMatrix, r: MatrixRole, row: CompareRow): CompareCell {
  const admin = r.base === 'admin';
  let value: unknown, bool: boolean, text: string, locked = false, src: CompareCell['src'] = null;
  if (row.kind === 'area') {
    value = withCoupling(r.areas ?? areasOf(r.values))[row.area];
    bool = true;
    locked = admin;
  } else if (row.kind === 'field') {
    value = r.values[row.field.key];
    bool = row.field.kind === 'bool';
    locked = admin && PERM_SET.has(row.field.key);
    const s = r.sources[row.field.key];
    src = s === 'role' || s === 'env' ? s : null;
  } else {
    value = r.livetvGroups ?? [];
    bool = false;
  }
  if (bool) text = cellText({ kind: 'bool' }, value);
  else if (row.kind === 'field') text = cellText(row.field, value);
  else text = chipsText(value as string[]) || tr('adminLive.grp.rowNone');
  const words = bool ? tr(value ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied') : text;
  const name = tr(src === 'role' ? 'adminPeople.roles.cellNameChanged' : 'adminPeople.roles.cellName', { role: roleName(r), field: rowLabel(row), value: words });
  return {
    value, bool, text, locked, src, name,
    href: locked ? null : compareHref(r, rowKey(row)),
    label: locked ? name : tr('adminPeople.roles.compare.cell', { cell: name }),
  };
}
