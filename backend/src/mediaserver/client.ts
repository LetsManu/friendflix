// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { MEDIA_STEPS, PENDING, signUpdater, startedJob, streamBinding, updaterCall, updaterKey, type MediaStep, type StartResult } from '../updater.js';

/**
 * The backend's side of the updater's managed media server API (updater/src/mediaserver/: signed POST /v1/mediaserver, the two backup
 * streams, `mediaserver` inside GET /v1/status), signed exactly like every other updater call (updater.ts signUpdater; the streams over
 * updater.ts streamBinding of the passphrase header). The updater's
 * answers carry codes only and are input like any other: every field is checked here before it goes further.
 */

export const MEDIA_ERRORS = ['no_base', 'base_missing', 'folder_missing', 'folder_symlink', 'folder_nested', 'folder_unreadable', 'too_many_folders', 'gpu_missing', 'nvidia_missing', 'no_network', 'name_taken', 'pull_failed', 'image_missing', 'arch_unsupported', 'verify_failed', 'snapshot_failed', 'downgrade_refused', 'template_violation', 'uid_unsupported', 'uid_mismatch', 'library_referenced', 'engine_old', 'create_failed', 'start_failed', 'unhealthy', 'managed_tampered', 'backup_failed', 'backup_invalid', 'kind_mismatch', 'restore_failed', 'remove_failed', 'interrupted', 'pin_invalid', 'no_logs', 'no_project', 'helper_timeout', 'helper_failed', 'admin_missing', 'source_missing', 'source_mismatch', 'source_layout', 'source_outside_base', 'source_version', 'no_space', 'adopt_failed', 'ids_mismatch', 'move_aborted', 'source_nested'] as const;
export type MediaError = (typeof MEDIA_ERRORS)[number];
/** `starting`: the updater has read no media status yet since it started (updater/src/mediaserver/status.ts STARTING_VIEW) */
const REASONS = ['engine_old', 'no_logs', 'no_project', 'no_network', 'starting'] as const;
const KINDS = ['ferrofin', 'jellyfin'] as const;
const GPUS = ['off', 'dri', 'nvidia'] as const;
const HEALTH = ['healthy', 'unhealthy', 'starting', ''] as const;
const TAGS = ['manual', 'auto', 'upload'] as const;
const RESULT = ['pass', 'fail'] as const;
type Kind = (typeof KINDS)[number];

