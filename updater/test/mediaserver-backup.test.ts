// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Decrypter, Encrypter } from 'age-encryption';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { StepError } from '../src/docker.js';
import { restoreBackup, writeBackup } from '../src/mediaHelper.js';
import { BACKUP_EXCLUDE, metaEntry, type ArchiveMeta } from '../src/mediaserver/archive.js';
import { backupId, decodePassphrase, download, prune, retain, upload } from '../src/mediaserver/backup.js';
import { MediaJobs } from '../src/mediaserver/jobs.js';
import type { BackupMeta, BackupTag } from '../src/mediaserver/types.js';
import { JSPEC, N, SPEC, T0, ferroPin, jellyPin, world } from './media-world.js';

const PASS = 'korrekt pferd batterie';
const POLISH = 'zażółć gęślą jaźń';
const SLOW = 60_000;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ff-backup-'));
  dirs.push(d);
  return d;
}
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** a fake ServerResponse: collects what download writes; `onChunk` sees every chunk */
class FakeRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  chunks: Buffer[] = [];
  onChunk: (() => void) | null = null;
  writeHead(code: number, h: Record<string, string>): this {
    this.statusCode = code;
    Object.assign(this.headers, h);
    this.headersSent = true;
    return this;
  }
  override _write(c: Buffer, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.headersSent = true;
    this.chunks.push(c);
    this.onChunk?.();
    cb();
  }
  body(): Buffer { return Buffer.concat(this.chunks); }
  asRes(): ServerResponse { return this as unknown as ServerResponse; }
}

/** a fake IncomingMessage: the bytes in 64-KB chunks and the given headers */
function req(bytes: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 65536) parts.push(bytes.subarray(i, i + 65536));
  return Object.assign(Readable.from(parts), { headers }) as unknown as IncomingMessage;
}

async function encrypt(plain: Uint8Array, pass = PASS): Promise<Buffer> {
  const e = new Encrypter();
  e.setPassphrase(pass);
  e.setScryptWorkFactor(10); // fixtures only: the updater encrypts with age's default (18)
  return Buffer.from(await e.encrypt(plain));
}

async function decrypt(cipher: Uint8Array, pass = PASS): Promise<Buffer> {
  const d = new Decrypter();
  d.addPassphrase(pass);
  return Buffer.from(await d.decrypt(cipher));
}

/** a backup archive as the helper writes it: the metadata entry first, then (here) an empty tar */
function archive(meta: Partial<ArchiveMeta> = {}, extra = Buffer.alloc(0)): Buffer {
  const m: ArchiveMeta = { v: 1, kind: 'jellyfin', upstream: '10.11.3', createdAt: '2026-11-01T10:00:00.000Z', ...meta };
  return gzipSync(Buffer.concat([metaEntry(m), extra, Buffer.alloc(1024)]));
}

const entry = (id: string, tag: BackupTag, at: string, kind: BackupMeta['kind'] = 'jellyfin', upstream = '10.11.3'): BackupMeta => ({ id, kind, upstream, at, tag, size: 1 });

/** the media world with the jobs reading and writing their backups in a temp dir */
function setup() {
  const w = world();
  const dir = tempDir();
  const jobs = new MediaJobs({ ...w.deps, backupDir: dir });
  const run = async (op: Parameters<MediaJobs['start']>[0]) => {
    const r = jobs.start(op);
    if (!r.ok) throw new Error(`not started: ${r.error}`);
    await w.updater.idle();
    return w.updater.snapshot().lastJob!;
  };
  const logs = (): string => w.updater.log.tail(500).join('\n');
  return { ...w, dir, jobs, run, logs };
}

/** the open file descriptors of this process that point at `path` */
function openFds(path: string): number {
  let n = 0;
  for (const fd of readdirSync('/proc/self/fd')) {
    try { if (readlinkSync(`/proc/self/fd/${fd}`) === path) n++; } catch { /* closed meanwhile */ }
  }
  return n;
}

