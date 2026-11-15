// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 3 Task 6: the Jellyfin library folder (spec §15.3). Real files in temporary folders: a recording folder as the recorder leaves
 * it, and an empty "library" folder standing in for the overlay's `/library` mount.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_BUDGET_MS, Library, LibraryError, MARKER, sanitizeName } from '../src/library.js';
import { recordingPlaylist } from '../src/recorder.js';
import { createRun, type Run, type RunOptions } from '../src/run.js';
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
/**
 * ffmpeg as the tests need it without one: the concat list's runs, byte for byte, into the output; ffprobe answers `probed` seconds
 * (default: what the playlist says); a decode check answers `decodes`. `calls` keeps what was asked.
 */
const fake = { probed: null as number | null, decodes: true, remux: 0, calls: [] as string[][], opts: [] as RunOptions[], beforeRemux: null as null | (() => void) };
/** what a child reads as its input file: `/proc/self/fd/0` is the descriptor it was handed as stdin, anything else a path */
const input = (path: string, o: RunOptions) => {
  if (path !== '/proc/self/fd/0') return readFileSync(path);
  const b = Buffer.alloc(fstatSync(o.stdinFd!).size);
  readSync(o.stdinFd!, b, 0, b.length, 0);
  return b;
};
const fakeRun: Run = async (cmd, args, o) => {
  fake.calls.push([cmd, ...args]);
  fake.opts.push(o);
  const ok = (stdout = '') => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' });
  if (cmd === 'ffprobe') {
    const list = input(args.at(-1)!, o).length / 188; // the fixtures are 188-byte packets of 4 s each (an init counts as nothing)
    return ok(`${fake.probed ?? Math.floor(list) * 4}\n`);
  }
  if (args.includes('concat')) {
    fake.beforeRemux?.();
    if (fake.remux) return { code: fake.remux, stdout: Buffer.alloc(0), stderr: 'x' };
    const list = args[args.indexOf('-i') + 1]!;
    const dir = list.slice(0, list.lastIndexOf('/'));
    const runs = [...readFileSync(list, 'utf8').matchAll(/^file '([^']+)'$/gm)].map((m) => readFileSync(join(dir, m[1]!)));
    // pipe:1 goes to the descriptor the child was handed as stdout; anything else is a path ffmpeg opens itself (following links)
    if (args.at(-1) === 'pipe:1') writeSync(o.stdoutFd!, Buffer.concat(runs));
    else writeFileSync(args.at(-1)!, Buffer.concat(runs));
    return ok();
  }
  return fake.decodes ? ok() : { code: 69, stdout: Buffer.alloc(0), stderr: 'x' };
};
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof LibraryError ? e.code : String(e); } };

beforeEach(() => {
  recRoot = mkdtempSync(join(tmpdir(), 'ltv-recroot-'));
  libRoot = mkdtempSync(join(tmpdir(), 'ltv-library-'));
  logs.length = 0;
  Object.assign(fake, { probed: null, decodes: true, remux: 0, calls: [], opts: [], beforeRemux: null });
  lib = new Library({ root: libRoot, recordingsRoot: recRoot, log: (m) => logs.push(m), run: fakeRun });
});
afterEach(() => {
  rmSync(recRoot, { recursive: true, force: true });
  rmSync(libRoot, { recursive: true, force: true });
});

