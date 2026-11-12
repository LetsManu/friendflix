// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /api/admin/roles (the role names, the invitable roles and the whole matrix) shared by the parts of one page: the person page's
 * header, its *Rechte* tab and its *Audit-Log* tab ask through one loader, so the page reads it once. A failed answer is not kept:
 * the next caller (a retry) asks again.
 *   const roles = sharedRoles();  …  <Rights loadRoles={roles} />  …  fetchRoleNames(roles)
 */
import { api } from '#lib/api';
import type { RoleInfo } from '#lib/roles';
import type { RoleMatrix } from './model';

export interface RolesAnswer { roles: Record<string, RoleInfo>; invitable?: string[]; matrix?: RoleMatrix }
export type RolesLoader = () => Promise<RolesAnswer>;

/** asks the server on every call (the default for a part used on its own) */
export const fetchRoles: RolesLoader = () => api<RolesAnswer>('/api/admin/roles');

/** one answer for every caller of the returned loader; a failure is dropped so a retry asks again */
export function sharedRoles(load: RolesLoader = fetchRoles): RolesLoader {
  let p: Promise<RolesAnswer> | null = null;
  return () => (p ??= load().catch((e: unknown) => { p = null; throw e; }));
}
