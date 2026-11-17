// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'node:fs';
import { chmod, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { BACKUP_EXCLUDE, BACKUP_UPSTREAM_RE, metaEntry, readFileMeta } from './mediaserver/archive.js';
import { isRel } from './mediaserver/paths.js';
import { BACKUP_ID_RE, KINDS, type Kind } from './mediaserver/types.js';

/**
 * The helper program run inside short-lived helper containers (`node updater/dist/mediaHelper.js <verb> …`). It answers with one
 * JSON line on stdout: codes, names and numbers only, never a path below the base and never an error message.
 */

class HelperError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface BaseCheck { exists: boolean; dir: boolean; listable: boolean; looksSystem: boolean }
export type FolderCode = 'ok' | 'folder_missing' | 'folder_symlink' | 'folder_unreadable';
export interface FolderCheck { rel: string; code: FolderCode; read: boolean; watch: boolean; maxWatches: number | null }
export interface BrowseEntry { name: string; symlink: boolean; unreadable: boolean }
export interface GpuNode { node: string; gid: number; vendor: 'intel' | 'amd' | 'other' }

const MAX_ENTRIES = 300;
const MAX_FOLDERS = 20;

/** whether the directory looks like a system root or a Docker data root rather than a media library */
export function checkBase(dir: string): BaseCheck {
  let st;
  try { st = statSync(dir); } catch { return { exists: false, dir: false, listable: false, looksSystem: false }; }
  if (!st.isDirectory()) return { exists: true, dir: false, listable: false, looksSystem: false };
  let names: string[];
  try { names = readdirSync(dir); } catch { return { exists: true, dir: true, listable: false, looksSystem: false }; }
  const has = (...n: string[]): boolean => n.every((x) => names.includes(x));
  return { exists: true, dir: true, listable: true, looksSystem: has('bin', 'etc', 'usr') || has('overlay2') || has('volumes', 'containers') };
}

function maxWatches(): number | null {
  try {
    const n = Number(readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/** one file read (the first regular file, or true when there is none) */
function canRead(dir: string): boolean {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const fd = openSync(join(dir, e.name), 'r');
      try {
        if (!fstatSync(fd).isFile()) continue;
        readSync(fd, Buffer.alloc(1), 0, 1, 0);
      } finally { closeSync(fd); }
      return true;
    }
    return true;
  } catch { return false; }
}

/** an inotify watch on one subfolder (or the folder itself when it has none) */
function canWatch(dir: string): boolean {
  try {
    const sub = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && !e.name.startsWith('.'));
    const w = watch(sub ? join(dir, sub.name) : dir);
    w.on('error', () => undefined);
    w.close();
    return true;
  } catch { return false; }
}

function walk(root: string, rel: string): FolderCode {
  let at = root;
  for (const part of rel.split('/')) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EACCES' ? 'folder_unreadable' : 'folder_missing'; }
    if (st.isSymbolicLink()) return 'folder_symlink';
    if (!st.isDirectory()) return 'folder_missing';
  }
  return 'ok';
}

/** every component below the root is looked at with lstat; an ok folder is also read once and watched once */
export function checkFolders(root: string, rels: string[]): FolderCheck[] {
  return rels.map((rel) => {
    const code = walk(root, rel);
    if (code !== 'ok') return { rel, code, read: false, watch: false, maxWatches: null };
    const dir = join(root, rel);
    try { readdirSync(dir); } catch { return { rel, code: 'folder_unreadable' as const, read: false, watch: false, maxWatches: null }; }
    const read = canRead(dir);
    const watching = canWatch(dir);
    return { rel, code, read, watch: watching, maxWatches: watching ? null : maxWatches() };
  });
}

/** directories below `rel` (symlinks included, flagged), hidden ones skipped, sorted by name, at most 300 */
export function browseDir(root: string, rel: string): { entries: BrowseEntry[]; truncated: boolean } {
  if (!isRel(rel, 0, 2)) throw new HelperError('invalid_body');
  if (rel !== '') {
    const code = walk(root, rel);
    if (code !== 'ok') throw new HelperError(code);
  }
  const dir = rel === '' ? root : join(root, rel);
  let found;
  try { found = readdirSync(dir, { withFileTypes: true }); } catch { throw new HelperError('folder_unreadable'); }
  const all: BrowseEntry[] = [];
  for (const e of found) {
    if (e.name.startsWith('.')) continue;
    const symlink = e.isSymbolicLink();
    if (!symlink && !e.isDirectory()) continue;
    let unreadable = false;
    if (!symlink) { try { readdirSync(join(dir, e.name)); } catch { unreadable = true; } }
    all.push({ name: e.name, symlink, unreadable });
  }
  all.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: all.slice(0, MAX_ENTRIES), truncated: all.length > MAX_ENTRIES };
}

