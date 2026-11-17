// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRel } from './mediaserver/paths.js';

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

function answer(args: string[]): unknown {
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
  throw new HelperError('invalid_body');
}

/** prints one JSON line; exit code 0, or 2 with `{"error":"<code>"}` */
export function main(args: string[]): number {
  try {
    process.stdout.write(JSON.stringify(answer(args)) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof HelperError ? e.code : 'helper_failed' }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
