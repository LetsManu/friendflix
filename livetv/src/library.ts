// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Log } from './log.js';
import { DIR_RE, parseRecordingPlaylist } from './recorder.js';

/**
 * The Jellyfin library folder (spec §15.3, plan Phase 3 Task 6): the opt-in overlay `compose.livetv-library.yaml` mounts ONE dedicated
 * sub-folder of the media share at `/library`, read-write. livetv concatenates a finished recording's segments without re-encoding into
 * `/library/<folder>/<file>.ts` (TS segments) or `.mp4` (fMP4: the init, then the fragments), and removes such a file again when the
 * backend deletes the recording. It never follows or creates a link: every path is built below `/library` from sanitised names,
 * opened with O_NOFOLLOW and checked with realpath. A marker `.friendflix-recordings` proves the folder is dedicated: a folder that
 * is not empty and has no marker refuses every export (`library_not_dedicated`, a mount of the whole media share by mistake).
 * Logs name the recording id and fixed codes only, never a title or a path.
 */
export const MARKER = '.friendflix-recordings';
export const NAME_MAX = 120;

export class LibraryError extends Error {
  constructor(readonly code: 'no_library' | 'library_not_writable' | 'library_not_dedicated' | 'not_found' | 'invalid' | 'storage_full' | 'write_failed') { super(code); }
}

/** a file or folder name livetv may create: no `/`, `\`, `..`, control characters or leading dots, at most 120 characters; '' = unusable */
export function sanitizeName(raw: string): string {
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[/\\]+/g, '-').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  return [...s].slice(0, NAME_MAX).join('').trim();
}

export interface LibraryFacts { mounted: boolean; writable: boolean; dedicated: boolean; freeBytes: number | null }

const code = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

export class Library {
  constructor(private readonly o: { root: string; recordingsRoot: string; log?: Log }) {}

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
   * Concatenates the recording in `/recordings/<dir>/` (its playlist order) into `/library/<folder>/<file>.<ts|mp4>` without re-encoding;
   * an existing file of that name gets " (2)" … " (9)". Answers the path relative to the library and the bytes written.
   */
  async export(id: string, b: { dir: string; folder: string; file: string }): Promise<{ path: string; bytes: number }> {
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
    const fmp4 = entries.some((e) => e.ext === 'm4s');
    const ext = fmp4 ? 'mp4' : 'ts';
    const root = await this.guardedRoot();
    const dir = await this.folder(root, folderName);
    let name = '';
    for (let i = 1; i <= 9 && !name; i++) {
      const candidate = `${[...fileName].slice(0, NAME_MAX - 5).join('')}${i > 1 ? ` (${i})` : ''}.${ext}`;
      if (!(await lstat(join(dir, candidate)).catch(() => null))) name = candidate;
    }
    if (!name) throw new LibraryError('invalid');
    const part = join(dir, `.${name}.part`);
    let bytes = 0;
    let out;
    try {
      out = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    } catch (e) {
      if (code(e) === 'EACCES' || code(e) === 'EROFS' || code(e) === 'EPERM') throw new LibraryError('library_not_writable');
      throw e;
    }
    try {
      // fMP4: the first init, then every fragment (a recording's later init versions describe the same tracks)
      const first = entries.find((e) => e.init !== null)?.init;
      const files = [...(fmp4 && first !== undefined && first !== null ? [`init-${first}.mp4`] : []), ...entries.map((e) => `${e.seq}.${e.ext}`)];
      for (const f of files) {
        const data = await readFileNoFollow(join(src, f));
        if (data === null) continue; // a segment the recorder never finished: left out
        await out.write(data);
        bytes += data.length;
      }
      await out.close();
      out = null;
      await rename(part, join(dir, name));
    } catch (e) {
      if (out) await out.close().catch(() => undefined);
      await rm(part, { force: true }).catch(() => undefined);
      if (e instanceof LibraryError) throw e;
      throw new LibraryError(code(e) === 'ENOSPC' || code(e) === 'EDQUOT' ? 'storage_full' : 'write_failed');
    }
    this.o.log?.(`recording ${id} exported to the library`);
    return { path: `${folderName}/${name}`, bytes };
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
