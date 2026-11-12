// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseStatus, startLivetvJob, updaterView, type LivetvOp } from '../src/updater.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

// The backend side of the updater's livetv actions (spec §4.2): POST /v1/livetv with exactly the op as the signed body, the
// foreign-stack refusal up front, the job parsed field by field and the start / result audit like an update.
const SECRET = 'internal-secret-123456';
const JOB_ID = '0fedcba987654321';
const fake = {
  busy: false, stack: undefined as 'own' | 'foreign' | undefined, status: 200, jobState: 'running', jobAction: '' as string, livetv: undefined as unknown, answer: undefined as unknown,
  calls: [] as Array<{ method: string; path: string; body: string; sigOk: boolean; type: string | null }>,
  portainer: [] as string[],
  reset() { Object.assign(this, { busy: false, stack: undefined, status: 200, jobState: 'running', jobAction: '', livetv: undefined, answer: undefined, calls: [], portainer: [] }); },
};
const job = (action: string) => ({ id: JOB_ID, action, state: fake.jobState, step: fake.jobState === 'running' ? 'restart' : null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: fake.jobState === 'running' ? 'running' : 'ok', health: 'skipped', rollback: 'skipped' },
  startedAt: '2026-11-12T04:00:00.000Z', finishedAt: fake.jobState === 'running' ? null : '2026-11-12T04:00:20.000Z', error: null });
function sigOk(method: string, path: string, body: string, h: Record<string, string>): boolean {
  const key = createHmac('sha256', SECRET).update('friendflix-updater/v1').digest();
  const canon = [method, path, h['x-ff-updater-ts'], h['x-ff-updater-nonce'], createHash('sha256').update(body).digest('hex')].join('\n');
  return h['x-ff-updater-signature'] === `v1=${createHmac('sha256', key).update(canon).digest('hex')}`;
}
const updaterFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  if (u.host === 'portainer.example.com') { fake.portainer.push(u.href); return new Response(null, { status: 204 }); }
  if (u.host !== 'updater:7070') return new Response('{}', { status: 404 });
  const body = typeof init?.body === 'string' ? init.body : '';
  const method = init?.method ?? 'GET';
  const h = init?.headers as Record<string, string>;
  const ok = sigOk(method, u.pathname, body, h);
  fake.calls.push({ method, path: u.pathname, body, sigOk: ok, type: h['content-type'] ?? null });
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (!ok) return j({ error: 'bad_signature' }, 401);
  if (u.pathname === '/v1/status') {
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: fake.busy,
      job: fake.jobAction ? job(fake.jobAction) : null, log: [], services: [], ...(fake.stack ? { stack: fake.stack } : {}), ...(fake.livetv !== undefined ? { livetv: fake.livetv } : {}) });
  }
  if (u.pathname !== '/v1/livetv' || method !== 'POST') return j({ error: 'not_found' }, 404);
  if (fake.status !== 200) return j({ error: 'x' }, fake.status);
  if (fake.busy) return j({ error: 'busy' }, 409);
  if (fake.answer !== undefined) return j(fake.answer, 202);
  const op = (JSON.parse(body) as { op: string }).op;
  fake.jobAction = `livetv-${op}`;
  return j({ job: job(fake.jobAction) }, 202);
};

let env: TestEnv, adminId: string;
const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action=$1 order by id', [action])).rows;
const setCfg = (patch: Record<string, unknown>) => { env.ctx.cfg = { ...env.ctx.cfg, ...patch } as typeof env.ctx.cfg; };
const posts = () => fake.calls.filter((c) => c.method === 'POST');

beforeAll(async () => {
  env = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = updaterFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; } });
  await env.login(ADMIN);
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
});
afterAll(() => env.close());
beforeEach(() => { fake.reset(); setCfg({ UPDATER_URL: 'http://updater:7070', PORTAINER_WEBHOOK_URL: undefined }); });

