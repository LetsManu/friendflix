// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
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
