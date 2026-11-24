// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePassphrase, encodePassphrase, mediaDownload, mediaOp, mediaScan, mediaUpload, parseMediaStatus, startMediaJob } from '../src/mediaserver/client.js';
import { parseStatus, streamBinding, updaterView } from '../src/updater.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

const SECRET = cfg.INTERNAL_SECRET;
const JOB_ID = '0fedcba987654321';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const fullStatus = () => ({
  available: true, reason: null,
  base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: { kind: 'ferrofin', folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien/Kinder', target: '/media/serien-kinder' }], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: 44, egress: false, run: true },
  container: { state: 'running', health: 'healthy', kind: 'ferrofin', image: { digest: DIGEST, upstream: '1.2.3' }, template: 'current', tampered: false, createdAt: '2026-11-17T10:00:00.000Z' },
  pin: { image: `ghcr.io/example/friendflix-mediaserver@${DIGEST}`, upstream: '1.2.3', changed: false },
  pins: { ferrofin: true, jellyfin: true },
  engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false },
  error: null,
  backups: [{ id: 'ferrofin-20261117-1000-1.2.3', kind: 'ferrofin', upstream: '1.2.3', at: '2026-11-17T10:00:00.000Z', tag: 'manual', size: 1234 }],
  hdr: { kind: 'ferrofin', at: '2026-11-17T10:05:00.000Z', opencl: 'pass', qsv: 'fail' },
  move: null, source: null,
});
const CONTAINER = 'c'.repeat(64);
const SERVER_ID = 'f'.repeat(32);
const baseStatus = (extra: Record<string, unknown>) => ({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job: null, log: [], services: [], ...extra });
const mediaJob = (state: string, error: string | null = null) => ({ id: JOB_ID, action: 'mediaserver-apply', state, step: state === 'running' ? 'pull' : null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' },
  startedAt: '2026-11-17T10:00:00.000Z', finishedAt: state === 'running' ? null : '2026-11-17T10:01:00.000Z', error,
  media: { step: state === 'running' ? 'pull' : null, steps: { check: 'ok', pull: state === 'running' ? 'running' : 'ok', verify: 'pending', snapshot: 'bogus', create: 'pending', start: 'pending', health: 'pending', rollback: 'pending' } } });

const fake = {
  state: 'running', error: null as string | null, answer: undefined as { status: number; json: unknown } | undefined, reset: false,
  calls: [] as Array<{ method: string; path: string; body: string; signed: string; sigOk: boolean; headers: Record<string, string> }>,
};
/** the verify semantics of updater/src/protocol.ts (test-vectors/updater-hmac.json), over the string that is signed in place of the body
 * (the body, or for a stream streamBinding of the passphrase header as sent) */
function sigOk(method: string, path: string, signed: string, h: Record<string, string>): boolean {
  const key = createHmac('sha256', SECRET).update('friendflix-updater/v1').digest();
  const canon = [method, path, h['x-ff-updater-ts'], h['x-ff-updater-nonce'], createHash('sha256').update(signed).digest('hex')].join('\n');
  return h['x-ff-updater-signature'] === `v1=${createHmac('sha256', key).update(canon).digest('hex')}`;
}
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const method = init?.method ?? 'GET';
  const h = init?.headers as Record<string, string>;
  const body = typeof init?.body === 'string' ? init.body : '';
  const stream = u.pathname.startsWith('/v1/mediaserver/backups/');
  const signed = stream ? streamBinding(h['x-ff-backup-passphrase'] ?? '') : body;
  fake.calls.push({ method, path: u.pathname, body, signed, sigOk: sigOk(method, u.pathname, signed, h), headers: h });
  if (fake.reset) throw new TypeError('fetch failed');
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.pathname === '/v1/status') return j(baseStatus({ mediaserver: fullStatus(), job: mediaJob(fake.state, fake.error) }));
  if (fake.answer) return j(fake.answer.json, fake.answer.status);
  if (u.pathname === '/v1/mediaserver') return j({ job: mediaJob('running') }, 202);
  if (u.pathname.endsWith('/download')) return new Response('age-bytes', { status: 200 });
  if (u.pathname.endsWith('/upload')) return j({ backup: fullStatus().backups[0] });
  return j({ error: 'not_found' }, 404);
}) as typeof fetch;

let env: TestEnv, adminId: string;
const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
beforeAll(async () => {
  env = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; } });
  await env.login(ADMIN);
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
});
afterAll(async () => { await env.pool.end(); });
beforeEach(async () => {
  Object.assign(fake, { state: 'running', error: null, answer: undefined, reset: false, calls: [] });
  await env.pool.query('delete from audit_log');
  for (const k of await env.ctx.kv.keys('updater:pending:')) await env.ctx.kv.del(k);
});

