// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure rules of the card *Medienserver* (spec "Admin and wizard"): which choice is current and which one cannot be offered (and
 * why), the base code's countdown, the folder rows' checks (the backend's bounds, so a refusal rarely reaches the server), the first
 * run's progress rows, which actions fit the server's state, the image against this build's pin, and a readable sentence for every
 * code the card can receive (MEDIA_ERRORS, the first run's codes, the routes' refusals; an unknown code still names itself). The
 * Svelte components only render what these say.
 */
import { hasKey, trDynamic } from '#lib/i18n';
import type { FolderInput, Kind, LibraryEntry, MediaManaged, MediaView, OfferReason, SetupStep } from './api';

export type Choice = Kind | 'external';
export const CHOICES: readonly Choice[] = ['ferrofin', 'jellyfin', 'external'];
/** the managed kind preselected while Ferrofin is a trial (owner decision 8: a one-line change once it is tested) */
export const DEFAULT_MANAGED: Kind = 'jellyfin';
/** kinds that carry *Test* and the docs link */
export const TRIAL_KINDS: readonly Kind[] = ['ferrofin'];
export const DOCS_HREF = 'https://github.com/LetsManu/friendflix/blob/main/docs/mediaserver.md';
export type ReasonKey = OfferReason | 'image_missing';

/** the kind's own name (the typed confirmation of *Daten löschen*) */
export const kindName = (k: Kind): string => (k === 'ferrofin' ? 'Ferrofin' : 'Jellyfin');

/** the choice the server is on now: the managed kind, else the external server */
export const currentChoice = (v: MediaView): Choice => (v.mode === 'managed' && v.managed.kind ? v.managed.kind : 'external');

/** why a choice cannot be taken (null: it can): the backend's offer reason first, then a kind this build carries no image for */
export function choiceDisabled(v: MediaView, c: Choice): ReasonKey | null {
  if (c === 'external') return null;
  if (!v.offer.managed) return v.offer.reason ?? 'no_updater';
  return v.kinds[c] === false ? 'image_missing' : null;
}
export const reasonText = (r: ReasonKey): string => trDynamic(`mediaserver.reason.${r}`);

/** the base code's time left as mm:ss (00:00 once it is past, or for a time that does not parse) */
export function countdown(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  const s = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** where the updater wrote the code (spec "The base folder and its code", point 4) */
export const codeLogHint = {
  compose: 'docker compose logs updater | grep "media folder"',
  portainer: 'Portainer → Containers → updater → Logs',
} as const;

const codePoints = (s: string): number => [...s].length;
/** the backup passphrase: 12–1024 code points (backend decodePassphrase), typed twice the same */
export function passphraseError(a: string, b: string): null | 'short' | 'long' | 'mismatch' {
  if (codePoints(a) < 12) return 'short';
  if (codePoints(a) > 1024) return 'long';
  return a === b ? null : 'mismatch';
}

export const MAX_FOLDERS = 20;
const CONTROL = /\p{Cc}/u;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/**
 * The chosen folders as the backend checks them (routes/adminMediaserver.ts S.apply and the updater): at least one, at most 20, a
 * library name of 1–60 characters, one library per name (trimmed, without regard to case: 400 invalid_body otherwise), no folder
 * inside another (folder_nested).
 */
export function folderRowsError(rows: ReadonlyArray<Pick<FolderInput, 'rel' | 'name' | 'type'>>): null | 'none' | 'too_many' | 'name' | 'duplicate_name' | 'nested' {
  if (!rows.length) return 'none';
  if (rows.length > MAX_FOLDERS) return 'too_many';
  if (rows.some((r) => r.name.length < 1 || r.name.length > 60 || r.name.trim() === '' || CONTROL.test(r.name))) return 'name';
  if (rows.some((r, i) => rows.some((o, j) => j < i && sameName(o.name, r.name)))) return 'duplicate_name';
  if (rows.some((r, i) => rows.some((o, j) => j !== i && (o.rel === r.rel || r.rel.startsWith(`${o.rel}/`))))) return 'nested';
  return null;
}
/** the row whose name is the name of a kept library (a removed folder whose library stays in the server): 409 library_name_taken */
export const nameTakenRow = (rows: ReadonlyArray<Pick<FolderInput, 'name'>>, kept: readonly LibraryEntry[]): number =>
  rows.findIndex((r) => kept.some((k) => sameName(k.name, r.name)));

/** the slug of a mounted folder (`/media/<slug>`) */
const slugOf = (target: string) => target.replace(/^\/media\//, '');
/** the folders mounted now (or, before the first apply, every stored library) as editable rows */
export function initialRows(v: MediaView): FolderInput[] {
  const d = v.status?.desired;
  const libs = v.managed.libraries;
  const mounted = d ? libs.filter((l) => d.folders.some((f) => slugOf(f.target) === l.slug)) : libs;
  return mounted.map((l) => ({ rel: l.rel, name: l.name, type: l.type }));
}
/** libraries whose folder was removed: they stay in the server (their items show as missing) until deleted on their own */
export function keptLibraries(v: MediaView): LibraryEntry[] {
  const d = v.status?.desired;
  if (!d) return [];
  return v.managed.libraries.filter((l) => l.created && !d.folders.some((f) => slugOf(f.target) === l.slug));
}

/**
 * The Live TV recordings folder (LIVETV_RECORD_LIBRARY_JF_PATH, spec "Subfolders", last point): a chosen folder named like the last
 * part of that path (compared without regard to case) whose library is stored offers to set the path to its target `/media/<slug>`;
 * null when none is chosen, the library is not stored yet (its slug comes with the apply) or the path already points there.
 */
export function livetvOffer(v: MediaView, rows: ReadonlyArray<Pick<FolderInput, 'rel'>>): { rel: string; target: string } | null {
  const last = (p: string) => p.replace(/\/+$/, '').split('/').pop()!.toLowerCase();
  const want = v.livetvLibraryPath ? last(v.livetvLibraryPath) : '';
  const row = want ? rows.find((r) => last(r.rel) === want) : undefined;
  const lib = row ? v.managed.libraries.find((l) => l.rel === row.rel) : undefined;
  if (!row || !lib) return null;
  const target = `/media/${lib.slug}`;
  return target === v.livetvLibraryPath ? null : { rel: row.rel, target };
}

/** a container uid / gid / media group: an integer 1–65535, never 0 */
export const idError = (n: number): boolean => !(Number.isInteger(n) && n >= 1 && n <= 65535);

export const SETUP_STEPS = ['applying', 'first_run', 'api_key', 'libraries', 'hwaccel', 'finishing'] as const satisfies readonly SetupStep[];
export type SetupRowState = 'done' | 'running' | 'failed' | 'todo';
/**
 * The first run's progress rows (backend mediaserver/firstRun.ts): the steps before the current one done, the current one running
 * (failed with an error), the rest to do. `failed` is only reached through a startup wizard someone else completed (wizard_taken):
 * the first start failed.
 */
export function setupSteps(m: Pick<MediaManaged, 'setup' | 'setupError'>): Array<{ step: (typeof SETUP_STEPS)[number]; state: SetupRowState }> {
  const at = m.setup === 'done' ? SETUP_STEPS.length : m.setup === 'failed' ? SETUP_STEPS.indexOf('first_run') : SETUP_STEPS.indexOf(m.setup as (typeof SETUP_STEPS)[number]);
  const failed = m.setup === 'failed' || m.setupError !== null;
  return SETUP_STEPS.map((step, i) => ({ step, state: at < 0 || i > at ? 'todo' : i < at ? 'done' : failed ? 'failed' : 'running' }));
}
/** the first run is under way (the card follows it) */
export const setupActive = (m: Pick<MediaManaged, 'setup' | 'setupError'>): boolean =>
  m.setupError === null && (SETUP_STEPS as readonly string[]).includes(m.setup);

/** a numeric version compare (10.11 = 10.11.0); null when either is no version */
export function versionCmp(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (s: string) => (/^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
/**
 * The running image against this build's pin: `newer` = the container runs a newer upstream than this build pins (a FriendFlix rollback:
 * never down, "neuer als dieser FriendFlix-Stand"), `update` = another image, a template the updater would build differently, or a backend
 * build the pins were not read for yet; `same`; `unknown` without a container or a pin.
 */
export function pinState(v: MediaView): 'same' | 'update' | 'newer' | 'unknown' {
  const c = v.status?.container, pin = v.status?.pin;
  if (!c || !pin?.image) return 'unknown';
  if (pin.upstream && versionCmp(c.image.upstream, pin.upstream) === 1) return 'newer';
  if (!pin.image.endsWith(`@${c.image.digest}`) || c.template === 'update_pending' || pin.changed) return 'update';
  return 'same';
}

export type ActionOp = 'start' | 'stop' | 'restart' | 'update' | 'backup' | 'restore' | 'remove';
export const ACTION_ORDER: readonly ActionOp[] = ['start', 'stop', 'restart', 'update', 'backup', 'restore', 'remove'];
/**
 * The actions that fit (in a fixed order, so the row never reorders): none without an updater that reaches its engine; a running
 * managed server stops and restarts, any other starts (a leftover container while external is only removed); *Aktualisieren* only when the image or template is behind and the managed setup is done
 * (the first run's own apply reads update_pending until finish-setup ran); backups of a managed server, a restore when one of its kind
 * exists; *Entfernen* for a managed server or a leftover container. *Nochmal* lives with the setup progress, *HDR-Test* with the GPU.
 */
export function actionsFor(v: MediaView): ActionOp[] {
  const s = v.status;
  if (!s?.available) return [];
  const managed = v.mode === 'managed' && v.managed.kind !== null;
  const c = s.container;
  const out = new Set<ActionOp>();
  // a leftover container while external can only be removed
  if (c && managed) {
    if (c.state === 'running' || c.state === 'restarting') { out.add('stop'); out.add('restart'); } else out.add('start');
    if (v.managed.setup === 'done' && pinState(v) === 'update') out.add('update');
    out.add('backup');
  }
  if (managed && s.backups.some((b) => b.kind === v.managed.kind)) out.add('restore');
  if (managed || c) out.add('remove');
  return ACTION_ORDER.filter((a) => out.has(a));
}

const CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** a readable sentence for a code (a job's, the first run's, a route's); an unknown code reads as the generic one naming it */
export function mediaErrorText(code: string | null | undefined): string {
  const c = typeof code === 'string' && CODE.test(code) ? code : null;
  if (c && hasKey(`mediaserver.error.${c}`)) return trDynamic(`mediaserver.error.${c}`);
  return trDynamic('mediaserver.error.unknown', { code: c ?? '?' });
}
