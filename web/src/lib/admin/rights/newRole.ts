// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The start points of a new role (roles redesign §4.4, §5.2), shared by *+ Neue Rolle* on the list and *Duplizieren* on the list
 * and the role page: the templates the server lists in `matrix.templates` (Familie, Freund, Gast, Nur Live-TV while Live TV is
 * installed, Leer), each with the areas it starts with, and *Kopie von …* a chosen role. `createRole` posts `{ label, template }`
 * or `{ label, from }` and answers the new role's key; the page then opens that role's page.
 */
import { api, ApiError } from '#lib/api';
import { hasKey, tr, trDynamic } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import { areasOf, areaSummary, withCoupling } from './areas';
import type { RoleMatrix, RoleTemplateInfo } from './model';

export type StartKey = RoleTemplateInfo['key'] | 'copy';
export interface StartOption { key: StartKey; title: string; desc: string }
export type CreateBody = { label: string; template: RoleTemplateInfo['key'] } | { label: string; from: string };

const title = (k: StartKey): string => {
  if (k === 'liveOnly' || k === 'empty' || k === 'copy') return tr(`adminPeople.roles.new.${k}`);
  return hasKey(`admin.roleNames.${k}`) ? trDynamic(`admin.roleNames.${k}`) : k;
};

/** the options in the server's order, then the copy; `from`: the role the copy would start from (its areas are the copy's line) */
export function startOptions(m: RoleMatrix, from: string): StartOption[] {
  const out: StartOption[] = (m.templates ?? []).map((t) => ({
    key: t.key, title: title(t.key),
    desc: t.key === 'empty' ? tr('adminPeople.roles.new.emptyDesc') : t.key === 'liveOnly' ? tr('adminPeople.roles.new.liveOnlyDesc') : areaSummary(t.areas, m.features),
  }));
  const src = m.roles.find((r) => r.key === from);
  out.push({ key: 'copy', title: title('copy'), desc: src ? areaSummary(withCoupling(src.areas ?? areasOf(src.values)), m.features) : '' });
  return out;
}

/** where the dialog starts: a copy of `from` (*Duplizieren*), else Freund, else the first start point the server lists */
export function firstStart(m: RoleMatrix, from?: string): StartKey {
  if (from) return 'copy';
  const t = m.templates ?? [];
  return t.find((x) => x.key === 'friend')?.key ?? t[0]?.key ?? 'copy';
}

export const createBody = (label: string, start: StartKey, from: string): CreateBody => (start === 'copy' ? { label, from } : { label, template: start });

/** POST /api/admin/roles; the new role's key (throws the API error) */
export const createRole = async (body: CreateBody): Promise<string> => (await api<{ key: string }>('/api/admin/roles', { method: 'POST', body })).key;

/** the server no longer offers the template (Live TV gone meanwhile): the page reads the start points again */
export const templateGone = (e: unknown): boolean => e instanceof ApiError && e.body?.error === 'template_unavailable';

/** the dialog's error line: a template the server no longer offers says so, the rest as everywhere */
export const createError = (e: unknown): string => (templateGone(e) ? tr('adminPeople.roles.new.unavailable') : errorText(e));