describe('parseMediaStatus', () => {
  it('parses a full media status', () => {
    expect(parseMediaStatus(fullStatus())).toEqual(fullStatus());
  });

  it('keeps the starting view (the updater has read no media status yet since it started)', () => {
    const starting = {
      available: false, reason: 'starting', base: { set: false, path: null, pending: false, expiresAt: null }, desired: null, container: null, pin: null,
      pins: { ferrofin: false, jellyfin: false }, engine: { api: null, logs: false, arch: null, nvidia: false }, error: null, backups: [], hdr: null,
      move: null, source: null,
    };
    expect(parseMediaStatus(starting)).toEqual(starting);
    expect(parseMediaStatus({ ...starting, reason: 'whatever' })!.reason).toBeNull();
  });

  it('drops what does not fit', () => {
    const raw = fullStatus() as Record<string, any>;
    raw.base.path = '/srv/media\n/etc';
    raw.container.kind = 'plex';
    raw.desired.kind = 'plex';
    raw.desired.folders.push({ rel: '../x', target: '/media/x' }, { rel: 'ok', target: '/etc' });
    raw.pin.image = 'x'.repeat(5) + ' y';
    raw.backups = Array.from({ length: 30 }, (_, i) => ({ ...fullStatus().backups[0], id: `ferrofin-20261117-1000-${i}` }));
    raw.backups.push({ ...fullStatus().backups[0], id: 'nope' });
    raw.error = 'whatever';
    raw.hdr.opencl = 'maybe';
    const p = parseMediaStatus(raw)!;
    expect(p.base.path).toBeNull();
    expect(p.container).toBeNull();
    expect(p.desired).toBeNull();
    expect(p.pin!.image).toBeNull();
    expect(p.backups).toHaveLength(10);
    expect(p.error).toBeNull();
    expect(p.hdr).toBeNull();
    const d = parseMediaStatus({ ...fullStatus(), container: { ...fullStatus().container, image: { digest: `sha256:${'b'.repeat(65)}`, upstream: '1' } }, desired: { ...fullStatus().desired, folders: [...fullStatus().desired.folders, { rel: '../x', target: '/media/x' }, { rel: 'ok', target: '/etc' }] } })!;
    expect(d.container!.image.digest).toBe('');
    expect(d.desired!.folders).toHaveLength(2);
    expect(parseMediaStatus({ ...fullStatus(), desired: { ...fullStatus().desired, folders: Array.from({ length: 30 }, (_, i) => ({ rel: `f${i}`, target: `/media/f${i}` })) } })!.desired!.folders).toHaveLength(20);
  });

  it('a move, its source and migrated folders parse field by field', () => {
    const folders = [{ rel: 'Filme', target: '/movies', migrated: true }, { rel: '', target: '/media', migrated: true }, { rel: 'Serien/HD', target: '/data/tv', migrated: true }];
    const move = { phase: 'running', step: 'copy_bulk', source: { name: 'jellyfin', version: '10.10.3' }, folders, abort: false };
    const source = { name: 'jellyfin', state: 'exited', version: '10.10.3' };
    const desired = { ...fullStatus().desired, migrated: true, folders: [...folders, { rel: 'Neu', target: '/ffmedia/neu' }] };
    const p = parseMediaStatus({ ...fullStatus(), desired, move, source })!;
    expect(p.move).toEqual(move);
    expect(p.source).toEqual(source);
    expect(p.desired).toEqual(desired);
    // a migrated target the updater refuses, an empty rel without the migrated flag, a system tree: dropped
    const bad = [{ rel: 'x', target: '/etc/x', migrated: true }, { rel: '', target: '/media/x' }, { rel: 'y', target: '/data', migrated: true },
      { rel: 'z', target: '/movies' }, { rel: '..', target: '/a', migrated: true }, { rel: 'w', target: '/a/b/c/d', migrated: true }, { rel: 'v', target: '/proc', migrated: true }];
    expect(parseMediaStatus({ ...fullStatus(), move: { ...move, folders: [...folders, ...bad] } })!.move!.folders).toEqual(folders);
    expect(parseMediaStatus({ ...fullStatus(), move: { ...move, phase: 'whatever' } })!.move).toBeNull();
    expect(parseMediaStatus({ ...fullStatus(), move: { ...move, source: { name: '/etc/passwd', version: null } } })!.move).toBeNull();
    expect(parseMediaStatus({ ...fullStatus(), move: { ...move, step: 'bogus', abort: 'yes' } })!.move).toEqual({ ...move, step: null, abort: false });
    expect(parseMediaStatus({ ...fullStatus(), source: { name: 'jellyfin', state: 'Exited!', version: 7 } })!.source).toEqual({ name: 'jellyfin', state: 'unknown', version: null });
    expect(parseMediaStatus({ ...fullStatus(), source: { name: '' } })!.source).toBeNull();
  });

  it('move jobs parse with their steps', () => {
    const steps = { check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'skipped', copy_bulk: 'ok', stop_source: 'ok', copy: 'running', create: 'pending', start: 'pending', health: 'pending', adopt: 'pending', rollback: 'pending' };
    const j = parseStatus(baseStatus({ job: { ...mediaJob('running'), action: 'mediaserver-migrate', media: { step: 'copy', steps } } }))!.job!;
    expect(j).toMatchObject({ action: 'mediaserver-migrate', media: { step: 'copy', steps } });
    expect(parseStatus(baseStatus({ job: { ...mediaJob('running'), action: 'mediaserver-source' } }))!.job!.action).toBe('mediaserver-source');
  });

  it('old updater without mediaserver is null', () => {
    expect(parseMediaStatus(undefined)).toBeNull();
    expect(parseMediaStatus('x')).toBeNull();
    expect(parseStatus(baseStatus({}))!.mediaserver).toBeNull();
    expect(parseStatus(baseStatus({ mediaserver: fullStatus() }))!.mediaserver).toEqual(fullStatus());
  });

  it('helper_failed and helper_timeout survive parsing as error', () => {
    expect(parseMediaStatus({ ...fullStatus(), error: 'helper_failed' })!.error).toBe('helper_failed');
    expect(parseMediaStatus({ ...fullStatus(), error: 'helper_timeout' })!.error).toBe('helper_timeout');
  });

  it('media jobs parse with their steps', () => {
    const s = parseStatus(baseStatus({ job: mediaJob('succeeded_mediaserver_failed', 'helper_failed') }))!;
    expect(s.job).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded_mediaserver_failed', error: 'helper_failed',
      media: { step: null, steps: { check: 'ok', pull: 'ok', verify: 'pending', snapshot: 'pending', create: 'pending', start: 'pending', health: 'pending', rollback: 'pending' } } });
    expect(parseStatus(baseStatus({ job: { ...mediaJob('running'), media: undefined } }))!.job!.media).toBeNull();
  });
});