describe('the library export', () => {
  it('export remuxes ts / fmp4 without re-encoding, one run per init', async () => {
    const ts = recording();
    const a = await lib.export(ID, { dir: DIR, folder: 'Sternstunde Physik', file: 'Sternstunde Physik – 2026-11-15 20.58' });
    expect(a).toEqual({ path: 'Sternstunde Physik/Sternstunde Physik – 2026-11-15 20.58.ts', bytes: 3 * 188 });
    expect(readFileSync(join(libRoot, a.path))).toEqual(Buffer.concat(ts));
    expect(existsSync(join(libRoot, MARKER))).toBe(true); // first use marks the folder as FriendFlix's
    // the same name again: a numbered file, never an overwrite
    const b = await lib.export(ID, { dir: DIR, folder: 'Sternstunde Physik', file: 'Sternstunde Physik – 2026-11-15 20.58' });
    expect(b.path).toBe('Sternstunde Physik/Sternstunde Physik – 2026-11-15 20.58 (2).ts');
    // fMP4 (B-I8): each init with its own fragments as a run (init 1 starts at segment 2), the runs remuxed into one .ts
    const dir2 = '0f000000-0000-4000-a000-0000000000d2';
    const mp4 = recording({ fmp4: true, dir: dir2 });
    const c = await lib.export(ID, { dir: dir2, folder: 'Die Leuchtturmwärter', file: 'Folge 1' });
    expect(c.path).toBe('Die Leuchtturmwärter/Folge 1.ts');
    expect(readFileSync(join(libRoot, c.path))).toEqual(Buffer.concat([mp4[0]!, mp4[1]!, mp4[2]!, Buffer.from('INIT1'), mp4[3]!]));
    expect(readdirSync(join(libRoot, 'Die Leuchtturmwärter'))).toEqual(['Folge 1.ts']); // no part file left
    expect(readdirSync(join(recRoot, dir2)).filter((n) => n.startsWith('.'))).toEqual([]); // nor the runs
    // removing goes through the same names; the folder goes with its last file
    await lib.remove(ID, c.path);
    expect(existsSync(join(libRoot, 'Die Leuchtturmwärter'))).toBe(false);
    expect(await code(lib.remove(ID, c.path))).toBe('not_found');
    expect(logs.join('\n')).not.toMatch(/Sternstunde|Leuchtturm|ltv-/);
  });

  it('B-I8: a file that fails the check is never kept, and the recording stays', async () => {
    recording({ n: 3 });
    const before = readdirSync(join(recRoot, DIR)).sort();
    const at = { dir: DIR, folder: 'Hafenkanal', file: 'Nacht' };
    fake.probed = 6; // 12 s recorded, 6 s in the file: something got lost
    expect(await code(lib.export(ID, at))).toBe('verify_failed');
    fake.probed = 12.5; // within the tolerance, but the end does not decode
    fake.decodes = false;
    expect(await code(lib.export(ID, at))).toBe('verify_failed');
    fake.decodes = true;
    fake.remux = 1;
    expect(await code(lib.export(ID, at))).toBe('export_failed');
    for (const [k, n] of [['library', readdirSync(join(libRoot, 'Hafenkanal'))], ['recording', readdirSync(join(recRoot, DIR)).sort()]] as const) {
      expect(n, k).toEqual(k === 'library' ? [] : before);
    }
    fake.remux = 0;
    expect((await lib.export(ID, at)).path).toBe('Hafenkanal/Nacht.ts');
    // ffmpeg only ever reads the local runs, and checks start and end
    const remux = fake.calls.find((c) => c.includes('concat'))!;
    expect(remux.slice(remux.indexOf('-protocol_whitelist'), remux.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file']);
    expect(remux).toEqual(expect.arrayContaining(['-c', 'copy', '-map', '0']));
    expect(fake.calls.filter((c) => c[0] === 'ffmpeg' && c.includes('null')).slice(-2).map((c) => c.includes('-sseof'))).toEqual([false, true]);
  });

  it('N1: a link planted at the part file while the export runs is never written through', async () => {
    recording({ n: 3 });
    const outside = mkdtempSync(join(tmpdir(), 'ltv-outside-'));
    writeFileSync(join(outside, 'fremd.ts'), 'somebody else\'s recording');
    const part = join(libRoot, 'Hafenkanal', '.Nacht.ts.part');
    fake.beforeRemux = () => { rmSync(part); symlinkSync(join(outside, 'fremd.ts'), part); };
    expect(await code(lib.export(ID, { dir: DIR, folder: 'Hafenkanal', file: 'Nacht' }))).toBe('write_failed');
    expect(readFileSync(join(outside, 'fremd.ts'), 'utf8')).toBe('somebody else\'s recording');
    expect(readdirSync(join(libRoot, 'Hafenkanal'))).toEqual([]); // neither the link nor a file under the final name
    // ffmpeg is handed the part file as a descriptor livetv opened (O_NOFOLLOW), and reads it back through that descriptor
    const remux = fake.calls.find((c) => c.includes('concat'))!;
    expect(remux.at(-1)).toBe('pipe:1');
    expect(fake.calls.filter((c) => !c.includes('concat')).flatMap((c) => c.filter((a) => a.includes('Hafenkanal')))).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('N2: without room for the copy and the file on both volumes the export is refused before anything is written', async () => {
    recording({ n: 3 }); // 3 × 188 bytes
    const GiB = 1024 ** 3;
    const size = 3 * 188;
    const free = new Map<string, number>();
    const at = { dir: DIR, folder: 'Hafenkanal', file: 'Nacht' };
    const tight = new Library({
      root: libRoot, recordingsRoot: recRoot, run: fakeRun,
      // the two temp folders sit on one volume here; the seam answers per volume as if they were two
      free: async (p) => free.get(p.startsWith(recRoot) ? 'rec' : 'lib') ?? null, sameVolume: async () => false,
    });
    // the recordings volume keeps the copy, its margin (1 GiB or 2 %) and the 2 GiB running recordings need
    free.set('rec', size + GiB + 2 * GiB - 1).set('lib', 100 * GiB);
    expect(await code(tight.export(ID, at))).toBe('storage_full');
    free.set('rec', 100 * GiB).set('lib', size + GiB - 1);
    expect(await code(tight.export(ID, at))).toBe('storage_full');
    expect(readdirSync(libRoot).filter((n) => n !== MARKER)).toEqual([]); // no folder, no part file
    expect(readdirSync(join(recRoot, DIR)).filter((n) => n.startsWith('.'))).toEqual([]); // no staging copy
    expect(fake.calls).toEqual([]);
    free.set('lib', size + GiB);
    expect((await tight.export(ID, at)).path).toBe('Hafenkanal/Nacht.ts');
    // one volume for both: it needs room for both
    const one = new Library({ root: libRoot, recordingsRoot: recRoot, run: fakeRun, free: async () => 2 * size + 2 * GiB + 2 * GiB - 1, sameVolume: async () => true });
    expect(await code(one.export(ID, at))).toBe('storage_full');
  });

  it('N3: copy, remux and checks share one time budget; past it the export stops and leaves nothing', async () => {
    recording({ n: 3 });
    const at = { dir: DIR, folder: 'Hafenkanal', file: 'Nacht' };
    const timed = new Library({ root: libRoot, recordingsRoot: recRoot, run: fakeRun, budgetMs: 60_000 });
    await timed.export(ID, at);
    expect(fake.opts.map((o) => o.timeoutMs).every((t) => t > 0 && t <= 60_000)).toBe(true);
    // a budget spent in the copy: nothing is started, nothing stays
    fake.calls.length = 0;
    const spent = new Library({ root: libRoot, recordingsRoot: recRoot, run: fakeRun, budgetMs: 0 });
    expect(await code(spent.export(ID, at))).toBe('export_failed');
    expect(fake.calls).toEqual([]);
    expect(readdirSync(join(libRoot, 'Hafenkanal'))).toEqual(['Nacht.ts']);
    expect(readdirSync(join(recRoot, DIR)).filter((n) => n.startsWith('.'))).toEqual([]);
    // the default budget stays below the backend's wait (recstore.ts EXPORT_TIMEOUT_MS, 30 min) with room to spare
    expect(EXPORT_BUDGET_MS).toBeLessThanOrEqual(25 * 60_000);
  });

  it.skipIf(!existsSync('/usr/bin/ffmpeg') || !existsSync('/usr/bin/ffprobe'))('B-I8: a recording whose init changes mid-way exports as one file that decodes, both pictures in it', async () => {
    const dir = join(recRoot, DIR);
    mkdirSync(dir, { recursive: true });
    const gen = (src: string, size: string, init: number, start: number) => {
      const r = spawnSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `${src}=size=${size}:rate=25:duration=${start ? 4 : 6}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', `init-${init}.mp4`, '-start_number', String(start), '-hls_segment_filename', join(dir, '%d.m4s'), join(dir, `gen-${init}.m3u8`)]);
      expect(r.status, r.stderr?.toString()).toBe(0);
      rmSync(join(dir, `gen-${init}.m3u8`));
    };
    gen('testsrc', '320x240', 0, 0);
    gen('testsrc2', '480x360', 1, 3);
    const entries = [0, 1, 2, 3, 4].map((seq) => ({ seq, ext: 'm4s' as const, duration: 2, pdt: T0 + seq * 2000, disc: seq === 3, init: seq < 3 ? 0 : 1 }));
    writeFileSync(join(dir, 'index.m3u8'), recordingPlaylist(entries, true));
    const real = new Library({ root: libRoot, recordingsRoot: recRoot, run: createRun({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' }) });
    const a = await real.export(ID, { dir: DIR, folder: 'Sternwarte 24', file: 'Wechsel' });
    expect(a.path).toBe('Sternwarte 24/Wechsel.ts');
    const file = join(libRoot, a.path);
    const dec = spawnSync('/usr/bin/ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-']);
    expect([dec.status, dec.stderr.toString()]).toEqual([0, '']);
    const probe = spawnSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'frame=width', '-select_streams', 'v', '-of', 'csv=p=0', file]);
    expect(new Set(probe.stdout.toString().trim().split('\n').map((w) => w.replace(/,$/, '')))).toEqual(new Set(['320', '480']));
    const d = Number(spawnSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString());
    expect(Math.abs(d - 10)).toBeLessThan(1);
  }, 60_000);

  it('A-M6: a long name numbered " (2)" stays within the limit and can be removed again', async () => {
    recording();
    const at = { dir: DIR, folder: 'Sternwarte 24', file: 'Sternstunde Physik '.repeat(20) };
    await lib.export(ID, at);
    const b = await lib.export(ID, at);
    expect(b.path).toMatch(/ \(2\)\.ts$/);
    expect([...b.path.split('/')[1]!].length).toBeLessThanOrEqual(120);
    await lib.remove(ID, b.path);
    expect(existsSync(join(libRoot, b.path))).toBe(false);
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
