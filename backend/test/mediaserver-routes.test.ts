// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionKey } from '../src/session.js';
import { issueSetupCode } from '../src/setup/code.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { readManaged, writeManaged } from '../src/mediaserver/store.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

const SECRET = cfg.INTERNAL_SECRET;
const CODE = 'K7QM-2D9X-HT4R';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const FRIEND = { sub: 'sub-ben', email: 'ben@friend.example.com', name: 'Ben Muster', groups: [] as string[] };
const EXTERNAL = 'http://192.0.2.10:8096';
const EXTERNAL_KEY = 'k' + 'ey-' + 'external';
const CONTAINER = 'c'.repeat(64);
const SERVER_ID = '0123456789abcdef0123456789abcdef';

const media = () => ({
  available: true, reason: null as string | null,
  base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: null,
  container: { state: 'running', health: 'healthy', kind: 'ferrofin', image: { digest: DIGEST, upstream: '1.2.3' }, template: 'current', tampered: false, createdAt: '2026-11-17T10:00:00.000Z' } as Record<string, unknown> | null,
  pin: null, pins: { ferrofin: true, jellyfin: true },
  engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null,
  backups: [{ id: 'ferrofin-20261117-1000-1.2.3', kind: 'ferrofin', upstream: '1.2.3', at: '2026-11-17T10:00:00.000Z', tag: 'manual', size: 1234 }], hdr: null,
  move: null as Record<string, unknown> | null, source: null as Record<string, unknown> | null,
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
  /** what the current Jellyfin answers at /System/Info/Public (null: it does not answer) */
  info: { Id: SERVER_ID, StartupWizardCompleted: true } as Record<string, unknown> | null,
  infoCalls: [] as string[],
  /** while set, the sized scan answers only once it resolves */
  scanHold: null as Promise<void> | null,
};
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.pathname === '/v1/status') {
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job: null, log: [], services: [],
      ...(fake.media ? { mediaserver: fake.media } : {}) });
  }
  if (u.pathname === '/System/Info/Public') {
    fake.infoCalls.push(u.origin);
    if (!fake.info) throw new TypeError('fetch failed');
    return j(fake.info);
  }
  if (u.pathname !== '/v1/mediaserver') return j({ error: 'not_found' }, 404);
  const body = JSON.parse(String(init?.body)) as Record<string, any>;
  fake.bodies.push(body);
  if (body.op === 'migrate-scan' && body.source && fake.scanHold) await fake.scanHold;
  const fixed = fake.answer[body.op];
  if (fixed) return j(fixed.json, fixed.status);
  switch (body.op) {
    case 'base-request': return j({ pending: true, expiresAt: '2026-11-17T10:30:00.000Z', warning: null });
    case 'base-confirm': return j(body.code === CODE ? { result: 'ok', path: '/srv/media', kept: ['Filme'], dropped: [], job: null } : { result: 'wrong' });
    case 'base-clear': return j({ ok: true });
    case 'browse': return j({ entries: [{ name: 'Filme', symlink: false, unreadable: false }, { name: 'a/b', symlink: false, unreadable: false }], truncated: false });
    case 'gpu': return j({ dri: [{ node: 'renderD128', gid: 44, vendor: 'intel' }, { node: '../x', gid: 1, vendor: 'intel' }], nvidia: false });
    case 'logs': return j({ lines: ['x'.repeat(600), 7, 'ok'] });
    case 'migrate-scan': return j({ candidates: [{ id: CONTAINER, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', state: 'running', matches: true }],
      ...(body.source ? { scan: { source: { id: CONTAINER, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', version: '10.10.3' }, folders: [{ rel: 'Filme', target: '/movies', migrated: true }],
        layout: 'official', bytes: 1000, trickplayBytes: 500, plugins: ['Fanart'], nfo: false } } : {}) });
    case 'migrate-abort': return j({ job: job('mediaserver-migrate') }, 202);
    case 'source-start': return j({ job: job('mediaserver-source') }, 202);
    default: return j({ job: job(`mediaserver-${body.op}`) }, 202);
  }
}) as typeof fetch;

const ctxPatch = (c: TestEnv['ctx']) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; };
const opBodies = (op: string) => fake.bodies.filter((b) => b.op === op);
const resetFake = () => { Object.assign(fake, { media: media(), answer: {}, bodies: [], info: { Id: SERVER_ID, StartupWizardCompleted: true }, infoCalls: [], scanHold: null }); };
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
    await env.kv.del('media:move:scan');
    for (const k of await env.kv.keys('updater:pending:')) await env.kv.del(k);
  });

  const ROUTES: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
    ['GET', ''], ['POST', '/base', { path: '/srv/media' }], ['POST', '/base/confirm', { code: CODE }], ['DELETE', '/base'], ['POST', '/browse', { rel: '' }],
    ['POST', '/gpu'], ['POST', '/apply', applyBody()], ['POST', '/action', { op: 'stop' }], ['POST', '/logs', { tail: 100 }], ['GET', '/backups'],
    ['GET', '/libraries'], ['DELETE', '/libraries/filme'], ['POST', '/mode', { mode: 'external', restore: false }],
    ['POST', '/move/scan', {}], ['POST', '/move', { source: CONTAINER, trickplay: false }], ['POST', '/move/abort'], ['POST', '/back'],
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
      ['POST', '/action', { op: 'remove', data: true }], ['POST', '/mode', { mode: 'external', restore: false }], ['DELETE', '/libraries/filme'],
      ['POST', '/move', { source: CONTAINER, trickplay: false }], ['POST', '/back']];
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
    // the remove with data switched to external: the mode switch has nothing left to stop; no ids: no move, nothing moved: no way back
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
    for (const body of [{ source: 'abc' }, { source: CONTAINER, x: 1 }, { serverId: SERVER_ID }]) expect((await req(admin, 'POST', '/move/scan', body)).statusCode, JSON.stringify(body)).toBe(400);
    for (const body of [{ source: CONTAINER }, { trickplay: true }, { source: CONTAINER, trickplay: 'yes' }, { source: CONTAINER, trickplay: true, uid: 0 },
      { source: CONTAINER, trickplay: true, serverId: SERVER_ID }, { source: CONTAINER.toUpperCase(), trickplay: true }]) {
      expect((await req(admin, 'POST', '/move', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await req(admin, 'POST', '/move/abort', { op: 'migrate-abort' })).statusCode).toBe(400);
    expect((await req(admin, 'POST', '/back', { force: true })).statusCode).toBe(400);
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
    // the updater has not read its media status since it started: not an old updater
    fake.media = { ...media(), available: false, reason: 'starting', container: null, desired: null };
    expect(await reason()).toBe('starting');
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

  describe('the move from an external Jellyfin', () => {
    const linked = () => env.pool.query("update users set jellyfin_user_id = 'j1'");
    const moveView = async () => (await req(admin, 'GET', '')).json().move;
    /** a done scan of the source, as the sheet gets one before the move */
    const scanned = async (source = CONTAINER) => {
      expect((await req(admin, 'POST', '/move/scan', { source })).statusCode).toBe(202);
      await vi.waitFor(async () => expect((await moveView()).scan?.state).toBe('done'));
    };

    it('move offered only for an external Jellyfin with linked ids', async () => {
      await linked();
      fake.media = { ...media(), source: { name: 'jellyfin', state: 'exited', version: '10.10.3' } };
      expect(await moveView()).toEqual({ offered: true, reason: null, scan: null, state: null, migratedFrom: null, sourceState: 'exited', requestsWarning: false });
      // the fresh managed server is refused for the same install
      expect((await req(admin, 'GET', '')).json().offer).toEqual({ managed: false, reason: 'ids_in_use' });
      // nothing depends on the ids: nothing to move (a fresh server is offered instead)
      await noIds();
      expect(await moveView()).toMatchObject({ offered: false, reason: null });
      await linked();
      // the media server is managed already
      await writeManaged(env.ctx, { kind: 'ferrofin', setup: 'done' });
      expect(await moveView()).toMatchObject({ offered: false, reason: null });
      await env.pool.query('delete from media_managed');
      // no connection to a Jellyfin
      await env.ctx.settings.save({ JELLYFIN_URL: null, JELLYFIN_ADMIN_API_KEY: null }, null);
      expect(await moveView()).toMatchObject({ offered: false, reason: null });
      await env.ctx.settings.save({ JELLYFIN_URL: 'http://jellyfin:8096', JELLYFIN_ADMIN_API_KEY: 'adminkey' }, null);
      // a move under way: the backend follows one, or the updater holds an unfinished one (an aborted one is history)
      await writeManaged(env.ctx, { move: { phase: 'nfo', error: null, jobId: null, startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false } });
      expect(await moveView()).toMatchObject({ offered: false, reason: null, state: { phase: 'nfo' } });
      await writeManaged(env.ctx, { move: { phase: 'failed', error: 'no_space', jobId: null, startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false } });
      expect(await moveView()).toMatchObject({ offered: true });
      const upd = { step: null, source: { name: 'jellyfin', version: '10.10.3' }, folders: [], abort: false };
      for (const phase of ['running', 'ready']) {
        fake.media = { ...media(), move: { ...upd, phase } };
        expect(await moveView(), phase).toMatchObject({ offered: false });
      }
      fake.media = { ...media(), move: { ...upd, phase: 'aborted' } };
      expect(await moveView()).toMatchObject({ offered: true });
      await env.pool.query('delete from media_managed');
      // the updater cannot run the media server
      fake.media = { ...media(), available: false, reason: 'engine_old' };
      expect(await moveView()).toMatchObject({ offered: false, reason: 'engine_old' });
      fake.media = null;
      expect(await moveView()).toMatchObject({ offered: false, reason: 'updater_outdated' });
      env.ctx.cfg = { ...baseCfg, UPDATER_URL: undefined };
      expect(await moveView()).toMatchObject({ offered: false, reason: 'no_updater' });
    });

    it('not for Plex', async () => {
      await linked();
      env.ctx.cfg = { ...baseCfg, MEDIA_SERVER: 'plex' };
      expect(await moveView()).toMatchObject({ offered: false, reason: 'plex' });
      await reauth(admin);
      expect((await req(admin, 'POST', '/move/scan', {})).json()).toEqual({ error: 'plex' });
      expect((await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false })).json()).toEqual({ error: 'plex' });
      expect(fake.bodies).toEqual([]);
    });

    it('not when url_pinned', async () => {
      await linked();
      env.ctx.cfg = { ...baseCfg, JELLYFIN_URL: 'http://192.0.2.20:8096' };
      expect(await moveView()).toMatchObject({ offered: false, reason: 'url_pinned' });
      await reauth(admin);
      const r = await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'url_pinned' });
      expect(fake.bodies).toEqual([]);
      expect(fake.infoCalls).toEqual([]);
    });

    it('the scan: the list answers at once, the chosen one runs in the background; the server id never shows', async () => {
      await linked();
      const list = await req(admin, 'POST', '/move/scan', {});
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ candidates: [{ id: CONTAINER, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', state: 'running', matches: true }] });
      expect(fake.infoCalls).toEqual(['http://jellyfin:8096']);
      let release!: () => void;
      fake.scanHold = new Promise((r) => { release = r; });
      const one = await req(admin, 'POST', '/move/scan', { source: CONTAINER });
      expect(one.statusCode).toBe(202);
      expect(one.json().scan).toMatchObject({ source: CONTAINER, state: 'running' });
      expect((await moveView()).scan).toMatchObject({ source: CONTAINER, state: 'running' });
      // one scan at a time
      for (const body of [{ source: CONTAINER }, {}]) {
        const busy = await req(admin, 'POST', '/move/scan', body);
        expect(busy.statusCode).toBe(409);
        expect(busy.json()).toEqual({ error: 'busy' });
      }
      release();
      await vi.waitFor(async () => expect((await moveView()).scan?.state).toBe('done'));
      const v = await moveView();
      expect(v.scan).toMatchObject({ source: CONTAINER, state: 'done', result: { source: { id: CONTAINER, name: 'jellyfin' }, folders: [{ rel: 'Filme', target: '/movies', migrated: true }], bytes: 1000, plugins: ['Fanart'] } });
      expect(opBodies('migrate-scan')).toEqual([{ op: 'migrate-scan', serverId: SERVER_ID }, { op: 'migrate-scan', serverId: SERVER_ID, source: CONTAINER }]);
      expect(JSON.stringify([list.json(), one.json(), v])).not.toContain(SERVER_ID);
      // six scans in two minutes: four so far
      expect((await req(admin, 'POST', '/move/scan', {})).statusCode).toBe(200);
      expect((await req(admin, 'POST', '/move/scan', {})).statusCode).toBe(200);
      expect((await req(admin, 'POST', '/move/scan', {})).statusCode).toBe(429);
    });

    it('a failed scan shows its code and the container paths in the view', async () => {
      await linked();
      const failed = async () => {
        expect((await req(admin, 'POST', '/move/scan', { source: CONTAINER })).statusCode).toBe(202);
        await vi.waitFor(async () => expect((await moveView()).scan?.state).toBe('failed'));
        return (await moveView()).scan;
      };
      fake.answer['migrate-scan'] = { status: 409, json: { error: 'source_outside_base', outside: ['/movies'], refused: ['/srv'] } };
      expect(await failed()).toMatchObject({ source: CONTAINER, state: 'failed', error: 'source_outside_base', outside: ['/movies'], refused: ['/srv'], nested: [] });
      fake.answer['migrate-scan'] = { status: 409, json: { error: 'source_nested', nested: ['/media/tv'] } };
      expect(await failed()).toMatchObject({ state: 'failed', error: 'source_nested', outside: [], nested: ['/media/tv'] });
      // an answer without a scan of that container is no scan
      fake.answer['migrate-scan'] = { status: 200, json: { candidates: [] } };
      expect(await failed()).toMatchObject({ state: 'failed', error: 'updater_error' });
      expect((await failed()).result).toBeUndefined();
    });

    it('the move needs a fresh done scan of the same container', async () => {
      await linked();
      await reauth(admin);
      const move = async () => (await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false })).json();
      expect(await move()).toEqual({ error: 'scan_required' });
      // a scan of another container, a failed one, a stale one
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      const result = { source: { id: CONTAINER, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', version: '10.10.3' }, folders: [], layout: 'official', bytes: 1, trickplayBytes: 0, plugins: [], nfo: false };
      await env.kv.set('media:move:scan', JSON.stringify({ source: 'd'.repeat(64), state: 'done', result: { ...result, source: { ...result.source, id: 'd'.repeat(64) } }, at: at(0) }), 600);
      expect(await move()).toEqual({ error: 'scan_required' });
      await env.kv.set('media:move:scan', JSON.stringify({ source: CONTAINER, state: 'failed', error: 'no_space', at: at(0) }), 600);
      expect(await move()).toEqual({ error: 'scan_required' });
      offset += 3 * 60_000;
      await reauth(admin);
      await env.kv.set('media:move:scan', JSON.stringify({ source: CONTAINER, state: 'done', result, at: at(11 * 60_000) }), 600);
      expect(await move()).toEqual({ error: 'scan_required' });
      expect(opBodies('migrate')).toEqual([]);
      await env.kv.set('media:move:scan', JSON.stringify({ source: CONTAINER, state: 'done', result, at: at(60_000) }), 600);
      expect((await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false })).statusCode).toBe(202);
    });

    it('a Jellyfin that does not tell its server id cannot be scanned or moved', async () => {
      await linked();
      await reauth(admin);
      fake.info = null;
      expect((await req(admin, 'POST', '/move/scan', {})).json()).toEqual({ error: 'jellyfin_unreachable' });
      fake.info = { Id: 'not-an-id' };
      const r = await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'jellyfin_unreachable' });
      expect(fake.bodies.filter((b) => b.op !== 'gpu')).toEqual([]);
    });

    it('the move: the backend adds user, GPU, time zone and server id; the move is recorded and audited', async () => {
      await linked();
      await reauth(admin);
      fake.media = { ...media(), container: null, desired: { kind: 'ferrofin', folders: [], uid: 1500, gid: 1500, gpu: 'off', mediaGid: null, egress: true, run: false } };
      await scanned();
      const r = await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: true });
      expect(r.statusCode).toBe(202);
      const jobId = r.json().job.id as string;
      expect(r.json().job.action).toBe('mediaserver-migrate');
      const [sent] = opBodies('migrate');
      expect(Object.keys(sent!)).toEqual(['op', 'source', 'trickplay', 'gpu', 'uid', 'gid', 'tz', 'serverId']);
      // the GPU as the detection proposes it (dri found), the user the scan ran as
      expect(sent).toMatchObject({ op: 'migrate', source: CONTAINER, trickplay: true, gpu: 'dri', uid: 1500, gid: 1500, serverId: SERVER_ID });
      expect(sent!.tz).toMatch(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/);
      const m = await readManaged(env.pool);
      expect(m.move).toMatchObject({ phase: 'copying', error: null, jobId, requestsWarning: false });
      expect(m.move!.startedAt).toMatch(/^\d{4}-/);
      expect(m.kind).toBeNull();
      const adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
      expect(await audits('mediaserver.move')).toEqual([{ actor: adminId, meta: { trickplay: true, gpu: 'dri' } }]);
      expect(JSON.parse((await env.kv.get(`updater:pending:${jobId}`))!)).toMatchObject({ action: 'mediaserver', op: 'migrate' });
      fake.media = { ...media(), move: { phase: 'running', step: 'copy_bulk', source: { name: 'jellyfin', version: '10.10.3' }, folders: [], abort: false } };
      // not offered while it runs
      expect(await moveView()).toMatchObject({ offered: false, state: { phase: 'copying', error: null, jobId, step: 'copy_bulk', abort: false } });
      // one move at a time: refused while one is under way, before anything is sent
      offset += 3 * 60_000;
      await reauth(admin);
      const again = await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: true });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'busy' });
      expect(opBodies('migrate')).toHaveLength(1);
    });

    it('defaults without a recorded user or a GPU; 409 busy from the updater records nothing', async () => {
      await linked();
      await reauth(admin);
      fake.media = { ...media(), container: null, desired: null };
      fake.answer.gpu = { status: 200, json: { dri: [], nvidia: false } };
      fake.answer.migrate = { status: 409, json: { error: 'busy' } };
      await scanned();
      const r = await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'busy' });
      expect(opBodies('migrate')[0]).toMatchObject({ gpu: 'off', uid: 1000, gid: 1000 });
      expect((await readManaged(env.pool)).move).toBeNull();
      expect(await audits('mediaserver.move')).toEqual([]);
      // a failed move may be tried again
      await writeManaged(env.ctx, { move: { phase: 'failed', error: 'no_space', jobId: null, startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false } });
      delete fake.answer.migrate;
      fake.answer.gpu = { status: 200, json: { dri: [], nvidia: true } };
      expect((await req(admin, 'POST', '/move', { source: CONTAINER, trickplay: false })).statusCode).toBe(202);
      expect(opBodies('migrate')[1]).toMatchObject({ gpu: 'nvidia' });
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'copying', error: null });
    });

    it('abort: sent to the updater and audited; an abort run as its own job ends the move; after the switch it is refused', async () => {
      const COPY_JOB = 'aaaaaaaaaaaaaaaa';
      const move = (phase: string) => writeManaged(env.ctx, { move: { phase: phase as 'copying', error: null, jobId: COPY_JOB, startedAt: '2026-11-24T09:00:00.000Z', requestsWarning: false } });
      const answer = (id: string) => { fake.answer['migrate-abort'] = { status: 202, json: { job: { ...job('mediaserver-migrate'), id } } }; };
      // the copy's job is still running: it carries the abort out, its end is read by the move's phases
      await move('copying');
      answer(COPY_JOB);
      const r = await req(admin, 'POST', '/move/abort');
      expect(r.statusCode).toBe(202);
      expect(r.json().job).toMatchObject({ id: COPY_JOB, action: 'mediaserver-migrate' });
      expect(opBodies('migrate-abort')).toEqual([{ op: 'migrate-abort' }]);
      expect((await readManaged(env.pool)).move!.phase).toBe('copying');
      // the copy finished (the backend has not moved on yet): the updater runs the abort as a new job, the move has failed
      answer('bbbbbbbbbbbbbbbb');
      expect((await req(admin, 'POST', '/move/abort')).statusCode).toBe(202);
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'move_aborted' });
      // during the backend's phases the move has failed too
      await move('verify');
      answer('cccccccccccccccc');
      expect((await req(admin, 'POST', '/move/abort')).statusCode).toBe(202);
      expect((await readManaged(env.pool)).move).toMatchObject({ phase: 'failed', error: 'move_aborted' });
      const adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
      expect(await audits('mediaserver.move_abort')).toEqual([{ actor: adminId, meta: { phase: 'copying' } }, { actor: adminId, meta: { phase: 'copying' } }, { actor: adminId, meta: { phase: 'verify' } }]);
      // FriendFlix uses the new server from the switch on: no abort there (the way back is /back)
      offset += 3 * 60_000;
      await move('switch');
      const late = await req(admin, 'POST', '/move/abort');
      expect(late.statusCode).toBe(409);
      expect(late.json()).toEqual({ error: 'not_abortable' });
      expect(opBodies('migrate-abort')).toHaveLength(3);
      // an updater with nothing to abort answers its code
      await env.pool.query('delete from media_managed');
      fake.answer['migrate-abort'] = { status: 409, json: { error: 'no_target' } };
      expect((await req(admin, 'POST', '/move/abort')).json()).toEqual({ error: 'no_target' });
    });

    it('the way back: only after a move, never audited when it changed nothing', async () => {
      await reauth(admin);
      const r = await req(admin, 'POST', '/back');
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'not_moved' });
      await writeManaged(env.ctx, { kind: 'ferrofin', setup: 'done', migratedFrom: { name: 'jellyfin', version: '10.10.3', at: '2026-11-24T10:00:00.000Z' } });
      fake.media = { ...media(), source: { name: 'jellyfin', state: 'exited', version: '10.10.3' } };
      expect(await moveView()).toMatchObject({ offered: false, migratedFrom: { name: 'jellyfin', version: '10.10.3', at: '2026-11-24T10:00:00.000Z' }, sourceState: 'exited' });
      const back = await req(admin, 'POST', '/back');
      expect(back.statusCode).toBe(409);
      expect(back.json()).toEqual({ error: 'not_available' });
      expect(await audits('mediaserver.back')).toEqual([]);
      expect((await readManaged(env.pool)).kind).toBe('ferrofin');
    });
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
    // a base change refused while a migrated server exists (its media sit at the old base)
    fake.answer['base-confirm'] = { status: 409, json: { error: 'template_violation' } };
    const tv = await req(admin, 'POST', '/base/confirm', { code: CODE });
    expect(tv.statusCode).toBe(409);
    expect(tv.json()).toEqual({ error: 'template_violation' });
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
