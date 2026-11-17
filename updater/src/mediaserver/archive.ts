// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { Transform, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { KINDS, type Kind } from './types.js';

/**
 * The media server backup archive (spec "Backup and restore"): a `.tar.gz` whose first entry is `friendflix-backup.json`
 * (`{v: 1, kind, upstream, createdAt}`), followed by the data volume as busybox tar writes it. Shared by the helper (writes and
 * restores it) and the updater (reads the metadata of an upload). No dependency beyond Node itself: the helper loads this file.
 */

export const META_NAME = 'friendflix-backup.json';
export interface ArchiveMeta { v: 1; kind: Kind; upstream: string; createdAt: string }
/** the upstream part of a backup id (BACKUP_ID_RE) */
export const BACKUP_UPSTREAM_RE = /^[0-9A-Za-z.+_-]{1,40}$/;
const META_MAX = 4096;
const BLOCK = 512;

/**
 * What a backup leaves out, relative to the data volume. Checked against the layout `mediaserver/try.sh` copies from Jellyfin
 * 10.11.3's /config (config, data, data/trickplay, log, metadata, plugins, root; its cache is the /cache volume, transcodes go
 * below the cache since 10.9, older servers kept them in /config) and Ferrofin v1.5.1's /data, which keeps Jellyfin's layout:
 * its cache defaults to /data/cache (the template moves it to /cache with FERROFIN_CACHE_DIR, an older container may still
 * have one), hence `cache` for Ferrofin too. A path that does not exist is simply not there to leave out.
 */
export const BACKUP_EXCLUDE: Record<Kind, { always: string[]; trickplay: string[] }> = {
  ferrofin: { always: ['log', 'cache', 'transcodes'], trickplay: ['data/trickplay'] },
  jellyfin: { always: ['log', 'cache', 'transcodes'], trickplay: ['data/trickplay', 'metadata/trickplay'] },
};

const octal = (n: number, width: number): string => n.toString(8).padStart(width - 1, '0') + '\0';

/** the metadata entry (ustar header + content, padded to whole blocks) the archive starts with */
export function metaEntry(meta: ArchiveMeta): Buffer {
  const body = Buffer.from(JSON.stringify({ v: meta.v, kind: meta.kind, upstream: meta.upstream, createdAt: meta.createdAt }), 'utf8');
  const h = Buffer.alloc(BLOCK);
  h.write(META_NAME, 0, 'utf8');
  h.write(octal(0o644, 8), 100, 'latin1');
  h.write(octal(0, 8), 108, 'latin1');
  h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(body.length, 12), 124, 'latin1');
  h.write(octal(Math.floor(Date.parse(meta.createdAt) / 1000) || 0, 12), 136, 'latin1');
  h.write('0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'latin1');
  const pad = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK);
  return Buffer.concat([h, body, pad]);
}

const field = (h: Buffer, at: number, len: number): string => {
  const s = h.subarray(at, at + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? len : end).toString('latin1');
};
const num = (h: Buffer, at: number, len: number): number => {
  const s = field(h, at, len).trim();
  return /^[0-7]{1,11}$/.test(s) ? parseInt(s, 8) : -1;
};

/** the metadata JSON, field by field; null for anything else */
function parseMeta(raw: string): ArchiveMeta | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== 'createdAt,kind,upstream,v' || o.v !== 1) return null;
  const kind = KINDS.find((k) => k === o.kind);
  if (!kind || typeof o.upstream !== 'string' || !BACKUP_UPSTREAM_RE.test(o.upstream)) return null;
  if (typeof o.createdAt !== 'string' || o.createdAt.length > 40 || Number.isNaN(Date.parse(o.createdAt))) return null;
  return { v: 1, kind, upstream: o.upstream, createdAt: o.createdAt };
}

/**
 * The first entry of an uncompressed tar stream: the metadata and how many bytes it takes (header + padded content); null when
 * the first entry is not a valid `friendflix-backup.json`. Reads only as far as that entry (stops iterating there).
 */