/** the uid of the newest top-level entry of the data directory (null when it is empty) */
export function checkData(dir: string): number | null {
  let best: { uid: number; at: number } | null = null;
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (!best || st.mtimeMs > best.at) best = { uid: st.uid, at: st.mtimeMs };
  }
  return best ? best.uid : null;
}

/** the render nodes under devDir with their group and the vendor read from drmDir/<node>/device/vendor */
export function detectGpu(devDir: string, drmDir: string): GpuNode[] {
  let names: string[];
  try { names = readdirSync(devDir); } catch { return []; }
  return names.filter((n) => /^renderD[0-9]{1,4}$/.test(n)).sort().map((node) => {
    let vendor: GpuNode['vendor'] = 'other';
    try {
      const v = readFileSync(join(drmDir, node, 'device', 'vendor'), 'utf8').trim().toLowerCase();
      vendor = v === '0x8086' ? 'intel' : v === '0x1002' ? 'amd' : 'other';
    } catch { /* unknown vendor */ }
    return { node, gid: statSync(join(devDir, node)).gid, vendor };
  });
}

/**
 * the tar arguments for the data folder without the excluded paths: an entry is listed as a whole unless something below it is
 * excluded, then its children are listed instead (exact paths, never glob patterns)
 */
function members(root: string, exclude: string[], rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(rel === '' ? root : join(root, rel)).sort()) {
    const p = rel === '' ? name : `${rel}/${name}`;
    if (exclude.includes(p)) continue;
    if (exclude.some((e) => e.startsWith(`${p}/`)) && lstatSync(join(root, p)).isDirectory()) out.push(...members(root, exclude, p));
    else out.push(p);
  }
  return out;
}

/** a child process's exit code (spawn errors reject) */
function exited(p: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => { p.once('error', reject); p.once('close', resolve); });
}

/**
 * helper `backup`: `<backups>/<id>.tar.gz` of the data folder (the metadata entry first, then busybox tar's stream of the data
 * without BACKUP_EXCLUDE), written as `.part` and renamed when complete; mode 0644 (the updater, another user, streams it).
 */
export async function writeBackup(dirs: { data: string; backups: string }, a: { id: string; trickplay: boolean; kind: Kind; upstream: string }, now: Date, tar = 'tar'): Promise<{ size: number }> {
  const part = join(dirs.backups, `${a.id}.tar.gz.part`);
  const file = join(dirs.backups, `${a.id}.tar.gz`);
  const ex = BACKUP_EXCLUDE[a.kind];
  try {
    const list = members(dirs.data, [...ex.always, ...(a.trickplay ? [] : ex.trickplay)]);
    const head = metaEntry({ v: 1, kind: a.kind, upstream: a.upstream, createdAt: now.toISOString() });
    const child = list.length > 0 ? spawn(tar, ['-c', '-f', '-', '-C', dirs.data, '--', ...list], { stdio: ['ignore', 'pipe', 'ignore'] }) : null;
    const code = child ? exited(child) : Promise.resolve(0);
    code.catch(() => undefined);
    try {
      await pipeline(async function* () {
        yield head;
        if (child) yield* child.stdout!;
        else yield Buffer.alloc(1024); // an empty data folder: the end of the archive
      }, createGzip(), createWriteStream(part, { mode: 0o644 }));
    } catch (e) {
      child?.kill();
      throw e;
    }
    if ((await code) !== 0) throw new HelperError('backup_failed');
    await chmod(part, 0o644);
    await rename(part, file);
    return { size: statSync(file).size };
  } catch {
    await rm(part, { force: true }).catch(() => undefined);
    throw new HelperError('backup_failed');
  }
}

/** passes everything after the first `n` bytes */
function skip(n: number): Transform {
  let left = n;
  return new Transform({
    transform(c: Buffer, _e, cb) {
      if (left >= c.length) { left -= c.length; cb(); return; }
      const rest = c.subarray(left);
      left = 0;
      cb(null, rest);
    },
  });
}

/** counts the bytes passing through */
function counter(): Transform & { total: number } {
  const t = new Transform({ transform(c: Buffer, _e, cb) { t.total += c.length; cb(null, c); } }) as Transform & { total: number };
  t.total = 0;
  return t;
}

/**
 * a child's stdin as the end of a pipeline that always reads its source to the end: a tar that stops reading after the end of
 * the archive (busybox does) is no error, and the gzip stream before it is still checked to its last byte
 */
function into(stdin: Writable): Writable {
  let open = true;
  stdin.on('error', () => { open = false; });
  return new Writable({
    write(c: Buffer, _e, cb) {
      if (!open || stdin.destroyed) { cb(); return; }
      stdin.write(c, () => cb());
    },
    final(cb) { if (open && !stdin.destroyed) stdin.end(); cb(); },
  });
}

