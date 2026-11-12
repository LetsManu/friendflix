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
  /** the raw target (a role key); used for a built-in role's name when `targetName` is missing */
  target?: string | null;
}

/** a built-in role's name in the UI language; any other key stands as it is */
const roleText = (k: unknown): string => {
  const s = typeof k === 'string' ? k : '';
  return s && hasKey(`admin.roleNames.${s}`) ? trDynamic(`admin.roleNames.${s}`) : s;
};
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function valueText(key: string, v: unknown): string {
  const kind = FIELD_KINDS[key]!;
  if (kind === 'bool') return tr(v ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied');
  const f: MatrixField = { key, group: 'access', kind };
  return cellText(f, v);
}

/** one chip per known field that has a before and an after (an unknown key of another version is dropped, never shown raw) */
function chipsOf(meta: Record<string, unknown>): AuditChip[] {
  const from = isObject(meta.from) ? meta.from : {}, to = isObject(meta.to) ? meta.to : {};
  return Object.keys(FIELD_KINDS) // in matrix order
    .filter((k) => Object.hasOwn(to, k) && Object.hasOwn(from, k) && hasKey(`adminPeople.roles.f.${k}`))
    .map((k) => ({ label: fieldLabel(k), from: valueText(k, from[k]), to: valueText(k, to[k]) }));
}

const LEGACY = new Set(['request_limit', 'remote_cap', 'downloads', 'playback']);

export function auditSentence(e: AuditInput): { text: string; chips: AuditChip[] } {
  const actor = e.actorName || tr('admin.audit.system');
  const person = e.targetName || tr('admin.activity.someone');
  const role = e.targetName || roleText(e.target);
  const t = (k: string, p: Record<string, string>) => trDynamic(`adminPeople.sentence.${k}`, { actor, ...p });
  const m = e.meta;
  switch (e.action) {
    case 'role.update': return { text: t('roleUpdate', { target: role }), chips: chipsOf(m) };
    case 'role.create': {
      const name = typeof m.label === 'string' && m.label ? m.label : role;
      return { text: typeof m.from === 'string' && m.from ? t('roleCreateFrom', { target: name, from: roleText(m.from) }) : t('roleCreate', { target: name }), chips: [] };
    }
    case 'role.delete': return { text: typeof m.moveTo === 'string' && m.moveTo ? t('roleDeleteMoved', { target: role, to: roleText(m.moveTo) }) : t('roleDelete', { target: role }), chips: [] };
    case 'role.order': return { text: t('roleOrder', {}), chips: [] };
    case 'user.rights': return { text: t('userRights', { target: person }), chips: chipsOf(m) };
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