export async function readMeta(src: AsyncIterable<Uint8Array>): Promise<{ meta: ArchiveMeta; length: number } | null> {
  const chunks: Buffer[] = [];
  let have = 0;
  let need = BLOCK;
  let size = -1;
  for await (const c of src) {
    chunks.push(Buffer.from(c));
    have += c.length;
    if (size < 0 && have >= BLOCK) {
      const h = Buffer.concat(chunks).subarray(0, BLOCK);
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
      const type = h[156];
      size = num(h, 124, 12);
      if (field(h, 0, 100) !== META_NAME || field(h, 345, 155) !== '' || (type !== 0x30 && type !== 0) || num(h, 148, 8) !== sum) return null;
      if (size < 0 || size > META_MAX) return null;
      need = BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
    if (size >= 0 && have >= need) break;
  }
  if (size < 0 || have < need) return null;
  const meta = parseMeta(Buffer.concat(chunks).subarray(BLOCK, BLOCK + size).toString('utf8'));
  return meta ? { meta, length: need } : null;
}

/** readMeta of a `.tar.gz` file; a missing file, a gzip error or anything else invalid is null */
export async function readFileMeta(path: string): Promise<{ meta: ArchiveMeta; length: number } | null> {
  const gz = pipeline(createReadStream(path), createGunzip(), () => undefined);
  try {
    return await readMeta(gz);
  } catch {
    return null;
  } finally {
    gz.destroy();
  }
}

/** a name or link target that leads out of the folder it is extracted into */
const leaves = (p: string): boolean => p.startsWith('/') || p.split('/').includes('..');
/** a numeric header field: octal, or GNU base-256 (high bit set) for large sizes; -1 when invalid */
function size(h: Buffer): number {
  if ((h[124]! & 0x80) !== 0) {
    let n = h[124]! & 0x7f;
    for (let i = 125; i < 136; i++) n = n * 256 + h[i]!;
    return Number.isSafeInteger(n) ? n : -1;
  }
  return num(h, 124, 12);
}
/**
 * pax records `<len> key=value\n`: path and linkpath; null when malformed, when a path value holds a NUL (busybox ends it there:
 * `..\0x` is `..` to it) or when a record sets `size` (GNU tar would then read another length than the header's)
 */
function paxPaths(b: Buffer): { path?: string; linkpath?: string } | null {
  const out: { path?: string; linkpath?: string } = {};
  let at = 0;
  while (at < b.length) {
    if (b[at] === 0) break; // NUL padding after the last record
    const sp = b.indexOf(0x20, at);
    const len = sp < 0 ? NaN : Number(b.subarray(at, sp).toString('latin1'));
    if (!Number.isSafeInteger(len) || len <= sp - at + 1 || at + len > b.length || b[at + len - 1] !== 0x0a) return null;
    const rec = b.subarray(sp + 1, at + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq < 0) return null;
    const key = rec.slice(0, eq);
    const value = rec.slice(eq + 1);
    if (key === 'size') return null;
    if (key === 'path' || key === 'linkpath') {
      if (value.includes('\0')) return null;
      out[key] = value;
    }
    at += len;
  }
  return out;
}
const PAX_MAX = 1 << 20;
/** the entry types restore accepts: file (`0`, old `\0`, contiguous `7`), hard link, symlink, directory */
const ENTRY_TYPES = ['0', '\0', '7', '1', '2', '5'];
/** types whose size field tar ignores (no content follows): a size there would make this check and tar read different blocks */
const NO_CONTENT = ['1', '2', '5'];

/**
 * Passes a tar stream through unchanged and fails it at the first entry whose name or link target leaves the folder it is
 * extracted into (absolute, or a `..` component; the prefix field, GNU long names and pax `path`/`linkpath` included, each
 * checked where it is read), or at a header it cannot read. tar implementations differ here (busybox strips such prefixes and
 * extracts, GNU tar skips them), so restore decides itself, before the data folder is emptied. A backup the helper wrote never
 * holds such an entry. Checking ends at two empty blocks in a row, the end of the archive for every tar (busybox skips a single
 * one and reads on, so a single one does not end the check; one right after a long name or pax header is refused).
 * Everything a tar could read differently from this check is refused too, so both always see the same headers: a size on an
 * entry type tar reads without content (links, directories, and files whose name ends in `/`, which busybox makes directories),
 * a header without a name (busybox takes it for an empty block whatever its size), a NUL inside a long name or pax value, a pax
 * `size`, and every entry type but files, links and directories (devices and fifos have no place in a backup). Link targets are
 * checked on every entry (busybox makes a file entry with a link name and no content a hard link).
 */
export function entryCheck(): Transform {
  let head = Buffer.alloc(0);
  let skip = 0; // content bytes (padded) of the current entry still to pass
  let keep: { type: string; left: number; parts: Buffer[] } | null = null;
  let next: { path?: string; linkpath?: string } = {};
  let empty = 0; // empty blocks in a row
  let ended = false;
  const finish = (k: { type: string; parts: Buffer[] }): boolean => {
    const b = Buffer.concat(k.parts);
    let p: { path?: string; linkpath?: string } | null;
    if (k.type === 'L' || k.type === 'K') {
      const end = b.indexOf(0);
      if (end >= 0 && b.subarray(end).some((x) => x !== 0)) return false; // data after the NUL that ends it
      p = { [k.type === 'L' ? 'path' : 'linkpath']: b.subarray(0, end < 0 ? b.length : end).toString('utf8') };
    } else p = paxPaths(b);
    if (!p || Object.values(p).some(leaves)) return false;
    if (k.type !== 'g') next = { ...next, ...p };
    return true;
  };
  /** one header block: false = refuse */
  const header = (h: Buffer): boolean => {
    if (h.every((b) => b === 0)) {
      if (next.path !== undefined || next.linkpath !== undefined) return false;
      ended = ++empty >= 2;
      return true;
    }
    empty = 0;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    const n = size(h);
    if (num(h, 148, 8) !== sum || n < 0) return false;
    skip = Math.ceil(n / BLOCK) * BLOCK;
    const type = String.fromCharCode(h[156]!);
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (n > PAX_MAX) return false;
      keep = { type, left: n, parts: [] };
      if (n === 0) { const k = keep; keep = null; return finish(k); }
      return true;
    }
    if (!ENTRY_TYPES.includes(type)) return false;
    // the prefix whatever the magic says (a tar that joins it unchecked must not see more than this check)
    const prefix = field(h, 345, 155);
    const own = field(h, 0, 100);
    if (own === '' && prefix === '' && next.path === undefined) return false;
    const name = next.path ?? (prefix ? `${prefix}/${own}` : own);
    const link = next.linkpath ?? field(h, 157, 100);
    next = {};
    if (n > 0 && (NO_CONTENT.includes(type) || name.endsWith('/'))) return false;
    return !leaves(name) && !leaves(link);
  };
  return new Transform({
    transform(c: Buffer, _e, cb) {
      let at = 0;
      while (at < c.length && !ended) {
        if (skip > 0) {
          const n = Math.min(skip, c.length - at);
          if (keep && keep.left > 0) { keep.parts.push(c.subarray(at, at + Math.min(n, keep.left))); keep.left -= Math.min(n, keep.left); }
          skip -= n;
          at += n;
          if (skip === 0 && keep) { const k = keep; keep = null; if (!finish(k)) { cb(new Error('unsafe_entry')); return; } }
          continue;
        }
        const n = Math.min(BLOCK - head.length, c.length - at);
        head = Buffer.concat([head, c.subarray(at, at + n)]);
        at += n;
        if (head.length < BLOCK) break;
        const h = head;
        head = Buffer.alloc(0);
        if (!header(h)) { cb(new Error('unsafe_entry')); return; }
      }
      cb(null, c);
    },
  });
}
