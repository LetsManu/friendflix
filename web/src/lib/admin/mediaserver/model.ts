// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure rules of the card *Medienserver* (spec "Admin and wizard"): which choice is current and which one cannot be offered (and
 * why), the base code's countdown, the folder rows' checks (the backend's bounds, so a refusal rarely reaches the server), the first
 * run's progress rows, which actions fit the server's state, the image against this build's pin, and a readable sentence for every
 * code the card can receive (MEDIA_ERRORS, the first run's codes, the routes' refusals; an unknown code still names itself). The
 * Svelte components only render what these say.
 */
import { hasKey, tr, trDynamic } from '#lib/i18n';
import type { FolderInput, Kind, LibraryEntry, MediaFolder, MediaManaged, MediaView, MoveCandidate, MoveJobStep, MovePhase, MoveScan, MoveScanRecord, MoveState, OfferReason, SetupStep } from './api';

export type Choice = Kind | 'external';
export const CHOICES: readonly Choice[] = ['ferrofin', 'jellyfin', 'external'];
/** the managed kind preselected while Ferrofin is a trial (owner decision 8: a one-line change once it is tested) */
export const DEFAULT_MANAGED: Kind = 'jellyfin';
/** kinds that carry *Test* and the docs link */
export const TRIAL_KINDS: readonly Kind[] = ['ferrofin'];
export const DOCS_HREF = 'https://github.com/LetsManu/friendflix/blob/main/docs/mediaserver.md';
/** `moved`: a server a move made stays Ferrofin (the updater refuses another kind on its migrated spec) */
export type ReasonKey = OfferReason | 'image_missing' | 'moved';

/** the kind's own name (the typed confirmation of *Daten löschen*) */
export const kindName = (k: Kind): string => (k === 'ferrofin' ? 'Ferrofin' : 'Jellyfin');

/** the choice the server is on now: the managed kind, else the external server */
export const currentChoice = (v: MediaView): Choice => (v.mode === 'managed' && v.managed.kind ? v.managed.kind : 'external');

/**
 * why a choice cannot be taken (null: it can): another kind on a moved server (it stays Ferrofin), the backend's offer reason, then a
 * kind this build carries no image for
 */
export function choiceDisabled(v: MediaView, c: Choice): ReasonKey | null {
  if (c === 'external') return null;
  if (v.mode === 'managed' && v.managed.kind && c !== v.managed.kind && moved(v)) return 'moved';
  if (!v.offer.managed) return v.offer.reason ?? 'no_updater';
  return v.kinds[c] === false ? 'image_missing' : null;
}
export const reasonText = (r: ReasonKey): string => trDynamic(`mediaserver.reason.${r}`);
/**
 * The updater has read no media status yet since it started (a pin verify can take minutes): the card waits for it like for its
 * first load, with the neutral line instead of the form and the actions. Not while another offer reason stands (Plex, a pinned URL).
 */
export const statusStarting = (v: MediaView): boolean => v.status?.reason === 'starting' && (v.mode === 'managed' || v.offer.reason === 'starting');

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
 * inside another (folder_nested). `migrated`: a moved server's folders, which the backend adds to the same spec (they count).
 */
export function folderRowsError(rows: ReadonlyArray<Pick<FolderInput, 'rel' | 'name' | 'type'>>, migrated = 0): null | 'none' | 'too_many' | 'name' | 'duplicate_name' | 'nested' {
  if (!rows.length && !migrated) return 'none';
  if (rows.length + migrated > MAX_FOLDERS) return 'too_many';
  if (rows.some((r) => r.name.length < 1 || r.name.length > 60 || r.name.trim() === '' || CONTROL.test(r.name))) return 'name';
  if (rows.some((r, i) => rows.some((o, j) => j < i && sameName(o.name, r.name)))) return 'duplicate_name';
  if (rows.some((r, i) => rows.some((o, j) => j !== i && (o.rel === r.rel || r.rel.startsWith(`${o.rel}/`))))) return 'nested';
  return null;
}
/**
 * A picked folder's first library name: its own name cut at 60 (the backend's bound, UTF-16 units) at a code point boundary, so a
 * character outside the BMP is never split in half.
 */
export function defaultName(name: string): string {
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > 60) break;
    out += ch;
  }
  return out;
}

