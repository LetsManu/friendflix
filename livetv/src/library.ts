// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Log } from './log.js';
import { DIR_RE, parseRecordingPlaylist } from './recorder.js';
import { TIMEOUT_CODE, type Run } from './run.js';

/**
 * The Jellyfin library folder (spec §15.3, plan Phase 3 Task 6): the opt-in overlay `compose.livetv-library.yaml` mounts ONE dedicated
 * sub-folder of the media share at `/library`, read-write. livetv remuxes a finished recording without re-encoding into one MPEG-TS file
 * `/library/<folder>/<file>.ts` (ffmpeg, local files only), and removes such a file again when the
 * backend deletes the recording. It never follows or creates a link: every path is built below `/library` from sanitised names,
 * opened with O_NOFOLLOW and checked with realpath. A marker `.friendflix-recordings` proves the folder is dedicated: a folder that
 * is not empty and has no marker refuses every export (`library_not_dedicated`, a mount of the whole media share by mistake).
 * Logs name the recording id and fixed codes only, never a title or a path.
 */
export const MARKER = '.friendflix-recordings';
export const NAME_MAX = 120;
/**
 * N3: one export's whole time, copy included: the staging copy, the remux, the probe and both decode checks all draw on this one budget
 * (each step gets what is left, the remux and the checks at most their own caps), and the export stops with `export_failed` once it is
 * spent. 25 min < the backend's 30-min wait for the answer (recstore.ts EXPORT_TIMEOUT_MS), so the backend never gives up on an export
 * that still finishes and renames a file no row tracks; the 5 min left cover the request and the rename.
 */
export const EXPORT_BUDGET_MS = 25 * 60_000;
const REMUX_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 2 * 60_000;
/** how far the exported file's duration may be from the playlist's (or 1 % of it, if more) */
export const DURATION_TOLERANCE_S = 2;
/** N2: the least margin an export keeps on each volume beyond the recording's size (or 2 % of it, if more) */
export const EXPORT_MARGIN_MIN = 1024 ** 3;
/** N2: what running recordings keep on the recordings volume (the backend starts none below it: recsched.ts FREE_MIN_BYTES) */
export const RECORDING_RESERVE = 2 * 1024 ** 3;

export class LibraryError extends Error {
  constructor(readonly code: 'no_library' | 'library_not_writable' | 'library_not_dedicated' | 'not_found' | 'invalid' | 'storage_full' | 'write_failed' | 'export_failed' | 'verify_failed') { super(code); }
}

/** a file or folder name livetv may create: no `/`, `\`, `..`, control characters or leading dots, at most 120 characters; '' = unusable */
export function sanitizeName(raw: string): string {
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[/\\]+/g, '-').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  return [...s].slice(0, NAME_MAX).join('').trim();
}

export interface LibraryFacts { mounted: boolean; writable: boolean; dedicated: boolean; freeBytes: number | null }

const code = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

export class Library {
  /**
   * `free`: the bytes a volume has left (default statfs; null = unknown, which never refuses); `sameVolume`: whether the recording folder
   * and the library sit on one volume (default: the same st_dev). Both are seams for the tests.
   */
  constructor(private readonly o: {
    root: string; recordingsRoot: string; log?: Log; run?: Run;
    free?: (path: string) => Promise<number | null>; sameVolume?: (a: string, b: string) => Promise<boolean>;
    /** N3: the time budget of one export (default EXPORT_BUDGET_MS) */
    budgetMs?: number;
  }) {}

  /** what is left of the budget for the next step (at most `cap`); spent = `export_failed` */
  private left(deadline: number, cap: number): number {
    const ms = Math.min(cap, deadline - Date.now());
    if (ms <= 0) throw new LibraryError('export_failed');
    return ms;
  }

  /** `/v1/system.library`: null while the overlay is not on (no `/library`) */
  async facts(): Promise<LibraryFacts | null> {
    const st = await lstat(this.o.root).catch(() => null);
    if (!st?.isDirectory()) return null;
    const writable = await access(this.o.root, constants.W_OK).then(() => true, () => false);
    const names = await readdir(this.o.root).catch(() => [] as string[]);
    const dedicated = names.includes(MARKER) || names.length === 0;
    const free = await statfs(this.o.root).then((s) => Number(s.bavail) * Number(s.bsize), () => null);
    return { mounted: true, writable, dedicated, freeBytes: free };
  }

