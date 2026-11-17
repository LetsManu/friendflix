// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { backupId, decodePassphrase, download, older, prune, removeStaleParts, retain, upload } from '../src/mediaserver/backup.js';
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

describe('older', () => {
  it('compares plain X.Y.Z numerically', () => {
    expect(older('10.11.2', '10.11.3')).toBe(true);
    expect(older('10.9.9', '10.11.0')).toBe(true);
    expect(older('v1.5.1', 'v1.5.10')).toBe(true);
    expect(older('10.11.3', '10.11.3')).toBe(false);
    expect(older('10.11.11', '10.11.3')).toBe(false);
    expect(older('nope', '10.11.3')).toBe(false);
  });

  it('compares the build-stamp tags of Jellyfin 12.x', () => {
    const t = '12.4.20261026-211555';
    expect(older('12.4.20261023-013714', t)).toBe(true);
    expect(older(t, '12.4.20261023-013714')).toBe(false);
    expect(older('12.4.20261026-211554', t)).toBe(true);
    expect(older('12.3.20261023-013714', t)).toBe(true);
    expect(older('10.11.11', t)).toBe(true);
    expect(older(t, '10.11.11')).toBe(false);
    expect(older(t, t)).toBe(false);
    expect(older('13.0.20270101-000000', t)).toBe(false);
    // same X.Y: a stamp is newer than any plain patch tag
    expect(older('12.4.3', t)).toBe(true);
    expect(older(t, '12.4.3')).toBe(false);
  });
});

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
    // the safety snapshot of the same minute and upstream would have replaced the backup being restored: it moves on a minute
    expect(w.helperCalls.find((c) => c.verb === 'backup')!.args[0]).toBe('jellyfin-20261117-1403-10.11.3');
    expect(w.media().backups.map((b) => [b.id, b.tag])).toEqual([[id, 'manual'], ['jellyfin-20261117-1403-10.11.3', 'auto']]);
  }, SLOW);

  it('download checks the passphrase rule, and only one key derivation runs at a time', async () => {
    const w = setup();
    const id = 'jellyfin-20261117-1402-10.11.3';
    writeFileSync(join(w.dir, `${id}.tar.gz`), randomBytes(1024));
    w.updater.updateMedia((m) => { m.backups = [entry(id, 'manual', new Date(T0).toISOString())]; });
    const short = new FakeRes();
    await download({ dir: w.dir, updater: w.updater }, id, 'kurz', short.asRes());
    expect([short.statusCode, JSON.parse(short.body().toString())]).toEqual([400, { error: 'invalid_passphrase' }]);

    const first = new FakeRes();
    const running = download({ dir: w.dir, updater: w.updater }, id, PASS, first.asRes());
    const second = new FakeRes();
    await download({ dir: w.dir, updater: w.updater }, id, PASS, second.asRes());
    expect([second.statusCode, JSON.parse(second.body().toString())]).toEqual([409, { error: 'busy' }]);
    const body = await encrypt(archive());
    const stream = req(body);
    expect(await upload({ dir: w.dir, updater: w.updater, now: () => T0 }, stream, PASS)).toEqual({ ok: false, status: 409, error: 'busy' });
    // nothing of the refused upload was read
    expect(stream.readableFlowing).toBeNull();
    await running;
    expect(first.statusCode).toBe(200);
    expect((await upload({ dir: w.dir, updater: w.updater, now: () => T0 + 60_000 }, req(body), PASS)).ok).toBe(true);
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

  it('an unsound age header is refused before age reads it, with bounded memory', async () => {
    const w = setup();
    const d = { dir: w.dir, updater: w.updater, now: () => T0 };
    /** 1 GiB offered in 64-KB chunks; counts what was taken */
    const offer = (first: Buffer, fill: Buffer) => {
      let pulled = 0;
      const src = Readable.from((function* () {
        pulled++; yield first;
        for (let i = 0; i < 16384; i++) { pulled++; yield fill; }
      })());
      return { stream: Object.assign(src, { headers: {} }) as unknown as IncomingMessage, pulled: () => pulled };
    };
    // no newline at all
    const blob = Buffer.alloc(65536, 0x61);
    let o = offer(blob, blob);
    expect(await upload(d, o.stream, PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    expect(o.pulled()).toBeLessThan(64);
    // the right version line, but no end of the header within 64 KiB
    o = offer(Buffer.from('age-encryption.org/v1\n'), Buffer.from(`${'a'.repeat(63)}\n`.repeat(1024)));
    expect(await upload(d, o.stream, PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    expect(o.pulled()).toBeLessThan(64);
    // a scrypt work factor above 18 (age would accept up to 20: about 1 GB for the key)
    const body = await encrypt(archive());
    const head = body.subarray(0, 200).toString('latin1');
    const stanza = /^-> scrypt \S+ 10$/m.exec(head)![0];
    const heavy = Buffer.concat([Buffer.from(head.replace(stanza, stanza.replace(/ 10$/, ' 19')), 'latin1'), body.subarray(200)]);
    expect(await upload(d, req(heavy), PASS)).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    expect(readdirSync(w.dir)).toEqual([]);
    // the same file with its own work factor passes
    expect((await upload(d, req(body), PASS)).ok).toBe(true);
  }, SLOW);

  it('an archive cut short after its metadata is refused at upload', async () => {
    const w = setup();
    const whole = archive({}, randomBytes(100_000));
    const cut = whole.subarray(0, 60_000);
    const r = await upload({ dir: w.dir, updater: w.updater, now: () => T0 }, req(await encrypt(cut)), PASS);
    expect(r).toEqual({ ok: false, status: 400, error: 'backup_invalid' });
    expect(readdirSync(w.dir)).toEqual([]);
  }, SLOW);

  it('leftover part files are removed, at start and before each backup and upload', async () => {
    const w = setup();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    const leave = (): void => {
      writeFileSync(join(w.dir, 'ferrofin-20261117-1300-v1.5.1.tar.gz.part'), 'plain');
      writeFileSync(join(w.dir, '.upload-0123456789abcdef01234567.part'), 'plain');
    };
    writeFileSync(join(w.dir, 'ferrofin-20261117-1300-v1.5.1.tar.gz'), 'kept');
    leave();
    await removeStaleParts(w.dir);
    expect(readdirSync(w.dir)).toEqual(['ferrofin-20261117-1300-v1.5.1.tar.gz']);
    await removeStaleParts(join(w.dir, 'missing'));
    leave();
    expect((await w.run({ op: 'backup', trickplay: false })).state).toBe('succeeded');
    expect(readdirSync(w.dir)).toEqual(['ferrofin-20261117-1300-v1.5.1.tar.gz']);
    leave();
    expect((await upload({ dir: w.dir, updater: w.updater, now: () => T0 }, req(await encrypt(archive())), PASS)).ok).toBe(true);
    expect(readdirSync(w.dir).filter((f) => f.endsWith('.part'))).toEqual([]);
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

  it('restore stops, takes a safety snapshot, replaces the data, starts and checks health', async () => {
    const w = setup();
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    const id = 'jellyfin-20261110-0900-10.11.2';
    const safety = 'jellyfin-20261117-1402-10.11.3';
    writeFileSync(join(w.dir, `${id}.tar.gz`), 'x');
    w.updater.updateMedia((m) => { m.backups = [entry(id, 'upload', '2026-11-10T09:00:00.000Z', 'jellyfin', '10.11.2')]; });
    const job = await w.run({ op: 'restore', id });
    expect(job).toMatchObject({ action: 'mediaserver-restore', state: 'succeeded', error: null });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', 'helper restore', `start ${N.container}`]);
    expect(w.helperCalls.find((c) => c.verb === 'backup')!.args).toEqual([safety, '0', 'jellyfin', '10.11.3']);
    const call = w.helperCalls.find((c) => c.verb === 'restore')!;
    expect(call.args).toEqual([id, 'jellyfin']);
    expect(call.mounts).toEqual([
      { Type: 'volume', Source: N.data('jellyfin'), Target: '/data', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: N.backup, Target: '/backups', ReadOnly: true },
    ]);
    expect(job.media!.steps).toMatchObject({ check: 'ok', snapshot: 'ok', create: 'ok', start: 'ok', health: 'ok', rollback: 'skipped' });
    expect(w.media().backups.map((b) => [b.id, b.tag])).toEqual([[id, 'upload'], [safety, 'auto']]);
    const answer = w.cfg.answer;
    const again = async (restore: (c: { args: string[] }) => ReturnType<typeof answer>) => {
      w.cfg.answer = (c) => (c.verb === 'restore' ? restore(c) : answer(c));
      w.calls.length = 0;
      w.helperCalls.length = 0;
      w.clock.t += 60_000;
      return w.run({ op: 'restore', id });
    };

    // the archive failed the helper's check: nothing changed, the server runs again, no rollback
    const invalid = await again(() => ({ error: 'backup_invalid' }));
    expect(invalid).toMatchObject({ state: 'failed', error: 'backup_invalid' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', 'helper restore', `start ${N.container}`]);
    expect(invalid.media!.steps).toMatchObject({ snapshot: 'ok', create: 'failed', start: 'ok', rollback: 'skipped' });

    // the extraction failed after the data was emptied: the safety snapshot goes back, the server runs again
    const rolled = await again((c) => (c.args[0] === id ? { error: 'restore_failed' } : { ok: true }));
    expect(rolled).toMatchObject({ state: 'rolled_back', error: 'restore_failed' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', 'helper restore', 'helper restore', `start ${N.container}`]);
    const [target, back] = w.helperCalls.filter((c) => c.verb === 'restore');
    expect([target!.args[0], back!.args[0]]).toEqual([id, w.helperCalls.find((c) => c.verb === 'backup')!.args[0]]);
    expect(rolled.media!.steps).toMatchObject({ create: 'failed', rollback: 'ok', start: 'ok', health: 'ok' });
    expect(w.logs()).toContain('media server data restored from the safety snapshot');
    expect(w.media().lastError).toBe('restore_failed');

    // the rollback fails too: half-restored data is never started on
    const failed = await again(() => new StepError('helper_timeout'));
    expect(failed).toMatchObject({ state: 'failed', error: 'restore_failed' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', 'helper restore', 'helper restore']);
    expect(failed.media!.steps).toMatchObject({ create: 'failed', rollback: 'failed', start: 'skipped' });
    expect(w.find(N.container)!.running).toBe(false);

    // a later restore whose safety snapshot fails changes nothing, and does not start the half-restored server either
    w.cfg.answer = (c) => (c.verb === 'backup' ? { error: 'helper_failed' } : answer(c));
    w.calls.length = 0;
    const nosnap = await w.run({ op: 'restore', id });
    expect(nosnap).toMatchObject({ state: 'failed', error: 'snapshot_failed' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup']);
    // with the server running, a failed safety snapshot starts it again
    w.find(N.container)!.running = true;
    w.calls.length = 0;
    expect(await w.run({ op: 'restore', id })).toMatchObject({ state: 'failed', error: 'snapshot_failed' });
    expect(w.calls).toEqual([`stop ${N.container}`, 'helper backup', `start ${N.container}`]);

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

  it('restore checks the whole archive before it empties the data folder', async () => {
    const out = tempDir();
    const target = dataDir();
    const before = (): string[] => execFileSync('find', [target]).toString().split('\n').sort();
    const snapshot = before();
    const meta: ArchiveMeta = { v: 1, kind: 'jellyfin', upstream: '10.11.3', createdAt: new Date(T0).toISOString() };
    const store = (id: string, bytes: Buffer): string => { writeFileSync(join(out, `${id}.tar.gz`), bytes); return id; };
    // cut short after the metadata entry; a broken tar after it; a valid one too big for the disk
    const src = tempDir();
    writeFileSync(join(src, 'library.db'), randomBytes(200_000));
    const data = execFileSync('tar', ['-c', '-f', '-', '-C', src, 'library.db']);
    const cut = store('jellyfin-20261117-1402-10.11.3', gzipSync(Buffer.concat([metaEntry(meta), data])).subarray(0, 80_000));
    const broken = store('jellyfin-20261117-1403-10.11.3', gzipSync(Buffer.concat([metaEntry(meta), randomBytes(4096)])));
    const big = store('jellyfin-20261117-1404-10.11.3', gzipSync(Buffer.concat([metaEntry(meta), data])));
    for (const id of [cut, broken]) await expect(restoreBackup({ data: target, backups: out }, { id, kind: 'jellyfin' })).rejects.toMatchObject({ code: 'backup_invalid' });
    await expect(restoreBackup({ data: target, backups: out }, { id: big, kind: 'jellyfin' }, { room: async () => 100_000 })).rejects.toMatchObject({ code: 'backup_invalid' });
    expect(before()).toEqual(snapshot);
    // a tar that lists but cannot extract: the folder was emptied, the job's rollback takes over
    const fake = join(tempDir(), 'tar');
    writeFileSync(fake, '#!/bin/sh\ncase "$1" in -t) cat >/dev/null; exit 0;; *) exit 1;; esac\n');
    chmodSync(fake, 0o755);
    await expect(restoreBackup({ data: target, backups: out }, { id: big, kind: 'jellyfin' }, { tar: fake })).rejects.toMatchObject({ code: 'restore_failed' });
    // and the real one restores it
    expect(await restoreBackup({ data: target, backups: out }, { id: big, kind: 'jellyfin' })).toEqual({ ok: true });
    expect(readdirSync(target)).toEqual(['library.db']);
  });

  /** one tar entry (ustar header + content padded to whole blocks) */
  function tarEntry(name: string, body = '', o: { type?: string; link?: string; prefix?: string } = {}): Buffer {
    const content = Buffer.from(body, 'utf8');
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100, 'latin1');
    h.write('0000000\0', 108, 'latin1');
    h.write('0000000\0', 116, 'latin1');
    h.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    h.write('00000000000\0', 136, 'latin1');
    h.write(o.type ?? '0', 156, 'latin1');
    h.write(o.link ?? '', 157, 'utf8');
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    h.write(o.prefix ?? '', 345, 'utf8');
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    return Buffer.concat([h, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
  }
  /** the header checksum again after a change */
  function fixSum(e: Buffer): Buffer {
    e.fill(' ', 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += e[i]!;
    e.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    return e;
  }
  /** a pax extended header record set (`<len> key=value\n`) */
  const pax = (kv: Record<string, string>): string => Object.entries(kv).map(([k, v]) => {
    const rec = ` ${k}=${v}\n`;
    let len = rec.length + 1;
    while (`${len}${rec}`.length !== len) len++;
    return `${len}${rec}`;
  }).join('');

  it('restore refuses an archive whose entries leave the data folder, before anything changes', async () => {
    const out = tempDir();
    const parent = tempDir();
    const target = join(parent, 'data');
    mkdirSync(target);
    writeFileSync(join(target, 'library.db'), 'keep');
    const meta: ArchiveMeta = { v: 1, kind: 'ferrofin', upstream: 'v1.5.1', createdAt: new Date(T0).toISOString() };
    const end = Buffer.alloc(1024);
    const hostile: Record<string, Buffer[]> = {
      'a relative path out': [tarEntry('ok.txt', 'ok'), tarEntry('../escaped.txt', 'x')],
      'a path out further down': [tarEntry('metadata/../../escaped.txt', 'x')],
      'an absolute path': [tarEntry('/tmp/escaped.txt', 'x')],
      'a ustar prefix out': [tarEntry('escaped.txt', 'x', { prefix: '..' })],
      'a GNU long name out': [tarEntry('././@LongLink', '../escaped.txt\0', { type: 'L' }), tarEntry('placeholder', 'x')],
      'a pax path out': [tarEntry('PaxHeaders/x', pax({ path: '/escaped.txt' }), { type: 'x' }), tarEntry('placeholder', 'x')],
      'a global pax path out': [tarEntry('GlobalHead', pax({ path: '../escaped.txt' }), { type: 'g' }), tarEntry('ok.txt', 'x')],
      'a hard link out': [tarEntry('passwd', '', { type: '1', link: '/etc/passwd' })],
      'a GNU long link out': [tarEntry('././@LongLink', '../../etc/passwd\0', { type: 'K' }), tarEntry('passwd', '', { type: '1', link: 'placeholder' })],
      'a symlink out': [tarEntry('up', '', { type: '2', link: '../..' })],
      'an absolute symlink': [tarEntry('etc', '', { type: '2', link: '/etc' })],
      'a broken header': [tarEntry('ok.txt', 'ok').fill(7, 148, 150)],
      // busybox ends the archive only at two empty blocks in a row: one is skipped and the next entry still extracted
      'an entry after one empty block': [tarEntry('ok.txt', 'ok'), Buffer.alloc(512), tarEntry('../escaped.txt', 'x')],
      'a pax path for an empty block': [tarEntry('PaxHeaders/x', pax({ path: 'fine.txt' }), { type: 'x' }), Buffer.alloc(512), tarEntry('../escaped.txt', 'x')],
      'a prefix without the ustar magic': [(() => { const e = tarEntry('escaped.txt', 'x', { prefix: '..' }); e.write('xxxxx', 257, 'latin1'); return fixSum(e); })()],
    };
    let n = 0;
    for (const [what, entries] of Object.entries(hostile)) {
      const id = `ferrofin-20261117-${String(1000 + n++)}-v1.5.1`;
      writeFileSync(join(out, `${id}.tar.gz`), gzipSync(Buffer.concat([metaEntry(meta), ...entries, end])));
      const r = await restoreBackup({ data: target, backups: out }, { id, kind: 'ferrofin' }).then(() => 'restored', (e: { code?: string }) => e.code);
      expect([what, r]).toEqual([what, 'backup_invalid']);
      expect(readdirSync(parent)).toEqual(['data']);
      expect(readdirSync(target)).toEqual(['library.db']);
    }
    // the same layout with safe names restores, long names (GNU tar's own long-name entries) included
    const src = tempDir();
    const deep = join('metadata', 'a'.repeat(90), 'b'.repeat(90));
    mkdirSync(join(src, deep), { recursive: true });
    writeFileSync(join(src, deep, 'poster.jpg'), 'p');
    writeFileSync(join(src, 'library.db'), 'db');
    const id = 'ferrofin-20261117-1500-v1.5.1';
    const body = execFileSync('tar', ['--format=gnu', '-c', '-f', '-', '-C', src, 'library.db', 'metadata']);
    writeFileSync(join(out, `${id}.tar.gz`), gzipSync(Buffer.concat([metaEntry(meta), tarEntry('PaxHeaders/y', pax({ comment: 'fine' }), { type: 'x' }), body])));
    expect(await restoreBackup({ data: target, backups: out }, { id, kind: 'ferrofin' })).toEqual({ ok: true });
    expect(readFileSync(join(target, deep, 'poster.jpg'), 'utf8')).toBe('p');
    expect(readdirSync(parent)).toEqual(['data']);
  });

  it('a failing tar leaves no part file', async () => {
    const data = dataDir();
    const out = tempDir();
    const id = 'jellyfin-20261117-1402-10.11.3';
    await expect(writeBackup({ data, backups: out }, { id, trickplay: false, kind: 'jellyfin', upstream: '10.11.3' }, new Date(T0), 'false')).rejects.toMatchObject({ code: 'backup_failed' });
    expect(readdirSync(out)).toEqual([]);
  });
});
