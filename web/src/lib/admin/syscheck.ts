// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Systemcheck (Admin → Status, overview summary): mirror of the backend contract (`backend/src/syscheck/types.ts`), the loader and
 * the pure helpers that turn the coded lines into texts and links (i18n area `syscheck`). The backend sends codes only; a code without a
 * text shows nothing rather than the raw code. Spec: docs/superpowers/specs/2026-11-14-systemcheck-design.md.
 */
import { api } from '#lib/api';
import { hasKey, tr, trDynamic, type TKey, type TParams } from '#lib/i18n';
import type { Tone } from '#lib/ui/StatusPill.svelte';
import { failClassText } from './health';

export const CHECK_STATUSES = ['ok', 'warning', 'problem', 'not_set_up', 'unknown'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** fixed group order on the Status page */
export const CHECK_GROUPS = ['core', 'signin', 'media', 'livetv', 'updates', 'proxy'] as const;
export type CheckGroup = (typeof CHECK_GROUPS)[number];
/** the full catalogue in display order (same list as the backend; a unit test compares both) */
export const CHECK_IDS = [
  'core.publicUrl', 'core.database', 'core.redis', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env',
  'signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys', 'signin.mail',
  'media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder',
  'livetv.container', 'livetv.encoder', 'livetv.sources', 'livetv.guides',
  'updates.updater', 'updates.path', 'updates.portainer',
  'proxy.forwardedProto', 'proxy.peer', 'proxy.websocket', 'proxy.buffering', 'proxy.upload', 'proxy.headers',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
/** the lines only the browser can measure (they run on the Status page, never on the server) */
export const BROWSER_IDS: readonly CheckId[] = ['proxy.websocket', 'proxy.buffering', 'proxy.upload', 'proxy.headers'];

export interface CheckLine {
  id: CheckId;
  group: CheckGroup;
  status: CheckStatus;
  cause?: string;
  fix?: string;
  settingKey?: string;
  settingGroup?: string;
  locked?: true;
  href?: string;
  docs?: string;
  params?: Record<string, number | string>;
  ms?: number;
  runs: 'server' | 'browser';
  /** web only: no result for this line yet (not answered by the server, or a browser check that has not run) */
  placeholder?: true;
}
export interface SystemcheckResult { at: string; lines: CheckLine[]; counts: Record<CheckStatus, number> }

/** GET /api/admin/systemcheck (cached on the server); `refresh` is "Jetzt prüfen" (rate limited: 429 rate_limited) */
export const loadSystemcheck = (refresh = false): Promise<SystemcheckResult> => api<SystemcheckResult>(`/api/admin/systemcheck${refresh ? '?refresh=1' : ''}`);

const GROUP_OF = (id: string): CheckGroup => id.slice(0, id.indexOf('.')) as CheckGroup;
const CODE = /^[a-z][a-z0-9_]{0,59}$/;
const SETTING_KEY = /^[A-Z][A-Z0-9_]*$/;
const DOCS = /^[a-z-]+\.md(#[a-z0-9-]+)?$/;
const DOCS_BASE = 'https://github.com/LetsManu/friendflix/blob/main/docs/';

/** i18n key of a line's label ('core.disk.downloads' → syscheck.line.core_disk_downloads) */
export const lineKey = (id: string): string => `syscheck.line.${id.replace(/\./g, '_')}`;

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** a flow kind as sent in params ('setup_totp') → its name on the sign-in card */
const flowName = (kind: string): string => {
  const key = `adminContent.login.flows.${kind.replace(/_/g, '-')}`;
  return kind && hasKey(key) ? trDynamic(key) : '';
};
const diskName = (id: string): string => (id === 'downloads' || id === 'previews' ? tr(`adminContent.health.disks.${id}` as TKey) : '');

/** the values a cause / fix sentence may use; missing numbers read 0, never `{n}` */
function textParams(l: CheckLine): TParams {
  const p = l.params ?? {};
  return {
    n: num(p.n), pct: num(p.pct), ms: num(l.ms),
    flow: flowName(str(p.flow)), cls: str(p.cls) ? failClassText(str(p.cls)) : '', perms: str(p.perms).split(',').filter(Boolean).join(', '),
    keys: str(p.keys).split(',').filter(Boolean).join(', '), key: l.settingKey ?? '',
  };
}
const codeText = (kind: 'cause' | 'fix', code: string | undefined, params: TParams): string => {
  if (!code || !CODE.test(code)) return '';
  const key = `syscheck.${kind}.${code}`;
  return hasKey(key) ? trDynamic(key, params) : '';
};

export interface LineText { label: string; cause: string; fix: string; note: string }
/**
 * The texts of a line: label, cause and fix sentence (an unknown code → '', never the code), plus a note (the volume a disk shares, how
 * many more sign-in hints the card has). A setting from the environment adds "steht in der .env" to the fix.
 */
export function lineText(l: CheckLine): LineText {
  const key = lineKey(l.id);
  const params = textParams(l);
  const label = hasKey(key) ? trDynamic(key) : '';
  const cause = codeText('cause', l.cause, params);
  let fix = codeText('fix', l.fix, params);
  if (l.locked && l.settingKey) fix = [fix, tr('syscheck.fix.envLocked', { key: l.settingKey })].filter(Boolean).join(' ');
  const notes: string[] = [];
  const shared = diskName(str(l.params?.sharedWith));
  if (shared) notes.push(tr('syscheck.sharedWith', { name: shared }));
  if (l.id === 'signin.flows' && l.status !== 'ok' && num(l.params?.n) > 1) notes.push(tr('syscheck.more', { n: num(l.params?.n) - 1 }));
  return { label, cause, fix, note: notes.join(' ') };
}

/** "Zur Einstellung": Live-TV settings live on their own page; a key of another form opens the settings page only */
export function settingHref(key: string, group?: string): string {
  if (!SETTING_KEY.test(key)) return '/admin/settings';
  return group === 'livetv' ? `/admin/livetv?tab=settings&setting=${key}` : `/admin/settings?setting=${key}`;
}

/** "Anleitung": a file under docs/ on GitHub ('' for anything that is not `<file>.md#anchor`) */
export const docsHref = (docs: string): string => (DOCS.test(docs) ? DOCS_BASE + docs : '');

const TONE: Record<CheckStatus, Tone> = { ok: 'ok', warning: 'warn', problem: 'err', not_set_up: 'muted', unknown: 'muted' };
/** pill colour (repeats the word, never alone): not set up is neutral, never red */
export const statusTone = (s: CheckStatus): Tone => TONE[s] ?? 'muted';
const ICON: Record<CheckStatus, string> = { ok: 'check', warning: 'clock', problem: 'alert', not_set_up: 'x', unknown: 'info' };
export const statusIcon = (s: CheckStatus): string => ICON[s] ?? 'info';

/** "2 Probleme" / "1 Warnung" / "Alles in Ordnung": problems before warnings; not set up and unknown lines never count */
export function summaryOf(counts: Partial<Record<CheckStatus, number>>): { tone: Tone; text: string } {
  const problems = counts.problem ?? 0, warnings = counts.warning ?? 0;
  if (problems > 0) return { tone: 'err', text: tr('syscheck.summary.problems', { n: problems }) };
  if (warnings > 0) return { tone: 'warn', text: tr('syscheck.summary.warnings', { n: warnings }) };
  return { tone: 'ok', text: tr('syscheck.summary.allOk') };
}

/** counts of real results (placeholders are not checked yet and not counted) */
export function countLines(lines: readonly CheckLine[]): Record<CheckStatus, number> {
  const c = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const l of lines) if (!l.placeholder && l.status in c) c[l.status]++;
  return c;
}

const placeholder = (id: CheckId): CheckLine => ({ id, group: GROUP_OF(id), status: 'unknown', runs: BROWSER_IDS.includes(id) ? 'browser' : 'server', placeholder: true });

/**
 * One line per catalogue id, in catalogue order: the browser's result for a browser id, else the server's, else a placeholder
 * (`unknown`, "nicht geprüft"). Nothing reorders when results arrive; an id outside the catalogue is dropped.
 */
export function mergeLines(server: readonly CheckLine[], browser: readonly CheckLine[]): CheckLine[] {
  const b = new Map(browser.filter((l) => BROWSER_IDS.includes(l.id)).map((l) => [l.id, l]));
  const s = new Map(server.filter((l) => !BROWSER_IDS.includes(l.id)).map((l) => [l.id, l]));
  return CHECK_IDS.map((id) => b.get(id) ?? s.get(id) ?? placeholder(id));
}
