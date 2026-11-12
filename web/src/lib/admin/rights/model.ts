// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The role matrix of Rollen & Rechte (spec §4.1): the types of GET /api/admin/roles `matrix` as the server sends them (backend
 * roleWrite.ts rolesOverview), cell formatting, accessible names, and the staged (unsaved) changes behind the save bar.
 */
import { fmtNumber, hasKey, tr, trDynamic } from '#lib/i18n';
import { PERM_KEYS, type PermKey } from '#lib/perms';

export type FieldKind = 'bool' | 'int' | 'bitrate' | 'height' | 'rating' | 'libraries';
export type FieldGroup = 'access' | 'playback' | 'downloads' | 'requests' | 'together' | 'cast' | 'livetv';
export type Feature = 'requests' | 'cast' | 'livetv';
export type RightSource = 'default' | 'env' | 'role' | 'admin';

export interface MatrixField {
  key: string;
  group: FieldGroup;
  kind: FieldKind;
  min?: number;
  max?: number;
  options?: Array<number | null>;
  requires?: Feature;
}

export interface MatrixRole {
  key: string;
  /** null = the built-in / env label (the UI translates it) */
  label: string | null;
  builtinLabel: boolean;
  /** the built-in role whose code defaults apply below the role's own template */
  base: 'family' | 'friend' | 'guest' | 'admin';
  origin: 'code' | 'env' | 'admin';
  invitable: boolean;
  position: number;
  accounts: number;
  profiles: number;
  kidsProfiles: number;
  /** effective template + perms (+ requestsPerMonth); null = no cap (height, rating, requests per month); libraries 'all' | names; bitrates in bit/s */
  values: Record<string, unknown>;
  sources: Record<string, RightSource | undefined>;
  /** the same fields without the role's own stored row (ROLE_TEMPLATES, else the base's code default): "geändert (Standard: …)" */
  defaults: Record<string, unknown>;
  /** an env role whose key left ROLE_TEMPLATES ("nicht mehr in .env"; it can be deleted) */
  envGone: boolean;
  /** library names of the role the media server no longer has */
  missingLibraries: string[];
}

export interface RoleMatrix {
  fields: MatrixField[];
  features: Record<Feature, boolean>;
  roles: MatrixRole[];
  libraries: Array<{ id: string; name: string }>;
}

/** switches the role write takes under `perms` */
const PERM_SET: ReadonlySet<string> = new Set<PermKey>(PERM_KEYS);
/** fields the media server policy carries (backend rights.ts MEDIA_FIELDS): a change re-applies the policy of the role's accounts */
const MEDIA_FIELDS: ReadonlySet<string> = new Set(['libraries', 'maxParentalRating', 'maxStreams', 'maxBitrate', 'transcoding', 'maxHeight', 'download']);
/** a null value means "no cap" here; the role write spells it 'unlimited' (null there = back to the inherited value) */
const NULL_IS_UNLIMITED: ReadonlySet<string> = new Set(['maxHeight', 'maxParentalRating', 'requestsPerMonth']);

/** the fields to show: those whose optional feature is off are dropped (no request service: no Wünsche; Live TV not installed: no Live-TV) */
export const visibleFields = (m: RoleMatrix): MatrixField[] => m.fields.filter((f) => !f.requires || m.features[f.requires]);

const unlimited = (v: unknown): boolean => v === null || v === undefined || v === 'unlimited';

function mbit(bps: number): string {
  const n = bps / 1_000_000;
  return tr('adminPeople.roles.mbit', { n: fmtNumber(n, { maximumFractionDigits: n < 10 ? 1 : 0 }) });
}

/** the compact text of one cell value ("✓", "20 Mbit/s", "1080p", "ab 12", "3 Bibliotheken") */
export function cellText(f: MatrixField, v: unknown): string {
  switch (f.kind) {
    case 'bool': return v ? '✓' : '–';
    case 'int': return unlimited(v) ? tr('adminPeople.roles.unlimited') : String(v);
    case 'bitrate': return typeof v === 'number' ? mbit(v) : tr('adminPeople.roles.unlimited');
    case 'height': return typeof v === 'number' ? (v > 0 ? `${v}p` : '–') : tr('adminPeople.roles.heightAll');
    case 'rating': return typeof v === 'number' ? tr('adminPeople.roles.ratingFrom', { n: v }) : tr('adminPeople.roles.ratingAll');
    case 'libraries': return Array.isArray(v) ? tr('adminPeople.roles.libs', { n: v.length }) : tr('adminPeople.roles.ratingAll');
  }
}

