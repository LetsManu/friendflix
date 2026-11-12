// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV → *Gruppen & Rechte* (spec §8, §9.3): the wire shapes of the groups routes (plan Task 18, backend/src/livetv/groups.ts and
 * adminRoutes.ts), thin callers, and the pure text and list helpers the tab renders from.
 *
 * Refusals the tab shows: 400 `{ error: 'invalid', field }`, `409 name_taken`, `409 conflict` (a write racing another one), 404 `not_found`,
 * and for the person's exceptions `400 admin_groups_locked` (an admin takes none: it sees every released group).
 */
import { api, apiCode } from '#lib/api';
import { tr } from '#lib/i18n';
import { roleName, type MatrixRole } from '#lib/admin/rights/model';

/** `GroupView` of backend/src/livetv/groups.ts (Task 18), field for field */
export interface GroupView {
  id: string;
  name: string;
  kidFriendly: boolean;
  /** role keys that see the group, in catalogue order */
  roles: string[];
  released: boolean;
  position: number;
  /** channels whose effective group this is (missing channels not counted) */
  channels: number;
  /** provider group-titles mapped into it ("aus: …"), sorted */
  providerGroups: string[];
}
/** `GET /groups`: unreleased first, then by position; `pending` = how many are unreleased */
export interface GroupsAnswer { groups: GroupView[]; pending: number }
/** `GroupRef` / `UserGroups` of backend/src/livetv/groups.ts: a person's exceptions (allow adds a group to what the role sees, deny removes one) */
export interface GroupRef { id: string; name: string }
export interface UserGroups { allow: GroupRef[]; deny: GroupRef[] }

/** `livetv` of `GET /users/:id/check?profile=` (backend livetv/rights.ts livetvCheck); null = Live TV not installed or the profile may not use it: show nothing */
export type GroupHiddenReason = 'notReleased' | 'notKidFriendly' | 'notGranted' | 'denied';
export interface LivetvCheck {
  groups: Array<{ id: string; name: string; visible: boolean; reason: GroupHiddenReason | null }>;
  channels: number;
}

