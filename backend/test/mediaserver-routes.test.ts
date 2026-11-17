// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionKey } from '../src/session.js';
import { issueSetupCode } from '../src/setup/code.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { readManaged } from '../src/mediaserver/store.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const SECRET = 'internal-secret-123456';
const CODE = 'K7QM-2D9X-HT4R';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const FRIEND = { sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] as string[] };
const EXTERNAL = 'http://192.0.2.10:8096';
const EXTERNAL_KEY = 'k' + 'ey-' + 'external';

const media = () => ({
  available: true, reason: null as string | null,
  base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: null,
  container: { state: 'running', health: 'healthy', kind: 'ferrofin', image: { digest: DIGEST, upstream: '1.2.3' }, template: 'current', tampered: false, createdAt: '2026-11-17T10:00:00.000Z' } as Record<string, unknown> | null,
  pin: null, pins: { ferrofin: true, jellyfin: true },
  engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null,
  backups: [{ id: 'ferrofin-20261117-1000-1.2.3', kind: 'ferrofin', upstream: '1.2.3', at: '2026-11-17T10:00:00.000Z', tag: 'manual', size: 1234 }], hdr: null,
});
let jobN = 0;
const job = (action: string) => ({ id: (++jobN).toString(16).padStart(16, '0'), action, state: 'running', step: null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-17T10:00:00.000Z', finishedAt: null, error: null,
  media: { step: 'check', steps: {} } });

const fake = {
  media: media() as Record<string, unknown> | null,
  /** a fixed answer per op instead of the default */
  answer: {} as Record<string, { status: number; json: unknown }>,
  bodies: [] as Array<Record<string, any>>,
};
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.pathname === '/v1/status') {
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job: null, log: [], services: [],
      ...(fake.media ? { mediaserver: fake.media } : {}) });
  }
  if (u.pathname !== '/v1/mediaserver') return j({ error: 'not_found' }, 404);
  const body = JSON.parse(String(init?.body)) as Record<string, any>;
  fake.bodies.push(body);
  const fixed = fake.answer[body.op];
  if (fixed) return j(fixed.json, fixed.status);
  switch (body.op) {
    case 'base-request': return j({ pending: true, expiresAt: '2026-11-17T10:30:00.000Z', warning: null });
    case 'base-confirm': return j(body.code === CODE ? { result: 'ok', path: '/srv/media', kept: ['Filme'], dropped: [], job: null } : { result: 'wrong' });
    case 'base-clear': return j({ ok: true });
    case 'browse': return j({ entries: [{ name: 'Filme', symlink: false, unreadable: false }, { name: 'a/b', symlink: false, unreadable: false }], truncated: false });
    case 'gpu': return j({ dri: [{ node: 'renderD128', gid: 44, vendor: 'intel' }, { node: '../x', gid: 1, vendor: 'intel' }], nvidia: false });
    case 'logs': return j({ lines: ['x'.repeat(600), 7, 'ok'] });
    default: return j({ job: job(`mediaserver-${body.op}`) }, 202);
  }
}) as typeof fetch;

const ctxPatch = (c: TestEnv['ctx']) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; };
const opBodies = (op: string) => fake.bodies.filter((b) => b.op === op);
const resetFake = () => { Object.assign(fake, { media: media(), answer: {}, bodies: [] }); };
const FOLDERS = [{ rel: 'Filme', name: 'Filme', type: 'movies' }, { rel: 'Serien/Neu', name: 'Serien', type: 'tvshows' }];
const applyBody = (extra: Record<string, unknown> = {}) => ({ kind: 'ferrofin', folders: FOLDERS, uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true, ...extra });

type Sess = { cookies: Record<string, string>; csrf: string };