describe('ids and passphrases', () => {
  it('backupId uses UTC minutes', () => {
    expect(backupId('ferrofin', 'v1.5.1', new Date('2026-11-17T08:05:59Z'))).toBe('ferrofin-20261117-0805-v1.5.1');
    expect(backupId('jellyfin', '10.11.3', new Date('2026-01-02T23:59:00+02:00'))).toBe('jellyfin-20260102-2159-10.11.3');
  });

  it('the passphrase header is base64url of UTF-8, 12 to 1024 code points', () => {
    const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
    expect(decodePassphrase(enc(POLISH))).toBe(POLISH);
    expect(decodePassphrase(enc('kırmızı şapka çok güzel'))).toBe('kırmızı şapka çok güzel');
    expect(decodePassphrase(enc('a'.repeat(12)))).toBe('a'.repeat(12));
    expect(decodePassphrase(`${enc('a'.repeat(12))}==`)).toBe('a'.repeat(12));
    // 11 code points (22 bytes) is too short, 1025 too long; 1024 four-byte code points pass
    expect(decodePassphrase(enc('ż'.repeat(11)))).toBeNull();
    expect(decodePassphrase(enc('😀'.repeat(1024)))).toBe('😀'.repeat(1024));
    expect(decodePassphrase(enc('a'.repeat(1025)))).toBeNull();
    // not base64url, not canonical, not UTF-8, missing
    expect(decodePassphrase(Buffer.from('a'.repeat(12)).toString('base64').replace(/=+$/, '') + '+')).toBeNull();
    // 13 bytes end in a character with unused bits: 'Q' is canonical, 'R' decodes to the same bytes
    expect(decodePassphrase(enc('a'.repeat(13)))).toBe('a'.repeat(13));
    expect(decodePassphrase(enc('a'.repeat(13)).slice(0, -1) + 'R')).toBeNull();
    expect(decodePassphrase(Buffer.from([0xff, 0xfe, ...Buffer.from('a'.repeat(12))]).toString('base64url'))).toBeNull();
    expect(decodePassphrase(undefined)).toBeNull();
    expect(decodePassphrase('')).toBeNull();
  });
});

describe('retention', () => {
  it('retention keeps 3 manual and upload, 2 auto', async () => {
    const list = [
      entry('jellyfin-20261101-1000-10.11.3', 'manual', '2026-11-01T10:00:00.000Z'),
      entry('jellyfin-20261102-1000-10.11.3', 'manual', '2026-11-02T10:00:00.000Z'),
      entry('jellyfin-20261103-1000-10.11.3', 'auto', '2026-11-03T10:00:00.000Z'),
      entry('jellyfin-20261104-1000-10.11.3', 'upload', '2026-11-04T10:00:00.000Z'),
      entry('jellyfin-20261105-1000-10.11.3', 'manual', '2026-11-05T10:00:00.000Z'),
      entry('jellyfin-20261106-1000-10.11.3', 'auto', '2026-11-06T10:00:00.000Z'),
      entry('jellyfin-20261107-1000-10.11.3', 'manual', '2026-11-07T10:00:00.000Z'),
      entry('jellyfin-20261108-1000-10.11.3', 'manual', '2026-11-08T10:00:00.000Z'),
      entry('jellyfin-20261109-1000-10.11.3', 'auto', '2026-11-09T10:00:00.000Z'),
    ];
    const r = prune(list);
    expect(r.drop.map((b) => b.id).sort()).toEqual([
      'jellyfin-20261101-1000-10.11.3', 'jellyfin-20261102-1000-10.11.3', 'jellyfin-20261103-1000-10.11.3', 'jellyfin-20261104-1000-10.11.3',
    ]);
    expect(r.keep.map((b) => b.id)).toEqual([
      'jellyfin-20261105-1000-10.11.3', 'jellyfin-20261106-1000-10.11.3', 'jellyfin-20261107-1000-10.11.3', 'jellyfin-20261108-1000-10.11.3', 'jellyfin-20261109-1000-10.11.3',
    ]);

    // retain applies it to the state and deletes the files of what it dropped (only those)
    const w = setup();
    for (const b of list) writeFileSync(join(w.dir, `${b.id}.tar.gz`), 'x');
    writeFileSync(join(w.dir, 'other.txt'), 'x');
    w.updater.updateMedia((m) => { m.backups = list; });
    await retain({ dir: w.dir, updater: w.updater });
    expect(w.media().backups.map((b) => b.id)).toEqual(r.keep.map((b) => b.id));
    expect(readdirSync(w.dir).sort()).toEqual([...r.keep.map((b) => `${b.id}.tar.gz`), 'other.txt'].sort());
  });

  it('a deploy snapshot keeps the last 2 automatic backups', async () => {
    const w = setup();
    w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2');
    const old = [entry('jellyfin-20261101-1000-10.11.1', 'auto', '2026-11-01T10:00:00.000Z'), entry('jellyfin-20261102-1000-10.11.2', 'auto', '2026-11-02T10:00:00.000Z')];
    for (const b of old) writeFileSync(join(w.dir, `${b.id}.tar.gz`), 'x');
    w.updater.updateMedia((m) => { m.backups = old; });
    const job = await w.run({ op: 'update' });
    expect(job.state).toBe('succeeded');
    const id = backupId('jellyfin', '10.11.2', new Date(T0));
    expect(w.media().backups.map((b) => [b.id, b.tag])).toEqual([['jellyfin-20261102-1000-10.11.2', 'auto'], [id, 'auto']]);
    expect(readdirSync(w.dir)).toEqual(['jellyfin-20261102-1000-10.11.2.tar.gz']);
  });
});

