// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StepError } from '../src/docker.js';
import { EngineError, type Engine } from '../src/mediaserver/engine.js';
import { TemplateViolation } from '../src/mediaserver/guard.js';
import { cleanupHelpers, runHdr, runHelper } from '../src/mediaserver/helpers.js';
import { hdrSpec, helperSpec } from '../src/mediaserver/template.js';
import { browseDir, checkBase, checkData, checkFolders, detectGpu, main } from '../src/mediaHelper.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ff-helper-')); });
afterEach(() => { try { chmodSync(join(root, 'zu'), 0o755); } catch { /* none */ } rmSync(root, { recursive: true, force: true }); });

const isRoot = process.getuid?.() === 0;

describe('mediaHelper functions', () => {
  it('browse lists directories only, flags symlinks and unreadable ones', () => {
    for (const d of ['Filme', 'Serien', '.hidden', 'zu']) mkdirSync(join(root, d));
    writeFileSync(join(root, 'notiz.txt'), 'x');
    symlinkSync('/etc', join(root, 'link'));
    chmodSync(join(root, 'zu'), 0o000);
    const r = browseDir(root, '');
    expect(r.truncated).toBe(false);
    expect(r.entries).toEqual([
      { name: 'Filme', symlink: false, unreadable: false },
      { name: 'link', symlink: true, unreadable: false },
      { name: 'Serien', symlink: false, unreadable: false },
      { name: 'zu', symlink: false, unreadable: !isRoot },
    ]);
    expect(browseDir(root, 'Filme')).toEqual({ entries: [], truncated: false });
  });

  it('browse caps at 300 entries and refuses a bad or symlinked rel', () => {
    for (let i = 0; i < 301; i++) mkdirSync(join(root, `d${String(i).padStart(3, '0')}`));
    symlinkSync('/etc', join(root, 'zlink'));
    const r = browseDir(root, '');
    expect(r.entries).toHaveLength(300);
    expect(r.truncated).toBe(true);
    expect(() => browseDir(root, '../x')).toThrow('invalid_body');
    expect(() => browseDir(root, 'a/b/c')).toThrow('invalid_body');
    expect(() => browseDir(root, 'zlink')).toThrow('folder_symlink');
    expect(() => browseDir(root, 'nope')).toThrow('folder_missing');
  });

  it('checkFolders reports each code', () => {
    mkdirSync(join(root, 'Filme', 'Neu'), { recursive: true });
    writeFileSync(join(root, 'Filme', 'a.txt'), 'x');
    symlinkSync('/etc', join(root, 'Kinder'));
    mkdirSync(join(root, 'Real'));
    symlinkSync(join(root, 'Real'), join(root, 'Via'));
    const r = checkFolders(root, ['Filme', 'Weg', 'Kinder', 'Via/Neu', 'Filme/Neu']);
    expect(r.map((x) => [x.rel, x.code])).toEqual([
      ['Filme', 'ok'], ['Weg', 'folder_missing'], ['Kinder', 'folder_symlink'], ['Via/Neu', 'folder_symlink'], ['Filme/Neu', 'ok'],
    ]);
    expect(r[0]).toMatchObject({ read: true, watch: true, maxWatches: null });
    expect(r[1]).toEqual({ rel: 'Weg', code: 'folder_missing', read: false, watch: false, maxWatches: null });
  });

  it('checkBase flags a system root and a Docker root', () => {
    const mk = (names: string[]): string => {
      const d = mkdtempSync(join(root, 'b-'));
      for (const n of names) mkdirSync(join(d, n));
      return d;
    };
    expect(checkBase(mk(['bin', 'etc', 'usr']))).toEqual({ exists: true, dir: true, listable: true, looksSystem: true });
    expect(checkBase(mk(['volumes', 'overlay2'])).looksSystem).toBe(true);
    expect(checkBase(mk(['Filme', 'Serien'])).looksSystem).toBe(false);
    writeFileSync(join(root, 'f'), 'x');
    expect(checkBase(join(root, 'f'))).toEqual({ exists: true, dir: false, listable: false, looksSystem: false });
    expect(checkBase(join(root, 'nope'))).toEqual({ exists: false, dir: false, listable: false, looksSystem: false });
  });

  it('checkData names the owner of the newest entry', () => {
    expect(checkData(root)).toBeNull();
    writeFileSync(join(root, 'x.db'), 'x');
    expect(checkData(root)).toBe(statSync(join(root, 'x.db')).uid);
  });

  it('detectGpu reads gid and vendor', () => {
    mkdirSync(join(root, 'dri'));
    writeFileSync(join(root, 'dri', 'renderD128'), '');
    writeFileSync(join(root, 'dri', 'renderD129'), '');
    writeFileSync(join(root, 'dri', 'card0'), '');
    mkdirSync(join(root, 'drm', 'renderD128', 'device'), { recursive: true });
    writeFileSync(join(root, 'drm', 'renderD128', 'device', 'vendor'), '0x8086\n');
    const gid = statSync(join(root, 'dri', 'renderD128')).gid;
    expect(detectGpu(join(root, 'dri'), join(root, 'drm'))).toEqual([
      { node: 'renderD128', gid, vendor: 'intel' }, { node: 'renderD129', gid, vendor: 'other' },
    ]);
    mkdirSync(join(root, 'drm', 'renderD129', 'device'), { recursive: true });
    writeFileSync(join(root, 'drm', 'renderD129', 'device', 'vendor'), '0x1002\n');
    expect(detectGpu(join(root, 'dri'), join(root, 'drm'))[1]!.vendor).toBe('amd');
    expect(detectGpu(join(root, 'none'), join(root, 'drm'))).toEqual([]);
  });

  it('main answers a bad verb or argument with exit 2', async () => {
    const w = process.stdout.write;
    const out: string[] = [];
    process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
    const bad = [
      ['nope'], ['browse', '../x'], ['check', 'folders', '[1]'], ['check', 'folders', 'zzz'],
      // backup <id> <trickplay 0|1> <kind> <upstream>, restore <id> <kind>: the id must name that kind and upstream
      ['backup', 'jellyfin-20261117-1402-10.11.3', '2', 'jellyfin', '10.11.3'], ['backup', 'jellyfin-20261117-1402-10.11.3', '0', 'ferrofin', '10.11.3'],
      ['backup', 'jellyfin-20261117-1402-10.11.3', '0', 'jellyfin', '10.11.4'], ['backup', '../x', '0', 'jellyfin', '10.11.3'],
      ['restore', 'jellyfin-20261117-1402-10.11.3', 'ferrofin'], ['restore', 'jellyfin-20261117-1402-10.11.3'],
    ];
    try {
      for (const args of bad) expect(await main(args)).toBe(2);
      expect(await main(['gpu'])).toBe(0);
    } finally { process.stdout.write = w; }
    expect(out.slice(0, bad.length)).toEqual(Array(bad.length).fill('{"error":"invalid_body"}\n'));
    expect(JSON.parse(out[bad.length]!)).toEqual({ nodes: expect.any(Array) });
  });
});

