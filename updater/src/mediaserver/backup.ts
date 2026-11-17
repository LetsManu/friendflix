// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, readdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable, Transform, Writable, finished } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadable } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { Decrypter, Encrypter } from 'age-encryption';
import { StepError } from '../docker.js';
import type { Updater } from '../job.js';
import type { Job } from '../state.js';
import { readFileMeta } from './archive.js';
import type { Engine } from './engine.js';
import type { Existing } from './jobs.js';
import { BACKUP_ID_RE, type BackupMeta, type BackupTag, type Kind, type MediaStep } from './types.js';

/**
 * Media server backups (spec "Backup and restore"): ids, retention, the `backup` / `restore` jobs, and the two streams that are
 * the only way a backup leaves or enters the updater: the age-encrypted download (scrypt passphrase recipient, `age -d` opens
 * it) and the upload of such a file. The plain archive never leaves the updater, nothing is written to the host, a passphrase
 * is never stored or logged. The streams run outside the job lock; a restore and a download of the same backup exclude each other.
 */

export const BACKUP_DIR = '/backups';
/** encrypted bytes of an upload (Controller's call: a large library's metadata, without trickplay) */
export const UPLOAD_MAX = 20 * 1024 ** 3;
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 1024;
const KEEP = { manualAndUpload: 3, auto: 2 };
/** an upload's age header must end within this many bytes (age's own reader has no limit) */
const HEADER_MAX = 64 * 1024;
/** the highest scrypt work factor an upload may ask for: age's default, what the age CLI and our download write */
const SCRYPT_MAX_LOG_N = 18;
// X.Y.Z, or X.Y.<YYYYMMDD>-<HHMMSS> (Jellyfin 12.x build tags); the stamp alternative comes first so it is not read as Z
const VERSION_RE = /^v?([0-9]+)\.([0-9]+)\.(?:([0-9]{8})-([0-9]{6})|([0-9]+))/;

const fail = (code: 'backup_invalid' | 'backup_failed' | 'kind_mismatch' | 'downgrade_refused' | 'unhealthy' | 'restore_failed'): never => { throw new StepError(code); };
const fileOf = (dir: string, id: string): string => join(dir, `${id}.tar.gz`);
const codePoints = (s: string): number => [...s].length;
const passphraseOk = (p: string): boolean => codePoints(p) >= PASSPHRASE_MIN && codePoints(p) <= PASSPHRASE_MAX;

/** the `x-ff-backup-passphrase` header: base64url of the UTF-8 passphrase (Controller's call 2); null unless 12–1024 code points */
export function decodePassphrase(header: string | undefined): string | null {
  if (typeof header !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(header)) return null;
  const bytes = Buffer.from(header, 'base64url');
  const s = bytes.toString('utf8');
  // only the canonical encoding of valid UTF-8 (a broken sequence would decode to U+FFFD and not round-trip)
  if (Buffer.from(s, 'utf8').toString('base64url') !== header.replace(/=+$/, '')) return null;
  return passphraseOk(s) ? s : null;
}

const two = (n: number): string => String(n).padStart(2, '0');
/** `<kind>-<YYYYMMDD-HHMM UTC>-<upstream>` (Controller's call 14) */
export function backupId(kind: Kind, upstream: string, at: Date): string {
  return `${kind}-${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(at.getUTCHours())}${two(at.getUTCMinutes())}-${upstream}`;
}

/**
 * `v?X.Y.Z` or `X.Y.<YYYYMMDD>-<HHMMSS>` compared numerically, a older than b; anything else is never "older" (the never-down
 * rule of deploys and restores). Same X.Y: a build-stamp tag is newer than any plain patch tag (12.x has only stamp tags, 10.x
 * only plain ones, so the case does not occur for real releases); two stamps compare by their date and time.
 */
export function older(a: string, b: string): boolean {
  const x = VERSION_RE.exec(a);
  const y = VERSION_RE.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 2; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]);
  const stampA = x[3] !== undefined, stampB = y[3] !== undefined;
  if (stampA !== stampB) return !stampA;
  if (stampA) return Number(x[3]! + x[4]!) < Number(y[3]! + y[4]!);
  return Number(x[5]) < Number(y[5]);
}

