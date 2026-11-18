// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { REDEPLOY_KEY, REDEPLOY_LOCK } from '../src/redeploy.js';
import { autoUpdateTick, parseStatus, signUpdater, streamBinding, updaterKey, updaterView } from '../src/updater.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';
import { sessionKey } from '../src/session.js';

// The backend side of the opt-in updater: signing (shared vectors with updater/), the admin routes (admin only, re-auth, rate
// limit, audit of start and result), the updater-absent fallback and the automatic update tick.
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/updater-hmac.json', import.meta.url), 'utf8')) as {
  secret: string; key: string; cases: Array<{ method: string; path: string; body: string; ts: string; nonce: string; signature: string }>;
  streamBindings: Array<{ header: string; binding: string }>;
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
  /** what the updater lists as running (null: the backend alone, on sha-aaaaaaa) */
  services: null as unknown[] | null,
  /** the updater refuses POST /v1/update with this error (null: it starts the job) */
  refuse: null as string | null,
  /** runs when POST /v1/update arrives, before the answer (it throws: the answer is lost, e.g. a timeout) */
  onStart: null as (() => void) | null,
  calls: [] as Array<{ method: string; path: string; body: string; sigOk: boolean }>,
  portainer: [] as Array<{ method: string; url: string }>,
  reset() { Object.assign(this, { up: true, busy: false, previous: 'sha-aaaaaaa', status: 200, jobState: 'running', answer: null, stack: undefined, release: 'v2.0.0', portainerStatus: 204, services: null, refuse: null, onStart: null, calls: [], portainer: [] }); },
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
    busy: fake.busy, job: job(), log: ['2026-10-18T04:00:00.000Z step pull'], services: fake.services ?? [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-aaaaaaa', version: '1.1.0', extra: '<script>' }],
    ...(fake.stack ? { stack: fake.stack } : {}) });
  if (u.pathname === '/v1/channel') return fake.busy ? j({ error: 'busy' }, 409) : j({ ...JSON.parse(body), targetTag: 'latest' });
  if (fake.busy) return j({ error: 'busy' }, 409);
  if (u.pathname === '/v1/update' && fake.refuse) return j({ error: fake.refuse }, 409);
  if (u.pathname === '/v1/update') fake.onStart?.();
  if (u.pathname === '/v1/rollback' && !fake.previous) return j({ error: 'no_previous' }, 400);
  return j({ job: { ...job(), action: u.pathname.slice(4) } }, 202);
};