const IMG = 'sha256:' + 'c'.repeat(64);
const BASE = 'friendflix_mediaserver-base-' + createHash('sha256').update('/srv/media').digest('hex').slice(0, 8);
const spec = (verb: 'browse' | 'check' = 'browse') => helperSpec({ verb, args: ['Filme'], uid: 1000, gid: 1000, groups: [2000], mounts: [{ kind: 'base', volume: BASE }] }, { project: 'friendflix', image: IMG });
const G = { project: 'friendflix', uid: 1000, gid: 1000, image: IMG, verb: 'browse' as const };

interface FakeOpts { stdout?: string[]; exit?: number; waitThrows?: unknown; logsThrows?: boolean; list?: Array<{ id: string; names: string[]; state: string; labels: Record<string, string> }> }
function fake(o: FakeOpts = {}): { engine: Engine; calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const engine = {
    create: async (r: unknown) => { calls.push(['create', r]); return 'cid'; },
    start: async (id: string) => { calls.push(['start', id]); },
    stop: async (id: string, s: number) => { calls.push(['stop', id, s]); },
    wait: async (id: string, ms: number) => { calls.push(['wait', id, ms]); if (o.waitThrows) throw o.waitThrows; return o.exit ?? 0; },
    logs: async (id: string, tail: number, s: string) => { calls.push(['logs', id, tail, s]); if (o.logsThrows) throw new EngineError(500, 'engine_error'); return o.stdout ?? []; },
    remove: async (id: string, opts: unknown) => { calls.push(['remove', id, opts]); },
    listContainers: async (labels: unknown, all: boolean) => { calls.push(['list', labels, all]); return o.list ?? []; },
  } as unknown as Engine;
  return { engine, calls };
}
const names = (c: Array<[string, ...unknown[]]>): string[] => c.map((x) => x[0]);
const failure = async (p: Promise<unknown>): Promise<unknown> => { try { await p; } catch (e) { return e; } throw new Error('did not throw'); };

