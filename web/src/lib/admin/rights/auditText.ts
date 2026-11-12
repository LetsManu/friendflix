// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Audit entries about roles and rights as sentences with from → to chips (spec §6.6): the role's *Verlauf* sheet, the person's
 * *Verlauf* tab and the audit page use it. Only names, field labels and values appear: never a title, a search term, an id or a PIN
 * (the counts and ids in `user.check_viewed` / `profile.*` meta are left out). The old `role.request_limit` / `role.remote_cap` /
 * `role.downloads` / `role.playback` entries (one value each, no from) say "… changed {field}" without chips.
 *   const { text, chips } = auditSentence({ action: e.action, actorName: e.actor, targetName: e.target_name, meta: e.meta ?? {} });
 */
import { hasKey, tr, trDynamic } from '#lib/i18n';
import { cellText, FIELD_KINDS, fieldLabel, type MatrixField } from './model';

export interface AuditChip { label: string; from: string; to: string }
export interface AuditInput {
  action: string;
  actorName: string | null;
  /** the name of what the entry is about (the person, the role's name); null = not known */
  targetName: string | null;
  meta: Record<string, unknown>;
  /** the raw target (a role key): named through `roleName` when `targetName` is missing */
  target?: string | null;
  /** a role's name by key (from the matrix: its label, built-in or not); null = the role does not exist (any more) */
  roleName?: (key: string) => string | null;
}

/** a built-in role's name in the UI language; null for any other key (a key is never shown) */
const builtinName = (k: unknown): string | null => (typeof k === 'string' && k && hasKey(`admin.roleNames.${k}`) ? trDynamic(`admin.roleNames.${k}`) : null);
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function valueText(key: string, v: unknown): string {
  const kind = FIELD_KINDS[key]!;
  if (kind === 'bool') return tr(v ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied');
  const f: MatrixField = { key, group: 'access', kind };
  return cellText(f, v);
}

/** one chip per known field that has a before and an after, in matrix order, then the name and the invitable switch (a key of another version is dropped, never shown raw) */
function chipsOf(meta: Record<string, unknown>, was: string): AuditChip[] {
  const from = isObject(meta.from) ? meta.from : {}, to = isObject(meta.to) ? meta.to : {};
  const both = (k: string) => Object.hasOwn(to, k) && Object.hasOwn(from, k);
  const chips = Object.keys(FIELD_KINDS)
    .filter((k) => both(k) && hasKey(`adminPeople.roles.f.${k}`))
    .map((k) => ({ label: fieldLabel(k), from: valueText(k, from[k]), to: valueText(k, to[k]) }));
  const word = (v: unknown) => tr(v ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied');
  // a name that was not set reads as the role's name before (the built-in one), or a dash
  const str = (v: unknown, none: string) => (typeof v === 'string' && v ? v : none);
  if (both('label')) chips.push({ label: tr('adminPeople.roles.fLabel'), from: str(from.label, was), to: str(to.label, '–') });
  if (both('invitable')) chips.push({ label: tr('adminPeople.roles.fInvitable'), from: word(from.invitable), to: word(to.invitable) });
  return chips;
}

const LEGACY = new Set(['request_limit', 'remote_cap', 'downloads', 'playback']);

export function auditSentence(e: AuditInput): { text: string; chips: AuditChip[] } {
  const actor = e.actorName || tr('admin.audit.system');
  const person = e.targetName || tr('admin.activity.someone');
  const m = e.meta;
  const label = typeof m.label === 'string' && m.label ? m.label : null;
  /** a role by key: the matrix's name, the entry's own label (its target), a built-in's name; a role that is gone: a neutral phrase, never the key */
  const ref = (key: unknown, own: string | null = null): string => (typeof key === 'string' ? e.roleName?.(key) : null) ?? own ?? builtinName(key) ?? tr('adminPeople.sentence.deletedRole');
  const role = e.targetName || ref(e.target, label);
  const t = (k: string, p: Record<string, string>) => trDynamic(`adminPeople.sentence.${k}`, { actor, ...p });
  switch (e.action) {
    case 'role.update': return { text: t('roleUpdate', { target: role }), chips: chipsOf(m, builtinName(e.target) ?? '–') };
    case 'role.create': {
      const name = e.targetName || label || ref(e.target);
      return { text: typeof m.from === 'string' && m.from ? t('roleCreateFrom', { target: name, from: ref(m.from) }) : t('roleCreate', { target: name }), chips: [] };
    }
    case 'role.delete': return { text: typeof m.moveTo === 'string' && m.moveTo ? t('roleDeleteMoved', { target: role, to: ref(m.moveTo) }) : t('roleDelete', { target: role }), chips: [] };
    case 'role.order': return { text: t('roleOrder', {}), chips: [] };
    case 'user.rights': return { text: t('userRights', { target: person }), chips: chipsOf({ from: m.from, to: m.to }, '–') };
    case 'profile.admin_create': return { text: t('profileCreate', { target: person }), chips: [] };
    case 'profile.admin_update': return { text: t('profileUpdate', { target: person }), chips: [] };
    case 'profile.admin_delete': return { text: t('profileDelete', { target: person }), chips: [] };
    case 'user.check_viewed': return { text: t('checkViewed', { target: person }), chips: [] };
    default: {
      const legacy = e.action.startsWith('role.') ? e.action.slice(5) : '';
      if (LEGACY.has(legacy)) return { text: t('roleField', { field: trDynamic(`adminPeople.sentence.legacy.${legacy}`), target: role }), chips: [] };
      return { text: tr('admin.activity.unknown', { actor }), chips: [] };
    }
  }
}

/**
 * A role's own history: the entries (newest first) up to and including its latest `role.create`. A role deleted and made again under
 * the same key (a name gives the same slug) starts a new life; its predecessor's updates and delete do not belong to it.
 */
export function sinceLatestCreate<T extends { action: string; target: string | null }>(entries: readonly T[], key: string): T[] {
  const at = entries.findIndex((e) => e.action === 'role.create' && e.target === key);
  return at < 0 ? [...entries] : entries.slice(0, at + 1);
}
