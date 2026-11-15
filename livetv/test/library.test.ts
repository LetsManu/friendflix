// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 3 Task 6: the Jellyfin library folder (spec §15.3). Real files in temporary folders: a recording folder as the recorder leaves
 * it, and an empty "library" folder standing in for the overlay's `/library` mount.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, LibraryError, MARKER, sanitizeName } from '../src/library.js';
import { recordingPlaylist } from '../src/recorder.js';
import { recordingRoutes } from '../src/routes/recordings.js';
import type { Recorder } from '../src/recorder.js';

const ID = '0f000000-0000-4000-a000-000000000001';
const DIR = '0f000000-0000-4000-a000-0000000000d1';
const T0 = Date.parse('2026-11-15T19:58:00.000Z');
let recRoot = '';
let libRoot = '';
let lib: Library;
const logs: string[] = [];

function recording(o: { fmp4?: boolean; n?: number; dir?: string } = {}): Buffer[] {
  const dir = join(recRoot, o.dir ?? DIR);
  mkdirSync(dir, { recursive: true });
  const ext = o.fmp4 ? 'm4s' : 'ts';
  const parts: Buffer[] = [];
  if (o.fmp4) {
    writeFileSync(join(dir, 'init-0.mp4'), 'INIT0');
    writeFileSync(join(dir, 'init-1.mp4'), 'INIT1');
    parts.push(Buffer.from('INIT0'));
  }
  const entries = Array.from({ length: o.n ?? 3 }, (_, i) => ({ seq: i, ext: ext as 'ts' | 'm4s', duration: 4, pdt: T0 + i * 4000, disc: false, init: o.fmp4 ? (i < 2 ? 0 : 1) : null }));
  for (const e of entries) {
    const b = Buffer.alloc(188, e.seq + 1);
    writeFileSync(join(dir, `${e.seq}.${ext}`), b);
    parts.push(b);
  }
  writeFileSync(join(dir, 'index.m3u8'), recordingPlaylist(entries, true));
  return parts;
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof LibraryError ? e.code : String(e); } };

beforeEach(() => {
  recRoot = mkdtempSync(join(tmpdir(), 'ltv-recroot-'));
  libRoot = mkdtempSync(join(tmpdir(), 'ltv-library-'));
  logs.length = 0;
  lib = new Library({ root: libRoot, recordingsRoot: recRoot, log: (m) => logs.push(m) });
});
afterEach(() => {
  rmSync(recRoot, { recursive: true, force: true });
  rmSync(libRoot, { recursive: true, force: true });
});

