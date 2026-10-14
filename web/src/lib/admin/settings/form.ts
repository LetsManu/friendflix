// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Settings form logic: drafts per key, what a save sends (only the fields that changed: a shown value may be redacted, e.g.
 * ntfy's `auth=redacted`, and must never be saved back), texts for codes, and the change kept across a re-authentication. That copy
 * lives in sessionStorage and never holds a secret or a URL with a credential in it: those are entered again.
 */
import { fmtList, hasKey, tr, trDynamic } from '#lib/i18n';
import type { ProbeResult, SettingGroup, SettingView } from './api';

/** A field's edited value: text, a switch, or null (a secret marked "remove"). */
export type Draft = string | boolean | null;

/** The value a field shows before any edit (secrets: always empty, they are write-only). */
export function shownDraft(v: SettingView): string | boolean {
  if (v.kind === 'bool') return v.value === true;
  if (v.kind === 'secret' || v.value === null || v.value === undefined) return '';
  if (Array.isArray(v.value)) return v.value.join(', ');
  return typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
}

const cidrs = (s: string) => s.split(',').map((c) => c.trim()).filter(Boolean).join(',');

/** The JSON a save sends for a draft: typed for switches and numbers, null for an emptied field (back to the default). */
export function submitValue(v: SettingView, d: Draft): unknown {
  if (d === null || typeof d === 'boolean') return d;
  const s = v.kind === 'secret' ? d : d.trim();
  if (!s) return null;
  if (v.kind === 'int' || v.kind === 'number') {
    const n = Number(s);
    return Number.isFinite(n) ? n : s; // the backend answers invalid_number
  }
  return v.kind === 'cidrList' ? cidrs(s) : s;
}

/** Whether a draft differs from what the field showed (typing the shown value back is no change). */
export function isChange(v: SettingView, d: Draft | undefined): boolean {
  if (d === undefined) return false;
  if (v.kind === 'secret') return d === null ? v.set : typeof d === 'string' && d !== '';
  const shown = shownDraft(v);
  if (typeof d === 'boolean' || typeof shown === 'boolean') return d !== shown;
  if (d === null) return shown !== '';
  return v.kind === 'cidrList' ? cidrs(d) !== cidrs(shown) : d.trim() !== shown.trim();
}

/** The values a save of these rows sends: only changed fields, never a locked (env) row. */
export function changedValues(items: readonly SettingView[], edits: Readonly<Record<string, Draft>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of items) {
    if (v.source === 'env' || !isChange(v, edits[v.key])) continue;
    out[v.key] = submitValue(v, edits[v.key]!);
  }
  return out;
}

/** A draft that may sit in sessionStorage: no secret, no URL with userinfo or a token-like query parameter. */
export function keepable(v: SettingView, d: Draft): boolean {
  if (v.kind === 'secret') return false;
  if (typeof d !== 'string' || v.kind !== 'url') return true;
  return !d.includes('@') && !/[?&#;](auth|token|key|secret|pass|password|apikey|api_key|sig)=/i.test(d);
}

const STASH = 'ff_settings_pending';
/** a stashed change older than this is dropped (the re-authentication window is 10 minutes) */
const MAX_AGE_MS = 15 * 60_000;

/** A save interrupted by a re-authentication: the group and the drafts that could be kept. */
export interface Pending { group: SettingGroup; edits: Record<string, Draft>; /** a secret or credential URL was left out */ dropped: boolean; at: number }

/** Keeps a group's changed drafts for the return from the sign-in; returns whether something had to be left out. */
export function stashPending(group: SettingGroup, items: readonly SettingView[], edits: Readonly<Record<string, Draft>>, now = Date.now()): { dropped: boolean } {
  const kept: Record<string, Draft> = {};
  let dropped = false;
  for (const v of items) {
    const d = edits[v.key];
    if (v.source === 'env' || !isChange(v, d)) continue;
    if (keepable(v, d!)) kept[v.key] = d!;
    else dropped = true;
  }
  const p: Pending = { group, edits: kept, dropped, at: now };
  try { sessionStorage.setItem(STASH, JSON.stringify(p)); } catch { /* storage blocked: the person types it again */ }
  return { dropped };
}

/** Reads and removes the stashed change (null when there is none, it is too old or unreadable). */
export function takePending(now = Date.now()): Pending | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STASH);
    sessionStorage.removeItem(STASH);
  } catch { return null; }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pending>;
    if (typeof p.group !== 'string' || !p.edits || typeof p.edits !== 'object' || typeof p.at !== 'number' || now - p.at > MAX_AGE_MS || p.at > now) return null;
    const edits: Record<string, Draft> = {};
    for (const [k, d] of Object.entries(p.edits)) if (typeof d === 'string' || typeof d === 'boolean' || d === null) edits[k] = d;
    return { group: p.group as SettingGroup, edits, dropped: p.dropped === true, at: p.at };
  } catch { return null; }
}

/** The setting's label (the key itself for a key this version has no text for). */
export const keyLabel = (key: string): string => (hasKey(`settings.keys.${key}.label`) ? trDynamic(`settings.keys.${key}.label`) : key);
export const keyHelp = (key: string): string => (hasKey(`settings.keys.${key}.help`) ? trDynamic(`settings.keys.${key}.help`) : '');

/** The env names to remove after a move; legacy names of an old product are summarised, not named. */
export function moveHint(names: readonly string[]): string {
  const own = names.filter((n) => !/seerr/i.test(n));
  const list = fmtList(own);
  return tr('settings.moveHint', { keys: own.length < names.length ? tr('settings.moveHintOlder', { keys: list }) : list });
}

/** Text of a field error code (400 invalid_settings). */
export const errorText = (code: string): string =>
  (/^[a-z_]+$/.test(code) && hasKey(`settings.errors.${code}`) ? trDynamic(`settings.errors.${code}`) : tr('settings.errors.invalid'));

/** Text of a probe result: the code's sentence plus the detail's, when there is one. */
export function probeText(r: ProbeResult): string {
  const code = hasKey(`settings.probe.${r.code}`) ? trDynamic(`settings.probe.${r.code}`) : tr('settings.probe.invalid');
  const detail = r.detail && /^[a-z_]+$/.test(r.detail) && hasKey(`settings.probeDetail.${r.detail}`) ? trDynamic(`settings.probeDetail.${r.detail}`) : '';
  return detail ? `${code} ${detail}` : code;
}