describe('admin routes', () => {
  let env: TestEnv;
  let admin: Sess;
  /** each test runs 11 minutes after the last one: the portal-wide limits of the earlier tests are over (Date.now only) */
  let offset = 0;
  const realNow = Date.now.bind(Date);
  const req = (s: Sess | null, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: unknown) =>
    env.app.inject({ method, url: `/api/admin/mediaserver${path}`, ...(s ? { cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const reauth = async (s: Sess, at = Date.now()) => {
    const key = sessionKey(s.cookies.ff_sid!);
    await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: at }), 600);
  };
  const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
  const noIds = () => env.pool.query("update users set jellyfin_user_id = ''; update profiles set jellyfin_user_id = null");
  let baseCfg: TestEnv['ctx']['cfg'];

  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    env = await makeEnv({}, { ctxPatch });
    baseCfg = env.ctx.cfg;
  });
  afterAll(async () => { vi.restoreAllMocks(); await env.close(); });
  beforeEach(async () => {
    offset += 11 * 60_000;
    env.ctx.cfg = baseCfg;
    await env.ctx.settings.save({ JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'adminkey' }, null);
    admin = await env.login(ADMIN);
    resetFake();
    await env.pool.query('delete from audit_log; delete from media_managed');
    for (const k of await env.kv.keys('updater:pending:')) await env.kv.del(k);
  });

  const ROUTES: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
    ['GET', ''], ['POST', '/base', { path: '/srv/media' }], ['POST', '/base/confirm', { code: CODE }], ['DELETE', '/base'], ['POST', '/browse', { rel: '' }],
    ['POST', '/gpu'], ['POST', '/apply', applyBody()], ['POST', '/action', { op: 'stop' }], ['POST', '/logs', { tail: 100 }], ['GET', '/backups'],
    ['GET', '/libraries'], ['DELETE', '/libraries/filme'], ['POST', '/mode', { mode: 'external', restore: false }],
  ];

  it('admin only', async () => {
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-ben', 'ben@friend.example.com', 'Ben Muster', 'friend', 'jfben', 'Ben', $1)", [encrypt(env.ctx.encKey, 'pw')]);
    const friend = await env.login(FRIEND);
    for (const [method, path, body] of ROUTES) {
      expect((await req(friend, method, path, body)).statusCode, `${method} ${path}`).toBe(403);
      expect((await req(null, method, path, body)).statusCode, `${method} ${path}`).toBe(401);
    }
    expect(fake.bodies).toEqual([]);
  });

  it('re-auth where the spec asks', async () => {
    await noIds();
    await reauth(admin, Date.now() - 11 * 60_000);
    const needs: Array<['POST' | 'DELETE', string, unknown?]> = [['POST', '/base', { path: '/srv/media' }], ['POST', '/apply', applyBody()], ['POST', '/action', { op: 'restore', id: 'ferrofin-20261117-1000-1.2.3' }],
      ['POST', '/action', { op: 'remove', data: true }], ['POST', '/mode', { mode: 'external', restore: false }], ['DELETE', '/libraries/filme']];
    for (const [method, path, body] of needs) {
      const r = await req(admin, method, path, body);
      expect(r.statusCode, `${method} ${path}`).toBe(401);
      expect(r.json()).toEqual({ error: 'reauth_required' });
    }
    expect(fake.bodies).toEqual([]);
    // the refused requests did not use up the limits
    expect((await req(admin, 'POST', '/action', { op: 'stop' })).statusCode).toBe(202);
    expect((await req(admin, 'POST', '/base/confirm', { code: CODE })).statusCode).toBe(200);
    expect((await req(admin, 'POST', '/browse', { rel: 'Filme' })).statusCode).toBe(200);
    expect((await req(admin, 'POST', '/action', { op: 'remove', data: false })).statusCode).toBe(202);

    offset += 3 * 60_000;
    await reauth(admin);
    for (const [method, path, body] of needs) expect((await req(admin, method, path, body)).statusCode, `${method} ${path}`).not.toBe(401);
    // the remove with data switched to external: the mode switch has nothing left to stop
    expect(fake.bodies.map((b) => b.op)).toEqual(['stop', 'base-confirm', 'browse', 'remove', 'base-request', 'apply', 'restore', 'remove']);
  });

  it('strict bodies', async () => {
    await reauth(admin);
    await noIds();
    for (const body of [applyBody({ extra: 1 }), applyBody({ image: 'docker.io/evil/image:latest' }), applyBody({ folders: [{ ...FOLDERS[0], target: '/etc' }] }),
      applyBody({ uid: 0 }), applyBody({ gpu: 'all' }), applyBody({ folders: [FOLDERS[0], FOLDERS[0]] }), applyBody({ folders: [{ ...FOLDERS[0], name: '' }] })]) {
      const r = await req(admin, 'POST', '/apply', body);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'invalid_body' });
    }
    for (const body of [{ op: 'start', id: 'x' }, { op: 'backup' }, { op: 'restore', id: '../x' }, { op: 'remove' }, { op: 'hdr-test' }, { op: 'finish-setup' }, {}]) {
      expect((await req(admin, 'POST', '/action', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await req(admin, 'POST', '/base', { path: '/srv/media', x: 1 })).statusCode).toBe(400);
    expect((await req(admin, 'POST', '/logs', { tail: 10 })).statusCode).toBe(400);
    expect((await req(admin, 'POST', '/mode', { mode: 'managed', restore: false })).statusCode).toBe(400);
    expect(fake.bodies).toEqual([]);
  });

  it('folders sharing a library name are refused before anything is sent or stored', async () => {
    await reauth(admin);
    await noIds();
    // the server holds one library per name: two folders named "Filme" and " filme " would share one
    const r = await req(admin, 'POST', '/apply', applyBody({ folders: [FOLDERS[0], { rel: 'Neu', name: ' filme ', type: 'movies' }] }));
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'invalid_body' });
    expect(fake.bodies).toEqual([]);
    expect((await env.pool.query('select count(*)::int as n from media_managed')).rows[0].n).toBe(0);
    // distinct names are fine
    expect((await req(admin, 'POST', '/apply', applyBody({ folders: [FOLDERS[0], { rel: 'Neu', name: 'Filme 2', type: 'movies' }] }))).statusCode).toBe(202);
  });

  it('limits', async () => {
    await reauth(admin);
    for (let i = 0; i < 3; i++) expect((await req(admin, 'POST', '/base', { path: '/srv/media' })).statusCode).toBe(200);
    expect((await req(admin, 'POST', '/base', { path: '/srv/media' })).statusCode).toBe(429);
    for (let i = 0; i < 30; i++) expect((await req(admin, 'POST', '/browse', { rel: '' })).statusCode).toBe(200);
    expect((await req(admin, 'POST', '/browse', { rel: '' })).statusCode).toBe(429);
    expect(opBodies('base-request')).toHaveLength(3);
    expect(opBodies('browse')).toHaveLength(30);
  });

  it('the backend adds target and tz, never more', async () => {
    await reauth(admin);
    await noIds();
    const r = await req(admin, 'POST', '/apply', applyBody());
    expect(r.statusCode).toBe(202);
    expect(r.json().job.action).toBe('mediaserver-apply');
    const [sent] = opBodies('apply');
    expect(Object.keys(sent!)).toEqual(['op', 'spec', 'firstRun']);
    expect(Object.keys(sent!.spec)).toEqual(['kind', 'folders', 'uid', 'gid', 'gpu', 'mediaGid', 'egress', 'tz']);
    expect(sent!.spec.folders).toEqual([{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien/Neu', target: '/media/serien' }]);
    expect(sent!.spec.tz).toMatch(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/);
    expect(Object.keys(sent!.firstRun)).toEqual(['password']);
    expect(sent!.firstRun.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const m = await readManaged(env.pool);
    expect(m).toMatchObject({ kind: 'ferrofin', setup: 'applying', adminUser: 'friendflix-admin', hasPassword: true,
      libraries: [{ slug: 'filme', name: 'Filme', type: 'movies', rel: 'Filme', created: false }, { slug: 'serien', name: 'Serien', type: 'tvshows', rel: 'Serien/Neu', created: false }] });
    const stored = (await env.pool.query<{ p: string }>('select admin_password_enc as p from media_managed')).rows[0]!.p;
    expect(decrypt(env.ctx.encKey, stored)).toBe(sent!.firstRun.password);
    expect(await env.kv.keys('updater:pending:')).toHaveLength(1);

    // jellyfin: no password in the create body (the backend keeps one for its wizard)
    await env.pool.query('delete from media_managed');
    fake.bodies = [];
    offset += 3 * 60_000;
    await reauth(admin);
    expect((await req(admin, 'POST', '/apply', applyBody({ kind: 'jellyfin' }))).statusCode).toBe(202);
    expect(Object.keys(opBodies('apply')[0]!)).toEqual(['op', 'spec']);
    expect((await readManaged(env.pool)).hasPassword).toBe(true);
  });

  it('two first-run applies at once send the one stored password', async () => {
    await reauth(admin);
    await noIds();
    const rs = await Promise.all([req(admin, 'POST', '/apply', applyBody()), req(admin, 'POST', '/apply', applyBody())]);
    expect(rs.map((r) => r.statusCode)).toContain(202);
    const sent = opBodies('apply').map((b) => b.firstRun.password as string);
    expect(sent.length).toBeGreaterThan(0);
    const stored = (await env.pool.query<{ p: string }>('select admin_password_enc as p from media_managed')).rows[0]!.p;
    for (const p of sent) expect(p).toBe(decrypt(env.ctx.encKey, stored));
  });

  it('a re-apply keeps slugs and the stored password; a rename that cannot be counted is refused', async () => {
    await reauth(admin);
    await noIds();
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    const first = opBodies('apply')[0]!.firstRun.password as string;
    // a created library cannot be renamed while its references cannot be counted (no managed connection here): fail closed, nothing sent
    await env.pool.query("update media_managed set setup = 'done', libraries = jsonb_set(libraries, '{0,created}', 'true')");
    const refused = await req(admin, 'POST', '/apply', applyBody({ folders: [{ rel: 'Filme', name: 'Kino', type: 'movies' }] }));
    expect(refused.json()).toEqual({ error: 'unreachable' });
    expect(opBodies('apply')).toHaveLength(1);
    // the films folder renamed (not created yet), a new folder with a clashing name, the series folder removed
    await env.pool.query("update media_managed set libraries = jsonb_set(libraries, '{0,created}', 'false')");
    const r = await req(admin, 'POST', '/apply', applyBody({ folders: [{ rel: 'Filme', name: 'Kino', type: 'movies' }, { rel: 'Neu', name: 'Filme', type: 'movies' }] }));
    expect(r.statusCode).toBe(202);
    const second = opBodies('apply')[1]!;
    expect(second.firstRun).toBeUndefined();
    expect(second.spec.folders).toEqual([{ rel: 'Filme', target: '/media/filme' }, { rel: 'Neu', target: '/media/filme-2' }]);
    const m = await readManaged(env.pool);
    // after done, libraries not created yet send the setup back to its libraries step
    expect(m.setup).toBe('libraries');
    // the series library was never created in the server: dropped; the renamed one keeps its slug
    expect(m.libraries.map((l) => [l.slug, l.name, l.created])).toEqual([['filme', 'Kino', false], ['filme-2', 'Filme', false]]);
    // an unfinished setup sends the first run again, with the stored password
    await env.pool.query("update media_managed set setup = 'failed', setup_error = 'unhealthy'");
    offset += 3 * 60_000;
    await reauth(admin);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    expect(opBodies('apply')[2]!.firstRun.password).toBe(first);
    expect(await readManaged(env.pool)).toMatchObject({ setup: 'applying', setupError: null });
  });

  it('id rule', async () => {
    await reauth(admin);
    await env.pool.query("update users set jellyfin_user_id = 'j0'");
    expect((await req(admin, 'GET', '')).json().offer).toEqual({ managed: false, reason: 'ids_in_use' });
    const r = await req(admin, 'POST', '/apply', applyBody());
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'ids_in_use' });
    expect(fake.bodies).toEqual([]);
    await noIds();
    expect((await req(admin, 'GET', '')).json().offer).toEqual({ managed: true, reason: null });
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    // managed: the same kind is fine once ids exist (they are the managed server's), another kind is a fresh server
    await env.pool.query("update users set jellyfin_user_id = 'j1'");
    expect((await req(admin, 'GET', '')).json()).toMatchObject({ mode: 'managed', offer: { managed: true, reason: null } });
    expect((await req(admin, 'POST', '/apply', applyBody({ kind: 'jellyfin' }))).json()).toEqual({ error: 'ids_in_use' });
    offset += 3 * 60_000;
    await reauth(admin);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    expect(opBodies('apply')).toHaveLength(2);
  });

  it('offer reasons', async () => {
    await noIds();
    const reason = async () => (await req(admin, 'GET', '')).json().offer.reason;
    expect(await reason()).toBeNull();
    env.ctx.cfg = { ...baseCfg, MEDIA_SERVER: 'plex' };
    expect(await reason()).toBe('plex');
    env.ctx.cfg = { ...baseCfg, JELLYFIN_URL: 'http://192.0.2.20:8096' };
    expect(await reason()).toBe('url_pinned');
    env.ctx.cfg = { ...baseCfg, UPDATER_URL: undefined };
    expect(await reason()).toBe('no_updater');
    env.ctx.cfg = baseCfg;
    fake.media = { ...media(), available: false, reason: 'no_logs' };
    expect(await reason()).toBe('proxy_outdated');
    fake.media = { ...media(), available: false, reason: 'engine_old' };
    expect(await reason()).toBe('engine_old');
    fake.media = null;
    expect(await reason()).toBe('updater_outdated');
    fake.media = media();
    const v = (await req(admin, 'GET', '')).json();
    expect(v).toMatchObject({ mode: 'external', kinds: { ferrofin: true, jellyfin: true }, external: { url: null, hasKey: false }, livetvLibraryPath: '/media/Aufnahmen' });
    expect(v.status.container.kind).toBe('ferrofin');
    expect(JSON.stringify(v)).not.toContain('adminkey');
  });

  it('switching saves the external server and brings it back', async () => {
    await noIds();
    await env.ctx.settings.save({ JELLYFIN_URL: EXTERNAL, JELLYFIN_ADMIN_API_KEY: EXTERNAL_KEY }, null);
    await reauth(admin);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    const row = (await env.pool.query<{ external_url: string; external_key_enc: string }>('select external_url, external_key_enc from media_managed')).rows[0]!;
    expect(row.external_url).toBe(EXTERNAL);
    expect(row.external_key_enc).not.toContain(EXTERNAL_KEY);
    expect(decrypt(env.ctx.encKey, row.external_key_enc)).toBe(EXTERNAL_KEY);
    expect((await req(admin, 'GET', '')).json().external).toEqual({ url: EXTERNAL, hasKey: true });
    // the managed setup replaces the connection (Task 14); here a stand-in
    await env.ctx.settings.save({ JELLYFIN_URL: 'http://mediaserver:8096', JELLYFIN_ADMIN_API_KEY: 'managed-key' }, null);

    expect((await req(admin, 'POST', '/mode', { mode: 'external', restore: true })).statusCode).toBe(200);
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(EXTERNAL);
    expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBe(EXTERNAL_KEY);
    expect((await readManaged(env.pool)).kind).toBeNull();
    expect(opBodies('stop')).toEqual([{ op: 'stop' }]);
    expect((await audits('mediaserver.mode')).map((a) => a.meta)).toEqual([{ from: 'managed', to: 'external' }]);
    expect((await audits('mediaserver.action')).map((a) => a.meta)).toEqual([{ op: 'stop' }]);
    // already external
    expect((await req(admin, 'POST', '/mode', { mode: 'external', restore: true })).json()).toEqual({ error: 'not_managed' });
  });

  it('mode without restore empties the connection; a remove switches to external too', async () => {
    await noIds();
    await reauth(admin);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    expect((await req(admin, 'POST', '/mode', { mode: 'external', restore: false })).statusCode).toBe(200);
    expect(env.ctx.cfg.JELLYFIN_URL).toBeUndefined();
    expect(env.ctx.cfg.JELLYFIN_ADMIN_API_KEY).toBeUndefined();

    // a remove while external never touches the external connection
    await env.ctx.settings.save({ JELLYFIN_URL: EXTERNAL, JELLYFIN_ADMIN_API_KEY: EXTERNAL_KEY }, null);
    offset += 3 * 60_000;
    await reauth(admin);
    expect((await req(admin, 'POST', '/action', { op: 'remove', data: false })).statusCode).toBe(202);
    expect(env.ctx.cfg.JELLYFIN_URL).toBe(EXTERNAL);
    // a remove while managed: switched to external
    await env.pool.query("update media_managed set kind = 'ferrofin'");
    expect((await req(admin, 'POST', '/action', { op: 'remove', data: true })).statusCode).toBe(202);
    expect(env.ctx.cfg.JELLYFIN_URL).toBeUndefined();
    expect((await readManaged(env.pool)).kind).toBeNull();
    expect((await audits('mediaserver.mode')).map((a) => a.meta)).toEqual([{ from: 'managed', to: 'external' }, { from: 'managed', to: 'external' }]);
  });

  it('a managed setup after a switch without restore keeps the external server saved before', async () => {
    await noIds();
    await env.ctx.settings.save({ JELLYFIN_URL: EXTERNAL, JELLYFIN_ADMIN_API_KEY: EXTERNAL_KEY }, null);
    await reauth(admin);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    expect((await req(admin, 'POST', '/mode', { mode: 'external', restore: false })).statusCode).toBe(200);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    expect((await req(admin, 'GET', '')).json().external).toEqual({ url: EXTERNAL, hasKey: true });
  });

  it('a base change with a container records its job', async () => {
    fake.answer['base-confirm'] = { status: 200, json: { result: 'ok', path: '/srv/media2', kept: ['Filme', '../etc'], dropped: ['Serien'], job: job('mediaserver-apply') } };
    const r = await req(admin, 'POST', '/base/confirm', { code: CODE });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: 'ok', path: '/srv/media2', kept: ['Filme'], dropped: ['Serien'], job: { action: 'mediaserver-apply' } });
    const keys = await env.kv.keys('updater:pending:');
    expect(keys).toEqual([`updater:pending:${r.json().job.id}`]);
    expect(JSON.parse((await env.kv.get(keys[0]!))!)).toMatchObject({ action: 'mediaserver', op: 'apply' });
  });

  it('updater refusals are codes only', async () => {
    await reauth(admin);
    fake.answer['base-request'] = { status: 400, json: { error: 'path_refused' } };
    expect((await req(admin, 'POST', '/base', { path: '/etc' })).json()).toEqual({ error: 'path_refused' });
    fake.answer['base-request'] = { status: 409, json: { error: 'Error: connect ECONNREFUSED /var/run/docker.sock' } };
    const r = await req(admin, 'POST', '/base', { path: '/srv/media' });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: 'updater_error' });
    fake.answer['base-confirm'] = { status: 409, json: { error: 'not_available' } };
    expect((await req(admin, 'POST', '/base/confirm', { code: CODE })).json()).toEqual({ error: 'not_available' });
    fake.answer.stop = { status: 409, json: { error: 'busy' } };
    expect((await req(admin, 'POST', '/action', { op: 'stop' })).json()).toEqual({ error: 'busy' });
    // browse, gpu and logs: only checked fields
    expect((await req(admin, 'POST', '/browse', { rel: '' })).json()).toEqual({ entries: [{ name: 'Filme', symlink: false, unreadable: false }], truncated: false });
    expect((await req(admin, 'POST', '/gpu')).json()).toEqual({ dri: [{ node: 'renderD128', gid: 44, vendor: 'intel' }], nvidia: false });
    const logs = (await req(admin, 'POST', '/logs', { tail: 100 })).json();
    expect(logs.lines).toEqual(['x'.repeat(500), 'ok']);
    expect((await req(admin, 'GET', '/backups')).json().backups).toHaveLength(1);
    expect((await req(admin, 'DELETE', '/base')).json()).toEqual({ ok: true });
    expect((await audits('mediaserver.base_clear'))).toHaveLength(1);
  });

  it('retry clears the setup error without the updater; libraries list their references', async () => {
    await env.pool.query("insert into media_managed(id, kind, setup, setup_error, libraries) values (1, 'ferrofin', 'failed', 'unhealthy', '[{\"slug\":\"filme\",\"name\":\"Filme\",\"type\":\"movies\",\"rel\":\"Filme\",\"created\":true}]')");
    expect((await req(admin, 'POST', '/action', { op: 'retry' })).json()).toEqual({ ok: true });
    expect((await readManaged(env.pool)).setupError).toBeNull();
    expect(fake.bodies).toEqual([]);
    expect((await audits('mediaserver.action')).map((a) => a.meta)).toEqual([{ op: 'retry' }]);
    // no managed connection here: the references are unknown and the library cannot be deleted in the server (mediaserver-firstrun.test.ts
    // covers both against a server)
    expect((await req(admin, 'GET', '/libraries')).json()).toEqual({ libraries: [{ slug: 'filme', name: 'Filme', type: 'movies', rel: 'Filme', created: true, references: null }] });
    await reauth(admin);
    expect((await req(admin, 'DELETE', '/libraries/nope')).statusCode).toBe(404);
    expect((await req(admin, 'DELETE', '/libraries/filme')).json()).toEqual({ error: 'unreachable' });
  });

  it('audit rows carry no code or password', async () => {
    await reauth(admin);
    await noIds();
    expect((await req(admin, 'POST', '/base', { path: '/srv/media' })).statusCode).toBe(200);
    const wrong = await req(admin, 'POST', '/base/confirm', { code: 'AAAA-BBBB-CCCC' });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toEqual({ error: 'wrong' });
    expect((await req(admin, 'POST', '/base/confirm', { code: CODE })).statusCode).toBe(200);
    expect((await req(admin, 'POST', '/apply', applyBody())).statusCode).toBe(202);
    const adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
    expect(await audits('mediaserver.base_request')).toEqual([{ actor: adminId, meta: { path: '/srv/media' } }]);
    expect((await audits('mediaserver.base_confirm')).map((a) => a.meta)).toEqual([{ result: 'wrong' }, { result: 'ok', path: '/srv/media' }]);
    expect((await audits('mediaserver.apply')).map((a) => a.meta)).toEqual([{ kind: 'ferrofin', folders: 2, gpu: 'dri', egress: true }]);
    const password = opBodies('apply')[0]!.firstRun.password as string;
    const all = JSON.stringify((await env.pool.query('select * from audit_log')).rows);
    for (const secret of [CODE, 'AAAA-BBBB-CCCC', password]) expect(all).not.toContain(secret);
  });
});

