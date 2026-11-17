// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePassphrase } from '../src/mediaserver/client.js';
import { streamBinding } from '../src/updater.js';
import { sessionKey } from '../src/session.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const SECRET = 'internal-secret-123456';
const ID = 'ferrofin-20261117-1000-1.2.3';
const UPLOADED = { id: 'ferrofin-20261117-1100-1.2.3', kind: 'ferrofin', upstream: '1.2.3', at: '2026-11-17T11:00:00.000Z', tag: 'upload', size: 4321 };
/** Polish, 17 code points */
const PASS = 'Zażółć gęślą jaźń';
const ENC = encodePassphrase(PASS);
const MB = 1024 * 1024;
const GiB = 1024 ** 3;

const media = () => ({
  available: true, reason: null, base: { set: true, path: '/srv/media', pending: false, expiresAt: null }, desired: null,
  container: { state: 'running', health: 'healthy', kind: 'ferrofin', image: { digest: `sha256:${'a'.repeat(64)}`, upstream: '1.2.3' }, template: 'current', tampered: false, createdAt: '2026-11-17T10:00:00.000Z' },
  pin: null, pins: { ferrofin: true, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null,
  backups: [{ id: ID, kind: 'ferrofin', upstream: '1.2.3', at: '2026-11-17T10:00:00.000Z', tag: 'manual', size: 1234 }], hdr: null,
});
const job = (action: string) => ({ id: '00000000000000a1', action, state: 'running', step: null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-17T10:00:00.000Z', finishedAt: null, error: null,
  media: { step: 'check', steps: {} } });

/** the verify semantics of updater/src/protocol.ts, over the scrypt derivation of the passphrase header (streamBinding) that the stream routes sign in place of the body */
function sigOk(method: string, path: string, signed: string, h: Record<string, string>): boolean {
  const key = createHmac('sha256', SECRET).update('friendflix-updater/v1').digest();
  const canon = [method, path, h['x-ff-updater-ts'], h['x-ff-updater-nonce'], createHash('sha256').update(signed).digest('hex')].join('\n');
  return h['x-ff-updater-signature'] === `v1=${createHmac('sha256', key).update(canon).digest('hex')}`;
}

/** 5 MB in five 1-MB chunks */
const FILE = randomBytes(5 * MB);
interface StreamCall { method: string; path: string; headers: Record<string, string>; sigOk: boolean; signal: AbortSignal | undefined }
const fake = {
  ops: [] as Array<Record<string, unknown>>,
  streams: [] as StreamCall[],
  /** a fixed answer instead of the stream (download) or the backup (upload) */
  download: null as { status: number; json: unknown } | null,
  upload: null as { status: number; json: unknown } | null,
  /** the bytes the fake updater received on upload */
  received: null as Buffer | null,
  /** the download sends its first chunk, then waits for this */
  release: () => {},
  done: false,
};

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.pathname === '/v1/status') {
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job: null, log: [], services: [], mediaserver: media() });
  }
  if (u.pathname === '/v1/mediaserver') {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    fake.ops.push(body);
    return j({ job: job(`mediaserver-${String(body.op)}`) }, 202);
  }
  const h = init?.headers as Record<string, string>;
  const method = init?.method ?? 'GET';
  fake.streams.push({ method, path: u.pathname, headers: h, sigOk: sigOk(method, u.pathname, streamBinding(h['x-ff-backup-passphrase'] ?? ''), h), signal: init?.signal ?? undefined });
  if (u.pathname === `/v1/mediaserver/backups/${ID}/download`) {
    if (fake.download) return j(fake.download.json, fake.download.status);
    const released = new Promise<void>((resolve) => { fake.release = resolve; });
    const signal = init?.signal;
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) { signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); },
      async pull(c) {
        if (n === 1) await released;
        if (signal?.aborted) return;
        if (n === 5) { fake.done = true; c.close(); return; }
        c.enqueue(new Uint8Array(FILE.subarray(n * MB, (n + 1) * MB)));
        n++;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="other.sh"' } });
  }
  if (u.pathname === '/v1/mediaserver/backups/upload') {
    const parts: Buffer[] = [];
    for await (const c of init!.body as unknown as AsyncIterable<Buffer>) parts.push(Buffer.from(c));
    fake.received = Buffer.concat(parts);
    if (fake.upload) return j(fake.upload.json, fake.upload.status);
    return j({ backup: UPLOADED });
  }
  return j({ error: 'not_found' }, 404);
}) as typeof fetch;

