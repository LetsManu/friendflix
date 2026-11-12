// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Audit entries about roles and rights as sentences with from → to chips (spec §6.6): the role's *Verlauf* sheet, the person's
 * *Verlauf* tab and the audit page use it. Only names, field labels and values appear: never a title, a search term, an id or a PIN
 * (the counts and ids in `user.check_viewed` / `profile.*` meta are left out). The old `role.request_limit` / `role.remote_cap` /
 * `role.downloads` / `role.playback` entries (one value each, no from) say "… changed {field}" without chips.
 *   const { text, chips } = auditSentence({ action: e.action, actorName: e.actor, targetName: e.target_name, meta: e.meta ?? {} });
 */
import { api } from '#lib/api';
import { hasKey, tr, trDynamic } from '#lib/i18n';
import { cellText, FIELD_KINDS, fieldLabel, roleName, type MatrixField, type RoleMatrix } from './model';

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

/** the layer that decides a value, as the audit's `layer` names it (`default` is the role's own value) */
const layerWord = (l: unknown): string => trDynamic(`adminPeople.sentenceRights.layer.${l === 'user' || l === 'kids' || l === 'admin' || l === 'env' ? l : 'role'}`);
/** a stored override (the PUT encoding): null = none, 'unlimited' = a lifted cap, else as the field's value */
const storedText = (key: string, v: unknown): string => (v === null || v === undefined ? layerWord('role') : v === 'unlimited' ? tr('adminPeople.roles.unlimited') : valueText(key, v));

/**
 * `user.rights`, meta `{ from, to, layer?, stored?, note? }` (backend userRights.ts): `from`/`to` hold the changed effective values,
 * `layer[k] = { from, to }` the deciding layer before / after, `stored[k] = { from, to }` overrides that decide nothing. One changed
 * field (nothing stored, no note) reads as its own sentence; anything else is the general sentence with a chip per field.
 */
function rightsSentence(e: AuditInput, actor: string, person: string): { text: string; chips: AuditChip[] } {
  const m = e.meta;
  const t = (k: string, p: Record<string, string>) => trDynamic(`adminPeople.sentenceRights.${k}`, { actor, target: person, ...p });
  const chips = chipsOf({ from: m.from, to: m.to }, '–');
  const stored = isObject(m.stored) ? m.stored : {};
  const storedKeys = Object.keys(FIELD_KINDS).filter((k) => isObject(stored[k]) && hasKey(`adminPeople.roles.f.${k}`));
  const storedChips = storedKeys.map((k) => {
    const s = stored[k] as Record<string, unknown>;
    return { label: t('storedChip', { field: fieldLabel(k) }), from: storedText(k, s.from), to: storedText(k, s.to) };
  });
  const general = trDynamic('adminPeople.sentence.userRights', { actor, target: person });
  const noteOnly = m.note === 'changed';
  if (!chips.length && !storedChips.length) return { text: noteOnly ? t('noteChanged', {}) : general, chips: [] };
  if (!chips.length) return { text: t('storedOnly', {}), chips: storedChips };
  const lone = chips.length === 1 && !storedChips.length && !noteOnly
    // the same value before and after without a moved layer says nothing as a sentence: the general one with its chip
    && (chips[0]!.from !== chips[0]!.to || (isObject(m.layer) && Object.keys(m.layer).length > 0));
  const k = lone ? Object.keys(FIELD_KINDS).find((x) => hasKey(`adminPeople.roles.f.${x}`) && isObject(m.from) && isObject(m.to) && Object.hasOwn(m.from, x) && Object.hasOwn(m.to, x)) : undefined;
  if (k) {
    const from = (m.from as Record<string, unknown>)[k], to = (m.to as Record<string, unknown>)[k];
    const layer = isObject(m.layer) && isObject(m.layer[k]) ? (m.layer[k] as Record<string, unknown>) : null;
    const p = { field: fieldLabel(k), value: valueText(k, to) };
    const was = layer ? layerWord(layer.from) : valueText(k, from);
    const tone = (l: unknown) => (l === 'user' ? 'user' : l === 'kids' || l === 'admin' || l === 'env' ? 'other' : 'role');
    if (layer && chips[0]!.from === chips[0]!.to) {
      const now = tone(layer.to);
      if (now === 'user') return { text: t('pinned', { ...p, was }), chips: [] };
      if (now === 'role') return { text: t('unpinned', { ...p, was }), chips: [] };
      return { text: t('moved', { ...p, was, now: layerWord(layer.to) }), chips: [] };
    }
    // a switch says "erlaubt" / "nicht erlaubt" like any value, the label stays quoted: a label can be a predicate ("Darf aufnehmen")
    if (FIELD_KINDS[k] === 'bool') return { text: t('setBool', { ...p, was }), chips: [] };
    return { text: t('setValue', { ...p, was }), chips: [] };
  }
  return { text: general, chips: [...chips, ...storedChips] };
}

/** the entries about a person that read as sentences without the role names */
const PERSON_SENTENCES = new Set(['user.rights', 'profile.admin_create', 'profile.admin_update', 'profile.admin_delete', 'user.check_viewed']);
export const hasPersonSentence = (action: string): boolean => PERSON_SENTENCES.has(action);

export type RoleNames = (key: string) => string | null;
/** the roles' names by key (GET /api/admin/roles); null when they cannot be loaded (role entries then keep their older wording) */
export async function fetchRoleNames(): Promise<RoleNames | null> {
  try {
    const r = await api<{ matrix?: Pick<RoleMatrix, 'roles'> }>('/api/admin/roles');
    const roles = r.matrix?.roles;
    if (!roles) return null;
    return (key) => { const x = roles.find((y) => y.key === key); return x ? roleName(x) : null; };
  } catch { return null; }
}

/**
 * An audit row of the audit page or a person's *Verlauf* as a sentence with chips, or null when the older wording (`describeActivity`)
 * applies: only people's rights, profiles, content checks and (with the role names) role entries read through `auditSentence`.
 */
export function entrySentence(e: { action: string; actor?: string | null; target?: string | null; target_name?: string | null; meta?: Record<string, unknown> | null }, names: RoleNames | null): { text: string; chips: AuditChip[] } | null {
  const person = hasPersonSentence(e.action);
  if (!person && !(names && e.action.startsWith('role.'))) return null;
  return auditSentence({ action: e.action, actorName: e.actor ?? null, targetName: person ? (e.target_name ?? null) : null, target: e.target ?? null, meta: e.meta ?? {}, ...(names ? { roleName: names } : {}) });
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
    case 'user.rights': return rightsSentence(e, actor, person);
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