  /** the real library root after the dedicated-folder guard (the marker is written on first use) */
  private async guardedRoot(): Promise<string> {
    const st = await lstat(this.o.root).catch(() => null);
    if (!st?.isDirectory()) throw new LibraryError('no_library');
    const root = await realpath(this.o.root);
    const names = await readdir(root);
    if (!names.includes(MARKER)) {
      if (names.length) throw new LibraryError('library_not_dedicated');
      try {
        const fh = await open(join(root, MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        await fh.writeFile('FriendFlix Live TV recordings: this folder belongs to FriendFlix.\n');
        await fh.close();
      } catch (e) {
        if (code(e) === 'EEXIST') return root;
        if (code(e) === 'EACCES' || code(e) === 'EROFS' || code(e) === 'EPERM') throw new LibraryError('library_not_writable');
        throw e;
      }
    }
    return root;
  }

  /** a folder directly below the root (created when missing); never a link, its real path stays below the root */
  private async folder(root: string, name: string): Promise<string> {
    const path = join(root, name);
    const st = await lstat(path).catch((e: unknown) => (code(e) === 'ENOENT' ? null : Promise.reject(e)));
    if (st === null) {
      try { await mkdir(path, { mode: 0o755 }); } catch (e) {
        if (code(e) === 'EACCES' || code(e) === 'EROFS' || code(e) === 'EPERM') throw new LibraryError('library_not_writable');
        if (code(e) !== 'EEXIST') throw e;
      }
    } else if (!st.isDirectory()) throw new LibraryError('invalid');
    if ((await realpath(path)) !== path) throw new LibraryError('invalid');
    return path;
  }

  /**
   * Remuxes the recording in `/recordings/<dir>/` (its playlist order, every init version and discontinuity respected) into
   * `/library/<folder>/<file>.ts` without re-encoding (B-I8), and answers only once the file is checked: its duration within
   * DURATION_TOLERANCE_S (or 1 %) of the playlist's, its start and end decode. Any failure leaves no file behind (`export_failed`,
   * `verify_failed`), and the recording folder untouched, so the backend keeps the recording. An existing file of that name gets
   * " (2)" … " (9)". Answers the path relative to the library and the bytes written.
   */
  async export(id: string, b: { dir: string; folder: string; file: string }): Promise<{ path: string; bytes: number }> {
    const deadline = Date.now() + (this.o.budgetMs ?? EXPORT_BUDGET_MS);
    if (!DIR_RE.test(b.dir)) throw new LibraryError('invalid');
    const folderName = sanitizeName(b.folder);
    const fileName = sanitizeName(b.file);
    if (!folderName || !fileName) throw new LibraryError('invalid');
    const recRoot = await realpath(this.o.recordingsRoot).catch(() => null);
    const src = recRoot ? join(recRoot, b.dir) : null;
    const srcSt = src ? await lstat(src).catch(() => null) : null;
    if (!src || !srcSt?.isDirectory()) throw new LibraryError('not_found');
    const text = await readNoFollow(join(src, 'index.m3u8'));
    const entries = text ? parseRecordingPlaylist(text) : [];
    if (!entries.length) throw new LibraryError('not_found');
    const root = await this.guardedRoot();
    await this.roomFor(src, root, entries);
    const dir = await this.folder(root, folderName);
    let name = '';
    // room for " (9)" and the extension: a numbered name stays within NAME_MAX, so remove() takes it back (A-M6)
    for (let i = 1; i <= 9 && !name; i++) {
      const candidate = `${[...fileName].slice(0, NAME_MAX - 9).join('')}${i > 1 ? ` (${i})` : ''}.ts`;
      if (!(await lstat(join(dir, candidate)).catch(() => null))) name = candidate;
    }
    if (!name) throw new LibraryError('invalid');
    const part = join(dir, `.${name}.part`);
    const work = join(src, '.export');
    // the part file is created and opened here, never through a link, and stays open: ffmpeg writes into this descriptor (`pipe:1`) and
    // the checks read it back through it (`/proc/self/fd/0`), so nothing reopens the library path while the export runs (N1)
    const fh = await open(part, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644).catch((e: unknown) => {
      throw new LibraryError(code(e) === 'EACCES' || code(e) === 'EROFS' || code(e) === 'EPERM' ? 'library_not_writable' : 'write_failed');
    });
    let bytes: number;
    try {
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { mode: 0o755 });
      const runs = await writeRuns(src, work, entries, () => this.left(deadline, 1));
      if (!runs.length) throw new LibraryError('not_found');
      await this.remux(work, runs, fh.fd, dir, deadline);
      await this.verify(fh.fd, entries.reduce((n, e) => n + e.duration, 0), deadline);
      // the name still holds the file written (a link or another file swapped in meanwhile is refused, never moved into place)
      const st = await fh.stat();
      const now = await lstat(part).catch(() => null);
      if (!now?.isFile() || now.ino !== st.ino || now.dev !== st.dev) throw new LibraryError('write_failed');
      bytes = st.size;
      await rename(part, join(dir, name));
    } catch (e) {
      await rm(part, { force: true }).catch(() => undefined); // a planted link goes itself, its target is never touched
      if (e instanceof LibraryError) throw e;
      throw new LibraryError(code(e) === 'ENOSPC' || code(e) === 'EDQUOT' ? 'storage_full' : 'write_failed');
    } finally {
      await fh.close().catch(() => undefined);
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
    this.o.log?.(`recording ${id} exported to the library`);
    return { path: `${folderName}/${name}`, bytes };
  }

  /**
   * N2: the export stages a copy of the recording next to it and then writes the file into the library, so before anything is written
   * the recordings volume needs the recording's size, a margin (EXPORT_MARGIN_MIN or 2 %, whichever is more) and the RECORDING_RESERVE
   * that running recordings keep (they have priority); the library volume the size and the margin. One volume for both needs the sum.
   * Too little anywhere: `storage_full`, nothing touched.
   */
  private async roomFor(src: string, root: string, entries: ReturnType<typeof parseRecordingPlaylist>): Promise<void> {
    let size = 0;
    const inits = new Set(entries.flatMap((e) => (e.init === null ? [] : [`init-${e.init}.mp4`])));
    for (const f of [...inits, ...entries.map((e) => `${e.seq}.${e.ext}`)]) size += (await lstat(join(src, f)).catch(() => null))?.size ?? 0;
    const margin = Math.max(EXPORT_MARGIN_MIN, Math.ceil(size * 0.02));
    const free = this.o.free ?? ((p: string) => statfs(p).then((s) => Number(s.bavail) * Number(s.bsize), () => null));
    const same = await (this.o.sameVolume ?? (async (a: string, b: string) => (await lstat(a)).dev === (await lstat(b)).dev))(src, root).catch(() => false);
    const recNeeds = size + margin + RECORDING_RESERVE + (same ? size + margin : 0);
    const recFree = await free(src);
    if (recFree !== null && recFree < recNeeds) throw new LibraryError('storage_full');
    if (same) return;
    const libFree = await free(root);
    if (libFree !== null && libFree < size + margin) throw new LibraryError('storage_full');
  }

  /**
   * One file from the runs without re-encoding (B-I8): ffmpeg's concat demuxer reads every run with its own codec parameters (an init
   * change, a stream restart) and writes one MPEG-TS, which carries parameter changes in-band, to its stdout: the open part file `out`.
   * ffmpeg reads only the local run files.
   */
  private async remux(work: string, runs: string[], out: number, dir: string, deadline: number): Promise<void> {
    if (!this.o.run) throw new LibraryError('export_failed');
    const list = join(work, 'list.txt');
    await writeFile(list, runs.map((r) => `file '${r}'\n`).join(''), { flag: 'wx' });
    const r = await this.o.run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list,
      '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1',
    ], { timeoutMs: this.left(deadline, REMUX_TIMEOUT_MS), stdoutFd: out });
    if (r.code !== 0) throw new LibraryError(r.code === TIMEOUT_CODE ? 'export_failed' : (await enospc(dir)) ? 'storage_full' : 'export_failed');
  }