/** the kind of every matrix field by key (backend perms.ts MATRIX_FIELDS), for places that have no matrix at hand (the audit sentences) */
export const FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  libraries: 'libraries', maxParentalRating: 'rating', maxStreams: 'int', maxBitrate: 'bitrate', remoteMaxBitrate: 'bitrate', transcoding: 'bool', maxHeight: 'height',
  download: 'bool', maxDownloads: 'int', downloadMaxHeight: 'height', downloadDays: 'int', requests: 'bool', requestsPerMonth: 'int', party: 'bool',
  partySchedule: 'bool', comments: 'bool', cast: 'bool', liveTv: 'bool', liveRecord: 'bool',
};

export const fieldLabel = (key: string): string => trDynamic(`adminPeople.roles.f.${key}`);

/**
 * the accessible name of a cell: "Gast, Altersfreigabe: ab 12, geändert" (set in the role) or "…, nicht gespeichert" (staged);
 * a switch says "erlaubt" / "nicht erlaubt" in words
 */
export function cellName(roleLabel: string, f: MatrixField, v: unknown, changed: boolean | 'unsaved'): string {
  const value = f.kind === 'bool' ? tr(v ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied') : cellText(f, v);
  const params = { role: roleLabel, field: fieldLabel(f.key), value };
  return tr(changed === 'unsaved' ? 'adminPeople.roles.cellNameUnsaved' : changed ? 'adminPeople.roles.cellNameChanged' : 'adminPeople.roles.cellName', params);
}

/** unsaved changes: role key → field key → new value */
export type Stage = Record<string, Record<string, unknown>>;

/** besides the matrix fields the role sheet stages two settings of the role itself: `label` (its name) and `invitable` */

/** the loaded value of a staged key: the displayed name, the invitable flag, or the matrix value */
function loadedValue(r: MatrixRole | undefined, key: string): unknown {
  if (!r) return undefined;
  if (key === 'label') return roleName(r);
  if (key === 'invitable') return r.invitable;
  return r.values[key];
}

/** "geändert (Standard: ab 12)": the saved value of a role-set field that differs from its default; null otherwise (the tooltip falls back to "in dieser Rolle geändert") */
export function changedFromText(r: Pick<MatrixRole, 'values' | 'sources' | 'defaults'>, f: MatrixField): string | null {
  if (r.sources[f.key] !== 'role' || !Object.hasOwn(r.defaults, f.key) || same(r.values[f.key], r.defaults[f.key])) return null;
  const d = r.defaults[f.key];
  return tr('adminPeople.roles.changedFrom', { v: f.kind === 'bool' ? tr(d ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied') : cellText(f, d) });
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort(), sb = [...b].sort();
    return sa.every((x, i) => x === sb[i]);
  }
  return Object.is(a ?? null, b ?? null);
}

/** stages a value (a new Stage); the loaded value itself clears the entry (and an emptied role) */
export function stageSet(s: Stage, m: RoleMatrix, role: string, key: string, v: unknown): Stage {
  const loaded = loadedValue(m.roles.find((r) => r.key === role), key);
  const { [role]: cur = {}, ...others } = s;
  const { [key]: _drop, ...rest } = cur;
  const next = same(v, loaded) ? rest : { ...rest, [key]: v };
  return Object.keys(next).length ? { ...others, [role]: next } : others;
}

/** the PUT /api/admin/roles/:role bodies, one per changed role: switches nested under `perms`, "no cap" spelled 'unlimited' */
export function stageBodies(s: Stage): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [role, fields] of Object.entries(s)) {
    const body: Record<string, unknown> = {};
    const perms: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (PERM_SET.has(k)) perms[k] = v;
      else body[k] = v === null && NULL_IS_UNLIMITED.has(k) ? 'unlimited' : v;
    }
    if (Object.keys(perms).length) body.perms = perms;
    if (Object.keys(body).length) out[role] = body;
  }
  return out;
}