/** a folder of the media server; `migrated`: one a move took over (its target is the path the old Jellyfin used, `rel` '' the whole base) */
export interface MediaFolder { rel: string; target: string; migrated?: true }
const MOVE_PHASES = ['running', 'ready', 'aborted', 'done'] as const;
/** the updater's move (updater/src/mediaserver/status.ts MediaStatusView.move): its phase, the step of its job, the source, the folders */
export interface MediaMove { phase: (typeof MOVE_PHASES)[number]; step: MediaStep | null; source: { name: string; version: string | null }; folders: MediaFolder[]; abort: boolean }
/** the Jellyfin a move came from as Docker shows it now (`missing`: its recorded container is gone) */
export interface MediaSource { name: string; state: string; version: string | null }
export interface MediaBackup { id: string; kind: Kind; upstream: string; at: string; tag: (typeof TAGS)[number]; size: number }
/** the `mediaserver` part of the updater's status (updater/src/mediaserver/status.ts MediaStatusView) */
export interface MediaStatus {
  available: boolean;
  reason: (typeof REASONS)[number] | null;
  base: { set: boolean; path: string | null; pending: boolean; expiresAt: string | null };
  desired: { kind: Kind; folders: MediaFolder[]; uid: number; gid: number; gpu: (typeof GPUS)[number]; mediaGid: number | null; egress: boolean; run: boolean; migrated?: true } | null;
  container: { state: string; health: (typeof HEALTH)[number]; kind: Kind; image: { digest: string; upstream: string }; template: 'current' | 'update_pending'; tampered: boolean; createdAt: string } | null;
  pin: { image: string | null; upstream: string | null; changed: boolean } | null;
  pins: { ferrofin: boolean; jellyfin: boolean };
  engine: { api: string | null; logs: boolean; arch: string | null; nvidia: boolean };
  error: MediaError | null;
  backups: MediaBackup[];
  hdr: { kind: Kind; at: string; opencl: (typeof RESULT)[number]; qsv: (typeof RESULT)[number] } | null;
  move: MediaMove | null;
  source: MediaSource | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Obj => (isObj(v) ? v : {});
const pick = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const re = (v: unknown, r: RegExp): string | null => (typeof v === 'string' && r.test(v) ? v : null);
const id = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
/** an absolute host path: components of letters, digits, space and . _ - + ( ) & ' (updater/src/mediaserver/paths.ts), never a newline */
const HOST_PATH = /^\/[\p{L}\p{N} ._\-+()&'/]{0,199}$/u;
const REL = /^[\p{L}\p{N} ._\-+()&']{1,200}(\/[\p{L}\p{N} ._\-+()&']{1,200}){0,2}$/u;
/** /media/<slug>, or /ffmedia/<slug> for a folder added after a move (updater/src/mediaserver/paths.ts isTarget) */
const TARGET = /^\/(media|ffmedia)(\/[a-z0-9-]{1,40}){1,3}$/;
/** one component of a migrated target (as a base path's, updater/src/mediaserver/paths.ts) */
const TARGET_COMPONENT = /^[\p{L}\p{N} ._\-+()&']{1,200}$/u;
/** the trees a migrated target may not be or lie below (updater/src/mediaserver/paths.ts MIGRATED_REFUSED; `/data` itself too) */
const MIGRATED_REFUSED = ['cache', 'config', 'tmp', 'proc', 'sys', 'dev', 'etc', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'lib32', 'libx32', 'var', 'run', 'root', 'home', 'boot', 'opt',
  'nonexistent', 'ferrofin-data', 'ffmedia'];
const IMAGE = /^[a-z0-9][a-z0-9./_:-]{0,200}(@sha256:[0-9a-f]{64})?$/;
/** an image reference as a candidate shows it (a tag may carry capitals) */
const SOURCE_IMAGE = /^[a-z0-9][A-Za-z0-9./_:@-]{0,300}$/;
/** a Docker container name (without the leading slash) and id */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
/** a container path an updater refusal names (never a host path): absolute, no control character */
const CONTAINER_PATH = /^\/[^\p{Cc}]{0,199}$/u;
/** a plugin name as the scan lists it */
const PLUGIN = /^[^\p{Cc}]{1,100}$/u;
export const BACKUP_ID = /^(ferrofin|jellyfin)-[0-9]{8}-[0-9]{4}-[0-9A-Za-z.+_-]{1,40}$/;
const MAX_FOLDERS = 20;
const MAX_BACKUPS = 10;

/** a migrated target: absolute, normalised, 1–3 components, not a system tree, not `/data` itself (below it is fine) */
export function isMigratedTarget(t: string): boolean {
  if (t.length > 200 || !t.startsWith('/')) return false;
  const c = t.slice(1).split('/');
  if (c.length > 3 || !c.every((x) => TARGET_COMPONENT.test(x) && !x.startsWith('.'))) return false;
  return !MIGRATED_REFUSED.includes(c[0]!) && !(c[0] === 'data' && c.length === 1);
}

function folder(v: unknown): MediaFolder | null {
  const o = objOf(v);
  const migrated = o.migrated === true;
  const rel = migrated && o.rel === '' ? '' : re(o.rel, REL);
  const target = typeof o.target === 'string' && (TARGET.test(o.target) || (migrated && isMigratedTarget(o.target))) ? o.target : null;
  if (rel === null || rel.split('/').some((c) => c.startsWith('.')) || !target) return null;
  return migrated ? { rel, target, migrated: true } : { rel, target };
}
const folders = (v: unknown): MediaFolder[] => (Array.isArray(v) ? v.slice(0, MAX_FOLDERS).flatMap((f) => folder(f) ?? []) : []);

function desired(v: unknown): MediaStatus['desired'] {
  if (!isObj(v)) return null;
  const kind = pick(v.kind, KINDS), gpu = pick(v.gpu, GPUS);
  if (!kind || !gpu || !id(v.uid) || !id(v.gid) || !(v.mediaGid === null || id(v.mediaGid))) return null;
  return { kind, folders: folders(v.folders), uid: v.uid, gid: v.gid, gpu, mediaGid: v.mediaGid, egress: v.egress === true, run: v.run === true, ...(v.migrated === true ? { migrated: true as const } : {}) };
}

function move(v: unknown): MediaMove | null {
  if (!isObj(v)) return null;
  const phase = pick(v.phase, MOVE_PHASES), src = objOf(v.source), name = re(src.name, CONTAINER_NAME);
  if (!phase || !name) return null;
  return { phase, step: pick(v.step, MEDIA_STEPS), source: { name, version: re(src.version, VERSION) }, folders: folders(v.folders), abort: v.abort === true };
}

function source(v: unknown): MediaSource | null {
  if (!isObj(v)) return null;
  const name = re(v.name, CONTAINER_NAME);
  return name ? { name, state: re(v.state, /^[a-z]{1,20}$/) ?? 'unknown', version: re(v.version, VERSION) } : null;
}

function container(v: unknown): MediaStatus['container'] {
  if (!isObj(v)) return null;
  const kind = pick(v.kind, KINDS), createdAt = re(v.createdAt, ISO);
  if (!kind || !createdAt) return null;
  const image = objOf(v.image);
  return {
    state: re(v.state, /^[a-z]{1,20}$/) ?? 'unknown', health: pick(v.health, HEALTH) ?? '', kind,
    image: { digest: re(image.digest, DIGEST) ?? '', upstream: re(image.upstream, VERSION) ?? 'unknown' },
    template: v.template === 'update_pending' ? 'update_pending' : 'current', tampered: v.tampered === true, createdAt,
  };
}

function backup(v: unknown): MediaBackup | null {
  const o = objOf(v);
  const bid = re(o.id, BACKUP_ID), kind = pick(o.kind, KINDS), upstream = re(o.upstream, VERSION), at = re(o.at, ISO), tag = pick(o.tag, TAGS);
  const size = typeof o.size === 'number' && Number.isSafeInteger(o.size) && o.size >= 0 ? o.size : null;
  return bid && kind && upstream && at && tag && size !== null ? { id: bid, kind, upstream, at, tag, size } : null;
}

/** Only known fields with checked values (like updater.ts parseStatus); null = an updater from before the media server, or an answer that is not an object. */
export function parseMediaStatus(raw: unknown): MediaStatus | null {
  if (!isObj(raw)) return null;
  const base = objOf(raw.base), pin = raw.pin, pins = objOf(raw.pins), engine = objOf(raw.engine);
  const hdr = objOf(raw.hdr);
  const hdrKind = pick(hdr.kind, KINDS), hdrAt = re(hdr.at, ISO), opencl = pick(hdr.opencl, RESULT), qsv = pick(hdr.qsv, RESULT);
  const pinObj = objOf(pin);
  return {
    available: raw.available === true, reason: pick(raw.reason, REASONS),
    base: { set: base.set === true, path: re(base.path, HOST_PATH), pending: base.pending === true, expiresAt: re(base.expiresAt, ISO) },
    desired: desired(raw.desired), container: container(raw.container),
    pin: isObj(pin) ? { image: re(pinObj.image, IMAGE), upstream: re(pinObj.upstream, VERSION), changed: pinObj.changed === true } : null,
    pins: { ferrofin: pins.ferrofin === true, jellyfin: pins.jellyfin === true },
    engine: { api: re(engine.api, /^\d{1,3}\.\d{1,3}$/), logs: engine.logs === true, arch: re(engine.arch, /^[a-z0-9_]{1,20}$/), nvidia: engine.nvidia === true },
    error: pick(raw.error, MEDIA_ERRORS),
    backups: Array.isArray(raw.backups) ? raw.backups.slice(0, MAX_BACKUPS).flatMap((b) => backup(b) ?? []) : [],
    hdr: hdrKind && hdrAt && opencl && qsv ? { kind: hdrKind, at: hdrAt, opencl, qsv } : null,
    move: move(raw.move), source: source(raw.source),
  };
}

/** one signed `POST /v1/mediaserver`; the body is what the caller built from fixed keys (the updater refuses any other key). null = the updater is not there. */
export function mediaOp(ctx: Ctx, body: Record<string, unknown>): Promise<{ status: number; json: unknown } | null> {
  return updaterCall(ctx, 'POST', '/v1/mediaserver', JSON.stringify(body), 30_000);
}

/** the job action an op starts (updater/src/mediaserver/jobs.ts): a move's abort is (or answers) the move's job, the source start its own */
const JOB_OF: Record<string, string> = { 'finish-setup': 'finish', 'migrate-abort': 'migrate', 'source-start': 'source' };
const jobAction = (op: string) => `mediaserver-${JOB_OF[op] ?? op}` as const;

/**
 * Starts a media job and audits it: `updater:pending:<id>` records {actor, action: 'mediaserver', op} (never replaced: an abort answers
 * the running move's job, whose result stays the move's), the start is audited as `auditAction` with `auditMeta` as given, by default
 * `mediaserver.action` {op} (`apply` as `mediaserver.apply`); `auditMeta` never carries a code, a password or a path below the base.
 * reconcileAudit writes `mediaserver.result` when the job ends.
 */
export async function startMediaJob(ctx: Ctx, body: Record<string, unknown>, actor: string | null, auditMeta: Record<string, unknown>, auditAction?: string): Promise<StartResult> {
  const op = typeof body.op === 'string' ? body.op : '';
  const r = await mediaOp(ctx, body);
  const started = startedJob(r, jobAction(op) as Parameters<typeof startedJob>[1]);
  if (!started.ok) return started;
  await ctx.kv.setnx(`${PENDING}${started.job.id}`, JSON.stringify({ actor, action: 'mediaserver', op }), 7 * 86_400).catch(() => undefined);
  const action = auditAction ?? (op === 'apply' ? 'mediaserver.apply' : 'mediaserver.action');
  await audit(ctx, actor, action, undefined, auditAction || op === 'apply' ? auditMeta : { ...auditMeta, op });
  return started;
}

/** a Jellyfin container on the updater's engine; `matches`: its server id is the one FriendFlix uses (null: not scanned) */
export interface MoveCandidate { id: string; name: string; image: string; state: string; matches: boolean | null }
/** the chosen candidate scanned: its media folders as Ferrofin will see them, the copy's size, the plugins left behind, the NFO saver */
export interface MoveScan {
  source: { id: string; name: string; image: string; version: string | null }; folders: MediaFolder[]; layout: 'official' | 'linuxserver';
  bytes: number; trickplayBytes: number; plugins: string[]; nfo: boolean;
}
/** a refused scan: its code, and the container paths (never host paths) the admin is shown for source_outside_base / source_nested */
export interface MoveScanRefusal { ok: false; status: number; error: string; outside: string[]; refused: string[]; nested: string[] }
export type MoveScanResult = { ok: true; candidates: MoveCandidate[]; scan: MoveScan | null } | MoveScanRefusal;

/** the candidate list scans each candidate's server id (a short helper each); the sized scan reads the whole /config (updater: up to 120 s) */
const LIST_MS = 45_000;
const SCAN_MS = 150_000;
const MAX_CANDIDATES = 20;
const size = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const paths = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && CONTAINER_PATH.test(p)).slice(0, MAX_FOLDERS) : []);

