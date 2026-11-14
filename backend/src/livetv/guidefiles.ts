// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Ctx } from '../ctx.js';

/**
 * The stored files of uploaded XMLTV guides (extra guides, Stage 2; docs/superpowers/specs/2026-11-14-livetv-extra-guides-design.md
 * *Import and refresh*). The backend never parses them: it only stores the bytes, hashes them and streams them to livetv's
 * `POST /v1/parse/xmltv` (epg.ts). They live in `<PREVIEW_DIR>/livetv-guides/` (the backend's own data volume, outside any web root,
 * never served back):
 *
 * - `<id>.pending.part`: an upload while it is received (cut at GUIDE_FILE_MAX_BYTES);
 * - `<id>.pending.xml[.gz]`: a received upload while it is imported (the extension says whether its first bytes are the gzip magic);
 * - `<id>.xml[.gz]`: the guide's current file (`livetv_sources.guide_file`), replaced by the pending one only after its import succeeded.
 *
 * Names are built from the source id only (a uuid), never from anything the admin sent.
 */
export const GUIDE_FILE_MAX_BYTES = 300 * 1024 * 1024;
/** what the card shows of the uploaded name; longer ones are cut */
const MAX_LABEL = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xml(?:\.gz)?$/;

export const guideDir = (ctx: Pick<Ctx, 'cfg'>): string => join(ctx.cfg.PREVIEW_DIR, 'livetv-guides');

function own(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('not a source id');
  return id;
}
/** the path of a stored name (`guide_file`); anything else (a damaged row) is refused */
export function storedPath(ctx: Pick<Ctx, 'cfg'>, name: string): string {
  if (!STORED_RE.test(name)) throw new Error('not a stored guide file');
  return join(guideDir(ctx), name);
}
const storedName = (id: string, gz: boolean) => `${own(id)}.xml${gz ? '.gz' : ''}`;
const pendingPath = (ctx: Pick<Ctx, 'cfg'>, id: string, gz: boolean) => join(guideDir(ctx), `${own(id)}.pending.xml${gz ? '.gz' : ''}`);
const partPath = (ctx: Pick<Ctx, 'cfg'>, id: string) => join(guideDir(ctx), `${own(id)}.pending.part`);

/** the uploaded name as the card shows it: the last path segment, without control characters, cut; null when nothing is left */
export function fileLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // control characters, zero-width and direction marks: a name must not hide or reorder what the card shows
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return clean ? [...clean].slice(0, MAX_LABEL).join('') : null;
}

/** a received upload, waiting for its import */
export interface PendingFile { path: string; gz: boolean; bytes: number; sha256: string }
export type ReceiveError = 'too_large' | 'empty' | 'broken';

class TooLarge extends Error {}

/**
 * Streams an upload to `<id>.pending.part` (hashed and counted on the way; more than `max` bytes stop it), then renames it to
 * `<id>.pending.xml[.gz]` by its first two bytes. Any failure leaves no part file. `tick` is called about every 30 s while bytes
 * arrive (the caller renews its lock).
 */
export async function receiveGuideFile(ctx: Pick<Ctx, 'cfg'>, id: string, body: Readable, o: { max?: number; tick?: () => unknown } = {}): Promise<PendingFile | { error: ReceiveError }> {
  const max = o.max ?? GUIDE_FILE_MAX_BYTES;
  await mkdir(guideDir(ctx), { recursive: true, mode: 0o700 });
  const part = partPath(ctx, id);
  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  let last = Date.now();
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > max) { done(new TooLarge()); return; }
      if (head.length < 2) head = Buffer.concat([head, chunk.subarray(0, 2)]);
      hash.update(chunk);
      if (o.tick && Date.now() - last > 30_000) { last = Date.now(); void Promise.resolve(o.tick()).catch(() => undefined); }
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, count, createWriteStream(part, { mode: 0o600 }));
  } catch (e) {
    await rm(part, { force: true });
    return { error: e instanceof TooLarge ? 'too_large' : 'broken' };
  }
  if (bytes === 0) { await rm(part, { force: true }); return { error: 'empty' }; }
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const path = pendingPath(ctx, id, gz);
  await rm(pendingPath(ctx, id, !gz), { force: true }); // an older pending file of the other kind
  await rename(part, path);
  return { path, gz, bytes, sha256: hash.digest('hex') };
}

/** the pending file becomes the guide's file (`<id>.xml[.gz]`, its stored name answered); a current file of the other kind goes */
export async function promoteGuideFile(ctx: Pick<Ctx, 'cfg'>, id: string, p: PendingFile): Promise<string> {
  const name = storedName(id, p.gz);
  await rename(p.path, storedPath(ctx, name));
  await rm(storedPath(ctx, storedName(id, !p.gz)), { force: true });
  return name;
}

/** a pending file whose import failed: it goes, the guide's current file stays */
export async function dropPendingFile(p: PendingFile): Promise<void> {
  await rm(p.path, { force: true });
}

/** every file of the guide (current, pending, part): a deleted guide, or an upload for a guide deleted meanwhile */
export async function removeGuideFiles(ctx: Pick<Ctx, 'cfg'>, id: string): Promise<void> {
  for (const p of [storedName(id, false), storedName(id, true)].map((n) => storedPath(ctx, n)).concat(pendingPath(ctx, id, false), pendingPath(ctx, id, true), partPath(ctx, id))) {
    await rm(p, { force: true });
  }
}

/** the stored file's path, size and SHA-256; null when it is not there (any more) */
export async function storedGuideFile(ctx: Pick<Ctx, 'cfg'>, name: string): Promise<{ path: string; bytes: number; sha256: string } | null> {
  const path = storedPath(ctx, name);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return null;
  return { path, bytes: st.size, sha256: await fileSha256(path) };
}

export async function fileSha256(path: string, prefix?: Uint8Array): Promise<string> {
  const h = createHash('sha256');
  if (prefix) h.update(prefix);
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

/** the request body of `/v1/parse/xmltv`: `head` (the filter line), then the file's bytes */
export async function* headThenFile(head: Uint8Array, path: string): AsyncGenerator<Uint8Array> {
  yield head;
  for await (const c of createReadStream(path)) yield c as Buffer;
}