describe('signed calls', () => {
  it('signs media ops and stream calls', async () => {
    const body = { op: 'apply', spec: { kind: 'ferrofin' } };
    const r = await mediaOp(env.ctx, body);
    expect(r?.status).toBe(202);
    const c = fake.calls[0]!;
    expect(c).toMatchObject({ method: 'POST', path: '/v1/mediaserver', body: JSON.stringify(body), sigOk: true });
    expect(c.headers['content-type']).toBe('application/json');

    const pass = 'zażółć gęślą jaźń';
    const header = encodePassphrase(pass);
    expect(decodePassphrase(header)).toBe(pass);
    const ac = new AbortController();
    const dl = await mediaDownload(env.ctx, 'ferrofin-20261117-1000-1.2.3', header, ac.signal);
    expect(await dl!.text()).toBe('age-bytes');
    const d = fake.calls[1]!;
    expect(d).toMatchObject({ method: 'GET', path: '/v1/mediaserver/backups/ferrofin-20261117-1000-1.2.3/download', signed: streamBinding(header), sigOk: true });
    // a tampered header fails verification
    expect(sigOk(d.method, d.path, streamBinding(`${header.slice(0, -1)}${header.endsWith('A') ? 'B' : 'A'}`), d.headers)).toBe(false);
    expect(d.headers['x-ff-backup-passphrase']).toBe(header);

    const up = await mediaUpload(env.ctx, Readable.from([Buffer.from('abc')]), 3, header, ac.signal);
    expect(up?.status).toBe(200);
    const u = fake.calls[2]!;
    expect(u).toMatchObject({ method: 'POST', path: '/v1/mediaserver/backups/upload', signed: streamBinding(header), sigOk: true });
    expect(u.headers['content-length']).toBe('3');
    // a bad id never leaves the process
    expect(await mediaDownload(env.ctx, '../x', header, ac.signal)).toBeNull();
    expect(fake.calls).toHaveLength(3);
  });

  it('passphrase length is counted in code points', () => {
    expect(decodePassphrase(encodePassphrase('a'.repeat(11)))).toBeNull();
    expect(decodePassphrase(encodePassphrase('a'.repeat(12)))).toBe('a'.repeat(12));
    expect(decodePassphrase(encodePassphrase('😀'.repeat(12)))).toBe('😀'.repeat(12));
    expect(decodePassphrase(encodePassphrase('a'.repeat(1025)))).toBeNull();
    expect(decodePassphrase(undefined)).toBeNull();
    expect(decodePassphrase('not base64!')).toBeNull();
  });

  it('a reset connection is a null answer, not a crash', async () => {
    fake.reset = true;
    const ac = new AbortController();
    expect(await mediaUpload(env.ctx, Readable.from([Buffer.from('abc')]), 3, encodePassphrase('a'.repeat(12)), ac.signal)).toBeNull();
    expect(await mediaDownload(env.ctx, 'ferrofin-20261117-1000-1.2.3', encodePassphrase('a'.repeat(12)), ac.signal)).toBeNull();
    expect(await mediaOp(env.ctx, { op: 'gpu' })).toBeNull();
  });
});

