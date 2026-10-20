// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { autoUpdateTick, parseStatus, signUpdater, updaterKey } from '../src/updater.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// The backend side of the opt-in updater: signing (shared vectors with updater/), the admin routes (admin only, re-auth, rate
// limit, audit of start and result), the updater-absent fallback and the automatic update tick.
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/updater-hmac.json', import.meta.url), 'utf8')) as {
  secret: string; key: string; cases: Array<{ method: string; path: string; body: string; ts: string; nonce: string; signature: string }>;
};
type Sess = { cookies: Record<string, string>; csrf: string };
const DORA = { sub: 'sub-dora', email: 'dora@example.com', name: 'Dora', groups: [] as string[] };
const SECRET = 'internal-secret-123456';
const JOB_ID = '0123456789abcdef';

/** a fake updater: checks every signature like updater/src/protocol.ts, records the calls */
const fake = {
  up: true, busy: false, previous: 'sha-aaaaaaa' as string | null, status: 200, jobState: 'running' as string, answer: null as unknown,
  /** the updater's stack field (undefined = an updater from before it existed) */
  stack: undefined as 'own' | 'foreign' | undefined,
  /** newest GitHub release tag; Portainer webhook answer status */
  release: 'v2.0.0', portainerStatus: 204,
  calls: [] as Array<{ method: string; path: string; body: string; sigOk: boolean }>,
  portainer: [] as Array<{ method: string; url: string }>,
  reset() { Object.assign(this, { up: true, busy: false, previous: 'sha-aaaaaaa', status: 200, jobState: 'running', answer: null, stack: undefined, release: 'v2.0.0', portainerStatus: 204, calls: [], portainer: [] }); },
};
const HOOK = 'https://portainer.example.com/api/stacks/webhooks/0e1d2c3b-hook';
const job = () => ({ id: JOB_ID, action: 'update', state: fake.jobState, step: fake.jobState === 'running' ? 'pull' : null, from: 'sha-aaaaaaa', to: 'latest',
  steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: fake.jobState === 'running' ? 'pending' : 'ok', rollback: 'skipped' },
  startedAt: '2026-10-18T04:00:00.000Z', finishedAt: fake.jobState === 'running' ? null : '2026-10-18T04:03:00.000Z', error: null });
function sigOk(method: string, path: string, body: string, h: Record<string, string>): boolean {
  const key = createHmac('sha256', SECRET).update('friendflix-updater/v1').digest();
  const canon = [method, path, h['x-ff-updater-ts'], h['x-ff-updater-nonce'], createHash('sha256').update(body).digest('hex')].join('\n');
  return h['x-ff-updater-signature'] === `v1=${createHmac('sha256', key).update(canon).digest('hex')}` && Math.abs(Date.now() - Number(h['x-ff-updater-ts'])) < 60_000;
}
const updaterFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  if (u.host === 'portainer.example.com') { fake.portainer.push({ method: init?.method ?? 'GET', url: u.href }); return new Response(null, { status: fake.portainerStatus }); }
  if (u.host === 'api.github.com') {
    if (u.pathname.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: fake.release, name: fake.release, html_url: 'https://github.com/x/r', published_at: '2026-10-01T00:00:00Z', body: '' }));
    if (u.pathname.includes('/actions/workflows/')) return new Response(JSON.stringify({ workflow_runs: [] }));
    return new Response('{}', { status: 404 });
  }
  if (u.host !== 'updater:7070') return new Response('{}', { status: 404 });
  if (!fake.up) throw new TypeError('fetch failed');
  const body = typeof init?.body === 'string' ? init.body : '';
  const method = init?.method ?? 'GET';
  const ok = sigOk(method, u.pathname, body, init?.headers as Record<string, string>);
  fake.calls.push({ method, path: u.pathname, body, sigOk: ok });
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (!ok) return j({ error: 'bad_signature' }, 401);
  if (fake.status !== 200) return j({ error: 'x' }, fake.status);
  if (u.pathname === '/v1/status') return j(fake.answer ?? { updater: { version: '1.1.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: fake.previous,
    busy: fake.busy, job: job(), log: ['2026-10-18T04:00:00.000Z step pull'], services: [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-aaaaaaa', version: '1.1.0', extra: '<script>' }],
    ...(fake.stack ? { stack: fake.stack } : {}) });
  if (u.pathname === '/v1/channel') return fake.busy ? j({ error: 'busy' }, 409) : j({ ...JSON.parse(body), targetTag: 'latest' });
  if (fake.busy) return j({ error: 'busy' }, 409);
  if (u.pathname === '/v1/rollback' && !fake.previous) return j({ error: 'no_previous' }, 400);
  return j({ job: { ...job(), action: u.pathname.slice(4) } }, 202);
};

let env: TestEnv, admin: Sess;
const as = (s: Sess, method: string, url: string, payload?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });
const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
const setCfg = (patch: Record<string, unknown>) => { env.ctx.cfg = { ...env.ctx.cfg, ...patch } as typeof env.ctx.cfg; };