let env: TestEnv, admin: Sess;
const as = (s: Sess, method: string, url: string, payload?: unknown) => env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });
const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
const setCfg = (patch: Record<string, unknown>) => { env.ctx.cfg = { ...env.ctx.cfg, ...patch } as typeof env.ctx.cfg; };
/** the last Portainer redeploy ended (here: forgotten), so the next one may start (one at a time, redeploy.ts) */
const endRedeploy = async (e: TestEnv = env) => { await e.kv.del(REDEPLOY_LOCK); await e.kv.del(REDEPLOY_KEY); };

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
    // the backup streams sign a scrypt derivation of the passphrase header, the same bytes as updater/src/protocol.ts streamBinding
    for (const c of vectors.streamBindings) expect(streamBinding(c.header)).toBe(c.binding);
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

  it('parseStatus keeps commit, digest, registry, changed only in their shapes', () => {
    const D = 'sha256:' + '1'.repeat(64), R = 'sha256:' + '2'.repeat(64);
    const s = parseStatus({ channel: 'nightly', services: [
      { service: 'backend', state: 'running', health: 'healthy', sha: 'sha-1111111', version: '3.6.0', commit: '1'.repeat(40), digest: D, registry: R, changed: true },
      { service: 'web', state: 'running', commit: 'abc', digest: 'sha256:xyz', registry: `ghcr.io/x@${R}`, changed: 'yes' },
      { service: 'gateway', state: 'running', commit: 'A'.repeat(40), digest: D.toUpperCase(), registry: null, changed: false },
    ] })!;
    expect(s.services).toEqual([
      { service: 'backend', state: 'running', health: 'healthy', sha: 'sha-1111111', version: '3.6.0', commit: '1'.repeat(40), digest: D, registry: R, changed: true },
      { service: 'web', state: 'running', health: '', sha: null, version: null, commit: null, digest: null, registry: null, changed: null },
      // changed only stands when both digests passed: an unreadable one makes it unknown
      { service: 'gateway', state: 'running', health: '', sha: null, version: null, commit: null, digest: null, registry: null, changed: null },
    ]);
    expect(parseStatus({ channel: 'nightly', services: [{ service: 'web', digest: D, registry: 'x', changed: true }, { service: 'backend', digest: D, registry: D, changed: false }] })!.services.map((x) => x.changed)).toEqual([null, false]);
    // an updater from before the fields: all null
    expect(parseStatus({ channel: 'stable', services: [{ service: 'backend', sha: 'sha-1111111' }] })!.services[0]).toMatchObject({ commit: null, digest: null, registry: null, changed: null });
  });

  it('parseStatus keeps the job report (updated / unchanged per known service) and whether a rollback is possible', () => {
    const job = { id: JOB_ID, action: 'update', state: 'succeeded', step: null, to: 'nightly', steps: {}, startedAt: '2026-11-17T10:00:00.000Z' };
    const s = parseStatus({ channel: 'nightly', rollback: { available: true, refs: ['x'] }, job: { ...job, services: { backend: 'unchanged', web: 'updated', postgres: 'updated', gateway: '<b>', livetv: 'unchanged' } } })!;
    expect(s.job!.services).toEqual({ backend: 'unchanged', web: 'updated', livetv: 'unchanged' });
    expect(s.rollback).toEqual({ available: true });
    expect(parseStatus({ channel: 'stable', rollback: { available: 'yes' }, job: { ...job, services: 'all' } })).toMatchObject({ rollback: null, job: { services: null } });
    // an updater from before them
    expect(parseStatus({ channel: 'stable', job })).toMatchObject({ rollback: null, job: { services: null } });
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
    expect(b.portainer).toEqual({ configured: false, mode: null, missing: [] });
    expect(b.redeploy).toBeNull();
  });

  it('the Portainer API set up only in part: the page is told which setting is missing (names only, never a value)', async () => {
    fake.stack = 'foreign';
    setCfg({ PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: 'ptr_secret_value' });
    const b = (await as(admin, 'GET', '/api/admin/updater')).json();
    expect(b.portainer).toEqual({ configured: false, mode: null, missing: ['PORTAINER_STACK_ID'] });
    expect(JSON.stringify(b)).not.toContain('ptr_secret_value');
    setCfg({ PORTAINER_URL: undefined, PORTAINER_API_KEY: undefined });
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
    expect(fake.portainer).toEqual([{ method: 'POST', url: `${HOOK}?FF_TAG=latest` }]); // the stable channel rides along
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]); // the updater never runs a job on a foreign stack
    // audited before the call and with its outcome after it
    expect((await audits('system.update')).at(-1)).toMatchObject({ actor: null, meta: { mode: 'webhook', toVersion: '99.0.0', auto: true } });
    expect((await audits('system.update_result')).at(-1)).toMatchObject({ actor: null, meta: { mode: 'webhook', toVersion: '99.0.0', auto: true, result: 'started' } });
    // the next nights: a version that was redeployed is not redeployed again (also when the stack pins another tag)
    expect(await tick(at(2, 1, 24))).toBe('done');
    expect(fake.portainer.length).toBe(1);
    // a redeploy still running is never doubled by the next night: busy, nothing sent
    fake.release = 'v99.0.1';
    expect(await tick(at(2, 1, 25))).toBe('busy');
    expect(fake.portainer.length).toBe(1);
    await endRedeploy();
    // Portainer refuses: logged (never the URL), audited as failed, one attempt per night, tried again the next night
    fake.portainerStatus = 500;
    expect(await tick(at(2, 1, 26))).toBe('failed');
    expect(await tick(at(2, 5, 26))).toBe('done');
    expect(warns).toEqual([[{ mode: 'webhook', step: 'webhook', status: 500 }, 'automatic update through Portainer failed']]);
    expect(JSON.stringify(warns)).not.toContain('0e1d2c3b');
    expect((await audits('system.update_result')).at(-1)).toMatchObject({ actor: null, meta: { toVersion: '99.0.1', result: 'failed', error: 'portainer', step: 'webhook', status: 500 } });
    fake.portainerStatus = 204;
    expect(await tick(at(2, 1, 27))).toBe('started');
    expect(await tick(at(2, 1, 28))).toBe('done');
    expect(fake.portainer.length).toBe(3);
  });

  it('an updater from before the stack field on a Portainer-configured install: the update goes through Portainer, never the old updater', async () => {
    await endRedeploy();
    const at = (h: number, m: number, d: number) => new Date(2026, 9, d, h, m);
    setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '02:00', PORTAINER_WEBHOOK_URL: HOOK });
    fake.stack = undefined;
    fake.release = 'v98.0.0';
    expect(await autoUpdateTick(env.ctx, at(2, 1, 29))).toBe('started');
    expect(fake.portainer).toEqual([{ method: 'POST', url: `${HOOK}?FF_TAG=latest` }]); // the stable channel rides along
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