/** gunzip (to its end) → skip `skipBytes` → `tar <args> -f -`: true when both the stream and tar succeeded; the bytes tar was given */
async function throughTar(tar: string, file: string, skipBytes: number, args: string[]): Promise<{ ok: boolean; total: number }> {
  const child = spawn(tar, [...args, '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const code = exited(child);
  code.catch(() => undefined);
  const count = counter();
  try {
    await pipeline(createReadStream(file), createGunzip(), skip(skipBytes), count, into(child.stdin!));
  } catch {
    child.kill();
    await code.catch(() => undefined);
    return { ok: false, total: count.total };
  }
  return { ok: (await code.catch(() => null)) === 0, total: count.total };
}

/** the sizes of everything below `dir` (not following links) */
function usage(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += lstatSync(p).size;
    if (e.isDirectory()) n += usage(p);
  }
  return n;
}

/** what the data folder can hold once emptied: free space plus what is in it now */
async function room(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize + usage(dir);
}

/**
 * helper `restore`: the archive is checked completely before anything changes: its metadata (this kind), the whole gzip stream,
 * a `tar -t` of all of it, and that its unpacked size fits the data folder (else `backup_invalid`, nothing touched). Then the
 * data folder is emptied and the archive extracted into it without its metadata entry (a failure now is `restore_failed`).
 */
export async function restoreBackup(dirs: { data: string; backups: string }, a: { id: string; kind: Kind }, o: { tar?: string; room?(): Promise<number> } = {}): Promise<{ ok: true }> {
  const tar = o.tar ?? 'tar';
  const file = join(dirs.backups, `${a.id}.tar.gz`);
  const head = await readFileMeta(file);
  if (!head || head.meta.kind !== a.kind) throw new HelperError('backup_invalid');
  const listed = await throughTar(tar, file, head.length, ['-t']);
  if (!listed.ok) throw new HelperError('backup_invalid');
  let space: number;
  try { space = await (o.room ?? (() => room(dirs.data)))(); } catch { throw new HelperError('backup_invalid'); }
  if (listed.total > space) throw new HelperError('backup_invalid');
  try {
    for (const name of readdirSync(dirs.data)) await rm(join(dirs.data, name), { recursive: true, force: true });
  } catch {
    throw new HelperError('restore_failed');
  }
  const done = await throughTar(tar, file, head.length, ['-x', '-o', '-C', dirs.data]);
  if (!done.ok) throw new HelperError('restore_failed');
  return { ok: true };
}

/** the arguments of `backup` / `restore`: an id that names this kind and upstream */
function backupArgs(id: string | undefined, kind: string | undefined, upstream?: string): { id: string; kind: Kind } {
  const k = KINDS.find((x) => x === kind);
  if (id === undefined || !BACKUP_ID_RE.test(id) || !k || !id.startsWith(`${k}-`)) throw new HelperError('invalid_body');
  if (upstream !== undefined && (!BACKUP_UPSTREAM_RE.test(upstream) || !id.endsWith(`-${upstream}`))) throw new HelperError('invalid_body');
  return { id, kind: k };
}

async function answer(args: string[]): Promise<unknown> {
  const [verb, a, b] = args;
  if (verb === 'check' && a === 'base' && args.length === 2) return checkBase('/base');
  if (verb === 'check' && a === 'folders' && args.length === 3) {
    let rels: unknown;
    try { rels = JSON.parse(b!); } catch { throw new HelperError('invalid_body'); }
    if (!Array.isArray(rels) || rels.length > MAX_FOLDERS || !rels.every((r) => typeof r === 'string' && isRel(r, 1, 3))) throw new HelperError('invalid_body');
    return { folders: checkFolders('/base', rels as string[]) };
  }
  if (verb === 'check' && a === 'data' && args.length === 2) return { owner: checkData('/data') };
  if (verb === 'browse' && args.length === 2) return browseDir('/base', a!);
  if (verb === 'gpu' && args.length === 1) return { nodes: detectGpu('/dev/dri', '/sys-drm') };
  if (verb === 'backup' && args.length === 5 && (b === '0' || b === '1')) {
    const { id, kind } = backupArgs(a, args[3], args[4]);
    return writeBackup({ data: '/data', backups: '/backups' }, { id, trickplay: b === '1', kind, upstream: args[4]! }, new Date());
  }
  if (verb === 'restore' && args.length === 3) return restoreBackup({ data: '/data', backups: '/backups' }, backupArgs(a, b));
  throw new HelperError('invalid_body');
}

/** prints one JSON line; exit code 0, or 2 with `{"error":"<code>"}` */
export async function main(args: string[]): Promise<number> {
  try {
    process.stdout.write(JSON.stringify(await answer(args)) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof HelperError ? e.code : 'helper_failed' }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