beforeAll(async () => {
  env = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = updaterFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070' }; } });
  admin = await env.login(ADMIN);
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-dora', 'dora@example.com', 'Dora', 'friend', $1, 'Dora', $2)", ['d'.repeat(32), encrypt(env.ctx.encKey, 'pw')]);
});
afterAll(() => env.close());
beforeEach(() => { fake.reset(); setCfg({ UPDATER_URL: 'http://updater:7070', UPDATE_CHANNEL: 'stable', UPDATE_VERSION: undefined, AUTO_UPDATE: 'off', AUTO_UPDATE_TIME: '04:00', PORTAINER_WEBHOOK_URL: undefined }); });

describe('updater signing', () => {
  it('matches the shared vectors (updater/test/protocol.test.ts uses the same file)', () => {
    const key = updaterKey(vectors.secret);
    expect(key.toString('hex')).toBe(vectors.key);
    for (const c of vectors.cases) expect(signUpdater(key, c.method, c.path, c.body, c.ts, c.nonce)['x-ff-updater-signature']).toBe(c.signature);
    const a = signUpdater(key, 'GET', '/v1/status'), b = signUpdater(key, 'GET', '/v1/status');
    expect(a['x-ff-updater-nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(a['x-ff-updater-nonce']).not.toBe(b['x-ff-updater-nonce']);
  });

  it('status answers are parsed field by field', () => {
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({ channel: 'evil' })).toBeNull();
    const s = parseStatus({ channel: 'pinned', version: '1.2.3', current: 'latest; id', previous: 'sha-zzz', job: { id: 'x' }, log: [1, 'a'.repeat(400)], services: [{ service: 'Bad Name' }, { service: 'web', state: 'running', sha: 'sha-abcdef1' }] })!;
    expect(s).toMatchObject({ channel: 'pinned', version: '1.2.3', current: null, previous: null, job: null, busy: false, services: [{ service: 'web', state: 'running', health: '', sha: 'sha-abcdef1', version: null }] });
    expect(s.log).toEqual(['a'.repeat(300)]);
    expect(s.stack).toBeNull(); // an updater from before the field
    expect(parseStatus({ channel: 'stable', stack: 'foreign' })!.stack).toBe('foreign');
    expect(parseStatus({ channel: 'stable', stack: 'own' })!.stack).toBe('own');
    expect(parseStatus({ channel: 'stable', stack: '<b>' })!.stack).toBeNull();
    // why, and the two directories (host paths; anything but a plain absolute path is dropped)
    expect(parseStatus({ channel: 'stable', stack: 'foreign', stackReason: 'working_dir', stackDir: '/volume1/docker/friendflix', projectDir: '/project' })).toMatchObject(
      { stack: 'foreign', stackReason: 'working_dir', stackDir: '/volume1/docker/friendflix', projectDir: '/project' });
    expect(parseStatus({ channel: 'stable', stackReason: 'evil', stackDir: '/x/<script>', projectDir: 'relative' })).toMatchObject({ stackReason: null, stackDir: null, projectDir: null });
  });
});

describe('GET /api/admin/updater', () => {
  it('admin only', async () => {
    const dora = await env.login(DORA);
    expect((await as(dora, 'GET', '/api/admin/updater')).statusCode).toBe(403);
    admin = await env.login(ADMIN);
  });

  it('present: the checked status, signed request, no-store; automatic update setting', async () => {
    const r = await as(admin, 'GET', '/api/admin/updater');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = r.json();
    expect(b).toMatchObject({ present: true, status: { channel: 'stable', current: 'latest', previous: 'sha-aaaaaaa', job: { id: JOB_ID, state: 'running' } }, autoUpdate: { mode: 'off', time: '04:00', locked: [] } });
    expect(JSON.stringify(b)).not.toContain('<script>');
    expect(fake.calls).toEqual([{ method: 'GET', path: '/v1/status', body: '', sigOk: true }]);
    expect(b.portainer).toEqual({ configured: false, mode: null });
  });

  it('a foreign stack: the status says so, with whether Portainer is set up (the page explains it up front)', async () => {
    fake.stack = 'foreign';
    setCfg({ PORTAINER_WEBHOOK_URL: HOOK });
    const b = (await as(admin, 'GET', '/api/admin/updater')).json();
    expect(b).toMatchObject({ present: true, status: { stack: 'foreign' }, portainer: { configured: true, mode: 'webhook' } });
    expect(JSON.stringify(b)).not.toContain('0e1d2c3b'); // never the webhook URL
  });

});

describe('settings and automatic updates', () => {
  it('the pinned channel needs a version (Admin -> Settings / the channel switch)', async () => {
    const r = await as(admin, 'PUT', '/api/admin/settings', { values: { UPDATE_CHANNEL: 'pinned' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors).toEqual({ UPDATE_VERSION: 'required' });
    expect((await as(admin, 'PUT', '/api/admin/settings', { values: { UPDATE_VERSION: 'latest' } })).json().errors).toEqual({ UPDATE_VERSION: 'invalid' });
    expect((await as(admin, 'PUT', '/api/admin/settings', { values: { UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: '1.2.3' } })).statusCode).toBe(200);
    const u = (await as(admin, 'GET', '/api/admin/update')).json();
    expect(u.channel).toMatchObject({ selected: 'pinned', version: '1.2.3', envLine: 'FF_TAG=1.2.3' });
    expect((await as(admin, 'PUT', '/api/admin/settings', { values: { UPDATE_CHANNEL: 'stable', UPDATE_VERSION: null, AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '03:30' } })).statusCode).toBe(200);
    expect((await as(admin, 'PUT', '/api/admin/settings', { values: { AUTO_UPDATE_TIME: '25:00' } })).json().errors).toEqual({ AUTO_UPDATE_TIME: 'invalid' });
    expect((await as(admin, 'GET', '/api/admin/updater')).json().autoUpdate).toEqual({ mode: 'nightly-window', time: '03:30', locked: [] });
    await as(admin, 'PUT', '/api/admin/settings', { values: { AUTO_UPDATE: null, AUTO_UPDATE_TIME: null } });
  });

  it('nightly window: off by default, once per day inside the 30 minutes from the time, as the system', async () => {
    const at = (h: number, m: number, d = 18) => new Date(2026, 9, d, h, m);
    expect(await autoUpdateTick(env.ctx, at(4, 5))).toBe('off');
    setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '23:50' });
    expect(await autoUpdateTick(env.ctx, at(0, 21))).toBe('outside');
    fake.busy = true;
    expect(await autoUpdateTick(env.ctx, at(0, 10))).toBe('busy'); // across midnight
    fake.busy = false;
    expect(await autoUpdateTick(env.ctx, at(0, 10))).toBe('started');
    expect(await autoUpdateTick(env.ctx, at(0, 11))).toBe('done');
    expect(fake.calls.filter((c) => c.path === '/v1/update').length).toBe(1);
    expect((await audits('system.updater_start')).at(-1)).toEqual({ actor: null, meta: { action: 'update', from: 'sha-aaaaaaa', to: 'latest', auto: true } });
    // the next day again
    expect(await autoUpdateTick(env.ctx, at(23, 55, 19))).toBe('started');
    fake.status = 500;
    expect(await autoUpdateTick(env.ctx, at(23, 55, 20))).toBe('absent');
  });

  it('a foreign stack without Portainer: the updater is never asked to run, once per day, nothing retried every tick', async () => {
    const at = (h: number, m: number, d: number) => new Date(2026, 9, d, h, m);
    setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '02:00' });
    fake.stack = 'foreign';
    expect(await autoUpdateTick(env.ctx, at(2, 1, 21))).toBe('foreign');
    expect(await autoUpdateTick(env.ctx, at(2, 2, 21))).toBe('done');
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(fake.portainer).toEqual([]);
  });

  it('a foreign stack with the Portainer webhook: a new version redeploys through Portainer, once per version; a failure is logged and retried the next night', async () => {
    const at = (h: number, m: number, d: number) => new Date(2026, 9, d, h, m);
    const warns: Array<[object, string]> = [];
    const log = { warn: (o: object, m: string) => { warns.push([o, m]); } };
    const tick = (d: Date) => autoUpdateTick(env.ctx, d, log);
    setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '02:00', PORTAINER_WEBHOOK_URL: HOOK });
    fake.stack = 'foreign';
    // nothing newer than the installed version: nothing redeployed
    expect(await tick(at(2, 1, 22))).toBe('current');
    expect(fake.portainer).toEqual([]);
    fake.release = 'v99.0.0';
    expect(await tick(at(2, 1, 23))).toBe('started');
    expect(fake.portainer).toEqual([{ method: 'POST', url: HOOK }]);
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]); // the updater never runs a job on a foreign stack
    // audited before the call and with its outcome after it
    expect((await audits('system.update')).at(-1)).toMatchObject({ actor: null, meta: { mode: 'webhook', toVersion: '99.0.0', auto: true } });
    expect((await audits('system.update_result')).at(-1)).toMatchObject({ actor: null, meta: { mode: 'webhook', toVersion: '99.0.0', auto: true, result: 'started' } });
    // the next nights: a version that was redeployed is not redeployed again (also when the stack pins another tag)
    expect(await tick(at(2, 1, 24))).toBe('done');
    expect(fake.portainer.length).toBe(1);
    // Portainer refuses: logged (never the URL), audited as failed, one attempt per night, tried again the next night
    fake.release = 'v99.0.1';
    fake.portainerStatus = 500;
    expect(await tick(at(2, 1, 25))).toBe('failed');
    expect(await tick(at(2, 5, 25))).toBe('done');
    expect(warns).toEqual([[{ mode: 'webhook', step: 'webhook', status: 500 }, 'automatic update through Portainer failed']]);
    expect(JSON.stringify(warns)).not.toContain('0e1d2c3b');
    expect((await audits('system.update_result')).at(-1)).toMatchObject({ actor: null, meta: { toVersion: '99.0.1', result: 'failed', error: 'portainer', step: 'webhook', status: 500 } });
    fake.portainerStatus = 204;
    expect(await tick(at(2, 1, 26))).toBe('started');
    expect(await tick(at(2, 1, 27))).toBe('done');
    expect(fake.portainer.length).toBe(3);
  });

  it('an updater from before the stack field on a Portainer-configured install: the update goes through Portainer, never the old updater', async () => {
    const at = (h: number, m: number, d: number) => new Date(2026, 9, d, h, m);
    setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '02:00', PORTAINER_WEBHOOK_URL: HOOK });
    fake.stack = undefined;
    fake.release = 'v98.0.0';
    expect(await autoUpdateTick(env.ctx, at(2, 1, 28))).toBe('started');
    expect(fake.portainer).toEqual([{ method: 'POST', url: HOOK }]);
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