describe('runHelper', () => {
  it('creates, waits, reads the last line and always removes', async () => {
    const f = fake({ stdout: ['noise', '{"entries":[]}', ''] });
    expect(await runHelper(f.engine, spec(), G, 120_000)).toEqual({ entries: [] });
    expect(names(f.calls)).toEqual(['create', 'start', 'wait', 'logs', 'remove']);
    expect(f.calls[2]).toEqual(['wait', 'cid', 120_000]);
    expect(f.calls[3]).toEqual(['logs', 'cid', 50, 'stdout']);
    expect(f.calls[4]).toEqual(['remove', 'cid', { volumes: true }]);
  });

  it('refuses a body the guard refuses before create', async () => {
    const bad = spec();
    (bad.body.HostConfig as Record<string, unknown>).NetworkMode = 'host';
    const f = fake();
    expect(await failure(runHelper(f.engine, bad, G, 1000))).toBeInstanceOf(TemplateViolation);
    expect(f.calls).toEqual([]);
  });

  it('stops and removes on a timeout', async () => {
    const f = fake({ waitThrows: new EngineError(0, 'timeout') });
    const e = await failure(runHelper(f.engine, spec(), G, 1000));
    expect(e).toBeInstanceOf(StepError);
    expect((e as StepError).code).toBe('helper_timeout');
    expect(names(f.calls)).toEqual(['create', 'start', 'wait', 'stop', 'remove']);
    expect(f.calls[4]![2]).toEqual({ force: true, volumes: true });
  });

  it('removes when the log read fails and fails on a non-object last line', async () => {
    const a = fake({ logsThrows: true });
    expect(((await failure(runHelper(a.engine, spec(), G, 1000))) as StepError).code).toBe('helper_failed');
    expect(names(a.calls).at(-1)).toBe('remove');
    for (const out of [[], ['not json'], ['[1]'], ['"x"']]) {
      const f = fake({ stdout: out });
      expect(((await failure(runHelper(f.engine, spec(), G, 1000))) as StepError).code).toBe('helper_failed');
      expect(names(f.calls).at(-1)).toBe('remove');
    }
  });
});

describe('cleanupHelpers', () => {
  it('removes only this project helpers', async () => {
    const helper = { 'friendflix.managed': 'helper', 'friendflix.project': 'friendflix' };
    const f = fake({
      list: [
        { id: 'h1', names: ['friendflix-mediahelper-aaaaaaaa'], state: 'exited', labels: helper },
        { id: 'h2', names: ['other-mediahelper-bbbbbbbb'], state: 'exited', labels: { ...helper, 'friendflix.project': 'other' } },
        { id: 'm1', names: ['friendflix-mediaserver'], state: 'running', labels: { 'friendflix.managed': 'mediaserver', 'friendflix.project': 'friendflix' } },
      ],
    });
    expect(await cleanupHelpers(f.engine, 'friendflix')).toBe(1);
    expect(f.calls[0]).toEqual(['list', helper, true]);
    expect(f.calls.filter((c) => c[0] === 'remove')).toEqual([['remove', 'h1', { force: true, volumes: true }]]);
  });
});

describe('runHdr', () => {
  const MIMG = 'ghcr.io/letsmanu/friendflix-mediaserver@sha256:' + 'a'.repeat(64);
  const o = { project: 'friendflix', kind: 'ferrofin' as const, image: MIMG, uid: 1000, gid: 1000, renderGids: [993], node: 'renderD128' };

  it('reads test 2 from stdout and test 1 from the exit code', async () => {
    const pass = fake({ stdout: ['RESULT vpp FAIL x', 'RESULT qsv PASS codec_name=h264'] });
    expect(await runHdr(pass.engine, 2, o, 1000)).toBe('pass');
    expect(pass.calls.find((c) => c[0] === 'logs')![3]).toBe('stdout');
    expect(pass.calls.at(-1)).toEqual(['remove', 'cid', { volumes: true }]);
    expect(await runHdr(fake({ stdout: ['RESULT qsv FAIL no frames'] }).engine, 2, o, 1000)).toBe('fail');
    const t1 = fake({ exit: 1 });
    expect(await runHdr(t1.engine, 1, o, 1000)).toBe('fail');
    expect(names(t1.calls)).toEqual(['create', 'start', 'wait', 'remove']);
    expect(await runHdr(fake({ exit: 0 }).engine, 1, o, 1000)).toBe('pass');
    expect(hdrSpec(1, o).name).toMatch(/^friendflix-mediahelper-/);
  });
});