/** retention: the last 3 manual and uploaded backups together, the last 2 automatic ones; order kept */
export function prune(list: BackupMeta[]): { keep: BackupMeta[]; drop: BackupMeta[] } {
  const newest = (auto: boolean, n: number): BackupMeta[] => list.filter((b) => (b.tag === 'auto') === auto)
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id < b.id ? 1 : -1)).slice(0, n);
  const keep = new Set([...newest(false, KEEP.manualAndUpload), ...newest(true, KEEP.auto)]);
  return { keep: list.filter((b) => keep.has(b)), drop: list.filter((b) => !keep.has(b)) };
}

// --- what is in use (one updater process, one backup volume) ---

const downloads = new Map<string, number>();
const restores = new Set<string>();
/** `.part` files being written now (an upload's, a helper backup's); every other `.part` is a leftover */
const writing = new Set<string>();
/** one scrypt key derivation (download or upload) at a time: each takes about 256 MB */
let scrypting = false;
/** a download or a restore of this backup runs */
export const backupInUse = (id: string): boolean => restores.has(id) || (downloads.get(id) ?? 0) > 0;
const release = (id: string): void => {
  const n = (downloads.get(id) ?? 1) - 1;
  if (n > 0) downloads.set(id, n); else downloads.delete(id);
};

/**
 * removes leftover `.part` files (plain archives of an interrupted backup or upload: they hold password hashes and keys), but
 * never one being written. Runs at updater start and before each backup and upload.
 */
export async function removeStaleParts(dir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const n of names) if (n.endsWith('.part') && !writing.has(n)) await rm(join(dir, n), { force: true }).catch(() => undefined);
}

/**
 * a helper backup's id and time: `backupId` at `now`, moved on by a minute while that id is being restored or downloaded (the
 * new archive would replace it: a safety snapshot in the minute of the upload it restores)
 */
export function freeBackupId(kind: Kind, upstream: string, now: number): { id: string; at: Date } {
  let at = new Date(now);
  while (backupInUse(backupId(kind, upstream, at))) at = new Date(at.getTime() + 60_000);
  return { id: backupId(kind, upstream, at), at };
}

/** runs a helper backup that writes `<id>.tar.gz.part`: leftovers removed first, its own part file kept while it runs */
export async function writingBackup<T>(dir: string, id: string, fn: () => Promise<T>): Promise<T> {
  const part = `${id}.tar.gz.part`;
  await removeStaleParts(dir);
  writing.add(part);
  try { return await fn(); } finally { writing.delete(part); }
}

/** applies the retention to `media.backups` and deletes the files of what it dropped (never one being restored) */
export async function retain(d: { dir: string; updater: Updater }): Promise<void> {
  const gone = prune(d.updater.mediaState().backups).drop.filter((b) => !restores.has(b.id)).map((b) => b.id);
  if (gone.length === 0) return;
  d.updater.updateMedia((m) => { m.backups = m.backups.filter((b) => !gone.includes(b.id)); });
  for (const id of gone) await rm(fileOf(d.dir, id), { force: true }).catch(() => undefined);
}

/** records a backup (an id that exists already is replaced, Controller's call 14) and applies the retention */
export async function record(d: { dir: string; updater: Updater }, meta: BackupMeta): Promise<void> {
  d.updater.updateMedia((m) => { m.backups = [...m.backups.filter((b) => b.id !== meta.id), meta]; });
  await retain(d);
}

// --- the streams ---