function candidate(v: unknown): MoveCandidate | null {
  const o = objOf(v);
  const cid = re(o.id, CONTAINER_ID), name = re(o.name, CONTAINER_NAME), image = re(o.image, SOURCE_IMAGE);
  if (!cid || !name || !image) return null;
  return { id: cid, name, image, state: re(o.state, /^[a-z]{1,20}$/) ?? 'unknown', matches: typeof o.matches === 'boolean' ? o.matches : null };
}

function scan(v: unknown): MoveScan | null {
  if (!isObj(v)) return null;
  const src = objOf(v.source);
  const sid = re(src.id, CONTAINER_ID), name = re(src.name, CONTAINER_NAME), image = re(src.image, SOURCE_IMAGE);
  const layout = pick(v.layout, ['official', 'linuxserver'] as const);
  if (!sid || !name || !image || !layout || !size(v.bytes) || !size(v.trickplayBytes) || typeof v.nfo !== 'boolean') return null;
  const plugins = Array.isArray(v.plugins) ? v.plugins.filter((p): p is string => typeof p === 'string' && PLUGIN.test(p)).slice(0, 50) : [];
  return { source: { id: sid, name, image, version: re(src.version, VERSION) }, folders: folders(v.folders), layout, bytes: v.bytes, trickplayBytes: v.trickplayBytes, plugins, nfo: v.nfo };
}