// Mail stage C, Task 3: a failed update job and a failed automatic Portainer redeploy are admin alerts (notice + mail `updatefailed`)
describe('admin alerts', () => {
  const failedNotices = async () => (await env.pool.query<{ user_id: string; title: string; dedupe: string }>("select user_id, title, dedupe from notifications where kind = 'update_failed' order by id")).rows;
  const admins = async () => (await env.pool.query<{ id: string }>("select id from users where role = 'admin' and not disabled")).rows.map((r) => r.id);
  beforeEach(async () => { await env.pool.query("delete from notifications where kind = 'update_failed'"); });

  it('a rolled-back update job reported through updaterView alerts the admins', async () => {
    await env.kv.set(`updater:pending:${JOB_ID}`, JSON.stringify({ actor: null, action: 'update', from: 'sha-aaaaaaa', to: 'latest', auto: true }), 600);
    fake.jobState = 'rolled_back';
    for (const k of await env.kv.keys('update:')) await env.kv.del(k); // no release cached: the stable tag gives no version
    await updaterView(env.ctx);
    await updaterView(env.ctx); // the result is taken once: no second alert, no second audit
    const ids = await admins();
    expect(ids.length).toBeGreaterThan(0);
    const n = await failedNotices();
    expect(n.map((x) => x.user_id).sort()).toEqual([...ids].sort());
    expect(n[0]).toMatchObject({ title: 'Update fehlgeschlagen', dedupe: `update-failed-${JOB_ID}-${n[0]!.user_id}` });
    expect((await audits('system.updater_result')).at(-1)).toEqual({ actor: null, meta: { action: 'update', from: 'sha-aaaaaaa', to: 'latest', result: 'rolled_back', error: null, auto: true } });
    expect((await audits('system.updater_result')).filter((a) => a.meta.result === 'rolled_back')).toHaveLength(1);
  });

  it('a succeeded update job does not alert', async () => {
    await env.kv.set(`updater:pending:${JOB_ID}`, JSON.stringify({ actor: null, action: 'update', from: 'sha-aaaaaaa', to: 'latest', auto: true }), 600);
    fake.jobState = 'succeeded';
    await updaterView(env.ctx);
    expect(await failedNotices()).toEqual([]);
  });

  it('the failed automatic Portainer redeploy alerts once per target and day', async () => {
    await endRedeploy();
    const at = (h: number, m: number, d: number) => new Date(2026, 10, d, h, m);
    setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '02:00', PORTAINER_WEBHOOK_URL: HOOK });
    fake.stack = 'foreign';
    fake.release = 'v99.2.0';
    fake.portainerStatus = 500;
    expect(await autoUpdateTick(env.ctx, at(2, 1, 2))).toBe('failed');
    const ids = await admins();
    expect((await failedNotices()).map((x) => x.title)).toEqual(ids.map(() => 'Automatisches Update über Portainer fehlgeschlagen'));
    expect((await failedNotices())[0]!.dedupe).toMatch(/^update-failed-portainer-stable:99\.2\.0-2026-11-02-/);
    expect(await autoUpdateTick(env.ctx, at(2, 5, 2))).toBe('done'); // the night's one attempt is used up
    expect(await failedNotices()).toHaveLength(ids.length);
    // the next night it fails again: one more alert
    expect(await autoUpdateTick(env.ctx, at(2, 1, 3))).toBe('failed');
    expect(await failedNotices()).toHaveLength(2 * ids.length);
  });

  // the window wanted to install a newer version but could not start it: the same alert (fix after mail stage C)
  describe('the nightly window cannot start a newer version', () => {
    const at = (h: number, m: number, d: number) => new Date(2026, 10, d, h, m);
    const startNotices = async () => (await env.pool.query<{ title: string; body: string | null; dedupe: string }>(
      "select title, body, dedupe from notifications where kind = 'update_failed' and dedupe like 'update-start-%' order by id")).rows;
    const body = (version: string, reason: string) => `Version ${version} wurde nicht installiert: ${reason}. Mehr unter Admin → Update.`;
    /** the GitHub answer cache ran out (the release the tick compares with is fetched again) */
    const freshInfo = async () => { for (const k of await env.kv.keys('update:')) await env.kv.del(k); };
    beforeEach(async () => {
      await endRedeploy();
      await freshInfo();
      setCfg({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '02:00', APP_VERSION: undefined });
    });

    it('an unreachable updater alerts once per version and day, from the 10th minute of the window on', async () => {
      const ctx = { ...env.ctx }; // its own "absent" memo, so the other tests see the updater again at once
      fake.release = 'v99.4.0';
      fake.up = false;
      expect(await autoUpdateTick(ctx, at(2, 1, 4))).toBe('absent');
      expect(await startNotices()).toEqual([]); // it may still come up within the window
      expect(await autoUpdateTick(ctx, at(2, 10, 4))).toBe('absent');
      const ids = await admins();
      const n = await startNotices();
      expect(n).toHaveLength(ids.length);
      expect(n[0]).toMatchObject({ title: 'Automatisches Update konnte nicht starten', body: body('99.4.0', 'der Updater ist nicht erreichbar') });
      expect(n[0]!.dedupe).toMatch(/^update-start-stable-99\.4\.0-2026-11-04-/);
      // the next ticks the same day do not alert again
      expect(await autoUpdateTick(ctx, at(2, 11, 4))).toBe('absent');
      expect(await autoUpdateTick(ctx, at(2, 29, 4))).toBe('absent');
      expect(await autoUpdateTick(ctx, at(2, 30, 4))).toBe('outside');
      expect(await startNotices()).toHaveLength(ids.length);
      // a newer version the same day does, and the next day again
      await freshInfo();
      fake.release = 'v99.4.1';
      expect(await autoUpdateTick(ctx, at(2, 12, 4))).toBe('absent');
      expect(await startNotices()).toHaveLength(2 * ids.length);
      expect(await autoUpdateTick(ctx, at(2, 12, 5))).toBe('absent');
      expect(await startNotices()).toHaveLength(3 * ids.length);
    });

    it('a refused signature (secret mismatch) alerts as refused, once per day', async () => {
      const ctx = { ...env.ctx, cfg: { ...env.ctx.cfg, INTERNAL_SECRET: 'another-secret-value-123' } };
      fake.release = 'v99.4.2';
      expect(await autoUpdateTick(ctx, at(2, 10, 6))).toBe('absent');
      expect(await autoUpdateTick(ctx, at(2, 20, 6))).toBe('absent');
      const n = await startNotices();
      expect(n).toHaveLength((await admins()).length);
      expect(n[0]!.body).toBe(body('99.4.2', 'der Updater hat den Start abgelehnt'));
    });

    it('the updater refuses the job: alerts once per version and day', async () => {
      fake.release = 'v99.5.0';
      fake.refuse = 'pull_denied';
      expect(await autoUpdateTick(env.ctx, at(2, 1, 7))).toBe('failed');
      const ids = await admins();
      expect((await startNotices()).map((x) => x.body)).toEqual(ids.map(() => body('99.5.0', 'der Updater hat den Start abgelehnt')));
      expect(await autoUpdateTick(env.ctx, at(2, 2, 7))).toBe('done');
      expect(await startNotices()).toHaveLength(ids.length);
      expect(await autoUpdateTick(env.ctx, at(2, 1, 8))).toBe('failed');
      expect(await startNotices()).toHaveLength(2 * ids.length);
    });

    it('a Portainer stack without Portainer set up: alerts once per version and day, the updater never runs', async () => {
      fake.release = 'v99.6.0';
      fake.stack = 'foreign';
      expect(await autoUpdateTick(env.ctx, at(2, 1, 9))).toBe('foreign');
      expect(await autoUpdateTick(env.ctx, at(2, 2, 9))).toBe('done');
      const ids = await admins();
      expect((await startNotices()).map((x) => x.body)).toEqual(ids.map(() => body('99.6.0', 'der Stack wird von Portainer verwaltet, aber Portainer ist nicht eingerichtet')));
      expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    /** env.ctx with one store call failing (rejecting, like the real store) for keys starting with `prefix` */
    const failingKv = (method: 'get' | 'set', prefix: string) => new Proxy(env.ctx.kv, {
      get(t, p) {
        const v = Reflect.get(t, p) as unknown;
        if (typeof v !== 'function') return v;
        const f = (v as (...a: unknown[]) => unknown).bind(t);
        return p === method ? (k: string, ...rest: unknown[]) => (k.startsWith(prefix) ? Promise.reject(new Error('store down')) : f(k, ...rest)) : f;
      },
    });

    it('the start throws before the updater or Portainer accepted it: alerts, and the error still reaches the caller', async () => {
      setCfg({ PORTAINER_WEBHOOK_URL: HOOK });
      fake.stack = 'foreign';
      fake.release = 'v99.6.1';
      // the store fails where the tick looks up whether this version was already redeployed: nothing was sent yet
      await expect(autoUpdateTick({ ...env.ctx, kv: failingKv('get', 'updater:portainer:') }, at(2, 1, 10))).rejects.toThrow('store down');
      expect(fake.portainer).toEqual([]);
      const n = await startNotices();
      expect(n).toHaveLength((await admins()).length);
      expect(n[0]!.body).toBe(body('99.6.1', 'beim Start ist ein Fehler aufgetreten'));
    });

    it('a throw after the start was accepted never says "could not start" (Portainer redeploying, updater job running)', async () => {
      const warns: Array<[object, string]> = [];
      const log = { warn: (o: object, m: string) => { warns.push([o, m]); } };
      setCfg({ PORTAINER_WEBHOOK_URL: HOOK });
      fake.stack = 'foreign';
      fake.release = 'v99.6.2';
      // Portainer got the redeploy, then the store fails to note the version as done: started, logged by code only
      expect(await autoUpdateTick({ ...env.ctx, kv: failingKv('set', 'updater:portainer:') }, at(2, 1, 14), log)).toBe('started');
      expect(fake.portainer).toHaveLength(1);
      expect(warns).toEqual([[{ code: 'done_not_saved' }, 'automatic update through Portainer: the redeployed version was not noted']]);
      // the updater accepted the job, then the store fails to note it as pending
      setCfg({ PORTAINER_WEBHOOK_URL: undefined });
      fake.stack = undefined;
      expect(await autoUpdateTick({ ...env.ctx, kv: failingKv('set', 'updater:pending:') }, at(2, 1, 15), log)).toBe('started');
      expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/update')).toHaveLength(1);
      expect(await startNotices()).toEqual([]);
    });

    it('the answer to the start is lost: the updater\'s status tells a running job (quiet) from one that did not start (error) or a gone updater (unreachable)', async () => {
      const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
      const ids = await admins();
      // accepted (the job runs), only the 202 got lost: started, nobody is told it was not installed
      fake.release = 'v99.6.3';
      fake.onStart = () => { fake.busy = true; timeout(); };
      expect(await autoUpdateTick({ ...env.ctx }, at(2, 1, 16))).toBe('started');
      expect(await startNotices()).toEqual([]);
      // recorded like any automatic start: audited, and its result (a later failure alerts) is reconciled
      const meta = { action: 'update', from: 'sha-aaaaaaa', to: 'latest', auto: true };
      expect(JSON.parse((await env.kv.get(`updater:pending:${JOB_ID}`))!)).toEqual({ actor: null, ...meta });
      expect((await audits('system.updater_start')).at(-1)).toEqual({ actor: null, meta });
      await env.kv.del(`updater:pending:${JOB_ID}`);
      // the updater still answers but runs nothing: an error while starting, not "unreachable"
      fake.busy = false;
      fake.onStart = timeout;
      expect(await autoUpdateTick({ ...env.ctx }, at(2, 1, 17))).toBe('failed');
      expect((await startNotices()).map((x) => x.body)).toEqual(ids.map(() => body('99.6.3', 'beim Start ist ein Fehler aufgetreten')));
      // the updater went away with the request: unreachable
      fake.onStart = () => { fake.up = false; timeout(); };
      expect(await autoUpdateTick({ ...env.ctx }, at(2, 1, 18))).toBe('failed');
      expect((await startNotices()).slice(ids.length).map((x) => x.body)).toEqual(ids.map(() => body('99.6.3', 'der Updater ist nicht erreichbar')));
    });

    it('never for nothing to install, outside the window, a busy updater or a job that started', async () => {
      // nothing newer: the same failures stay quiet
      setCfg({ APP_VERSION: '99.7.0' });
      fake.release = 'v99.7.0';
      const ctx = { ...env.ctx };
      fake.up = false;
      expect(await autoUpdateTick(ctx, at(2, 15, 11))).toBe('absent');
      fake.up = true;
      fake.refuse = 'pull_denied';
      expect(await autoUpdateTick(env.ctx, at(2, 1, 11))).toBe('failed');
      fake.refuse = null;
      fake.stack = 'foreign';
      expect(await autoUpdateTick(env.ctx, at(2, 1, 12))).toBe('foreign');
      fake.stack = undefined;
      // something newer, but outside the window, a busy updater, or the job started (its later failure: reconcileAudit)
      setCfg({ APP_VERSION: undefined });
      await freshInfo();
      fake.release = 'v99.8.0';
      fake.up = false;
      expect(await autoUpdateTick({ ...env.ctx }, at(3, 0, 13))).toBe('outside');
      fake.up = true;
      fake.busy = true;
      expect(await autoUpdateTick(env.ctx, at(2, 15, 13))).toBe('busy');
      fake.busy = false;
      expect(await autoUpdateTick(env.ctx, at(2, 16, 13))).toBe('started');
      expect(await startNotices()).toEqual([]);
    });
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
    const key = sessionKey(a2.cookies.ff_sid!);
    await e2.kv.set(key, JSON.stringify({ ...JSON.parse((await e2.kv.get(key))!), reauthAt: at }), 600);
  };
  // a fresh app per test: the route allows 3 starts per 2 minutes for the whole portal
  beforeEach(async () => {
    await e2?.close();
    e2 = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = updaterFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070' }; } });
    a2 = await e2.login(ADMIN);
  });
  afterAll(() => e2?.close());

  it('non-admins are refused; an admin session is enough (no re-authentication), unknown actions are 404', async () => {
    await e2.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'sub-dora', 'dora@example.com', 'Dora', 'friend', $1, 'Dora', $2)", ['d'.repeat(32), encrypt(e2.ctx.encKey, 'pw')]);
    const dora = await e2.login(DORA);
    expect((await e2.app.inject({ method: 'POST', url: '/api/admin/updater/update', cookies: dora.cookies, headers: { 'x-csrf-token': dora.csrf } })).statusCode).toBe(403);
    expect(fake.calls).toEqual([]);
    expect((await post('exec')).statusCode).toBe(404);
    a2 = await e2.login(ADMIN);
    // a sign-in long ago (no reauthAt stamp, or an old one): the job starts and is audited all the same
    await stamp(Date.now() - 11 * 60_000);
    const r = await post('update');
    expect(r.statusCode).toBe(202);
    expect(r.json().job).toMatchObject({ id: JOB_ID, action: 'update' });
    expect((await e2.pool.query("select 1 from audit_log where action='system.updater_start'")).rowCount).toBe(1);
  });

  it('the automatic-update switch saves with an admin session only (no re-authentication)', async () => {
    const r = await e2.app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: a2.cookies, headers: { 'x-csrf-token': a2.csrf },
      payload: { values: { AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '03:30' } } });
    expect(r.statusCode).toBe(200);
    expect(e2.ctx.cfg).toMatchObject({ AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '03:30' });
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
    expect(fake.portainer).toEqual([{ method: 'POST', url: `${HOOK}?FF_TAG=latest` }]); // the stable channel rides along
    expect(fake.calls.map((c) => [c.method, c.path])).toEqual([['GET', '/v1/status']]); // no channel sync, no /v1/update
    const userId = (await e2.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
    expect((await e2.pool.query('select actor, meta from audit_log where action=$1', ['system.update'])).rows).toEqual([{ actor: userId, meta: expect.objectContaining({ mode: 'webhook' }) }]);
    // a second start while it runs: refused (busy), nothing sent, the record stays
    const running = await e2.kv.get(REDEPLOY_KEY);
    const twice = await post('update');
    expect([twice.statusCode, twice.json()]).toEqual([409, { error: 'busy' }]);
    expect(fake.portainer.length).toBe(1);
    expect(await e2.kv.get(REDEPLOY_KEY)).toBe(running);
    // Portainer refuses: the error comes back
    await endRedeploy(e2);
    fake.portainerStatus = 500;
    const f = await post('update');
    expect([f.statusCode, f.json()]).toEqual([502, { error: 'portainer', status: 500, step: 'webhook' }]);
  });

  it('the redeploy handed to Portainer is followed on the page: pulling, recreating n of 3, the new backend: health, done (kept across the restart)', async () => {
    await stamp();
    fake.stack = 'foreign';
    e2.ctx.cfg = { ...e2.ctx.cfg, PORTAINER_WEBHOOK_URL: HOOK, GIT_SHA: 'a'.repeat(40) };
    expect((await post('update')).statusCode).toBe(202);
    const view = async () => (await e2.app.inject({ url: '/api/admin/updater', cookies: a2.cookies })).json().redeploy;
    const svc = (service: string, sha: string, state = 'running', health = 'healthy') => ({ service, state, health, sha, version: null });
    expect(await view()).toMatchObject({ mode: 'webhook', tag: 'latest', phase: 'pulling', running: true, services: { updated: 0, total: 1 } });
    fake.services = [svc('backend', 'sha-aaaaaaa'), svc('gateway', 'sha-bbbbbbb'), svc('web', 'sha-aaaaaaa', 'exited', '')];
    expect(await view()).toMatchObject({ phase: 'recreating', services: { updated: 1, total: 3 } });
    // Portainer recreated this backend: the new one (another build) reads the same record from the kv store
    e2.ctx.cfg = { ...e2.ctx.cfg, GIT_SHA: 'b'.repeat(40) };
    fake.services = [svc('backend', 'sha-bbbbbbb'), svc('gateway', 'sha-bbbbbbb'), svc('web', 'sha-bbbbbbb', 'running', 'starting')];
    expect(await view()).toMatchObject({ phase: 'health', running: true, services: { updated: 3, total: 3 } });
    fake.services = [svc('backend', 'sha-bbbbbbb'), svc('gateway', 'sha-bbbbbbb'), svc('web', 'sha-bbbbbbb')];
    expect(await view()).toMatchObject({ phase: 'done', running: false });
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

  it('an updater that cannot tell the stack and the Portainer API set up only in part: refused (foreign_stack), never an updater job that fails with compose_config', async () => {
    await stamp();
    e2.ctx.cfg = { ...e2.ctx.cfg, PORTAINER_URL: 'https://portainer.example.com', PORTAINER_API_KEY: 'ptr_secret_value' };
    const r = await post('update');
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'foreign_stack' }]);
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(fake.portainer).toEqual([]);
    // the updater confirms its own stack: the job runs as before
    fake.stack = 'own';
    expect((await post('update')).statusCode).toBe(202);
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