// the tests below build their own apps: makeEnv resets the shared test database, so the top-level app is not used after here
describe('updater absent or misconfigured', () => {
  it('absent: no UPDATER_URL, or the name does not resolve (remembered briefly): present false, the page keeps the manual steps', async () => {
    const fresh = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = updaterFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: undefined }; } });
    const a = await fresh.login(ADMIN);
    const get = async () => (await fresh.app.inject({ url: '/api/admin/updater', cookies: a.cookies })).json();
    expect(await get()).toMatchObject({ present: false });
    expect(fake.calls).toEqual([]);
    fresh.ctx.cfg = { ...fresh.ctx.cfg, UPDATER_URL: 'http://updater:7070' };
    fake.up = false;
    expect(await get()).toMatchObject({ present: false });
    fake.up = true;
    expect(await get()).toMatchObject({ present: false }); // the absence is remembered for 30 s
    expect(fake.calls).toEqual([]);
    await fresh.close();
  });

  it('a refused signature (secret mismatch) and a broken answer are reported, never forwarded', async () => {
    const fresh = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = updaterFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: 'another-secret-value-123' }; } });
    const a = await fresh.login(ADMIN);
    expect((await fresh.app.inject({ url: '/api/admin/updater', cookies: a.cookies })).json()).toMatchObject({ present: true, error: 'unauthorized' });
    fresh.ctx.cfg = { ...fresh.ctx.cfg, INTERNAL_SECRET: SECRET };
    fake.answer = { channel: 'nope' };
    expect((await fresh.app.inject({ url: '/api/admin/updater', cookies: a.cookies })).json()).toMatchObject({ present: true, error: 'invalid_answer' });
    await fresh.close();
  });
});