type Sess = { cookies: Record<string, string>; csrf: string };

describe('media server backup streams', () => {
  let env: TestEnv;
  let admin: Sess;
  const logs: string[] = [];
  /** each test runs 11 minutes after the last one: the portal-wide limits of the earlier tests are over (Date.now only) */
  let offset = 0;
  const realNow = Date.now.bind(Date);
  const reauth = async (s: Sess, at = Date.now()) => {
    const key = sessionKey(s.cookies.ff_sid!);
    await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: at }), 600);
  };
  const audits = async (action: string) => (await env.pool.query<{ meta: Record<string, unknown> }>('select meta from audit_log where action=$1 order by id', [action])).rows.map((r) => r.meta);
  /** `stream`: the answer as it arrives (payloadAsStream) */
  const download = (id: string, header: string | null = ENC, extra: { stream?: boolean; signal?: AbortSignal } = {}) =>
    env.app.inject({ method: 'GET', url: `/api/admin/mediaserver/backups/${id}/download`, cookies: admin.cookies, headers: header === null ? {} : { 'x-ff-backup-passphrase': header },
      ...(extra.stream ? { payloadAsStream: true } : {}), ...(extra.signal ? { signal: extra.signal } : {}) });
  const upload = (payload: Buffer | Readable, headers: Record<string, string> = {}, header: string | null = ENC) =>
    env.app.inject({ method: 'POST', url: '/api/admin/mediaserver/backups/upload', cookies: admin.cookies,
      headers: { 'x-csrf-token': admin.csrf, 'content-type': 'application/octet-stream', ...(header === null ? {} : { 'x-ff-backup-passphrase': header }), ...headers }, payload });
  const collect = async (s: AsyncIterable<Buffer>) => { const parts: Buffer[] = []; for await (const c of s) parts.push(Buffer.from(c)); return Buffer.concat(parts); };

  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    env = await makeEnv({}, {
      ctxPatch: (c) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; },
      logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' },
    });
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });
  beforeEach(async () => {
    offset += 11 * 60_000;
    admin = await env.login(ADMIN);
    await reauth(admin);
    Object.assign(fake, { ops: [], streams: [], download: null, upload: null, received: null, release: () => {}, done: false });
    logs.length = 0;
    await env.pool.query('delete from audit_log');
    for (const k of await env.kv.keys('updater:pending:')) await env.kv.del(k);
  });

  const noSecret = async () => {
    const rows = JSON.stringify((await env.pool.query('select * from audit_log')).rows);
    for (const s of [PASS, ENC]) {
      expect(rows).not.toContain(s);
      expect(logs.join('\n')).not.toContain(s);
    }
  };

  it('download streams without buffering', async () => {
    const r = await download(ID, ENC, { stream: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${ID}.tar.gz.age"`);
    expect(r.headers['cache-control']).toBe('no-store');
    const it = r.stream()[Symbol.asyncIterator]();
    const first = Buffer.from((await it.next()).value as Buffer);
    // the client has bytes while the updater still holds the rest back
    expect(first.length).toBeGreaterThan(0);
    expect(fake.done).toBe(false);
    fake.release();
    const rest = await collect({ [Symbol.asyncIterator]: () => it } as AsyncIterable<Buffer>);
    expect(Buffer.concat([first, rest]).equals(FILE)).toBe(true);
    expect(fake.done).toBe(true);
    // the header went on unchanged, signed
    expect(fake.streams).toHaveLength(1);
    expect(fake.streams[0]).toMatchObject({ method: 'GET', path: `/v1/mediaserver/backups/${ID}/download`, sigOk: true });
    expect(fake.streams[0]!.headers['x-ff-backup-passphrase']).toBe(ENC);
    // the fake refuses a tampered header: the signature binds the header as sent
    const s0 = fake.streams[0]!;
    expect(sigOk(s0.method, s0.path, streamBinding(encodePassphrase(`${PASS}!`)), s0.headers)).toBe(false);
    expect(await audits('mediaserver.backup_download')).toEqual([{ id: ID }]);
    await noSecret();
  });

  it('the backend passes the client abort on', async () => {
    const ac = new AbortController();
    const r = await download(ID, ENC, { stream: true, signal: ac.signal });
    expect(r.statusCode).toBe(200);
    const s = r.stream();
    await s[Symbol.asyncIterator]().next();
    expect(fake.streams[0]!.signal!.aborted).toBe(false);
    ac.abort();
    s.destroy();
    await vi.waitFor(() => expect(fake.streams[0]!.signal!.aborted).toBe(true));
    expect(fake.done).toBe(false);
  });

  it('updater refusals keep their status and code', async () => {
    fake.download = { status: 404, json: { error: 'not_found' } };
    let r = await download(ID);
    expect([r.statusCode, r.json()]).toEqual([404, { error: 'not_found' }]);
    fake.download = { status: 409, json: { error: 'busy' } };
    r = await download(ID);
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'busy' }]);
    fake.download = { status: 500, json: { error: 'Some Docker Text' } };
    r = await download(ID);
    expect([r.statusCode, r.json()]).toEqual([502, { error: 'updater_error' }]);
    expect(await audits('mediaserver.backup_download')).toEqual([]);
  });

  it('admin and csrf', async () => {
    const anon = await env.app.inject({ method: 'GET', url: `/api/admin/mediaserver/backups/${ID}/download`, headers: { 'x-ff-backup-passphrase': ENC } });
    expect(anon.statusCode).toBe(401);
    const anonUp = await env.app.inject({ method: 'POST', url: '/api/admin/mediaserver/backups/upload', headers: { 'content-type': 'application/octet-stream', 'x-ff-backup-passphrase': ENC }, payload: Buffer.from('age') });
    expect(anonUp.statusCode).toBe(401);
    const noCsrf = await env.app.inject({ method: 'POST', url: '/api/admin/mediaserver/backups/upload', cookies: admin.cookies, headers: { 'content-type': 'application/octet-stream', 'x-ff-backup-passphrase': ENC }, payload: Buffer.from('age') });
    expect([noCsrf.statusCode, noCsrf.json()]).toEqual([403, { error: 'csrf' }]);
    expect(fake.streams).toEqual([]);
  });

  it('re-auth and passphrase rules', async () => {
    await reauth(admin, Date.now() - 11 * 60_000);
    let r = await download(ID);
    expect([r.statusCode, r.json()]).toEqual([401, { error: 'reauth_required' }]);
    r = await upload(Buffer.from('age'));
    expect([r.statusCode, r.json()]).toEqual([401, { error: 'reauth_required' }]);
    await reauth(admin);
    for (const h of [null, 'not base64!', encodePassphrase('Zażółć gęśl'), Buffer.alloc(16, 0xff).toString('base64url'), encodePassphrase('x'.repeat(1025))]) {
      r = await download(ID, h);
      expect([r.statusCode, r.json()], String(h)).toEqual([400, { error: 'invalid_passphrase' }]);
      r = await upload(Buffer.from('age'), {}, h);
      expect([r.statusCode, r.json()], String(h)).toEqual([400, { error: 'invalid_passphrase' }]);
    }
    for (const id of ['%2E%2E%2Fx', 'x', 'ferrofin-20261117-1000-1.2.3%2Fy', 'plex-20261117-1000-1.2.3']) {
      r = await download(id);
      expect([r.statusCode, r.json()], id).toEqual([404, { error: 'not_found' }]);
    }
    expect(fake.streams).toEqual([]);
    // the refusals did not use up the limit (3 per 2 minutes); the Polish passphrase passes
    fake.download = { status: 409, json: { error: 'busy' } };
    for (let i = 0; i < 3; i++) expect((await download(ID)).statusCode).toBe(409);
    expect((await download(ID)).statusCode).toBe(429);
    expect(fake.streams).toHaveLength(3);
    expect(fake.streams.every((s) => s.headers['x-ff-backup-passphrase'] === ENC && s.sigOk)).toBe(true);
  });

  it('upload streams to the updater and starts the restore', async () => {
    const body = randomBytes(3 * MB);
    const r = await upload(body);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ backup: UPLOADED, job: expect.objectContaining({ id: '00000000000000a1', action: 'mediaserver-restore' }) });
    expect(fake.received!.equals(body)).toBe(true);
    expect(fake.streams).toHaveLength(1);
    expect(fake.streams[0]).toMatchObject({ method: 'POST', path: '/v1/mediaserver/backups/upload', sigOk: true });
    expect(fake.streams[0]!.headers['x-ff-backup-passphrase']).toBe(ENC);
    expect(fake.streams[0]!.headers['content-length']).toBe(String(3 * MB));
    expect(fake.ops).toEqual([{ op: 'restore', id: UPLOADED.id }]);
    expect(await audits('mediaserver.backup_upload')).toEqual([{ size: 3145728 }]);
    expect(await audits('mediaserver.action')).toEqual([{ op: 'restore' }]);
    await noSecret();
  });

  it('a restore the updater refuses keeps its code', async () => {
    // the restore op is refused (no recorded container)
    const orig = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input)).pathname === '/v1/mediaserver'
      ? new Response(JSON.stringify({ error: 'no_target' }), { status: 409 }) : orig(input, init))) as typeof fetch;
    try {
      const r = await upload(randomBytes(1000));
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'no_target', backup: UPLOADED });
      expect(await audits('mediaserver.backup_upload')).toEqual([{ size: 1000 }]);
      expect(await audits('mediaserver.action')).toEqual([]);
    } finally {
      env.ctx.fetchImpl = orig;
    }
  });

  it('upload limits before reading', async () => {
    let r = await upload(Readable.from([Buffer.from('age')]));
    expect([r.statusCode, r.json()]).toEqual([411, { error: 'length_required' }]);
    // the unread rest of a refused body is never read: the connection closes
    expect(r.headers.connection).toBe('close');
    r = await upload(Buffer.from('age'), { 'content-length': String(20 * GiB + 1) });
    expect([r.statusCode, r.json()]).toEqual([413, { error: 'too_large' }]);
    r = await upload(Buffer.from('{}'), { 'content-type': 'application/json' });
    expect([r.statusCode, r.json()]).toEqual([415, { error: 'unsupported_media_type' }]);
    expect(fake.streams).toEqual([]);

    fake.upload = { status: 400, json: { error: 'backup_invalid' } };
    r = await upload(randomBytes(1000));
    expect([r.statusCode, r.json()]).toEqual([400, { error: 'backup_invalid' }]);
    expect(fake.ops).toEqual([]);
    expect(await audits('mediaserver.backup_upload')).toEqual([]);
  });

  it('a connection the updater cuts is a failure, never a restore', async () => {
    const orig = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname !== '/v1/mediaserver/backups/upload') return orig(input, init);
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    }) as typeof fetch;
    try {
      const r = await upload(randomBytes(1000));
      expect([r.statusCode, r.json()]).toEqual([502, { error: 'updater_error' }]);
      expect(fake.ops).toEqual([]);
      expect(await audits('mediaserver.backup_upload')).toEqual([]);
    } finally {
      env.ctx.fetchImpl = orig;
    }
  });

  it('the logger redacts the passphrase header', () => {
    env.app.log.info({ headers: { 'x-ff-backup-passphrase': ENC, host: 'friend.example.com' } }, 'probe');
    const line = logs.find((l) => l.includes('"probe"'))!;
    expect(line).toContain('friend.example.com');
    expect(line).not.toContain(ENC);
    expect(line).toContain('[redacted]');
  });
});
