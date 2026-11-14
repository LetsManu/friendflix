// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
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
 * - `<id>.pending.<token>.part`: an upload while it is received (one name per upload, created exclusively; cut at GUIDE_FILE_MAX_BYTES);
 * - `<id>.pending.xml[.gz]`: a received upload while it is imported (the extension says whether its first bytes are the gzip magic);
 * - `<id>.xml[.gz]`: the guide's current file (`livetv_sources.guide_file`), replaced by the pending one only after its import succeeded.
 *
 * Names are built from the source id (a lowercase uuid) and random tokens only, never from anything the admin sent.
 */
export const GUIDE_FILE_MAX_BYTES = 300 * 1024 * 1024;
/** an upload that sends nothing for this long is cut off (a stalled client must not hold the source's lock) */
export const GUIDE_FILE_IDLE_MS = 60_000;
/** what the card shows of the uploaded name; longer ones are cut */
const MAX_LABEL = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xml(?:\.gz)?$/;
/** a pending or part file of some guide (the boot sweep and a guide's delete) */
const PENDING_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pending\.(?:xml(?:\.gz)?|(?:[0-9a-f]{24}\.)?part)$/;

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
const partPath = (ctx: Pick<Ctx, 'cfg'>, id: string) => join(guideDir(ctx), `${own(id)}.pending.${randomBytes(12).toString('hex')}.part`);

/** the uploaded name as the card shows it: the last path segment, without control characters, cut; null when nothing is left */
export function fileLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  // control characters, zero-width and direction marks: a name must not hide or reorder what the card shows
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return clean ? [...clean].slice(0, MAX_LABEL).join('') : null;
}

/** the `x-ff-file-name` header (percent-encoded UTF-8) as a raw name for fileLabel; undefined when absent or not decodable */
export function fileNameHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4096) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

/** a received upload, waiting for its import */
export interface PendingFile { path: string; gz: boolean; bytes: number; sha256: string }
/** `lost` = the caller's lock could not be renewed (another upload or refresh may own the source now); `gone` = the guide was deleted */
export type ReceiveError = 'too_large' | 'empty' | 'broken' | 'idle' | 'lost' | 'gone';

class Refused extends Error {
  constructor(readonly code: ReceiveError) { super(code); }
}

/**
 * Streams an upload to its own `<id>.pending.<token>.part` (created exclusively; hashed and counted on the way; more than `max` bytes
 * stop it), then renames it to `<id>.pending.xml[.gz]` by its first two bytes. Any failure leaves no part file. `renew` (the caller's
 * lock) is called about every 30 s while bytes arrive and once more before the rename: false or a failure stops the upload (`lost`),
 * so a pending file is only ever written under the lock. Nothing for `idleMs` stops it too (`idle`).
 */
export async function receiveGuideFile(
  ctx: Pick<Ctx, 'cfg'>, id: string, body: Readable, o: { max?: number; idleMs?: number; renew?: () => Promise<boolean> } = {},
): Promise<PendingFile | { error: ReceiveError }> {
  const max = o.max ?? GUIDE_FILE_MAX_BYTES;
  const idleMs = o.idleMs ?? GUIDE_FILE_IDLE_MS;
  const held = async () => (o.renew ? await o.renew().catch(() => false) : true);
  await mkdir(guideDir(ctx), { recursive: true, mode: 0o700 });
  const part = partPath(ctx, id);
  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  let last = Date.now();
  let idle: NodeJS.Timeout | undefined;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      armIdle();
      bytes += chunk.length;
      if (bytes > max) { done(new Refused('too_large')); return; }
      if (head.length < 2) head = Buffer.concat([head, chunk.subarray(0, 2)]);
      hash.update(chunk);
      if (o.renew && Date.now() - last > 30_000) {
        last = Date.now();
        void held().then((ok) => done(ok ? null : new Refused('lost'), ok ? chunk : undefined));
        return;
      }
      done(null, chunk);
    },
  });
  function armIdle() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => count.destroy(new Refused('idle')), idleMs);
    idle.unref();
  }
  armIdle();
  try {
    await pipeline(body, count, createWriteStream(part, { mode: 0o600, flags: 'wx' }));
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    return { error: e instanceof Refused ? e.code : 'broken' };
  } finally {
    clearTimeout(idle);
  }
  try {
    if (bytes === 0) throw new Refused('empty');
    if (!(await held())) throw new Refused('lost');
    const gz = head[0] === 0x1f && head[1] === 0x8b;
    const path = pendingPath(ctx, id, gz);
    await rm(pendingPath(ctx, id, !gz), { force: true }); // an older pending file of the other kind
    await rename(part, path);
    return { path, gz, bytes, sha256: hash.digest('hex') };
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined);
    // the guide's delete removed the part file meanwhile: the rename finds nothing
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { error: 'gone' };
    return { error: e instanceof Refused ? e.code : 'broken' };
  }
}

/** the pending file becomes the guide's file (`<id>.xml[.gz]`, its stored name answered); the other kind stays until removeOtherKind */
export async function promoteGuideFile(ctx: Pick<Ctx, 'cfg'>, id: string, p: PendingFile): Promise<string> {
  const name = storedName(id, p.gz);
  await rename(p.path, storedPath(ctx, name));
  return name;
}

/** after `guide_file` names the promoted file: a stored file of the other kind (an older upload) goes */
export async function removeOtherKind(ctx: Pick<Ctx, 'cfg'>, id: string, current: string): Promise<void> {
  const other = storedName(id, !current.endsWith('.gz'));
  if (other !== current) await rm(storedPath(ctx, other), { force: true });
}

/** a pending file whose import failed: it goes, the guide's current file stays */
export async function dropPendingFile(p: PendingFile): Promise<void> {
  await rm(p.path, { force: true });
}

/** every file of the guide (current, pending, parts): a deleted guide, or an upload for a guide deleted meanwhile */
export async function removeGuideFiles(ctx: Pick<Ctx, 'cfg'>, id: string): Promise<void> {
  const prefix = `${own(id)}.pending.`;
  const names = await readdir(guideDir(ctx)).catch(() => [] as string[]);
  const pending = names.filter((n) => n.startsWith(prefix) && PENDING_RE.test(n)).map((n) => join(guideDir(ctx), n));
  for (const p of [storedName(id, false), storedName(id, true)].map((n) => storedPath(ctx, n)).concat(pending)) {
    await rm(p, { force: true });
  }
}

/**
 * At boot: pending and part files are left over from a crash or a restart mid-upload. Only `*.pending*` files of the guide directory
 * go (the stored files stay), and only of guides whose single-flight lock is not held (`busy`): another backend may be receiving or
 * importing one right now. A lock left by a crash expires after 15 min; its files then go with the guide's next upload, its delete or
 * the next start. Answers how many went.
 */
export async function sweepPendingGuideFiles(ctx: Pick<Ctx, 'cfg'>, busy: (id: string) => Promise<boolean>): Promise<number> {
  const names = await readdir(guideDir(ctx)).catch(() => [] as string[]);
  let n = 0;
  for (const name of names) {
    if (!PENDING_RE.test(name) || (await busy(name.slice(0, 36)))) continue;
    await rm(join(guideDir(ctx), name), { force: true }).then(() => { n++; }, () => undefined);
  }
  return n;
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