const B = '/api/admin/livetv/groups';
export const fetchGroups = () => api<GroupsAnswer>(B);
export const createGroup = (body: { name: string; kidFriendly?: boolean; roles?: string[]; released?: boolean }) => api<GroupView>(B, { method: 'POST', body });
/** partial; `{ released: false }` = *Freigabe zurücknehmen* (the roles stay) */
export const patchGroup = (id: string, patch: Partial<{ name: string; kidFriendly: boolean; roles: string[]; released: boolean }>) =>
  api<GroupView>(`${B}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
export const deleteGroup = (id: string) => api<{ ok: true }>(`${B}/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** *Freigeben*: every group of `ids` ends released with exactly these roles and this *Kinderfreundlich* */
export const releaseGroups = (ids: string[], roles: string[], kidFriendly: boolean) => api<{ released: number }>(`${B}/release`, { method: 'POST', body: { ids, roles, kidFriendly } });
/** *Zusammenführen*: the provider groups and channel overrides of `ids` move into `into`, the rest are deleted */
export const mergeGroups = (ids: string[], into: string) => api<GroupView>(`${B}/merge`, { method: 'POST', body: { ids, into } });
export const orderGroups = (ids: string[]) => api<{ ok: true }>(`${B}/order`, { method: 'PUT', body: { ids } }).then(() => undefined);
/** `PUT /users/:id/livetv-groups`: the person's exceptions, replaced as a whole */
export const putUserGroups = (userId: string, allow: string[], deny: string[]) =>
  api<{ livetvGroups: UserGroups }>(`/api/admin/users/${encodeURIComponent(userId)}/livetv-groups`, { method: 'PUT', body: { allow, deny } }).then((r) => r.livetvGroups);

/** "Sport, Nachrichten +2": the first `max` names, the rest counted */
export function chipsText(names: readonly string[], max = 2): string {
  if (names.length <= max) return names.join(', ');
  const rest = `+${names.length - max}`;
  return max > 0 ? `${names.slice(0, max).join(', ')} ${rest}` : rest;
}

/**
 * The kids preview line: the released, kid-friendly groups that at least one role grants (the person's own exceptions are not counted
 * here), with their channel count. Without any: the sentence says so.
 */
export function kidsLine(groups: readonly GroupView[]): string {
  const seen = groups.filter((x) => x.released && x.kidFriendly && x.roles.length > 0);
  if (!seen.length) return tr('adminLive.grp.kidsNone');
  return tr('adminLive.grp.kidsSee', { groups: seen.map((x) => x.name).join(', '), n: seen.reduce((n, x) => n + x.channels, 0) });
}

/** the list order of the tab: unreleased groups first, then by position (stable); `onlyPending` keeps only the unreleased ones */
export function pendingFirst(groups: readonly GroupView[], onlyPending: boolean): GroupView[] {
  return groups.filter((x) => !onlyPending || !x.released).sort((a, b) => Number(a.released) - Number(b.released) || a.position - b.position);
}

/** one person for the exceptions list: the answer of `GET /users/:id/rights` (null = the read failed) */
export interface ExceptionRow { userId: string; name: string; livetvGroups: UserGroups | null }
/**
 * `plus` / `minus` are the exceptions on released groups (effective); `plusOff` / `minusOff` are those on a group that is not released:
 * nobody sees such a group, an exception does not reach it (ruling 39), so the tab shows them as not effective, never as a grant.
 */
export interface PersonExceptions { userId: string; name: string; plus: string[]; minus: string[]; plusOff: string[]; minusOff: string[] }
/** the people with at least one plus or minus, with the group names; `groups` (when given) tells which of them are released */
export function exceptionsOf(rows: readonly ExceptionRow[], groups?: readonly GroupView[]): PersonExceptions[] {
  const live = groups ? new Set(groups.filter((x) => x.released).map((x) => x.id)) : null;
  const split = (l: GroupRef[]) => ({ on: l.filter((x) => !live || live.has(x.id)).map((x) => x.name), off: l.filter((x) => live && !live.has(x.id)).map((x) => x.name) });
  const out: PersonExceptions[] = [];
  for (const r of rows) {
    const e = r.livetvGroups;
    if (e && (e.allow.length || e.deny.length)) {
      const p = split(e.allow), m = split(e.deny);
      out.push({ userId: r.userId, name: r.name, plus: p.on, minus: m.on, plusOff: p.off, minusOff: m.off });
    }
  }
  return out;
}

/** how many accounts one read looks at; more than this and the tab says only the first ones were checked */
export const EXCEPTIONS_MAX = 500;
/** the result of `loadExceptions`: the rows, how many accounts could not be read, and whether the list was cut at `EXCEPTIONS_MAX` */
export interface ExceptionsRead { rows: ExceptionRow[]; unread: number; capped: boolean }

/**
 * Reads the exceptions of every non-admin account: the users list, then `GET /users/:id/rights` per account, at most `limit` at a time
 * (no route lists them all, ruling R21). A failed read leaves that person out (`livetvGroups: null`) and is counted in `unread`;
 * `capped` = the account list has more than `EXCEPTIONS_MAX` entries.
 */
export async function loadExceptions(limit = 4): Promise<ExceptionsRead> {
  const list = await api<{ users: Array<{ id: string; name: string; role: string | null; pending?: boolean }>; total: number }>(`/api/admin/users?limit=${EXCEPTIONS_MAX}`);
  const people = list.users.filter((u) => u.role && u.role !== 'admin' && !u.pending);
  const rows: ExceptionRow[] = new Array(people.length);
  let next = 0, unread = 0;
  await Promise.all(Array.from({ length: Math.min(limit, people.length) }, async () => {
    for (let i = next++; i < people.length; i = next++) {
      const u = people[i]!;
      const livetvGroups = await api<{ livetvGroups?: UserGroups }>(`/api/admin/users/${encodeURIComponent(u.id)}/rights`).then((r) => r.livetvGroups ?? null, () => { unread++; return null; });
      rows[i] = { userId: u.id, name: u.name, livetvGroups };
    }
  }));
  return { rows, unread, capped: list.total > EXCEPTIONS_MAX };
}

/** a role as the grants offer it: `readOnly` = defined only in `.env`, the backend refuses to grant it a group (400), so the UI only shows it */
export interface GrantRole { key: string; name: string; readOnly: boolean }
type RoleLike = Pick<MatrixRole, 'key' | 'label' | 'base' | 'builtinLabel' | 'stored'>;
/** the roles a group can be granted to: every role but the admin (which sees every released group), env-only ones read-only */
export const rolesFor = (roles: readonly RoleLike[]): GrantRole[] => roles.filter((r) => r.base !== 'admin').map((r) => ({ key: r.key, name: roleName(r), readOnly: !r.stored }));

/** the sentence of a refused groups write (backend code), never the raw code */
export function groupError(code: string | undefined): string {
  switch (code) {
    case 'name_taken': return tr('adminLive.grp.err.nameTaken');
    case 'conflict': return tr('adminLive.grp.err.conflict');
    case 'admin_groups_locked': return tr('adminLive.grp.err.adminLocked');
    case 'not_found': return tr('adminLive.grp.err.notFound');
    default: return tr('adminLive.err.generic');
  }
}
/** the error toast text of a failed groups call */
export const groupErrorOf = (e: unknown): string => groupError(apiCode(e));