function answer(res: ServerResponse, status: 400 | 404 | 409 | 500, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

/**
 * `GET /v1/mediaserver/backups/:id/download`: the backup encrypted to the passphrase (age, scrypt recipient) streamed into
 * `res`, no content-length. 400 `invalid_passphrase` (12–1024 code points), 404 `not_found` (unknown id or no file), 409 `busy`
 * while that backup is being restored or another download or upload derives its key. A client that goes away ends the stream
 * and closes the file before this resolves.
 */
export async function download(d: { dir: string; updater: Updater }, id: string, passphrase: string, res: ServerResponse): Promise<void> {
  if (!passphraseOk(passphrase)) return answer(res, 400, 'invalid_passphrase');
  if (!BACKUP_ID_RE.test(id) || !d.updater.mediaState().backups.some((b) => b.id === id)) return answer(res, 404, 'not_found');
  if (restores.has(id) || scrypting) return answer(res, 409, 'busy');
  scrypting = true;
  let fh;
  try { fh = await open(fileOf(d.dir, id), 'r'); } catch { scrypting = false; return answer(res, 404, 'not_found'); }
  const file = fh.createReadStream();
  downloads.set(id, (downloads.get(id) ?? 0) + 1);
  try {
    const e = new Encrypter();
    e.setPassphrase(passphrase);
    let out;
    try { out = await e.encrypt(Readable.toWeb(file) as unknown as ReadableStream<Uint8Array>); } finally { scrypting = false; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.tar.gz.age"` });
    await pipeline(Readable.fromWeb(out as unknown as WebReadable<Uint8Array>), res);
    d.updater.log.add('media backup downloaded');
  } catch {
    if (res.headersSent) res.destroy(); else answer(res, 500, 'backup_failed');
    d.updater.log.add('media backup download ended early');
  } finally {
    if (!file.closed) await new Promise<void>((resolve) => { file.once('close', () => resolve()); file.destroy(); });
    release(id);
  }
}

/** the age header (up to and with its `--- <mac>` line): version line first, scrypt work factor at most 18 */
function headerOk(text: string): boolean {
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== 'age-encryption.org/v1' || !lines[lines.length - 1]!.startsWith('--- ')) return false;
  return lines.every((l) => {
    if (!l.startsWith('-> scrypt')) return true;
    const a = l.split(' ');
    return a.length === 4 && /^[1-9][0-9]?$/.test(a[3]!) && Number(a[3]) <= SCRYPT_MAX_LOG_N;
  });
}

const VERSION_LINE = Buffer.from('age-encryption.org/v1\n', 'latin1');

/**
 * passes an upload on to age only once its header is known to be sound: the version line, a `---` line within HEADER_MAX
 * bytes, no scrypt work factor above 18. Holds at most HEADER_MAX bytes plus one chunk (age's line reader would collect a
 * newline-free body without limit). Throws on anything else.
 */
async function* ageHeaderGuard(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const it = src[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let end = -1;
  while (end < 0) {
    const r = await it.next();
    if (r.done) throw new Error('age header');
    buf = Buffer.concat([buf, r.value]);
    const n = Math.min(buf.length, VERSION_LINE.length);
    if (!buf.subarray(0, n).equals(VERSION_LINE.subarray(0, n))) throw new Error('age header');
    const mac = buf.indexOf('\n--- ');
    const nl = mac < 0 ? -1 : buf.indexOf('\n', mac + 1);
    end = nl < 0 ? -1 : nl + 1;
    if ((end < 0 && buf.length > HEADER_MAX) || end > HEADER_MAX) throw new Error('age header');
  }
  if (!headerOk(buf.subarray(0, end).toString('latin1'))) throw new Error('age header');
  yield buf;
  for (;;) {
    const r = await it.next();
    if (r.done) return;
    yield r.value;
  }
}

/** the whole gzip stream of a file decompresses (its CRC and length check at the end) */
async function gzipComplete(path: string): Promise<boolean> {
  try {
    await pipeline(createReadStream(path), createGunzip(), new Writable({ write: (_c, _e, cb) => cb() }));
    return true;
  } catch {
    return false;
  }
}

export type UploadResult =
  | { ok: true; backup: BackupMeta }
  | { ok: false; status: 400 | 409 | 413; error: 'backup_invalid' | 'busy' | 'too_large' | 'invalid_passphrase' };

/**
 * `POST /v1/mediaserver/backups/upload`: an age file of a backup decrypted with the passphrase into the backup volume, tagged
 * `upload`, named by its metadata's kind and upstream and the upload time. More than `max` encrypted bytes (UPLOAD_MAX) abort
 * the request (`too_large`); an unsound age header (ageHeaderGuard), a wrong passphrase, a damaged or cut file, a gzip stream
 * that does not decompress to its end, or an archive without valid metadata is `backup_invalid`; another download or upload
 * deriving its key is `busy` (nothing read). Nothing of a refused upload is kept.
 */
export async function upload(d: { dir: string; updater: Updater; now(): number; max?: number }, req: IncomingMessage, passphrase: string): Promise<UploadResult> {
  const max = d.max ?? UPLOAD_MAX;
  const refuse = (status: 400 | 409 | 413, error: 'backup_invalid' | 'busy' | 'too_large' | 'invalid_passphrase'): UploadResult => {
    d.updater.log.add(`media backup upload refused: ${error}`);
    return { ok: false, status, error };
  };
  if (!passphraseOk(passphrase)) return refuse(400, 'invalid_passphrase');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) { req.destroy(); return refuse(413, 'too_large'); }
  if (scrypting) return refuse(409, 'busy');
  scrypting = true;
  let keyed = false;
  const unlock = (): void => { if (!keyed) { keyed = true; scrypting = false; } };

  const name = `.upload-${randomBytes(12).toString('hex')}.part`;
  const part = join(d.dir, name);
  writing.add(name);
  let seen = 0;
  let tooLarge = false;
  const counted = new Transform({
    transform(c: Buffer, _e, cb) {
      seen += c.length;
      if (seen > max) { tooLarge = true; cb(new Error('too_large')); } else cb(null, c);
    },
  });
  // the request ends early (the client went away): the decryption fails instead of waiting
  finished(req, (err) => { if (err) counted.destroy(err); });
  req.pipe(counted);
  try {
    await removeStaleParts(d.dir);
    const dec = new Decrypter();
    dec.addPassphrase(passphrase);
    let plain;
    try {
      plain = await dec.decrypt(Readable.toWeb(Readable.from(ageHeaderGuard(counted))) as unknown as ReadableStream<Uint8Array>);
    } finally {
      unlock();
    }
    await pipeline(Readable.fromWeb(plain as unknown as WebReadable<Uint8Array>), createWriteStream(part, { flags: 'wx', mode: 0o644 }));
    // readable by the helper, which restores as the media server's user
    await chmod(part, 0o644);
    if (!(await gzipComplete(part))) fail('backup_invalid');
    const head = (await readFileMeta(part)) ?? fail('backup_invalid');
    const at = new Date(d.now());
    const id = backupId(head.meta.kind, head.meta.upstream, at);
    if (!BACKUP_ID_RE.test(id)) fail('backup_invalid');
    if (restores.has(id)) {
      await rm(part, { force: true });
      return refuse(409, 'busy');
    }
    await rename(part, fileOf(d.dir, id));
    const meta: BackupMeta = { id, kind: head.meta.kind, upstream: head.meta.upstream, at: at.toISOString(), tag: 'upload', size: (await stat(fileOf(d.dir, id))).size };
    await record(d, meta);
    d.updater.log.add('media backup uploaded');
    return { ok: true, backup: meta };
  } catch {
    req.unpipe(counted);
    counted.destroy();
    if (tooLarge) req.destroy();
    await rm(part, { force: true }).catch(() => undefined);
    return tooLarge ? refuse(413, 'too_large') : refuse(400, 'backup_invalid');
  } finally {
    unlock();
    writing.delete(name);
  }
}

// --- the jobs ---

/** what the backup and restore jobs use of MediaJobs (its step bookkeeping, the guarded container, the helper runs, health) */
export interface BackupKit {
  updater: Updater;
  engine: Pick<Engine, 'start' | 'stop'>;
  dir: string;
  step<T>(job: Job, name: MediaStep, fn: () => Promise<T>): Promise<T>;
  /** the container under the real name with our labels, guard-clean; null when there is none */
  ours(): Promise<Existing | null>;
  snapshot(tag: Exclude<BackupTag, 'upload'>, trickplay: boolean): Promise<BackupMeta>;
  restoreSnapshot(id: string, kind: Kind): Promise<void>;
  healthy(id: string): Promise<boolean>;
}

/**
 * `mediaserver-backup`: stop the container, helper `backup` (tagged `manual`, retention applied), start it again whatever
 * happened unless it was stopped on purpose. Steps: check, snapshot (the backup), start.
 */
export async function backupJob(k: BackupKit, job: Job, trickplay: boolean): Promise<void> {
  const found = await k.step(job, 'check', () => k.ours());
  let failed: unknown = null;
  try {
    await k.step(job, 'snapshot', async () => {
      if (found) await k.engine.stop(found.id).catch(() => fail('backup_failed'));
      await k.snapshot('manual', trickplay);
    });
  } catch (e) {
    failed = e;
  }
  if (found && k.updater.mediaState().desired?.run) {
    try { await k.step(job, 'start', () => k.engine.start(found.id)); } catch (e) { failed ??= e; }
  }
  if (failed) throw failed;
}

/**
 * `mediaserver-restore`: the backup's kind must be the server's (`kind_mismatch`) and its upstream not newer than the running
 * image (`downgrade_refused`), both before anything stops. Then:
 * - `snapshot`: stop, and an automatic safety snapshot of the current data (tagged `auto`, normal retention);
 * - `create`: helper `restore`, which verifies the whole archive before it empties the data volume;
 * - `start`, `health` when the server should run.
 * The helper's `backup_invalid` (and a failed safety snapshot) changed nothing: the server is started again if it ran before,
 * and the job fails with that code. Any other restore failure touched the data: `rollback` restores the safety snapshot and
 * starts the server again if it ran before (job `rolled_back`), or, when that fails too, leaves it stopped (half-restored data
 * is never started on); the code is `restore_failed` either way.
 */
export async function restoreJob(k: BackupKit, job: Job, id: string): Promise<void> {
  restores.add(id);
  try {
    const c = await k.step(job, 'check', async () => {
      const m = k.updater.mediaState();
      const b = m.backups.find((x) => x.id === id) ?? fail('backup_invalid');
      const running = m.container ?? fail('backup_invalid');
      if (b.kind !== running.kind) fail('kind_mismatch');
      if (older(running.upstream, b.upstream)) fail('downgrade_refused');
      await stat(fileOf(k.dir, id)).catch(() => fail('backup_invalid'));
      return { b, found: await k.ours() };
    });
    /** after a restore: when the server should run; with the data as it was: only when it ran before this job */
    const startAgain = async (asBefore = false): Promise<void> => {
      if (!c.found || !k.updater.mediaState().desired?.run || (asBefore && !c.found.running)) return;
      const cid = c.found.id;
      await k.step(job, 'start', () => k.engine.start(cid));
      await k.step(job, 'health', async () => { if (!(await k.healthy(cid))) fail('unhealthy'); });
    };
    const codeOf = (e: unknown): string => (e instanceof StepError ? e.code : '');

    let safety: BackupMeta;
    try {
      safety = await k.step(job, 'snapshot', async () => {
        if (c.found) await k.engine.stop(c.found.id);
        return k.snapshot('auto', false);
      });
    } catch (e) {
      if (codeOf(e) !== 'template_violation') await startAgain(true).catch(() => undefined);
      throw e;
    }

    try {
      await k.step(job, 'create', () => k.restoreSnapshot(id, c.b.kind));
    } catch (e) {
      if (codeOf(e) === 'template_violation') throw e;
      if (codeOf(e) === 'backup_invalid') {
        await startAgain(true).catch(() => undefined);
        throw new StepError('backup_invalid');
      }
      const back = await k.step(job, 'rollback', () => k.restoreSnapshot(safety.id, safety.kind)).then(() => true, () => false);
      k.updater.log.add(back ? 'media server data restored from the safety snapshot' : 'media rollback failed');
      if (back) await startAgain(true).catch(() => undefined);
      k.updater.updateMedia((m) => { m.lastError = 'restore_failed'; });
      throw new StepError('restore_failed');
    }

    try {
      await startAgain();
    } catch {
      k.updater.updateMedia((m) => { m.lastError = 'restore_failed'; });
      throw new StepError('restore_failed');
    }
    k.updater.updateMedia((m) => { if (m.lastError === 'restore_failed') m.lastError = null; });
  } finally {
    restores.delete(id);
  }
}
