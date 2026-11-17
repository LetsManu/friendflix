// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { PENDING, signUpdater, startedJob, updaterCall, updaterKey, type StartResult } from '../updater.js';

/**
 * The backend's side of the updater's managed media server API (updater/src/mediaserver/: signed POST /v1/mediaserver, the two backup
 * streams, `mediaserver` inside GET /v1/status), signed exactly like every other updater call (updater.ts signUpdater). The updater's
 * answers carry codes only and are input like any other: every field is checked here before it goes further.
 */

export const MEDIA_ERRORS = ['no_base', 'base_missing', 'folder_missing', 'folder_symlink', 'folder_nested', 'folder_unreadable', 'too_many_folders', 'gpu_missing', 'nvidia_missing', 'no_network', 'name_taken', 'pull_failed', 'image_missing', 'arch_unsupported', 'verify_failed', 'snapshot_failed', 'downgrade_refused', 'template_violation', 'uid_unsupported', 'uid_mismatch', 'library_referenced', 'engine_old', 'create_failed', 'start_failed', 'unhealthy', 'managed_tampered', 'backup_failed', 'backup_invalid', 'kind_mismatch', 'restore_failed', 'remove_failed', 'interrupted', 'pin_invalid', 'no_logs', 'no_project', 'helper_timeout', 'helper_failed', 'admin_missing'] as const;
export type MediaError = (typeof MEDIA_ERRORS)[number];
const REASONS = ['engine_old', 'no_logs', 'no_project', 'no_network'] as const;
const KINDS = ['ferrofin', 'jellyfin'] as const;
const GPUS = ['off', 'dri', 'nvidia'] as const;
const HEALTH = ['healthy', 'unhealthy', 'starting', ''] as const;
const TAGS = ['manual', 'auto', 'upload'] as const;
const RESULT = ['pass', 'fail'] as const;
type Kind = (typeof KINDS)[number];

export interface MediaFolder { rel: string; target: string }
export interface MediaBackup { id: string; kind: Kind; upstream: string; at: string; tag: (typeof TAGS)[number]; size: number }
/** the `mediaserver` part of the updater's status (updater/src/mediaserver/status.ts MediaStatusView) */
export interface MediaStatus {
  available: boolean;
  reason: (typeof REASONS)[number] | null;
  base: { set: boolean; path: string | null; pending: boolean; expiresAt: string | null };
  desired: { kind: Kind; folders: MediaFolder[]; uid: number; gid: number; gpu: (typeof GPUS)[number]; mediaGid: number | null; egress: boolean; run: boolean } | null;
  container: { state: string; health: (typeof HEALTH)[number]; kind: Kind; image: { digest: string; upstream: string }; template: 'current' | 'update_pending'; tampered: boolean; createdAt: string } | null;
  pin: { image: string | null; upstream: string | null; changed: boolean } | null;
  pins: { ferrofin: boolean; jellyfin: boolean };
  engine: { api: string | null; logs: boolean; arch: string | null; nvidia: boolean };
  error: MediaError | null;
  backups: MediaBackup[];
  hdr: { kind: Kind; at: string; opencl: (typeof RESULT)[number]; qsv: (typeof RESULT)[number] } | null;
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
const TARGET = /^\/media(\/[a-z0-9-]{1,40}){1,3}$/;
const IMAGE = /^[a-z0-9][a-z0-9./_:-]{0,200}(@sha256:[0-9a-f]{64})?$/;
export const BACKUP_ID = /^(ferrofin|jellyfin)-[0-9]{8}-[0-9]{4}-[0-9A-Za-z.+_-]{1,40}$/;
const MAX_FOLDERS = 20;
const MAX_BACKUPS = 10;

function folder(v: unknown): MediaFolder | null {
  const o = objOf(v);
  const rel = re(o.rel, REL), target = re(o.target, TARGET);
  return rel && !rel.split('/').some((c) => c.startsWith('.')) && target ? { rel, target } : null;
}

function desired(v: unknown): MediaStatus['desired'] {
  if (!isObj(v)) return null;
  const kind = pick(v.kind, KINDS), gpu = pick(v.gpu, GPUS);
  if (!kind || !gpu || !id(v.uid) || !id(v.gid) || !(v.mediaGid === null || id(v.mediaGid))) return null;
  const folders = Array.isArray(v.folders) ? v.folders.slice(0, MAX_FOLDERS).flatMap((f) => folder(f) ?? []) : [];
  return { kind, folders, uid: v.uid, gid: v.gid, gpu, mediaGid: v.mediaGid, egress: v.egress === true, run: v.run === true };
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
  };
}

/** one signed `POST /v1/mediaserver`; the body is what the caller built from fixed keys (the updater refuses any other key). null = the updater is not there. */
export function mediaOp(ctx: Ctx, body: Record<string, unknown>): Promise<{ status: number; json: unknown } | null> {
  return updaterCall(ctx, 'POST', '/v1/mediaserver', JSON.stringify(body), 30_000);
}

/** the job action an op starts (updater/src/mediaserver/jobs.ts) */
const jobAction = (op: string) => `mediaserver-${op === 'finish-setup' ? 'finish' : op}` as const;

/**
 * Starts a media job and audits it: `updater:pending:<id>` records {actor, action: 'mediaserver', op}, the start is audited as
 * `mediaserver.action` {op} (`apply` as `mediaserver.apply`) with `auditMeta` (never a code, a password or a path below the base);
 * reconcileAudit writes `mediaserver.result` when the job ends.
 */
export async function startMediaJob(ctx: Ctx, body: Record<string, unknown>, actor: string | null, auditMeta: Record<string, unknown>): Promise<StartResult> {
  const op = typeof body.op === 'string' ? body.op : '';
  const r = await mediaOp(ctx, body);
  const started = startedJob(r, jobAction(op) as Parameters<typeof startedJob>[1]);
  if (!started.ok) return started;
  await ctx.kv.set(`${PENDING}${started.job.id}`, JSON.stringify({ actor, action: 'mediaserver', op }), 7 * 86_400).catch(() => undefined);
  await audit(ctx, actor, op === 'apply' ? 'mediaserver.apply' : 'mediaserver.action', undefined, op === 'apply' ? auditMeta : { ...auditMeta, op });
  return started;
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

/** the stream calls sign the header string in place of the body (updater/src/server.ts stream()) */
function streamHeaders(ctx: Ctx, method: 'GET' | 'POST', path: string, passphraseHeader: string): Record<string, string> {
  return { ...signUpdater(updaterKey(ctx.cfg.INTERNAL_SECRET), method, path, passphraseHeader), [PASSPHRASE_HEADER]: passphraseHeader };
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