  /**
   * The file is complete before the recording's FriendFlix copy may go (B-I8): its duration fits and its start and end decode. It is
   * read through the open descriptor `fd` (the child's stdin, opened as `/proc/self/fd/0`: the same file, seekable), never by path.
   */
  private async verify(fd: number, expectedS: number, deadline: number): Promise<void> {
    if (!this.o.run) throw new LibraryError('verify_failed');
    const file = '/proc/self/fd/0';
    const probe = await this.o.run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: this.left(deadline, PROBE_TIMEOUT_MS), stdinFd: fd });
    const duration = Number(probe.stdout.toString('utf8').trim());
    if (probe.code !== 0 || !Number.isFinite(duration) || Math.abs(duration - expectedS) > Math.max(DURATION_TOLERANCE_S, expectedS * 0.01)) throw new LibraryError('verify_failed');
    for (const at of [['-t', '5'], ['-sseof', '-5']]) {
      const pos = at[0] === '-sseof' ? at : [];
      const len = at[0] === '-t' ? at : [];
      const dec = await this.o.run('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file', ...pos, '-i', file, ...len, '-f', 'null', '-'], { timeoutMs: this.left(deadline, PROBE_TIMEOUT_MS), stdinFd: fd });
      if (dec.code !== 0) throw new LibraryError('verify_failed');
    }
  }

  /** removes an exported file (`<folder>/<file>`, as export answered it) and its folder when that is empty now; not_found when gone */
  async remove(id: string, rel: string): Promise<void> {
    const parts = rel.split('/');
    if (parts.length !== 2 || parts.some((p) => !p || p !== sanitizeName(p) || p.startsWith('.')) || !/\.(ts|mp4)$/.test(parts[1]!)) throw new LibraryError('invalid');
    const st0 = await lstat(this.o.root).catch(() => null);
    if (!st0?.isDirectory()) throw new LibraryError('no_library');
    const root = await realpath(this.o.root);
    const dir = join(root, parts[0]!);
    const file = join(dir, parts[1]!);
    const st = await lstat(file).catch(() => null);
    if (!st) throw new LibraryError('not_found');
    if (!st.isFile() || (await realpath(dir)) !== dir) throw new LibraryError('invalid');
    await unlink(file);
    await rmdir(dir).catch(() => undefined); // only when empty
    this.o.log?.(`recording ${id} removed from the library`);
  }
}