describe('mediaScan', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({ id: CONTAINER, name: 'jellyfin', image: 'lscr.io/linuxserver/jellyfin:10.10.3', state: 'running', matches: true, ...over });
  const scan = () => ({ source: { id: CONTAINER, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', version: '10.10.3' },
    folders: [{ rel: '', target: '/media', migrated: true }], layout: 'official', bytes: 38_000, trickplayBytes: 12_000, plugins: ['Open Subtitles', 'Fanart'], nfo: true });
  const timeouts = () => vi.spyOn(AbortSignal, 'timeout');

  it('the candidate list: serverId sent, the answer checked field by field, a longer deadline', async () => {
    const spy = timeouts();
    fake.answer = { status: 200, json: { candidates: [candidate(), candidate({ id: 'x', name: 'bad' }), candidate({ id: 'd'.repeat(64), name: 'jf/../x', matches: null }), candidate({ id: 'e'.repeat(64), name: 'jf-2', matches: null, state: 'exited', extra: 1 })] } };
    const r = await mediaScan(env.ctx, undefined, SERVER_ID);
    expect(JSON.parse(fake.calls[0]!.body)).toEqual({ op: 'migrate-scan', serverId: SERVER_ID });
    expect(fake.calls[0]!.sigOk).toBe(true);
    expect(spy).toHaveBeenCalledWith(45_000);
    expect(r).toEqual({ ok: true, candidates: [candidate(), { id: 'e'.repeat(64), name: 'jf-2', image: 'lscr.io/linuxserver/jellyfin:10.10.3', state: 'exited', matches: null }], scan: null });
    spy.mockRestore();
  });

  it('the sized scan of one source', async () => {
    const spy = timeouts();
    fake.answer = { status: 200, json: { candidates: [candidate()], scan: scan() } };
    const r = await mediaScan(env.ctx, CONTAINER, SERVER_ID);
    expect(JSON.parse(fake.calls[0]!.body)).toEqual({ op: 'migrate-scan', serverId: SERVER_ID, source: CONTAINER });
    expect(spy).toHaveBeenCalledWith(150_000);
    expect(r).toEqual({ ok: true, candidates: [candidate()], scan: scan() });
    // a scan that does not fit is no scan
    fake.answer = { status: 200, json: { candidates: [candidate()], scan: { ...scan(), layout: 'other' } } };
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toMatchObject({ ok: true, scan: null });
    fake.answer = { status: 200, json: { candidates: [candidate()], scan: { ...scan(), plugins: ['ok', 'a\nb', 7], bytes: -1 } } };
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toMatchObject({ ok: true, scan: null });
    fake.answer = { status: 200, json: { candidates: [candidate()], scan: { ...scan(), plugins: ['ok', 'a\nb', 7] } } };
    expect(((await mediaScan(env.ctx, CONTAINER, SERVER_ID)) as { scan: { plugins: string[] } }).scan.plugins).toEqual(['ok']);
    spy.mockRestore();
  });

  it('refusals carry their code and the container paths the web shows, nothing else', async () => {
    fake.answer = { status: 409, json: { error: 'source_outside_base', outside: ['/movies', 'relative', '/a\nb'], refused: ['/config2'], host: '/srv/secret' } };
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toEqual({ ok: false, status: 409, error: 'source_outside_base', outside: ['/movies'], refused: ['/config2'], nested: [] });
    fake.answer = { status: 409, json: { error: 'source_nested', nested: ['/media/tv'] } };
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toEqual({ ok: false, status: 409, error: 'source_nested', outside: [], refused: [], nested: ['/media/tv'] });
    fake.answer = { status: 409, json: { error: 'Error: /var/run/docker.sock' } };
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toEqual({ ok: false, status: 502, error: 'updater_error', outside: [], refused: [], nested: [] });
    fake.answer = { status: 400, json: { error: 'invalid_body' } };
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toMatchObject({ ok: false, status: 400, error: 'invalid_body' });
    fake.reset = true;
    expect(await mediaScan(env.ctx, CONTAINER, SERVER_ID)).toMatchObject({ ok: false, status: 409, error: 'not_available' });
  });
});