describe('setup routes', () => {
  let env: TestEnv;
  let setup: { cookies: Record<string, string>; csrf: string };
  const req = (method: 'GET' | 'POST', path: string, payload?: unknown, s: { cookies?: Record<string, string>; csrf?: string } = setup) =>
    env.app.inject({ method, url: `/api/setup/mediaserver${path}`, cookies: s.cookies ?? {}, headers: s.csrf ? { 'x-ff-setup-csrf': s.csrf } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

  beforeAll(async () => {
    env = await makeEnv({}, { ctxPatch, setupComplete: false });
    const code = await issueSetupCode(env.ctx);
    const r = await env.app.inject({ method: 'POST', url: '/api/setup/unlock', payload: { code }, remoteAddress: '192.0.2.50' });
    const cookies = Object.fromEntries(r.cookies.map((c) => [c.name, c.value]));
    setup = { cookies, csrf: cookies.ff_setup_csrf! };
  });
  afterAll(async () => { await env.close(); });
  beforeEach(resetFake);

  it('setup routes need the setup session and its CSRF', async () => {
    expect((await req('GET', '', undefined, {})).statusCode).toBe(401);
    expect((await req('POST', '/base', { path: '/srv/media' }, {})).statusCode).toBe(401);
    expect((await req('POST', '/base', { path: '/srv/media' }, { cookies: setup.cookies })).statusCode).toBe(403);
    expect((await req('POST', '/apply', applyBody(), { cookies: setup.cookies, csrf: 'nope' })).statusCode).toBe(403);
    expect(fake.bodies).toEqual([]);
    // the admin routes are closed during setup
    expect((await env.app.inject({ method: 'GET', url: '/api/admin/mediaserver' })).statusCode).toBe(503);

    expect((await req('GET', '')).json()).toMatchObject({ mode: 'external', offer: { managed: true, reason: null } });
    expect((await req('POST', '/base', { path: '/srv/media' })).statusCode).toBe(200);
    expect((await req('POST', '/base/confirm', { code: CODE })).statusCode).toBe(200);
    expect((await req('POST', '/browse', { rel: '' })).statusCode).toBe(200);
    expect((await req('POST', '/gpu')).statusCode).toBe(200);
    expect((await req('POST', '/apply', applyBody())).statusCode).toBe(202);
    expect((await req('POST', '/action', { op: 'hdr-test', kind: 'ferrofin' })).statusCode).toBe(202);
    expect((await req('POST', '/action', { op: 'retry' })).statusCode).toBe(200);
    expect((await req('POST', '/action', { op: 'stop' })).statusCode).toBe(400);
    expect((await req('POST', '/action', { op: 'remove', data: true })).statusCode).toBe(400);
    expect(fake.bodies.map((b) => b.op)).toEqual(['base-request', 'base-confirm', 'browse', 'gpu', 'apply', 'hdr-test']);
    expect(opBodies('apply')[0]!.firstRun.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = (await env.pool.query<{ actor: string | null; action: string }>("select actor, action from audit_log where action like 'mediaserver.%' order by id")).rows;
    expect(rows.map((r) => r.action)).toEqual(['mediaserver.base_request', 'mediaserver.base_confirm', 'mediaserver.apply', 'mediaserver.action', 'mediaserver.action']);
    expect(rows.every((r) => r.actor === null)).toBe(true);
    // no setup route for base-clear, logs, backups, libraries or mode
    for (const [method, path] of [['DELETE', '/base'], ['POST', '/logs'], ['GET', '/backups'], ['GET', '/libraries'], ['POST', '/mode']] as const) {
      expect((await env.app.inject({ method, url: `/api/setup/mediaserver${path}`, cookies: setup.cookies, headers: { 'x-ff-setup-csrf': setup.csrf } })).statusCode).toBe(503);
    }
    expect(fake.bodies).toHaveLength(6);
  });
});