describe('startLivetvJob', () => {
  it('startLivetvJob signs exactly the op', async () => {
    const r = await startLivetvJob(env.ctx, { op: 'remove', data: true }, adminId);
    expect(r).toMatchObject({ ok: true, job: { id: JOB_ID, action: 'livetv-remove', state: 'running', to: 'latest' } });
    expect(posts()).toEqual([{ method: 'POST', path: '/v1/livetv', body: '{"op":"remove","data":true}', sigOk: true, type: 'application/json' }]);
    // the body is built from the op alone, in a fixed key order: nothing else can ride along
    fake.reset();
    await startLivetvJob(env.ctx, { data: false, op: 'remove', image: 'evil' } as unknown as LivetvOp, adminId);
    await startLivetvJob(env.ctx, { op: 'enable', data: true } as unknown as LivetvOp, adminId);
    await startLivetvJob(env.ctx, { op: 'disable' }, adminId);
    expect(posts().map((c) => c.body)).toEqual(['{"op":"remove","data":false}', '{"op":"enable"}', '{"op":"disable"}']);
    // the channel is not sent (livetv follows the installed build, not a new channel target)
    expect(fake.calls.some((c) => c.path === '/v1/channel')).toBe(false);
    // anything that is not one of the three ops is refused before a request
    fake.reset();
    for (const bad of [{ op: 'remove' }, { op: 'remove', data: 'yes' }, { op: 'start' }, null]) {
      expect(await startLivetvJob(env.ctx, bad as unknown as LivetvOp, adminId)).toEqual({ ok: false, status: 400, error: 'invalid' });
    }
    expect(fake.calls).toEqual([]);
  });

  it('foreign stack → 409 foreign_stack', async () => {
    fake.stack = 'foreign';
    expect(await startLivetvJob(env.ctx, { op: 'enable' }, adminId)).toEqual({ ok: false, status: 409, error: 'foreign_stack' });
    // Portainer set up and an updater that does not confirm the stack as its own: refused too, and never redeployed through Portainer
    fake.stack = undefined;
    setCfg({ PORTAINER_WEBHOOK_URL: 'https://portainer.example.com/api/stacks/webhooks/0e1d2c3b-hook' });
    expect(await startLivetvJob(env.ctx, { op: 'disable' }, adminId)).toEqual({ ok: false, status: 409, error: 'foreign_stack' });
    expect(posts()).toEqual([]);
    expect(fake.portainer).toEqual([]);
    // own stack with Portainer set up: fine
    fake.stack = 'own';
    expect((await startLivetvJob(env.ctx, { op: 'disable' }, adminId)).ok).toBe(true);
  });

  it('the job is parsed and audited', async () => {
    const r = await startLivetvJob(env.ctx, { op: 'enable' }, adminId);
    expect(r).toEqual({ ok: true, job: { id: JOB_ID, action: 'livetv-enable', state: 'running', step: 'restart', from: null, to: 'latest',
      steps: { pull: 'skipped', verify: 'skipped', restart: 'running', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-12T04:00:00.000Z', finishedAt: null, error: null } });
    expect((await audits('system.updater_start')).at(-1)).toEqual({ actor: adminId, meta: { action: 'livetv-enable', from: null, to: 'latest' } });
    await startLivetvJob(env.ctx, { op: 'remove', data: true }, adminId);
    expect((await audits('system.updater_start')).at(-1)).toEqual({ actor: adminId, meta: { action: 'livetv-remove', data: true, from: null, to: 'latest' } });
    // the result is audited once, from the next status read after the job finished
    fake.jobState = 'succeeded';
    const v = await updaterView(env.ctx);
    expect(v).toMatchObject({ present: true, status: { job: { action: 'livetv-remove', state: 'succeeded' } } });
    await updaterView(env.ctx);
    const results = (await audits('system.updater_result')).filter((a) => String(a.meta.action).startsWith('livetv-'));
    expect(results).toEqual([{ actor: adminId, meta: { action: 'livetv-remove', from: null, to: 'latest', result: 'succeeded', error: null } }]);
  });

  it('busy, absent and broken updaters', async () => {
    fake.busy = true;
    expect(await startLivetvJob(env.ctx, { op: 'enable' }, adminId)).toEqual({ ok: false, status: 409, error: 'busy' });
    fake.busy = false;
    fake.answer = { job: { id: 'nope' } };
    expect(await startLivetvJob(env.ctx, { op: 'enable' }, adminId)).toEqual({ ok: false, status: 502, error: 'updater_error' });
    // an answer for another action is not taken for a livetv job
    fake.answer = { job: { ...job('update') } };
    expect(await startLivetvJob(env.ctx, { op: 'enable' }, adminId)).toEqual({ ok: false, status: 502, error: 'updater_error' });
    fake.answer = undefined;
    fake.status = 500;
    expect(await startLivetvJob(env.ctx, { op: 'enable' }, adminId)).toEqual({ ok: false, status: 502, error: 'x' });
    setCfg({ UPDATER_URL: undefined });
    expect(await startLivetvJob(env.ctx, { op: 'enable' }, adminId)).toEqual({ ok: false, status: 409, error: 'not_available' });
  });
});

describe('status: livetv', () => {
  it('parses the livetv field and the three livetv job actions', () => {
    expect(parseStatus({ channel: 'stable' })!.livetv).toBeNull(); // an updater from before livetv
    expect(parseStatus({ channel: 'stable', livetv: { state: 'enabled', container: 'running', error: null } })!.livetv).toEqual({ state: 'enabled', container: 'running', error: null });
    expect(parseStatus({ channel: 'stable', livetv: { state: 'disabled', container: null, error: 'unhealthy' } })!.livetv).toEqual({ state: 'disabled', container: null, error: 'unhealthy' });
    for (const e of ['pull_failed', 'verify_failed', 'restart_failed']) expect(parseStatus({ channel: 'stable', livetv: { state: 'disabled', error: e } })!.livetv?.error).toBe(e);
    expect(parseStatus({ channel: 'stable', livetv: { state: '<b>', container: 'paused', error: 'token ghp_x' } })!.livetv).toEqual({ state: 'absent', container: null, error: null });
    expect(parseStatus({ channel: 'stable', livetv: 'enabled' })!.livetv).toBeNull();
    for (const a of ['livetv-enable', 'livetv-disable', 'livetv-remove']) {
      expect(parseStatus({ channel: 'stable', job: { ...job(a), state: 'failed', error: 'health_timeout' } })!.job).toMatchObject({ action: a, error: 'health_timeout' });
    }
    expect(parseStatus({ channel: 'stable', job: job('livetv') })!.job).toBeNull();
    expect(parseStatus({ channel: 'stable', job: job('livetv-exec') })!.job).toBeNull();
  });

  it('the admin status passes livetv through', async () => {
    fake.livetv = { state: 'disabled', container: null, error: 'pull_failed' };
    expect(await updaterView(env.ctx)).toMatchObject({ present: true, status: { livetv: { state: 'disabled', container: null, error: 'pull_failed' } } });
  });
});