/**
 * `migrate-scan` (stage 2 "Finding the source"): without `source` the Jellyfin containers on the updater's engine, each matched against
 * `serverId` (the id of the server FriendFlix uses now); with `source` that candidate scanned too. Only checked fields come back; a
 * refusal keeps its code (400/409; anything else is updater_error) and the container paths it names.
 */
export async function mediaScan(ctx: Ctx, source: string | undefined, serverId: string): Promise<MoveScanResult> {
  const r = await updaterCall(ctx, 'POST', '/v1/mediaserver', JSON.stringify({ op: 'migrate-scan', serverId, ...(source !== undefined ? { source } : {}) }), source === undefined ? LIST_MS : SCAN_MS);
  const j = objOf(r?.json);
  if (r?.status === 200 && Array.isArray(j.candidates)) {
    return { ok: true, candidates: j.candidates.slice(0, MAX_CANDIDATES).flatMap((c) => candidate(c) ?? []), scan: scan(j.scan) };
  }
  const code = re(j.error, /^[a-z_]{1,40}$/);
  const refusal = !r ? { status: 409, error: 'not_available' }
    : (r.status === 400 || r.status === 409) && code ? { status: r.status, error: code }
      : r.status === 429 ? { status: 429, error: 'rate_limited' } : r.status === 404 ? { status: 409, error: 'updater_outdated' } : { status: 502, error: 'updater_error' };
  return { ok: false, ...refusal, outside: paths(j.outside), refused: paths(j.refused), nested: paths(j.nested) };
}

