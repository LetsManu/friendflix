// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodePassphrase, encodePassphrase, mediaDownload, mediaOp, mediaUpload, parseMediaStatus, startMediaJob } from '../src/mediaserver/client.js';
import { parseStatus, updaterView } from '../src/updater.js';
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
});
const baseStatus = (extra: Record<string, unknown>) => ({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job: null, log: [], services: [], ...extra });
const mediaJob = (state: string, error: string | null = null) => ({ id: JOB_ID, action: 'mediaserver-apply', state, step: state === 'running' ? 'pull' : null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' },
  startedAt: '2026-11-17T10:00:00.000Z', finishedAt: state === 'running' ? null : '2026-11-17T10:01:00.000Z', error,
  media: { step: state === 'running' ? 'pull' : null, steps: { check: 'ok', pull: state === 'running' ? 'running' : 'ok', verify: 'pending', snapshot: 'bogus', create: 'pending', start: 'pending', health: 'pending', rollback: 'pending' } } });

const fake = {
  state: 'running', error: null as string | null, answer: undefined as { status: number; json: unknown } | undefined, reset: false,
  calls: [] as Array<{ method: string; path: string; body: string; signed: string; sigOk: boolean; headers: Record<string, string> }>,
};
/** the verify semantics of updater/src/protocol.ts (test-vectors/updater-hmac.json), over the string that is signed in place of the body */
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
  const signed = stream ? (h['x-ff-backup-passphrase'] ?? '') : body;
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
    expect(d).toMatchObject({ method: 'GET', path: '/v1/mediaserver/backups/ferrofin-20261117-1000-1.2.3/download', signed: header, sigOk: true });
    expect(d.headers['x-ff-backup-passphrase']).toBe(header);

    const up = await mediaUpload(env.ctx, Readable.from([Buffer.from('abc')]), 3, header, ac.signal);
    expect(up?.status).toBe(200);
    const u = fake.calls[2]!;
    expect(u).toMatchObject({ method: 'POST', path: '/v1/mediaserver/backups/upload', signed: header, sigOk: true });
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

describe('media jobs', () => {
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
