// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The filters of the admin people list (GET /api/admin/users): their query string both ways and the chips that show the active ones. */
import { tr } from '#lib/i18n';
import { PERM_KEYS, type PermKey } from '#lib/perms';

export interface UserFilters {
  q: string;
  role: string | null;
  status: string | null;
  lastActive: string | null;
  overrides: boolean;
  kids: boolean;
  noMfa: boolean;
  /** one switch and the effective state it is filtered for (backend: perm=cast:off) */
  perm: { key: PermKey; on: boolean } | null;
}

export const STATUSES = ['active', 'locked', 'pending', 'expiring', 'deleting'] as const;
export const LAST_ACTIVE = ['7', '30', '90', '90+'] as const;
const LAST_ACTIVE_KEY = { '7': 'd7', '30': 'd30', '90': 'd90', '90+': 'inactive90' } as const;

export const emptyFilters = (): UserFilters => ({ q: '', role: null, status: null, lastActive: null, overrides: false, kids: false, noMfa: false, perm: null });

/** the request's query string (without paging and sort); unset filters add nothing */
export function toQuery(f: UserFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.role) p.set('role', f.role);
  if (f.status) p.set('status', f.status);
  if (f.lastActive) p.set('lastActive', f.lastActive);
  if (f.overrides) p.set('overrides', '1');
  if (f.kids) p.set('kids', '1');
  if (f.noMfa) p.set('mfa', 'off');
  if (f.perm) p.set('perm', `${f.perm.key}:${f.perm.on ? 'on' : 'off'}`);
  return p;
}

/** the filters of a query string; values the backend would refuse are dropped */
export function fromQuery(p: URLSearchParams): UserFilters {
  const f = emptyFilters();
  f.q = p.get('q') ?? '';
  f.role = p.get('role') || null;
  const status = p.get('status'), last = p.get('lastActive'), perm = p.get('perm')?.split(':');
  f.status = (STATUSES as readonly string[]).includes(status ?? '') ? status : null;
  f.lastActive = (LAST_ACTIVE as readonly string[]).includes(last ?? '') ? last : null;
  f.overrides = p.get('overrides') === '1';
  f.kids = p.get('kids') === '1';
  f.noMfa = p.get('mfa') === 'off';
  if (perm?.length === 2 && (PERM_KEYS as readonly string[]).includes(perm[0]!) && (perm[1] === 'on' || perm[1] === 'off')) f.perm = { key: perm[0] as PermKey, on: perm[1] === 'on' };
  // open approval requests have no rights and no 2FA state: the backend refuses the pair (400), so the status wins
  if (f.status === 'pending') { f.perm = null; f.noMfa = false; }
  return f;
}

/** a chip per active filter in the order of the row (the search text is the search field's own); `roleName` shows a role by its label */
export function activeChips(f: UserFilters, roleName: (key: string) => string = (k) => k): Array<{ id: keyof UserFilters; label: string }> {
  const out: Array<{ id: keyof UserFilters; label: string }> = [];
  if (f.role) out.push({ id: 'role', label: roleName(f.role) });
  if (f.status) out.push({ id: 'status', label: tr(`adminPeople.users.${f.status as typeof STATUSES[number]}`) });
  if (f.lastActive) out.push({ id: 'lastActive', label: tr(`adminPeople.users.lastActive.${LAST_ACTIVE_KEY[f.lastActive as keyof typeof LAST_ACTIVE_KEY]}`) });
  if (f.overrides) out.push({ id: 'overrides', label: tr('adminPeople.users.filterOverrides') });
  if (f.kids) out.push({ id: 'kids', label: tr('adminPeople.users.filterKids') });
  if (f.noMfa) out.push({ id: 'noMfa', label: tr('adminPeople.users.filterNoMfa') });
  if (f.perm) out.push({ id: 'perm', label: tr(f.perm.on ? 'adminPeople.users.filterRightOn' : 'adminPeople.users.filterRightOff', { right: tr(`adminPeople.roles.f.${f.perm.key}`) }) });
  return out;
}
