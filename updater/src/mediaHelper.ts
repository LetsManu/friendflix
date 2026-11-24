// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import {
  closeSync, constants, createReadStream, createWriteStream, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, watch, writeSync, type Stats,
} from 'node:fs';
import { chmod, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { BACKUP_EXCLUDE, BACKUP_UPSTREAM_RE, entryCheck, metaEntry, readFileMeta } from './mediaserver/archive.js';
import { isRel } from './mediaserver/paths.js';
import { FFMPEG_DIR } from './mediaserver/template.js';
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

/**
 * gunzip (to its end) → skip `skipBytes` → [`check`] → `tar <args> -f -`: true when the stream, the check and tar succeeded; the
 * bytes tar was given
 */
async function throughTar(tar: string, file: string, skipBytes: number, args: string[], check?: Transform): Promise<{ ok: boolean; total: number }> {
  const child = spawn(tar, [...args, '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const code = exited(child);
  code.catch(() => undefined);
  const count = counter();
  try {
    await pipeline(createReadStream(file), createGunzip(), skip(skipBytes), ...(check ? [check] : []), count, into(child.stdin!));
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

/** what the file system behind `dir` has free for an unprivileged writer (the move's space check: the Docker data root) */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/** what the data folder can hold once emptied: free space plus what is in it now */
async function room(dir: string): Promise<number> {
  return (await freeBytes(dir)) + usage(dir);
}

/**
 * helper `restore`: the archive is checked completely before anything changes: its metadata (this kind), the whole gzip stream,
 * a `tar -t` of all of it, that no entry leads out of the data folder (`entryCheck`), and that its unpacked size fits the data
 * folder (else `backup_invalid`, nothing touched). Then the data folder is emptied and the archive extracted into it without its
 * metadata entry (a failure now is `restore_failed`).
 */
export async function restoreBackup(dirs: { data: string; backups: string }, a: { id: string; kind: Kind }, o: { tar?: string; room?(): Promise<number> } = {}): Promise<{ ok: true }> {
  const tar = o.tar ?? 'tar';
  const file = join(dirs.backups, `${a.id}.tar.gz`);
  const head = await readFileMeta(file);
  if (!head || head.meta.kind !== a.kind) throw new HelperError('backup_invalid');
  const listed = await throughTar(tar, file, head.length, ['-t'], entryCheck());
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

// ---- moving an existing Jellyfin to Ferrofin (stage 2): `migrate-scan`, `migrate-copy` ----

export type SourceLayout = 'official' | 'linuxserver';

/**
 * The two Jellyfin `/config` layouts (spec "Reading the source"), kept here alone so they are corrected in one place. `program` is
 * Jellyfin's program data dir (`--datadir`, JELLYFIN_DATA_DIR) below `/config`, `config` its config dir (`--configdir`,
 * JELLYFIN_CONFIG_DIR). Jellyfin derives the rest from the program data dir: `data/` (jellyfin.db, device.txt = the server id,
 * playlists, collections, trickplay), `root/default` (the libraries), `metadata/`, `plugins/`.
 * - official (jellyfin/jellyfin): JELLYFIN_DATA_DIR=/config, JELLYFIN_CONFIG_DIR=/config/config (logs /config/log, cache /cache);
 * - linuxserver/jellyfin: --datadir=/config/data, --configdir=/config (logs /config/log, cache /config/cache).
 * To verify against the real images (task 3 report): these paths and that `data/device.txt` holds the server id.
 */
export const SOURCE_LAYOUTS: Record<SourceLayout, { program: string; config: string }> = {
  official: { program: '', config: 'config' },
  linuxserver: { program: 'data', config: '' },
};

/** the given parts joined with '/', empty ones left out ('' = the root) */
const sub = (...parts: string[]): string => parts.filter((p) => p !== '').join('/');

function layoutPaths(l: SourceLayout): { data: string; root: string; metadata: string; plugins: string; config: string } {
  const { program, config } = SOURCE_LAYOUTS[l];
  return { data: sub(program, 'data'), root: sub(program, 'root', 'default'), metadata: sub(program, 'metadata'), plugins: sub(program, 'plugins'), config };
}

/** the database files: copied only by the `final` pass, with Jellyfin stopped */
const DB_RE = /\.db(-wal|-shm)?$/;
/** the temporary name a file is written under before its rename (one per folder at a time) */
const TEMP = '.ffmigrate.part';

/** `keep`: never pruned by `final` (metadata: orphaned images are harmless) */
interface CopyItem { from: string; to: string; what: 'db' | 'xml' | 'file' | 'tree' | 'trickplay'; keep?: true }

/**
 * What is copied, source (by layout) → Ferrofin's data dir (FERROFIN_DATA_DIR; the official layout, as `mediaserver/try.sh`
 * copies it):
 * - `<data>/*.db`, `*.db-wal`, `*.db-shm` → `data/` (final pass only)
 * - `<data>/device.txt` → `data/device.txt` (keeps the server id)
 * - `<data>/playlists`, `<data>/collections` → `data/…`
 * - `<data>/trickplay` → `data/trickplay` (when chosen)
 * - `<program>/root/default` → `root/default`; `<program>/metadata` → `metadata`
 * - `<config>/*.xml` → `config/`
 *
 * Never: logs, cache, transcodes, keyframes, plugins (not carried over), anything else. Symlinks and special files are skipped,
 * never followed.
 */
function copyPlan(l: SourceLayout): CopyItem[] {
  const p = layoutPaths(l);
  return [
    { from: p.data, to: 'data', what: 'db' },
    { from: `${p.data}/device.txt`, to: 'data/device.txt', what: 'file' },
    { from: `${p.data}/playlists`, to: 'data/playlists', what: 'tree' },
    { from: `${p.data}/collections`, to: 'data/collections', what: 'tree' },
    { from: `${p.data}/trickplay`, to: 'data/trickplay', what: 'trickplay' },
    { from: p.root, to: 'root/default', what: 'tree' },
    { from: p.metadata, to: 'metadata', what: 'tree', keep: true },
    { from: p.config, to: 'config', what: 'xml' },
  ];
}

/** lstat, null for an entry that is gone (Jellyfin keeps running during `bulk`) */
function lst(p: string): Stats | null {
  try { return lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

/** readdir sorted, [] for a folder that is gone */
function names(p: string): string[] {
  try { return readdirSync(p).sort(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw e;
  }
}

/** what `rel` below `root` is when no component of it is a symlink: 'file', 'dir' or null */
function kindOf(root: string, rel: string): 'file' | 'dir' | null {
  let st = lst(root);
  let at = root;
  for (const part of rel === '' ? [] : rel.split('/')) {
    if (!st?.isDirectory()) return null;
    at = join(at, part);
    st = lst(at);
  }
  return st?.isDirectory() ? 'dir' : st?.isFile() ? 'file' : null;
}

/** a small regular file, opened without following a final symlink */
function readSmall(p: string, max: number): string {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error('not a small file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** every regular file of a copy item (source rel, target rel, lstat); `onDir` for each target folder before its files */
function each(src: string, item: CopyItem, onFile: (from: string, to: string, st: Stats) => void, onDir: (to: string) => void = () => undefined): void {
  const kind = kindOf(src, item.from);
  if (item.what === 'file') {
    const st = kind === 'file' ? lst(join(src, item.from)) : null;
    if (st?.isFile()) { onDir(dirname(item.to)); onFile(item.from, item.to, st); }
    return;
  }
  if (kind !== 'dir') return;
  onDir(item.to);
  const walk = (from: string, to: string, deep: boolean, re?: RegExp): void => {
    for (const name of names(join(src, from))) {
      if (name === TEMP || (re && !re.test(name))) continue;
      const st = lst(join(src, from, name));
      if (st?.isFile()) onFile(sub(from, name), `${to}/${name}`, st);
      else if (deep && st?.isDirectory()) { onDir(`${to}/${name}`); walk(sub(from, name), `${to}/${name}`, true); }
    }
  };
  if (item.what === 'db') walk(item.from, item.to, false, DB_RE);
  else if (item.what === 'xml') walk(item.from, item.to, false, /\.xml$/);
  else walk(item.from, item.to, true);
}

/** the one layout whose database, libraries and config folder exist (no symlink on the way), else `source_layout` */
export function detectLayout(src: string): SourceLayout {
  const found = (Object.keys(SOURCE_LAYOUTS) as SourceLayout[]).filter((l) => {
    const p = layoutPaths(l);
    return kindOf(src, `${p.data}/jellyfin.db`) === 'file' && kindOf(src, p.root) === 'dir' && kindOf(src, p.config) === 'dir';
  });
  if (found.length !== 1) throw new HelperError('source_layout');
  return found[0]!;
}

const GUID_RE = /^[{(]?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})[})]?$/i;

/**
 * the server id: Jellyfin's `SystemId` is the GUID in `<data>/device.txt` (Emby.Server.Implementations DeviceId, created on first
 * start), shown as 32 lowercase hex digits; missing or unreadable is `source_layout`
 */
function serverIdOf(src: string, l: SourceLayout): string {
  const rel = `${layoutPaths(l).data}/device.txt`;
  let raw: string;
  try {
    if (kindOf(src, rel) !== 'file') throw new Error('missing');
    raw = readSmall(join(src, rel), 1024).trim();
  } catch { throw new HelperError('source_layout'); }
  const m = GUID_RE.exec(raw);
  if (!m) throw new HelperError('source_layout');
  return m.slice(1).join('').toLowerCase();
}

/** installed plugins by name (meta.json's `name`, else the folder name without its version), at most 50 */
function pluginsOf(src: string, l: SourceLayout): string[] {
  const dir = layoutPaths(l).plugins;
  if (kindOf(src, dir) !== 'dir') return [];
  const found = new Set<string>();
  for (const e of names(join(src, dir))) {
    if (e === 'configurations' || kindOf(src, `${dir}/${e}`) !== 'dir') continue;
    let name = e.replace(/_[0-9]+(\.[0-9]+)*$/, '');
    try {
      const meta = JSON.parse(readSmall(join(src, dir, e, 'meta.json'), 65536)) as { name?: unknown };
      if (typeof meta.name === 'string') name = meta.name;
    } catch { /* no meta.json: the folder name */ }
    name = name.replace(/\p{Cc}/gu, '').trim().slice(0, 100);
    if (name) found.add(name);
  }
  return [...found].sort((a, b) => a.localeCompare(b, 'en')).slice(0, 50);
}

/**
 * whether the NFO saver is on for any library (`root/default/<library>/options.xml`): its `MetadataSavers` list names `Nfo`, or
 * it has no list of its own (absent or nil: Jellyfin then uses the server's metadata options, whose savers write local files when
 * `SaveLocalMetadata` is on; counted as on, the safe side: the move switches it off)
 */
function nfoOn(src: string, l: SourceLayout): boolean {
  const lib = layoutPaths(l).root;
  for (const e of names(join(src, lib))) {
    const rel = `${lib}/${e}/options.xml`;
    if (kindOf(src, rel) !== 'file') continue;
    let xml: string;
    try { xml = readSmall(join(src, rel), 1 << 20); } catch { continue; }
    const m = /<MetadataSavers(\s[^>]*)?\/>|<MetadataSavers(?:\s[^>]*)?>([\s\S]*?)<\/MetadataSavers>/.exec(xml);
    if (m && m[2] !== undefined) {
      if (/<string>\s*Nfo\s*<\/string>/i.test(m[2])) return true;
    } else if ((!m || /xsi:nil="true"/.test(m[1] ?? '')) && /<SaveLocalMetadata>\s*true\s*<\/SaveLocalMetadata>/i.test(xml)) return true;
  }
  return false;
}

export interface SourceScan { layout: SourceLayout; serverId: string; bytes: number; trickplayBytes: number; plugins: string[]; nfo: boolean }

/** helper `migrate-scan id`: the layout and the server id only (no tree is walked, so it stays fast on a large library) */
export function identifySource(src: string): { layout: SourceLayout; serverId: string } {
  const layout = detectLayout(src);
  return { layout, serverId: serverIdOf(src, layout) };
}

/** helper `migrate-scan`: reads `/source` only */
export function scanSource(src: string): SourceScan {
  const layout = detectLayout(src);
  const serverId = serverIdOf(src, layout);
  let bytes = 0;
  let trickplayBytes = 0;
  for (const item of copyPlan(layout)) {
    each(src, item, (_f, _t, st) => {
      if (item.what === 'trickplay') trickplayBytes += st.size;
      else bytes += st.size;
    });
  }
  return { layout, serverId, bytes, trickplayBytes, plugins: pluginsOf(src, layout), nfo: nfoOn(src, layout) };
}

/** `rel` below the target root as real folders: a file or symlink in the way is removed (never followed), then created */
function ensureDir(root: string, rel: string): void {
  let at = root;
  for (const part of rel.split('/')) {
    at = join(at, part);
    const st = lst(at);
    if (st?.isDirectory()) continue;
    if (st) rmSync(at, { force: true });
    mkdirSync(at, { mode: 0o755 });
  }
}

/** whether the target file is missing or differs from the source in size or mtime (by 1 ms or more) */
function differs(target: string, st: Stats): boolean {
  const t = lst(target);
  return !t?.isFile() || t.size !== st.size || Math.abs(t.mtimeMs - st.mtimeMs) >= 1;
}

/**
 * one file into the target: the source opened without following a final symlink (and only when it still is a regular file),
 * written to a temporary name in the target folder, synced, given the source's mtime, then renamed over the target (a reader never
 * sees half a database). false when the source went away meanwhile.
 */
function copyOne(from: string, target: string): boolean {
  let fd: number;
  // O_NONBLOCK: a FIFO swapped in after the lstat cannot hang the open; fstat below then skips it
  try { fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return false;
    throw e;
  }
  const part = join(dirname(target), TEMP);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return false;
    rmSync(part, { force: true });
    const out = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let pos = 0; ;) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n === 0) break;
        for (let w = 0; w < n;) w += writeSync(out, buf, w, n - w);
        pos += n;
      }
      fchmodSync(out, (st.mode & 0o777) | 0o600);
      fsyncSync(out);
    } finally { closeSync(out); }
    utimesSync(part, st.atimeMs / 1000, st.mtimeMs / 1000);
    if (lst(target)?.isDirectory()) rmSync(target, { recursive: true, force: true });
    renameSync(part, target);
    return true;
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  } finally { closeSync(fd); }
}

export type XmlEdit = { key: string; value: string } | { key: string; subnets: readonly string[] };

/**
 * targeted element edits on a serialised Jellyfin config (no XML library): each key a direct element of `root`, set to its value
 * (an empty value as `<Key />`; nil counts as empty) or, for a list, given the missing subnets after its own. A missing element is
 * added before the root's end tag (a missing empty one is already the default). null = unknown structure (another root, a key
 * twice, markup inside a value): the caller leaves the file untouched. `keys`: what changed, in edit order.
 */
export function adjustXml(text: string, root: string, edits: readonly XmlEdit[]): { text: string; keys: string[] } | null {
  const open = new RegExp(`^\\uFEFF?\\s*(?:<\\?xml[^>]*\\?>\\s*)?<${root}(?:\\s[^>]*)?>`).exec(text);
  if (!open || open[0].endsWith('/>')) return null;
  const end = text.lastIndexOf(`</${root}>`);
  if (end < open[0].length || text.slice(end + root.length + 3).trim() !== '') return null;
  let body = text.slice(open[0].length, end);
  const keys: string[] = [];
  for (const e of edits) {
    const count = body.match(new RegExp(`<${e.key}[\\s/>]`, 'g'))?.length ?? 0;
    if (count > 1) return null;
    const m = count === 0 ? null : new RegExp(`<${e.key}(\\s[^>]*)?\\/>|<${e.key}>([\\s\\S]*?)<\\/${e.key}>`).exec(body);
    if (count === 1 && !m) return null;
    if (m && m[1] !== undefined && !['', 'xsi:nil="true"'].includes(m[1].trim())) return null;
    const inner = m?.[2] ?? '';
    const lineStart = m ? body.lastIndexOf('\n', m.index) + 1 : 0;
    const indent = m && /^[ \t]*$/.test(body.slice(lineStart, m.index)) ? body.slice(lineStart, m.index) : '  ';
    let element: string;
    if ('subnets' in e) {
      if (!/^(\s*<string>[^<]*<\/string>)*\s*$/.test(inner)) return null;
      const own = [...inner.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!.trim());
      const missing = e.subnets.filter((s) => !own.includes(s));
      if (missing.length === 0) continue;
      element = `<${e.key}>\n${[...own, ...missing].map((s) => `${indent}  <string>${s}</string>\n`).join('')}${indent}</${e.key}>`;
    } else {
      if (inner.includes('<')) return null;
      if (inner === e.value) continue;
      element = e.value === '' ? `<${e.key} />` : `<${e.key}>${e.value}</${e.key}>`;
    }
    if (m) body = body.slice(0, m.index) + element + body.slice(m.index + m[0].length);
    else body = `${body}${body.endsWith('\n') ? '' : '\n'}${indent}${element}\n`;
    keys.push(e.key);
  }
  return { text: open[0] + body + text.slice(end), keys };
}

/** RFC 1918; Docker's default bridge (172.17.0.0/16) and default address pools (172.17–31.0.0/16, 192.168.0.0/20 slices) lie inside */
const LOCAL_SUBNETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
const FERROFIN_FFMPEG = `${FFMPEG_DIR.ferrofin}/ffmpeg`;

/** the copy's settings adjusted on `final` (spec "The move" step 4); the job log names `<prefix>.<key>`, never a value */
const CONFIG_EDITS: readonly { file: string; root: string; prefix: string; edits: readonly XmlEdit[] }[] = [
  {
    file: 'network.xml', root: 'NetworkConfiguration', prefix: 'network', edits: [
      { key: 'BaseUrl', value: '' }, { key: 'EnableHttps', value: 'false' }, { key: 'RequireHttps', value: 'false' },
      { key: 'InternalHttpPort', value: '8096' }, { key: 'PublicHttpPort', value: '8096' }, { key: 'LocalNetworkSubnets', subnets: LOCAL_SUBNETS },
    ],
  },
  {
    file: 'encoding.xml', root: 'EncodingOptions', prefix: 'encoding', edits: [
      { key: 'EncoderAppPath', value: FERROFIN_FFMPEG }, { key: 'EncoderAppPathDisplay', value: FERROFIN_FFMPEG },
      { key: 'TranscodingTempPath', value: '/cache/transcodes' },
    ],
  },
  { file: 'system.xml', root: 'ServerConfiguration', prefix: 'system', edits: [{ key: 'MetadataPath', value: '' }, { key: 'CachePath', value: '' }] },
];

/** the copied XMLs in `<dst>/config` adjusted in place (temporary file, then rename); the source is never opened here */
function adjustConfig(dst: string): string[] {
  const out: string[] = [];
  for (const c of CONFIG_EDITS) {
    const file = join(dst, 'config', c.file);
    const st = lst(file);
    if (!st?.isFile()) continue;
    const r = adjustXml(readFileSync(file, 'utf8'), c.root, c.edits);
    if (!r || r.keys.length === 0) continue;
    const part = join(dst, 'config', TEMP);
    rmSync(part, { force: true });
    const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, r.text);
      fchmodSync(fd, (st.mode & 0o777) | 0o600);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(part, file);
    out.push(...r.keys.map((k) => `${c.prefix}.${k}`));
  }
  return out;
}

/** removes `rel` below the target root, whatever it is: rm unlinks a symlink itself and never follows one */
function remove(dst: string, rel: string): void {
  rmSync(join(dst, rel), { recursive: true, force: true });
}

/** every entry below the target folder `rel` that the source did not have (`seen`), recursing only into real folders */
function prune(dst: string, rel: string, seen: Set<string>): void {
  for (const name of names(join(dst, rel))) {
    const r = `${rel}/${name}`;
    if (!seen.has(r)) remove(dst, r);
    else if (lst(join(dst, r))?.isDirectory()) prune(dst, r, seen);
  }
}

/** leftover temporary files of an interrupted copy anywhere in the target (real folders only) */
function sweepTemp(dst: string, rel = ''): void {
  for (const name of names(rel === '' ? dst : join(dst, rel))) {
    const r = sub(rel, name);
    if (name.endsWith(TEMP)) remove(dst, r);
    else if (lst(join(dst, r))?.isDirectory()) sweepTemp(dst, r);
  }
}

/**
 * helper `migrate-copy`: `/source` (read-only) → `/data` (Ferrofin's data volume). `bulk` (Jellyfin running) copies every file of
 * the plan except the database files when it differs from the target, and removes nothing. `final` (Jellyfin stopped) makes the
 * target match the source (the volume is kept after an abort, so a retry may find an older copy): it removes leftover temp files
 * and every `data/*.pre-ferrofin*` (else `adopted` would pass for an old adoption), copies the database files always and every
 * other file that differs, removes what the source no longer has under each plan item except `metadata` (libraries, playlists,
 * collections, trickplay, `config/*.xml`, database files: a stale WAL next to a fresh database corrupts it), removes trickplay when
 * it is not chosen, then adjusts the copied XMLs. Writes and removals go only below `dst`.
 */
export async function copySource(src: string, dst: string, o: { pass: 'bulk' | 'final'; trickplay: boolean; layout: SourceLayout }): Promise<{ copied: number; adjusted: string[] }> {
  if (detectLayout(src) !== o.layout) throw new HelperError('source_layout');
  const final = o.pass === 'final';
  try {
    let copied = 0;
    if (final) sweepTemp(dst);
    for (const item of copyPlan(o.layout)) {
      if (item.what === 'db' && !final) continue;
      if (item.what === 'trickplay' && !o.trickplay) {
        if (final) remove(dst, item.to);
        continue;
      }
      if (item.what === 'db' && kindOf(dst, item.to) === 'dir') {
        for (const name of names(join(dst, item.to))) if (name.includes('.pre-ferrofin')) remove(dst, `${item.to}/${name}`);
      }
      const seen = new Set<string>();
      each(src, item, (from, to, st) => {
        seen.add(to);
        const target = join(dst, to);
        if ((item.what === 'db' || differs(target, st)) && copyOne(join(src, from), target)) copied++;
      }, (to) => { seen.add(to); ensureDir(dst, to); });
      if (!final || item.keep || item.what === 'file') continue;
      if (item.what === 'tree' || item.what === 'trickplay') {
        if (seen.has(item.to)) prune(dst, item.to, seen);
        else remove(dst, item.to);
      } else {
        // `data/` and `config/` hold more than this item (and always exist in a detected layout): only its own pattern is pruned
        const re = item.what === 'db' ? DB_RE : /\.xml$/;
        for (const name of names(join(dst, item.to))) if (re.test(name) && !seen.has(`${item.to}/${name}`)) remove(dst, `${item.to}/${name}`);
      }
    }
    return { copied, adjusted: final ? adjustConfig(dst) : [] };
  } catch (e) {
    throw new HelperError((e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'no_space' : 'helper_failed');
  }
}

/** Ferrofin's adoption backup of the copied database is in the data folder (`data/jellyfin.db.pre-ferrofin`, as try.sh checks) */
export function checkAdopted(dir: string): boolean {
  return kindOf(dir, 'data/jellyfin.db.pre-ferrofin') === 'file';
}

const LAYOUT_NAMES = Object.keys(SOURCE_LAYOUTS) as SourceLayout[];

async function answer(args: string[]): Promise<unknown> {
  const [verb, a, b] = args;
  if (verb === 'check' && a === 'base' && args.length === 2) return checkBase('/base');
  if (verb === 'check' && a === 'folders' && args.length === 3) {
    let rels: unknown;
    try { rels = JSON.parse(b!); } catch { throw new HelperError('invalid_body'); }
    // '' is the whole base: only a migrated folder can be it (the template refuses it for any other), every component lstat'ed
    if (!Array.isArray(rels) || rels.length > MAX_FOLDERS || !rels.every((r) => typeof r === 'string' && isRel(r, 0, 3))) throw new HelperError('invalid_body');
    return { folders: checkFolders('/base', rels as string[]) };
  }
  if (verb === 'check' && a === 'data' && args.length === 2) return { owner: checkData('/data'), adopted: checkAdopted('/data'), free: await freeBytes('/data') };
  if (verb === 'browse' && args.length === 2) return browseDir('/base', a!);
  if (verb === 'gpu' && args.length === 1) return { nodes: detectGpu('/dev/dri', '/sys-drm') };
  if (verb === 'backup' && args.length === 5 && (b === '0' || b === '1')) {
    const { id, kind } = backupArgs(a, args[3], args[4]);
    return writeBackup({ data: '/data', backups: '/backups' }, { id, trickplay: b === '1', kind, upstream: args[4]! }, new Date());
  }
  if (verb === 'restore' && args.length === 3) return restoreBackup({ data: '/data', backups: '/backups' }, backupArgs(a, b));
  if (verb === 'migrate-scan' && args.length === 1) return scanSource('/source');
  if (verb === 'migrate-scan' && args.length === 2 && a === 'id') return identifySource('/source');
  if (verb === 'migrate-copy' && args.length === 5) {
    const [, pass, trickplay, layout, uid] = args;
    const l = LAYOUT_NAMES.find((x) => x === layout);
    if ((pass !== 'bulk' && pass !== 'final') || (trickplay !== '0' && trickplay !== '1') || !l || !/^[1-9][0-9]{0,9}$/.test(uid!) || Number(uid) > 0x7fffffff) {
      throw new HelperError('invalid_body');
    }
    // the copy runs as the Ferrofin container's user, so everything it writes is owned by that user (no chown, never root)
    if (process.getuid?.() !== Number(uid)) throw new HelperError('uid_mismatch');
    return copySource('/source', '/data', { pass, trickplay: trickplay === '1', layout: l });
  }
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

/** whether `argv1` started the module at `url`: Node gives the main module its real path, so a symlinked start path is resolved */
export function isMain(argv1: string | undefined, url: string): boolean {
  if (!argv1) return false;
  try { return url === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}

if (isMain(process.argv[1], import.meta.url)) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