/** the row whose name is the name of a kept library (a removed folder whose library stays in the server): 409 library_name_taken */
export const nameTakenRow = (rows: ReadonlyArray<Pick<FolderInput, 'name'>>, kept: readonly LibraryEntry[]): number =>
  rows.findIndex((r) => kept.some((k) => sameName(k.name, r.name)));

/** the slug of a mounted folder (`/media/<slug>`; after a move `/ffmedia/<slug>`) */
const slugOf = (target: string) => target.replace(/^\/(ff)?media\//, '');
/** a moved server's folders as the updater recorded them (read-only in the form; the backend sends them as recorded) */
export const migratedFolders = (v: MediaView): MediaFolder[] => (v.status?.desired?.migrated ? v.status.desired.folders.filter((f) => f.migrated) : []);
/** a server a move made (recorded by the updater, or by the backend) */
const moved = (v: MediaView): boolean => v.status?.desired?.migrated === true || Boolean(v.move?.migratedFrom);
/** the whole base folder was taken over (a migrated rel ''): every folder below it is visible in Ferrofin already */
export const wholeBaseMigrated = (migrated: readonly MediaFolder[]): boolean => migrated.some((f) => f.rel === '');
/**
 * a chosen folder against the migrated ones (the updater refuses both as folder_nested): `same` it is one of them, `overlap` it lies
 * inside one or holds one (any folder when the whole base was taken over); null when it is free
 */
export function migratedOverlap(rel: string, migrated: readonly MediaFolder[]): 'same' | 'overlap' | null {
  if (migrated.some((f) => f.rel === rel)) return 'same';
  return migrated.some((f) => f.rel === '' || rel.startsWith(`${f.rel}/`) || f.rel.startsWith(`${rel}/`)) ? 'overlap' : null;
}
/** the folders mounted now (or, before the first apply, every stored library) as editable rows */
export function initialRows(v: MediaView): FolderInput[] {
  const d = v.status?.desired;
  const libs = v.managed.libraries;
  const mounted = d ? libs.filter((l) => d.folders.some((f) => !f.migrated && slugOf(f.target) === l.slug)) : libs;
  return mounted.map((l) => ({ rel: l.rel, name: l.name, type: l.type }));
}
/** libraries whose folder was removed: they stay in the server (their items show as missing) until deleted on their own */
export function keptLibraries(v: MediaView): LibraryEntry[] {
  const d = v.status?.desired;
  if (!d) return [];
  return v.managed.libraries.filter((l) => l.created && !d.folders.some((f) => !f.migrated && slugOf(f.target) === l.slug));
}

/**
 * The Live TV recordings folder (LIVETV_RECORD_LIBRARY_JF_PATH, spec "Subfolders", last point): a chosen folder named like the last
 * part of that path (compared without regard to case) whose library is stored offers to set the path to its target `/media/<slug>`
 * (`/ffmedia/<slug>` on a moved server, where new folders mount);
 * null when none is chosen, the library is not stored yet (its slug comes with the apply) or the path already points there.
 */
export function livetvOffer(v: MediaView, rows: ReadonlyArray<Pick<FolderInput, 'rel'>>): { rel: string; target: string } | null {
  const last = (p: string) => p.replace(/\/+$/, '').split('/').pop()!.toLowerCase();
  const want = v.livetvLibraryPath ? last(v.livetvLibraryPath) : '';
  const row = want ? rows.find((r) => last(r.rel) === want) : undefined;
  const lib = row ? v.managed.libraries.find((l) => l.rel === row.rel) : undefined;
  if (!row || !lib) return null;
  const target = `/${lib.ffmedia || v.status?.desired?.migrated ? 'ffmedia' : 'media'}/${lib.slug}`;
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

/** a save picker or file write that failed in the browser (not a refusal of the backend): a sentence, else null */
export function saveErrorText(e: unknown): string | null {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'SecurityError' || name === 'NotAllowedError') return trDynamic('mediaserver.backup.saveRefused');
  if (name === 'AbortError') return trDynamic('mediaserver.backup.saveAborted');
  return null;
}

const CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** a readable sentence for a code (a job's, the first run's, a route's); an unknown code reads as the generic one naming it */
export function mediaErrorText(code: string | null | undefined): string {
  const c = typeof code === 'string' && CODE.test(code) ? code : null;
  if (c && hasKey(`mediaserver.error.${c}`)) return trDynamic(`mediaserver.error.${c}`);
  return trDynamic('mediaserver.error.unknown', { code: c ?? '?' });
}

// ------------------------------------------------------------------ the move from Jellyfin (stage 2)
/**
 * The sheet's step list (spec "The move"): the updater's copy job (copy_bulk … adopt), then the backend's phases (nfo, verify, switch,
 * requests). Fixed, so the list never reorders and its room is known from the start.
 */
export const MOVE_STEPS = ['copy_bulk', 'stop_source', 'copy', 'create', 'start', 'health', 'adopt', 'nfo', 'verify', 'switch', 'requests'] as const;
export type MoveStepName = (typeof MOVE_STEPS)[number];
/** the phases in which a move is under way (backend mediaserver/move.ts ACTIVE_PHASES) */
const ACTIVE: readonly MovePhase[] = ['copying', 'nfo', 'verify', 'switch', 'requests'];
/** the phases an abort still undoes (before the switch: backend SWITCHED_PHASES) */
const ABORTABLE: readonly MovePhase[] = ['copying', 'nfo', 'verify'];
const BACK_UNDER_WAY = ['starting', 'switched', 'stopped'];
/** the rate the downtime estimate assumes (Ruling: a fixed rate is good enough for an estimate the UI labels "etwa") */
export const MOVE_RATE = 50e6;
/** a scan the move accepts is at most 10 minutes old (backend SCAN_TTL_S); the sheet reuses one up to 9, leaving a minute to decide */
const SCAN_REUSE_MS = 9 * 60_000;

/**
 * The sheet's summary of a scan (spec sketch): the folders as Ferrofin sees them (the paths the old Jellyfin used), the copy's size
 * (trickplay only when chosen), the plugins that are not taken over and the downtime in whole minutes, at least one. The downtime is the
 * final pass's estimate at MOVE_RATE; the scan carries no database size of its own, so the estimate takes the whole copy (an upper bound:
 * the final pass copies the database and what changed since the bulk copy).
 */
export function moveSummary(scan: MoveScan, trickplay: boolean): { folders: string[]; bytes: number; downtimeMin: number; plugins: string[] } {
  const bytes = scan.bytes + (trickplay ? scan.trickplayBytes : 0);
  return { folders: scan.folders.map((f) => f.target), bytes, downtimeMin: Math.max(1, Math.ceil(bytes / MOVE_RATE / 60)), plugins: [...scan.plugins] };
}

/** where an updater step stands in MOVE_STEPS: the check, pull, image verify and snapshot prepare the copy; a rollback belongs to the deploy */
function updaterRow(step: MoveJobStep): number {
  if (step === 'check' || step === 'pull' || step === 'verify' || step === 'snapshot') return 0;
  if (step === 'rollback') return MOVE_STEPS.indexOf('health');
  return MOVE_STEPS.indexOf(step);
}
/**
 * The step list's rows: before the current one done, the current one running (failed when the move failed there), the rest to do. A
 * copy the updater holds as `ready` waits for the backend's first phase. A failure in one of the backend's phases (`failedIn`, an
 * abort there included) marks that phase's row; one in the copy the step the updater stopped at; without either (an older record) the
 * id check for `ids_mismatch`, otherwise no row: the result line says why.
 */
export function moveSteps(v: MediaView): Array<{ step: MoveStepName; state: SetupRowState }> {
  const st = v.move?.state ?? null;
  let at = -1, failed = false;
  if (st?.phase === 'done') at = MOVE_STEPS.length;
  else if (st?.phase === 'copying') at = st.step ? updaterRow(st.step) : v.status?.move?.phase === 'ready' ? MOVE_STEPS.indexOf('nfo') : 0;
  else if (st?.phase === 'failed') {
    failed = true;
    // a phase of the backend: its row (the updater's job ended long before, its step is cleared); the copy: the step it stopped at
    const phase = st.failedIn && st.failedIn !== 'copying' ? st.failedIn : null;
    at = phase ? MOVE_STEPS.indexOf(phase as MoveStepName) : st.step ? updaterRow(st.step) : st.error === 'ids_mismatch' ? MOVE_STEPS.indexOf('verify') : -1;
  } else if (st) at = MOVE_STEPS.indexOf(st.phase as MoveStepName);
  return MOVE_STEPS.map((step, i) => ({ step, state: at < 0 || i > at ? 'todo' : i < at ? 'done' : failed ? 'failed' : 'running' }));
}

/** a move under way (the card follows it; no second one starts) */
export const moveActive = (v: MediaView): boolean => Boolean(v.move?.state && ACTIVE.includes(v.move.state.phase));
/** the abort is offered: a move before its switch whose abort was not asked for yet */
export const moveAbortable = (v: MediaView): boolean => Boolean(v.move?.state && ABORTABLE.includes(v.move.state.phase) && !v.move.state.abort);
/** a way back under way (it runs in the background; the card follows it) */
export const backActive = (v: MediaView): boolean => BACK_UNDER_WAY.includes(v.move?.state?.back ?? '');
/** what the card polls for: a move or a way back under way, a scan running */
export const moveFollow = (v: MediaView): boolean => moveActive(v) || backActive(v) || v.move?.scan?.state === 'running';

/** a candidate the move can take: not one whose server id is known to be another server's */
const selectable = (c: MoveCandidate): boolean => c.matches !== false;
export const candidateSelectable = selectable;
/** the candidate the sheet scans without asking: the only one that can be the source */
export function autoCandidate(cs: readonly MoveCandidate[]): MoveCandidate | null {
  const ok = cs.filter(selectable);
  return ok.length === 1 ? ok[0]! : null;
}
/** a done scan of `source` young enough to move on (the move route wants one at most 10 minutes old) */
export function scanFresh(rec: MoveScanRecord | null | undefined, source: string, now: number): boolean {
  const age = rec ? now - Date.parse(rec.at) : NaN;
  return rec?.state === 'done' && rec.source === source && Boolean(rec.result) && age >= 0 && age <= SCAN_REUSE_MS;
}

/** the move's outcome as one line: done (with the updater's warning), failed with its reason (an id check with its numbers); null while it runs */
export function moveResult(st: MoveState | null | undefined): { ok: boolean; text: string } | null {
  if (st?.phase === 'done') {
    const warn = st.errorMeta && 'warning' in st.errorMeta ? ` ${tr('mediaserver.move.updaterAborted')}` : '';
    return { ok: true, text: `${tr('mediaserver.move.done')}${warn}` };
  }
  if (st?.phase !== 'failed') return null;
  if (st.error === 'move_aborted') return { ok: false, text: mediaErrorText('move_aborted') };
  const m = st.errorMeta && 'users' in st.errorMeta ? st.errorMeta : null;
  const ids = m ? ` ${tr('mediaserver.move.idsMismatch', { users: m.users.total, usersMissing: m.users.missing, items: m.items.sampled, itemsMissing: m.items.missing })}` : '';
  return { ok: false, text: tr('mediaserver.move.failed', { reason: `${mediaErrorText(st.error)}${ids}` }) };
}

/** the old Jellyfin as Docker shows it: stopped (kept for the way back), running, gone (the way back needs an address); null unknown */
export function sourceLine(v: MediaView): 'stopped' | 'running' | 'missing' | null {
  const s = v.move?.sourceState;
  if (s === 'exited' || s === 'created') return 'stopped';
  if (s === 'running' || s === 'restarting') return 'running';
  return s === 'missing' ? 'missing' : null;
}