describe('media jobs', () => {
  it('move ops start the move and source jobs, audited under their own action; a pending entry is never replaced', async () => {
    fake.answer = { status: 202, json: { job: { ...mediaJob('running'), action: 'mediaserver-migrate' } } };
    expect(await startMediaJob(env.ctx, { op: 'migrate', source: CONTAINER }, adminId, { trickplay: false, gpu: 'off' }, 'mediaserver.move')).toMatchObject({ ok: true });
    expect(await audits('mediaserver.move')).toEqual([{ actor: adminId, meta: { trickplay: false, gpu: 'off' } }]);
    // an abort while the move's job runs answers that very job: its result stays the move's
    expect(await startMediaJob(env.ctx, { op: 'migrate-abort' }, null, {}, 'mediaserver.move_abort')).toMatchObject({ ok: true, job: { action: 'mediaserver-migrate' } });
    expect(JSON.parse((await env.ctx.kv.get(`updater:pending:${JOB_ID}`))!)).toEqual({ actor: adminId, action: 'mediaserver', op: 'migrate' });
    expect(await audits('mediaserver.move_abort')).toEqual([{ actor: null, meta: {} }]);
    fake.answer = { status: 202, json: { job: { ...mediaJob('running'), action: 'mediaserver-source' } } };
    expect((await startMediaJob(env.ctx, { op: 'source-start' }, adminId, {}, 'mediaserver.back')).ok).toBe(true);
    expect(await audits('mediaserver.action')).toEqual([]);
  });

  it('a started job is recorded and audited', async () => {
    const r = await startMediaJob(env.ctx, { op: 'apply', spec: {} }, adminId, { kind: 'ferrofin', folders: 2, gpu: 'dri', egress: false });
    expect(r).toMatchObject({ ok: true, job: { id: JOB_ID, action: 'mediaserver-apply' } });
    expect((await audits('mediaserver.apply'))).toEqual([{ actor: adminId, meta: { kind: 'ferrofin', folders: 2, gpu: 'dri', egress: false } }]);
    expect(JSON.parse((await env.ctx.kv.get(`updater:pending:${JOB_ID}`))!)).toEqual({ actor: adminId, action: 'mediaserver', op: 'apply' });
  });

  it('other ops audit mediaserver.action, a refusal starts nothing', async () => {
    fake.answer = { status: 409, json: { error: 'busy' } };
    expect(await startMediaJob(env.ctx, { op: 'stop' }, adminId, {})).toEqual({ ok: false, status: 409, error: 'busy' });
    expect(await audits('mediaserver.action')).toEqual([]);
    expect(await env.ctx.kv.keys('updater:pending:')).toEqual([]);
    fake.answer = undefined;
    // finish-setup is the mediaserver-finish job, answered here as an apply job: not the one asked for
    expect((await startMediaJob(env.ctx, { op: 'finish-setup' }, adminId, {})).ok).toBe(false);
  });

  it('the audited op is the one started, whatever auditMeta carries', async () => {
    fake.answer = { status: 202, json: { job: { ...mediaJob('running'), action: 'mediaserver-stop' } } };
    expect((await startMediaJob(env.ctx, { op: 'stop' }, adminId, { op: 'remove', auto: true })).ok).toBe(true);
    expect((await audits('mediaserver.action')).map((a) => a.meta)).toEqual([{ op: 'stop', auto: true }]);
  });

  it('the result of a media job is audited as mediaserver.result once', async () => {
    await startMediaJob(env.ctx, { op: 'apply', spec: {} }, adminId, { kind: 'ferrofin', folders: 0, gpu: 'off', egress: false });
    fake.state = 'failed'; fake.error = 'helper_failed';
    await updaterView(env.ctx);
    await updaterView(env.ctx);
    expect(await audits('mediaserver.result')).toEqual([{ actor: adminId, meta: { action: 'mediaserver-apply', result: 'failed', error: 'helper_failed' } }]);
    expect(await audits('system.updater_result')).toEqual([]);
  });
});