describe('download', () => {
  it('download is age with the passphrase and decrypts with age -d semantics', async () => {
    const w = setup();
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    const id = 'jellyfin-20261117-1402-10.11.3';
    const plain = randomBytes(3 * 1024 * 1024);
    writeFileSync(join(w.dir, `${id}.tar.gz`), plain);
    w.updater.updateMedia((m) => { m.backups = [entry(id, 'manual', new Date(T0).toISOString())]; });
    const res = new FakeRes();
    await download({ dir: w.dir, updater: w.updater }, id, PASS, res.asRes());
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${id}.tar.gz.age"` });
    const out = res.body();
    expect(out.subarray(0, 40).toString('latin1')).toMatch(/^age-encryption\.org\/v1\n-> scrypt /);
    // age's own default work factor, as the age CLI writes it
    expect(out.subarray(0, 120).toString('latin1')).toMatch(/^age-encryption\.org\/v1\n-> scrypt [A-Za-z0-9+/]{22} 18\n/);
    expect((await decrypt(out)).equals(plain)).toBe(true);
    await expect(decrypt(out, 'korrekt pferd batteriE')).rejects.toThrow();
    const lines = [w.logs(), ...log.mock.calls.flat(), ...err.mock.calls.flat()].map(String).join('\n');
    expect(lines).not.toContain(PASS);
    expect(lines).not.toContain(w.dir);
  }, SLOW);

  it('an aborted download releases the backup', async () => {
    const w = setup();
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    const id = 'jellyfin-20261117-1402-10.11.3';
    const file = join(w.dir, `${id}.tar.gz`);
    writeFileSync(file, randomBytes(4 * 1024 * 1024));
    w.updater.updateMedia((m) => { m.backups = [entry(id, 'manual', new Date(T0).toISOString())]; });
    const res = new FakeRes();
    let during: ReturnType<MediaJobs['start']> | null = null;
    let fdsDuring = 0;
    res.onChunk = () => {
      if (during) return;
      fdsDuring = openFds(file);
      // a restore of the backup that is being downloaded waits
      during = w.jobs.start({ op: 'restore', id });
      res.destroy();
    };
    await download({ dir: w.dir, updater: w.updater }, id, PASS, res.asRes());
    expect(fdsDuring).toBe(1);
    expect(during).toEqual({ ok: false, error: 'busy' });
    // the read stream is closed and the restore can start
    expect(openFds(file)).toBe(0);
    const job = await w.run({ op: 'restore', id });
    expect(job).toMatchObject({ action: 'mediaserver-restore', state: 'succeeded' });
  }, SLOW);

  it('a missing or unknown backup is not_found, one being restored is busy', async () => {
    const w = setup();
    const id = 'jellyfin-20261117-1402-10.11.3';
    const at = new Date(T0).toISOString();
    const ask = async (x: string): Promise<FakeRes> => {
      const res = new FakeRes();
      await download({ dir: w.dir, updater: w.updater }, x, PASS, res.asRes());
      return res;
    };
    // listed, but no file
    w.updater.updateMedia((m) => { m.backups = [entry(id, 'manual', at)]; });
    let r = await ask(id);
    expect([r.statusCode, JSON.parse(r.body().toString())]).toEqual([404, { error: 'not_found' }]);
    // a file, but not listed; an id that is no backup id
    writeFileSync(join(w.dir, 'jellyfin-20261117-1403-10.11.3.tar.gz'), 'x');
    expect((await ask('jellyfin-20261117-1403-10.11.3')).statusCode).toBe(404);
    expect((await ask('../etc/passwd')).statusCode).toBe(404);

    // while the restore of that id runs
    writeFileSync(join(w.dir, `${id}.tar.gz`), 'x');
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    let release!: () => void;
    const gate = new Promise<void>((r2) => { release = r2; });
    const helper = w.deps.helper;
    const jobs = new MediaJobs({ ...w.deps, backupDir: w.dir, helper: async (...a: Parameters<typeof helper>) => { await gate; return helper(...a); } });
    expect(jobs.start({ op: 'restore', id }).ok).toBe(true);
    r = await ask(id);
    expect([r.statusCode, JSON.parse(r.body().toString())]).toEqual([409, { error: 'busy' }]);
    release();
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-restore', state: 'succeeded' });
    expect((await ask(id)).statusCode).toBe(200);
  }, SLOW);
});