describe('the library export', () => {
  it('export concatenates ts / fmp4 without re-encoding', async () => {
    const ts = recording();
    const a = await lib.export(ID, { dir: DIR, folder: 'Sternstunde Physik', file: 'Sternstunde Physik – 2026-11-15 20.58' });
    expect(a).toEqual({ path: 'Sternstunde Physik/Sternstunde Physik – 2026-11-15 20.58.ts', bytes: 3 * 188 });
    expect(readFileSync(join(libRoot, a.path))).toEqual(Buffer.concat(ts));
    expect(existsSync(join(libRoot, MARKER))).toBe(true); // first use marks the folder as FriendFlix's
    // the same name again: a numbered file, never an overwrite
    const b = await lib.export(ID, { dir: DIR, folder: 'Sternstunde Physik', file: 'Sternstunde Physik – 2026-11-15 20.58' });
    expect(b.path).toBe('Sternstunde Physik/Sternstunde Physik – 2026-11-15 20.58 (2).ts');
    // fMP4: the init, then the fragments, as .mp4
    const dir2 = '0f000000-0000-4000-a000-0000000000d2';
    const mp4 = recording({ fmp4: true, dir: dir2 });
    const c = await lib.export(ID, { dir: dir2, folder: 'Die Leuchtturmwärter', file: 'Folge 1' });
    expect(c.path).toBe('Die Leuchtturmwärter/Folge 1.mp4');
    expect(readFileSync(join(libRoot, c.path))).toEqual(Buffer.concat(mp4));
    expect(readdirSync(join(libRoot, 'Die Leuchtturmwärter'))).toEqual(['Folge 1.mp4']); // no part file left
    // removing goes through the same names; the folder goes with its last file
    await lib.remove(ID, c.path);
    expect(existsSync(join(libRoot, 'Die Leuchtturmwärter'))).toBe(false);
    expect(await code(lib.remove(ID, c.path))).toBe('not_found');
    expect(logs.join('\n')).not.toMatch(/Sternstunde|Leuchtturm|ltv-/);
  });

  it('refuses a non-empty unmarked folder', async () => {
    recording();
    writeFileSync(join(libRoot, 'Film.mkv'), 'a film of the media share');
    expect(await code(lib.export(ID, { dir: DIR, folder: 'X', file: 'Y' }))).toBe('library_not_dedicated');
    expect(await lib.facts()).toMatchObject({ mounted: true, writable: true, dedicated: false });
    expect(readdirSync(libRoot)).toEqual(['Film.mkv']);
    // an empty folder is fine, and a marked one with files of FriendFlix too
    rmSync(join(libRoot, 'Film.mkv'));
    expect(await lib.facts()).toMatchObject({ dedicated: true });
    await lib.export(ID, { dir: DIR, folder: 'X', file: 'Y' });
    expect(await lib.facts()).toMatchObject({ dedicated: true });
    // no overlay: no library
    const none = new Library({ root: join(libRoot, 'missing'), recordingsRoot: recRoot });
    expect(await none.facts()).toBeNull();
    expect(await code(none.export(ID, { dir: DIR, folder: 'X', file: 'Y' }))).toBe('no_library');
  });

  it('sanitises names and never follows a symlink', async () => {
    expect(sanitizeName('../../etc/passwd')).toBe('-.-etc-passwd');
    expect(sanitizeName('..')).toBe('');
    expect(sanitizeName('a\u0000b\nc')).toBe('a b c');
    expect(sanitizeName('.versteckt')).toBe('versteckt');
    expect([...sanitizeName('x'.repeat(300))]).toHaveLength(120);
    recording();
    const a = await lib.export(ID, { dir: DIR, folder: '../Hafen/kanal', file: 'Nacht\u0007 /etc' });
    expect(a.path).toBe('-Hafen-kanal/Nacht -etc.ts');
    expect(await code(lib.export(ID, { dir: DIR, folder: '..', file: 'x' }))).toBe('invalid');
    // a link planted as the series folder (pointing out of the library) is never written through
    const outside = mkdtempSync(join(tmpdir(), 'ltv-outside-'));
    symlinkSync(outside, join(libRoot, 'Sternwarte'));
    expect(await code(lib.export(ID, { dir: DIR, folder: 'Sternwarte', file: 'x' }))).toBe('invalid');
    expect(readdirSync(outside)).toEqual([]);
    // nor a link as the recording folder or as a file to remove
    symlinkSync(outside, join(recRoot, '0f000000-0000-4000-a000-0000000000d9'));
    expect(await code(lib.export(ID, { dir: '0f000000-0000-4000-a000-0000000000d9', folder: 'A', file: 'B' }))).toBe('not_found');
    writeFileSync(join(outside, 'keep.ts'), 'keep');
    mkdirSync(join(libRoot, 'Box'));
    symlinkSync(join(outside, 'keep.ts'), join(libRoot, 'Box', 'keep.ts'));
    expect(await code(lib.remove(ID, 'Box/keep.ts'))).toBe('invalid');
    expect(existsSync(join(outside, 'keep.ts'))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('paths stay below /library', async () => {
    for (const p of ['../x.ts', 'a/../../x.ts', '/etc/x.ts', 'a/b/c.ts', 'a', 'a/.x.ts.part', 'a/b.mkv', '']) expect(await code(lib.remove(ID, p)), p).toBe('invalid');
    expect(await code(lib.export(ID, { dir: '../x', folder: 'A', file: 'B' }))).toBe('invalid');
  });

  it('the routes: export of a running recording is refused, errors are fixed codes', async () => {
    recording();
    let running = true;
    const rec = { list: () => (running ? [{ id: ID, state: 'recording' }] : []) } as unknown as Recorder;
    const routes = recordingRoutes(rec, { library: lib });
    const call = (path: string, json: unknown) => {
      const r = routes.find((x) => x.method === 'POST' && typeof x.path !== 'string' && x.path.test(path))!;
      const params = (r.path as RegExp).exec(path)!.slice(1);
      return r.handle({ req: {} as never, res: {} as never, params, json });
    };
    expect(await call(`/v1/recordings/${ID}/export`, { dir: DIR, folder: 'A', file: 'B' })).toEqual({ status: 409, json: { error: 'recording' } });
    running = false;
    expect(await call(`/v1/recordings/${ID}/export`, { dir: DIR, folder: 'A', file: 'B' })).toEqual({ status: 200, json: { path: 'A/B.ts', bytes: 564 } });
    expect(await call(`/v1/recordings/${ID}/library-delete`, { path: 'A/../B.ts' })).toEqual({ status: 400, json: { error: 'invalid', field: 'path' } });
    expect(await call(`/v1/recordings/${ID}/library-delete`, { path: 'A/B.ts' })).toEqual({ status: 204 });
    expect(await call(`/v1/recordings/${ID}/library-delete`, { path: 'A/B.ts' })).toEqual({ status: 404, json: { error: 'not_found' } });
    writeFileSync(join(libRoot, 'fremd.txt'), 'x');
    rmSync(join(libRoot, MARKER));
    expect(await call(`/v1/recordings/${ID}/export`, { dir: DIR, folder: 'A', file: 'B' })).toEqual({ status: 409, json: { error: 'library_not_dedicated' } });
  });
});