const PASSPHRASE_HEADER = 'x-ff-backup-passphrase';
const BACKUP_PATH = '/v1/mediaserver/backups';
const codePoints = (s: string): number => [...s].length;

/** the `x-ff-backup-passphrase` header value: base64url of the UTF-8 passphrase (Controller's call 2) */
export function encodePassphrase(p: string): string {
  return Buffer.from(p, 'utf8').toString('base64url');
}

/** the passphrase of a header value; null unless it is the canonical base64url of valid UTF-8 of 12–1024 code points */
export function decodePassphrase(h: string | undefined): string | null {
  if (typeof h !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(h)) return null;
  const s = Buffer.from(h, 'base64url').toString('utf8');
  if (Buffer.from(s, 'utf8').toString('base64url') !== h.replace(/=+$/, '')) return null;
  return codePoints(s) >= 12 && codePoints(s) <= 1024 ? s : null;
}

/** the stream calls sign a scrypt derivation of the header string in place of the body (updater.ts streamBinding, updater/src/server.ts stream()) */
function streamHeaders(ctx: Ctx, method: 'GET' | 'POST', path: string, passphraseHeader: string): Record<string, string> {
  return { ...signUpdater(updaterKey(ctx.cfg.INTERNAL_SECRET), method, path, streamBinding(passphraseHeader)), [PASSPHRASE_HEADER]: passphraseHeader };
}

/** the encrypted backup as the updater streams it (`<id>.tar.gz.age`); null = the updater is not there. The caller checks `id` against BACKUP_ID first. */
export async function mediaDownload(ctx: Ctx, id: string, passphraseHeader: string, signal: AbortSignal): Promise<Response | null> {
  const base = ctx.cfg.UPDATER_URL;
  if (!base || !BACKUP_ID.test(id)) return null;
  const path = `${BACKUP_PATH}/${id}/download`;
  try {
    return await ctx.fetchImpl(`${base}${path}`, { method: 'GET', headers: streamHeaders(ctx, 'GET', path, passphraseHeader), signal, redirect: 'error' });
  } catch {
    return null;
  }
}

/**
 * Streams an encrypted backup to the updater. No timeout but `signal` (an upload may take long). A refusal may arrive as a reset
 * connection while the body is still being sent: that, like an absent updater, is null (the caller answers a failure code).
 */
export async function mediaUpload(ctx: Ctx, body: ReadableStream | NodeJS.ReadableStream, length: number, passphraseHeader: string, signal: AbortSignal): Promise<{ status: number; json: unknown } | null> {
  const base = ctx.cfg.UPDATER_URL;
  if (!base) return null;
  const path = `${BACKUP_PATH}/upload`;
  const headers = { ...streamHeaders(ctx, 'POST', path, passphraseHeader), 'content-type': 'application/octet-stream', 'content-length': String(length) };
  try {
    const init = { method: 'POST', headers, body, duplex: 'half', signal, redirect: 'error' } as RequestInit;
    const r = await ctx.fetchImpl(`${base}${path}`, init);
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch {
    return null;
  }
}