describe('upload', () => {
  it('upload round-trip', async () => {
    const w = setup();
    const plain = archive({ kind: 'jellyfin', upstream: '10.11.3' }, randomBytes(200_000));
    const body = await encrypt(plain, POLISH);
    w.clock.t = Date.UTC(2026, 10, 17, 15, 30, 0);
    const r = await upload({ dir: w.dir, updater: w.updater, now: () => w.clock.t }, req(body), POLISH);
    const id = 'jellyfin-20261117-1530-10.11.3';
    expect(r).toEqual({ ok: true, backup: { id, kind: 'jellyfin', upstream: '10.11.3', at: '2026-11-17T15:30:00.000Z', tag: 'upload', size: plain.length } });
    expect(readdirSync(w.dir)).toEqual([`${id}.tar.gz`]);
    expect(readFileSync(join(w.dir, `${id}.tar.gz`)).equals(plain)).toBe(true);
    // readable by the helper, which runs as the media server's user
    expect(statSync(join(w.dir, `${id}.tar.gz`)).mode & 0o777).toBe(0o644);
    expect(w.media().backups).toEqual([{ id, kind: 'jellyfin', upstream: '10.11.3', at: '2026-11-17T15:30:00.000Z', tag: 'upload', size: plain.length }]);
    expect(w.logs()).not.toContain(POLISH);
  }, SLOW);

  it('wrong passphrase leaves nothing', async () => {
    const w = setup();
    writeFileSync(join(w.dir, 'jellyfin-20261101-1000-10.11.3.tar.gz'), 'old');
    const body = await encrypt(archive());
    const r = await upload({ dir: w.dir, updater: w.updater, now: () => T0 }, req(body), 'falsches pferd batterie');
    expect(r).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    expect(readdirSync(w.dir)).toEqual(['jellyfin-20261101-1000-10.11.3.tar.gz']);
    expect(w.media().backups).toEqual([]);
  }, SLOW);

  it('an upload over the limit is cut and removed', async () => {
    const w = setup();
    const body = await encrypt(archive({}, randomBytes(2 * 1024 * 1024)));
    const d = { dir: w.dir, updater: w.updater, now: () => T0, max: 1024 * 1024 };
    const stream = req(body);
    expect(await upload(d, stream, PASS)).toEqual({ ok: false, status: 413, error: 'too_large' });
    expect(stream.destroyed).toBe(true);
    expect(readdirSync(w.dir)).toEqual([]);
    // a declared length over the limit is refused before anything is read
    const declared = req(body, { 'content-length': String(body.length) });
    expect(await upload(d, declared, PASS)).toEqual({ ok: false, status: 413, error: 'too_large' });
    expect(readdirSync(w.dir)).toEqual([]);
    expect(w.media().backups).toEqual([]);
  }, SLOW);

  it('a damaged file or missing metadata is invalid', async () => {
    const w = setup();
    const d = { dir: w.dir, updater: w.updater, now: () => T0 };
    const body = await encrypt(archive({}, randomBytes(100_000)));
    const flipped = Buffer.from(body);
    flipped[flipped.length - 100]! ^= 0x01;
    expect(await upload(d, req(flipped), PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    // cut short
    expect(await upload(d, req(body.subarray(0, body.length - 10)), PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    // a valid age file of a tar without the metadata entry
    const src = tempDir();
    writeFileSync(join(src, 'library.db'), 'db');
    const plainTar = execFileSync('tar', ['-c', '-z', '-f', '-', '-C', src, 'library.db']);
    expect(await upload(d, req(await encrypt(plainTar)), PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    // not gzip at all; metadata of another version or with a strange upstream
    expect(await upload(d, req(await encrypt(Buffer.from('plain text'))), PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    for (const meta of [{ v: 2 }, { upstream: '../10.11.3' }, { kind: 'plex' }] as Array<Partial<ArchiveMeta>>) {
      expect(await upload(d, req(await encrypt(archive(meta))), PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    }
    expect(readdirSync(w.dir)).toEqual([]);
    expect(w.media().backups).toEqual([]);
    // a passphrase outside the rule never reaches age
    expect(await upload(d, req(body), 'kurz')).toEqual({ ok: false, status: 400, error: 'invalid_passphrase' });
  }, SLOW);

  it('an upload is pruned with the manual ones and refused while that id is restored', async () => {
    const w = setup();
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    const old = ['jellyfin-20261101-1000-10.11.3', 'jellyfin-20261102-1000-10.11.3', 'jellyfin-20261103-1000-10.11.3'];
    for (const id of old) writeFileSync(join(w.dir, `${id}.tar.gz`), 'x');
    w.updater.updateMedia((m) => { m.backups = old.map((id, i) => entry(id, 'manual', `2026-11-0${i + 1}T10:00:00.000Z`)); });
    const body = await encrypt(archive());
    const r = await upload({ dir: w.dir, updater: w.updater, now: () => T0 }, req(body), PASS);
    expect(r.ok).toBe(true);
    const id = backupId('jellyfin', '10.11.3', new Date(T0));
    expect(w.media().backups.map((b) => b.id)).toEqual([old[1], old[2], id]);
    expect(readdirSync(w.dir).sort()).toEqual([`${old[1]}.tar.gz`, `${old[2]}.tar.gz`, `${id}.tar.gz`]);

    // the same minute again while the restore of that id runs
    let release!: () => void;
    const gate = new Promise<void>((r2) => { release = r2; });
    const helper = w.deps.helper;
    const jobs = new MediaJobs({ ...w.deps, backupDir: w.dir, helper: async (...a: Parameters<typeof helper>) => { await gate; return helper(...a); } });
    expect(jobs.start({ op: 'restore', id }).ok).toBe(true);
    expect(await upload({ dir: w.dir, updater: w.updater, now: () => T0 }, req(body), PASS)).toEqual({ ok: false, status: 409, error: 'busy' });
    expect(readdirSync(w.dir).filter((f) => f.endsWith('.part'))).toEqual([]);
    release();
    await w.updater.idle();
  }, SLOW);
});

describe('jobs', () => {
  it('backup job stops and restarts the server', async () => {
    const w = setup();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    const job = await w.run({ op: 'backup', trickplay: true });
    expect(job).toMatchObject({ action: 'mediaserver-backup', state: 'succeeded', error: null });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', `start ${N.container}`]);
    const id = 'ferrofin-20261117-1402-v1.5.1';
    const call = w.helperCalls.find((c) => c.verb === 'backup')!;
    expect(call.args).toEqual([id, '1', 'ferrofin', 'v1.5.1']);
    expect(call.mounts).toEqual([
      { Type: 'volume', Source: N.data('ferrofin'), Target: '/data', ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: N.backup, Target: '/backups', ReadOnly: false },
    ]);
    expect(w.media().backups).toEqual([{ id, kind: 'ferrofin', upstream: 'v1.5.1', at: new Date(T0).toISOString(), tag: 'manual', size: 4096 }]);
    expect(job.media!.steps).toMatchObject({ check: 'ok', snapshot: 'ok', start: 'ok' });

    // a failed helper: the server is started all the same, the job fails with backup_failed
    const answer = w.cfg.answer;
    w.cfg.answer = (c) => (c.verb === 'backup' ? { error: 'helper_failed' } : answer(c));
    w.calls.length = 0;
    const failed = await w.run({ op: 'backup', trickplay: false });
    expect(failed).toMatchObject({ action: 'mediaserver-backup', state: 'failed', error: 'backup_failed' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', `start ${N.container}`]);
    expect(w.find(N.container)!.running).toBe(true);
    expect(w.media().backups).toHaveLength(1);

    // a server stopped on purpose stays stopped
    w.cfg.answer = answer;
    w.updater.updateMedia((m) => { m.desired!.run = false; });
    w.calls.length = 0;
    expect((await w.run({ op: 'backup', trickplay: false })).state).toBe('succeeded');
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup']);
  });

  it('restore stops, replaces the data, starts and checks health', async () => {
    const w = setup();
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    const id = 'jellyfin-20261110-0900-10.11.2';
    writeFileSync(join(w.dir, `${id}.tar.gz`), 'x');
    w.updater.updateMedia((m) => { m.backups = [entry(id, 'upload', '2026-11-10T09:00:00.000Z', 'jellyfin', '10.11.2')]; });
    const job = await w.run({ op: 'restore', id });
    expect(job).toMatchObject({ action: 'mediaserver-restore', state: 'succeeded', error: null });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper restore', `start ${N.container}`]);
    const call = w.helperCalls.find((c) => c.verb === 'restore')!;
    expect(call.args).toEqual([id, 'jellyfin']);
    expect(call.mounts).toEqual([
      { Type: 'volume', Source: N.data('jellyfin'), Target: '/data', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: N.backup, Target: '/backups', ReadOnly: true },
    ]);
    expect(job.media!.steps).toMatchObject({ check: 'ok', snapshot: 'ok', start: 'ok', health: 'ok' });

    // a failed restore: half-restored data is never started on
    const answer = w.cfg.answer;
    w.cfg.answer = (c) => (c.verb === 'restore' ? new StepError('helper_timeout') : answer(c));
    w.calls.length = 0;
    const failed = await w.run({ op: 'restore', id });
    expect(failed).toMatchObject({ state: 'failed', error: 'restore_failed' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper restore']);
    expect(w.media().lastError).toBe('restore_failed');

    // unknown backup, or its file is gone
    w.cfg.answer = answer;
    expect(await w.run({ op: 'restore', id: 'jellyfin-20261110-0901-10.11.2' })).toMatchObject({ state: 'failed', error: 'backup_invalid' });
    w.updater.updateMedia((m) => { m.backups.push(entry('jellyfin-20261110-0902-10.11.2', 'manual', '2026-11-10T09:02:00.000Z', 'jellyfin', '10.11.2')); });
    expect(await w.run({ op: 'restore', id: 'jellyfin-20261110-0902-10.11.2' })).toMatchObject({ state: 'failed', error: 'backup_invalid' });
  });

  it('restore refuses another kind and a newer upstream', async () => {
    const w = setup();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    const jf = 'jellyfin-20261110-0900-10.11.3';
    writeFileSync(join(w.dir, `${jf}.tar.gz`), 'x');
    w.updater.updateMedia((m) => { m.backups = [entry(jf, 'manual', '2026-11-10T09:00:00.000Z')]; });
    expect(await w.run({ op: 'restore', id: jf })).toMatchObject({ action: 'mediaserver-restore', state: 'failed', error: 'kind_mismatch' });

    const v = setup();
    v.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    const newer = 'jellyfin-20261110-0900-10.11.4';
    writeFileSync(join(v.dir, `${newer}.tar.gz`), 'x');
    v.updater.updateMedia((m) => { m.backups = [entry(newer, 'manual', '2026-11-10T09:00:00.000Z', 'jellyfin', '10.11.4')]; });
    expect(await v.run({ op: 'restore', id: newer })).toMatchObject({ state: 'failed', error: 'downgrade_refused' });

    // neither stopped the server
    expect(w.calls.filter((c) => !c.startsWith('helper'))).toEqual([]);
    expect(v.calls.filter((c) => !c.startsWith('helper'))).toEqual([]);
    expect(w.find(N.container)!.running && v.find(N.container)!.running).toBe(true);
  });

  it('backup and restore need a managed server', () => {
    const w = setup();
    expect(w.jobs.start({ op: 'backup', trickplay: false })).toEqual({ ok: false, error: 'no_target' });
    expect(w.jobs.start({ op: 'restore', id: 'jellyfin-20261110-0900-10.11.3' })).toEqual({ ok: false, error: 'no_target' });
  });
});

describe('helper verbs', () => {
  function dataDir(): string {
    const d = tempDir();
    const files: Record<string, string> = {
      'config/system.xml': '<x/>', 'data/jellyfin.db': 'db', 'data/trickplay/a/1.jpg': 'tp', 'metadata/library/ab/poster.jpg': 'p',
      'metadata/trickplay/b.jpg': 'tp2', 'log/log_1.txt': 'secret log', 'transcodes/x.ts': 't', 'cache/c.bin': 'c', 'root/default/Filme/options.xml': 'o',
    };
    for (const [p, v] of Object.entries(files)) {
      mkdirSync(join(d, p, '..'), { recursive: true });
      writeFileSync(join(d, p), v);
    }
    return d;
  }
  const list = (file: string): string[] => execFileSync('tar', ['-t', '-z', '-f', file]).toString().trim().split('\n');

  it('the backup archive starts with the metadata and leaves out logs, transcodes and trickplay', async () => {
    const data = dataDir();
    const out = tempDir();
    const id = 'jellyfin-20261117-1402-10.11.3';
    const r = await writeBackup({ data, backups: out }, { id, trickplay: false, kind: 'jellyfin', upstream: '10.11.3' }, new Date(T0));
    const file = join(out, `${id}.tar.gz`);
    expect(readdirSync(out)).toEqual([`${id}.tar.gz`]);
    expect(r).toEqual({ size: statSync(file).size });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const names = list(file);
    expect(names[0]).toBe('friendflix-backup.json');
    const meta = JSON.parse(execFileSync('tar', ['-x', '-O', '-z', '-f', file, 'friendflix-backup.json']).toString());
    expect(meta).toEqual({ v: 1, kind: 'jellyfin', upstream: '10.11.3', createdAt: new Date(T0).toISOString() });
    expect(names).toEqual(expect.arrayContaining(['config/system.xml', 'data/jellyfin.db', 'metadata/library/ab/poster.jpg', 'root/default/Filme/options.xml']));
    for (const n of names) expect(n).not.toMatch(/^(log|transcodes|cache|data\/trickplay|metadata\/trickplay)(\/|$)/);

    // with trickplay
    const id2 = 'jellyfin-20261117-1403-10.11.3';
    await writeBackup({ data, backups: out }, { id: id2, trickplay: true, kind: 'jellyfin', upstream: '10.11.3' }, new Date(T0));
    expect(list(join(out, `${id2}.tar.gz`))).toEqual(expect.arrayContaining(['data/trickplay/a/1.jpg', 'metadata/trickplay/b.jpg']));
    expect(BACKUP_EXCLUDE.ferrofin.always).toEqual(expect.arrayContaining(['log', 'transcodes', 'cache']));
  });

  it('restore empties the data folder and skips the metadata', async () => {
    const data = dataDir();
    const out = tempDir();
    const id = 'jellyfin-20261117-1402-10.11.3';
    await writeBackup({ data, backups: out }, { id, trickplay: false, kind: 'jellyfin', upstream: '10.11.3' }, new Date(T0));
    const target = tempDir();
    mkdirSync(join(target, 'data'), { recursive: true });
    writeFileSync(join(target, 'data', 'newer.db'), 'n');
    writeFileSync(join(target, 'stale.txt'), 's');
    expect(await restoreBackup({ data: target, backups: out }, { id, kind: 'jellyfin' })).toEqual({ ok: true });
    expect(readdirSync(target).sort()).toEqual(['config', 'data', 'metadata', 'root']);
    expect(readFileSync(join(target, 'data', 'jellyfin.db'), 'utf8')).toBe('db');
    expect(readdirSync(join(target, 'data'))).toEqual(['jellyfin.db']);

    // another kind's backup is refused before anything is removed
    await expect(restoreBackup({ data: target, backups: out }, { id, kind: 'ferrofin' })).rejects.toMatchObject({ code: 'backup_invalid' });
    expect(readdirSync(target).sort()).toEqual(['config', 'data', 'metadata', 'root']);
    await expect(restoreBackup({ data: target, backups: out }, { id: 'jellyfin-20261117-1404-10.11.3', kind: 'jellyfin' })).rejects.toMatchObject({ code: 'backup_invalid' });
  });

  it('a failing tar leaves no part file', async () => {
    const data = dataDir();
    const out = tempDir();
    const id = 'jellyfin-20261117-1402-10.11.3';
    await expect(writeBackup({ data, backups: out }, { id, trickplay: false, kind: 'jellyfin', upstream: '10.11.3' }, new Date(T0), 'false')).rejects.toMatchObject({ code: 'backup_failed' });
    expect(readdirSync(out)).toEqual([]);
  });
});