/** the save bar's numbers: changes, roles, people the changes reach, their profiles, and whether the media server policy is re-applied */
export function stageCounts(s: Stage, m: RoleMatrix): { changes: number; roles: number; people: number; profiles: number; policy: boolean } {
  let changes = 0, roles = 0, people = 0, profiles = 0, policy = false;
  for (const [key, fields] of Object.entries(s)) {
    const keys = Object.keys(fields);
    if (!keys.length) continue;
    const r = m.roles.find((x) => x.key === key);
    changes += keys.length;
    roles += 1;
    people += r?.accounts ?? 0;
    profiles += r?.profiles ?? 0;
    if (keys.some((k) => MEDIA_FIELDS.has(k))) policy = true;
  }
  return { changes, roles, people, profiles, policy };
}

/** one line per staged change for the review sheet, in matrix field order ("Gast · Altersfreigabe: ab 12 → ab 16") */
export function reviewLines(s: Stage, m: RoleMatrix): Array<{ role: string; field: string; from: string; to: string }> {
  const lines: Array<{ role: string; field: string; from: string; to: string }> = [];
  for (const [key, fields] of Object.entries(s)) {
    const r = m.roles.find((x) => x.key === key);
    if (!r) continue;
    for (const f of m.fields) {
      if (!Object.hasOwn(fields, f.key)) continue;
      lines.push({ role: roleName(r), field: fieldLabel(f.key), from: cellText(f, r.values[f.key]), to: cellText(f, fields[f.key]) });
    }
    if (Object.hasOwn(fields, 'label')) lines.push({ role: roleName(r), field: tr('adminPeople.roles.fLabel'), from: roleName(r), to: String(fields.label) });
    if (Object.hasOwn(fields, 'invitable')) {
      const word = (v: unknown) => tr(v ? 'adminPeople.roles.allowed' : 'adminPeople.roles.denied');
      lines.push({ role: roleName(r), field: tr('adminPeople.roles.fInvitable'), from: word(r.invitable), to: word(fields.invitable) });
    }
  }
  return lines;
}

/** the name to show: a built-in default label (or none, falling back to the base's) in the UI language, else the configured label, else the key */
export function roleName(r: Pick<MatrixRole, 'key' | 'label' | 'base' | 'builtinLabel'>): string {
  if (r.label && !r.builtinLabel) return r.label;
  for (const k of [r.key, r.base]) if (hasKey(`admin.roleNames.${k}`)) return trDynamic(`admin.roleNames.${k}`);
  return r.label ?? r.key;
}

/** the phone card's second line: "2 Streams · 20 Mbit/s · ab 12 · Downloads aus" */
export function summaryLine(r: MatrixRole): string {
  const v = r.values;
  const by = (k: string, kind: FieldKind) => ({ key: k, group: 'access' as const, kind });
  return [
    tr('adminPeople.roles.sumStreams', { n: Number(v.maxStreams ?? 0) }),
    cellText(by('maxBitrate', 'bitrate'), v.maxBitrate),
    cellText(by('maxParentalRating', 'rating'), v.maxParentalRating),
    tr(v.download ? 'adminPeople.roles.sumDownloadsOn' : 'adminPeople.roles.sumDownloadsOff'),
  ].join(' · ');
}

export type StageCounts = ReturnType<typeof stageCounts>;

/** the save bar's line, every count in its plural form: "1 Änderung in 1 Rolle · betrifft 3 Personen" */
export const saveBarText = (c: StageCounts): string => tr('adminPeople.roles.saveBar', {
  n: c.changes, roles: tr('adminPeople.roles.saveBarRoles', { n: c.roles }), people: tr('adminPeople.roles.saveBarPeople', { n: c.people }),
});

/** the column head's second line: "8 Personen · 2 Kinderprofile" */
export const peopleLine = (r: Pick<MatrixRole, 'accounts' | 'kidsProfiles'>): string =>
  tr('adminPeople.roles.people', { n: r.accounts, kids: tr('adminPeople.roles.peopleKids', { n: r.kidsProfiles }) });

/** what saving re-applies on the media server: "Die Freigaben von 4 Personen und 6 Profilen werden … aktualisiert." */
export const policyLine = (c: StageCounts): string =>
  tr('adminPeople.roles.reviewPolicy', { n: c.people, profiles: tr('adminPeople.roles.reviewProfiles', { n: c.profiles }) });

/** a partial policy failure: "2 Konten konnten nicht aktualisiert werden." */
export const partialText = (failed: number): string => tr('adminPeople.roles.partialRetry', { n: failed });