describe('POST /api/admin/updater/:action', () => {
  let e2: TestEnv, a2: Sess;
  const post = (action: string) => e2.app.inject({ method: 'POST', url: `/api/admin/updater/${action}`, cookies: a2.cookies, headers: { 'x-csrf-token': a2.csrf } });
  const stamp = async (at = Date.now()) => {
    const key = `sess:${a2.cookies.ff_sid}`;
    await e2.kv.set(key, JSON.stringify({ ...JSON.parse((await e2.kv.get(key))!), reauthAt: at }), 600);
  };
  // a fresh app per test: the route allows 3 starts per 2 minutes for the whole portal
  beforeEach(async () => {
    await e2?.close();
    e2 = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = updaterFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070' }; } });
    a2 = await e2.login(ADMIN);
  });
  afterAll(() => e2?.close());

  it('non-admins are refused; an admin needs a recent re-authentication', async () => {
    await e2.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-dora', 'dora@example.com', 'Dora', 'friend', $1, 'Dora', $2)", ['d'.repeat(32), encrypt(e2.ctx.encKey, 'pw')]);
    const dora = await e2.login(DORA);
    expect((await e2.app.inject({ method: 'POST', url: '/api/admin/updater/update', cookies: dora.cookies, headers: { 'x-csrf-token': dora.csrf } })).statusCode).toBe(403);
    a2 = await e2.login(ADMIN);
    const r = await post('update');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'reauth_required' });
    await stamp(Date.now() - 11 * 60_000);
    expect((await post('update')).statusCode).toBe(401);
    expect((await post('exec')).statusCode).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it('update: the channel is sent first, then the job starts; start and result are audited once', async () => {
    await stamp();
    e2.ctx.cfg = { ...e2.ctx.cfg, UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: '1.2.3' };
    const r = await post('update');
    expect(r.statusCode).toBe(202);
    expect(r.json().job).toMatchObject({ id: JOB_ID, action: 'update', to: 'latest' });
    expect(fake.calls.map((c) => [c.method, c.path, c.body, c.sigOk])).toEqual([['GET', '/v1/status', '', true],
      ['POST', '/v1/channel', '{"channel":"pinned","version":"1.2.3"}', true], ['POST', '/v1/update', '', true]]);
    const userId = (await e2.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
    const start = (await e2.pool.query('select actor, meta from audit_log where action=$1', ['system.updater_start'])).rows;
    expect(start).toEqual([{ actor: userId, meta: { action: 'update', from: 'sha-aaaaaaa', to: 'latest' } }]);
    // the job finishes (the backend usually restarts meanwhile): the next status read audits the result, exactly once
    fake.jobState = 'rolled_back';
    await e2.app.inject({ url: '/api/admin/updater', cookies: a2.cookies });
    await e2.app.inject({ url: '/api/admin/updater', cookies: a2.cookies });
    const res = (await e2.pool.query('select actor, meta from audit_log where action=$1', ['system.updater_result'])).rows;
    expect(res).toEqual([{ actor: userId, meta: { action: 'update', from: 'sha-aaaaaaa', to: 'latest', result: 'rolled_back', error: null } }]);
  });

  it('rollback and self-update; refusals from the updater come back as 409', async () => {
    await stamp();
    expect((await post('rollback')).statusCode).toBe(202);
    expect(fake.calls.map((c) => c.path)).toEqual(['/v1/status', '/v1/rollback']); // whose stack it is; no channel sync for a rollback
    expect((await post('self-update')).statusCode).toBe(202);
    fake.previous = null;
    const r = await post('rollback');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'no_previous' });
  });

  it('busy, absent, unknown action, pinned without a version', async () => {
    await stamp();
    fake.busy = true;
    expect((await post('update')).json()).toEqual({ error: 'busy' });
    fake.busy = false;
    e2.ctx.cfg = { ...e2.ctx.cfg, UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: undefined };
    const p = await post('update');
    expect([p.statusCode, p.json()]).toEqual([409, { error: 'no_target' }]);
    fake.up = false;
    e2.ctx.cfg = { ...e2.ctx.cfg, UPDATE_CHANNEL: 'stable' };
    expect((await post('rollback')).json()).toEqual({ error: 'not_available' });
  });

  it('a foreign stack with Portainer configured: "update" redeploys through Portainer instead of the updater, audited', async () => {
    await stamp();
    fake.stack = 'foreign';
    e2.ctx.cfg = { ...e2.ctx.cfg, PORTAINER_WEBHOOK_URL: HOOK };
    const r = await post('update');
    expect([r.statusCode, r.json()]).toEqual([202, { portainer: { mode: 'webhook' } }]);
    expect(fake.portainer).toEqual([{ method: 'POST', url: HOOK }]);
    expect(fake.calls.map((c) => [c.method, c.path])).toEqual([['GET', '/v1/status']]); // no channel sync, no /v1/update
    const userId = (await e2.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
    expect((await e2.pool.query('select actor, meta from audit_log where action=$1', ['system.update'])).rows).toEqual([{ actor: userId, meta: expect.objectContaining({ mode: 'webhook' }) }]);
    // Portainer refuses: the error comes back
    fake.portainerStatus = 500;
    const f = await post('update');
    expect([f.statusCode, f.json()]).toEqual([502, { error: 'portainer', status: 500, step: 'webhook' }]);
  });

  it('a foreign stack without Portainer: refused with foreign_stack before the updater runs anything; rollback and self-update too', async () => {
    await stamp();
    fake.stack = 'foreign';
    for (const a of ['update', 'rollback', 'self-update']) {
      const r = await post(a);
      expect([r.statusCode, r.json()], a).toEqual([409, { error: 'foreign_stack' }]);
    }
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(fake.portainer).toEqual([]);
  });

  it('an updater without the stack field (or that cannot tell) and Portainer configured: treated as Portainer\'s stack', async () => {
    await stamp();
    e2.ctx.cfg = { ...e2.ctx.cfg, PORTAINER_WEBHOOK_URL: HOOK };
    const r = await post('update');
    expect([r.statusCode, r.json()]).toEqual([202, { portainer: { mode: 'webhook' } }]);
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    for (const a of ['rollback', 'self-update']) expect((await post(a)).json(), a).toEqual({ error: 'foreign_stack' });
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('our own stack: unchanged, the updater runs the job (also with Portainer configured)', async () => {
    await stamp();
    fake.stack = 'own';
    e2.ctx.cfg = { ...e2.ctx.cfg, PORTAINER_WEBHOOK_URL: HOOK };
    const r = await post('update');
    expect(r.statusCode).toBe(202);
    expect(r.json().job).toMatchObject({ action: 'update' });
    expect(fake.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/v1/channel', '/v1/update']);
    expect(fake.portainer).toEqual([]);
  });

  it('rate limit: 3 starts per 2 minutes for the whole portal', async () => {
    await stamp();
    for (let i = 0; i < 3; i++) expect((await post('rollback')).statusCode).toBe(202);
    expect((await post('rollback')).statusCode).toBe(429);
  });
});