async function readNoFollow(path: string): Promise<string | null> {
  const b = await readFileNoFollow(path);
  return b === null ? null : b.toString('utf8');
}
async function readFileNoFollow(path: string): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
  try { return await fh.readFile(); } finally { await fh.close(); }
}

/** whether the disk ran out under ffmpeg (its output is then shorter than it should be; statfs says) */
async function enospc(path: string): Promise<boolean> {
  return statfs(path).then((s) => Number(s.bavail) * Number(s.bsize) < 64 * 1024 * 1024, () => false);
}

/**
 * The recording cut into runs (B-I8): consecutive segments that share an init version and have no discontinuity between them. Each run
 * becomes one file in `work` (fMP4: its init, then its fragments, as `run-<n>.mp4`; TS: its segments as `run-<n>.ts`); a segment the
 * recorder never finished is left out. Answers the run file names.
 */
async function writeRuns(src: string, work: string, entries: ReturnType<typeof parseRecordingPlaylist>, inTime: () => void): Promise<string[]> {
  const runs: Array<typeof entries> = [];
  for (const e of entries) {
    const cur = runs.at(-1);
    const prev = cur?.at(-1);
    if (!cur || !prev || e.disc || e.init !== prev.init || e.ext !== prev.ext) runs.push([e]);
    else cur.push(e);
  }
  const names: string[] = [];
  for (const [i, run] of runs.entries()) {
    const ext = run[0]!.ext === 'm4s' ? 'mp4' : 'ts';
    const name = `run-${i}.${ext}`;
    const out = await open(join(work, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    let wrote = 0;
    try {
      const init = run[0]!.init;
      if (init !== null) {
        const data = await readFileNoFollow(join(src, `init-${init}.mp4`));
        if (data === null) continue; // without its init the run cannot be read: left out
        await out.write(data);
      }
      for (const e of run) {
        inTime(); // N3: the copy counts against the export's budget
        const data = await readFileNoFollow(join(src, `${e.seq}.${e.ext}`));
        if (data === null) continue;
        await out.write(data);
        wrote++;
      }
    } finally {
      await out.close();
    }
    if (wrote) names.push(name);
  }
  return names;
}
