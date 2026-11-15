// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deleting and copying a role (spec §2.1, roles redesign §5.1, §5.3), shared by the role list and the role page. A role nobody
 * holds is deleted after one confirm; while people or invites hold it the server answers 409 `role_in_use` with the counts, and the
 * page opens `DeleteRoleDialog` to pick the role they move to (never the role itself, never an admin-based one), then
 * `deleteMoving`. The pages keep only their dialog state and what follows a delete (the list reads again, the role page goes back).
 */
import { tick } from 'svelte';
import { api, ApiError } from '#lib/api';
import { tr } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import { confirm } from '#lib/ui/confirm';
import { toast } from '#lib/ui/toast';
import { roleName, type MatrixRole } from './model';

type RoleRef = Pick<MatrixRole, 'key' | 'label' | 'builtinLabel' | 'base' | 'origin' | 'envGone'>;
export interface InUse { accounts: number; invites: number }

/** roles made here can go, and env roles whose key left ROLE_TEMPLATES; built-ins and env roles cannot */
export const canDelete = (r: Pick<MatrixRole, 'origin' | 'envGone'>): boolean => r.origin === 'admin' || r.envGone;

/** the counts of a 409 role_in_use (people and open invites still hold the role); null for any other failure */
export const inUse = (e: unknown): InUse | null =>
  (e instanceof ApiError && e.status === 409 && e.body?.error === 'role_in_use' ? { accounts: Number(e.body.accounts) || 0, invites: Number(e.body.invites) || 0 } : null);

/** where the people of a deleted role may move: every other role but the admin-based ones, by display name */
export const moveTargetsOf = (roles: readonly RoleRef[], key: string | undefined): Array<{ key: string; name: string }> =>
  roles.filter((r) => r.key !== key && r.base !== 'admin').map((r) => ({ key: r.key, name: roleName(r) }));

/**
 * The first step of *Löschen*: nobody holds the role → asks once, then DELETE. Returns 'deleted'; 'kept' (cancelled: the focus
 * goes back to `trigger`; or failed: an error toast); or the counts of a 409 role_in_use, for the move dialog.
 */
export async function deleteRole(role: RoleRef & Pick<MatrixRole, 'accounts'>, trigger: HTMLElement | null): Promise<'deleted' | 'kept' | InUse> {
  const name = roleName(role);
  if (role.accounts === 0 && !(await confirm({ title: tr('adminPeople.roles.deleteTitle', { name }), body: tr('adminPeople.roles.deleteNone'), danger: true, confirmLabel: tr('adminPeople.roles.delete') }))) {
    void tick().then(() => trigger?.focus({ preventScroll: true }));
    return 'kept';
  }
  try { await api(`/api/admin/roles/${encodeURIComponent(role.key)}`, { method: 'DELETE' }); } catch (e) {
    const n = inUse(e);
    if (n) return n;
    toast.error(errorText(e));
    return 'kept';
  }
  return 'deleted';
}

/** the delete with a move (the dialog's *Löschen*): ok, or the error text and the server's new counts when it still answers role_in_use */
export async function deleteMoving(key: string, to: string): Promise<{ ok: true } | { ok: false; error: string; counts: InUse | null }> {
  try { await api(`/api/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE', body: { moveTo: to } }); } catch (e) {
    return { ok: false, error: errorText(e), counts: inUse(e) };
  }
  return { ok: true };
}

/** *Duplizieren* / *+ Neue Rolle*: a copy of `from` named `label`; the new role's key (throws the API error) */
export const copyRole = async (label: string, from: string): Promise<string> =>
  (await api<{ key: string }>('/api/admin/roles', { method: 'POST', body: { label, from } })).key;
