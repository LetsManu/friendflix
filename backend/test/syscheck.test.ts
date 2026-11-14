// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSystemcheck, getSystemcheck, line, registerChecks, resetChecksForTests, safeParams, systemcheckSettled, type GroupCheck,
} from '../src/syscheck/engine.js';
import { CHECK_GROUPS, CHECK_IDS, type CheckId } from '../src/syscheck/types.js';
import { encrypt } from '../src/crypto.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Systemcheck Stage 1, Task 1: the contract, the engine (limits, codes only, cache) and GET /api/admin/systemcheck, over fake checks.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess;
const runs = { core: 0, media: 0 };
const as = (s: Sess, url: string) => env.app.inject({ method: 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });

// lines come back out of order on purpose: the engine sorts them into catalogue order
const fakeCore: GroupCheck = {
  group: 'core', ids: ['core.publicUrl', 'core.database'], timeoutMs: 1000,
  run: async () => { runs.core++; return [line('core.database', 'problem', { cause: 'db_down', fix: 'db_down', docs: 'operations.md' }), line('core.publicUrl', 'ok')]; },
};
const fakeMedia: GroupCheck = {
  group: 'media', ids: ['media.server', 'media.requests'], timeoutMs: 1000,
  run: async () => { runs.media++; return [line('media.requests', 'not_set_up', { cause: 'requests_not_set', settingKey: 'REQUESTS_URL' }), line('media.server', 'warning', { cause: 'media_slow', ms: 2500 })]; },
};
const SIGNIN_IDS = ['signin.oidc', 'signin.authentik'] as const satisfies readonly CheckId[];

const clearKv = async () => { for (const k of await env.kv.keys('syscheck:')) await env.kv.del(k); };

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login(ADMIN);
});
afterAll(() => env.close());
beforeEach(async () => {
  resetChecksForTests();
  registerChecks([fakeMedia, fakeCore]); // registered out of group order as well
  runs.core = 0; runs.media = 0;
  env.ctx.cfg = { ...cfg };
  await clearKv();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('contract', () => {
  it('the catalogue lists every group in order and every id under its group prefix', () => {
    expect(CHECK_GROUPS).toEqual(['core', 'signin', 'media', 'livetv', 'updates', 'proxy']);
    const groups = CHECK_IDS.map((id) => id.split('.')[0]);
    expect([...new Set(groups)]).toEqual([...CHECK_GROUPS]);
    expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length);
  });
});

describe('engine', () => {
  it('answers lines in catalogue order with counts per status', async () => {
    const r = await as(admin, '/api/admin/systemcheck');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = r.json();
    expect(body.lines.map((l: { id: string }) => l.id)).toEqual(['core.publicUrl', 'core.database', 'media.server', 'media.requests']);
    expect(body.counts).toEqual({ ok: 1, warning: 1, problem: 1, not_set_up: 1, unknown: 0 });
    expect(body.lines[1]).toEqual({ id: 'core.database', group: 'core', status: 'problem', cause: 'db_down', fix: 'db_down', docs: 'operations.md', runs: 'server' });
    expect(body.lines[0]).toEqual({ id: 'core.publicUrl', group: 'core', status: 'ok', runs: 'server' });
    expect(typeof body.at).toBe('string');
  });

  it('a check over its limit yields unknown check_timeout for its ids and the answer comes within limit + 500 ms', async () => {
    registerChecks([{ group: 'signin', ids: SIGNIN_IDS, timeoutMs: 200, run: () => new Promise(() => undefined) }]);
    const t0 = performance.now();
    const r = await buildSystemcheck(env.ctx);
    expect(performance.now() - t0).toBeLessThan(700);
    expect(r.lines.filter((l) => l.group === 'signin')).toEqual(SIGNIN_IDS.map((id) => ({ id, group: 'signin', status: 'unknown', cause: 'check_timeout', runs: 'server' })));
    expect(r.lines.find((l) => l.id === 'core.database')?.status).toBe('problem'); // the other groups are filled
    expect(r.counts.unknown).toBe(2);
  });

  it('a throwing check yields unknown check_failed and no message in the answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerChecks([{ group: 'signin', ids: SIGNIN_IDS, timeoutMs: 1000, run: async () => { throw new Error('boom https://auth.example.com/?token=sekret-ak-0000'); } }]);
    const r = await buildSystemcheck(env.ctx);
    expect(r.lines.filter((l) => l.group === 'signin').map((l) => [l.status, l.cause])).toEqual([['unknown', 'check_failed'], ['unknown', 'check_failed']]);
    expect(JSON.stringify(r)).not.toMatch(/boom|sekret|auth\.example/);
    expect(warn).toHaveBeenCalledWith('systemcheck: check did not finish', { check: 'signin', code: 'check_failed' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/boom|sekret/);
  });

  it('a check cannot answer for ids outside its own; a line it leaves out is unknown check_failed', async () => {
    registerChecks([{ group: 'signin', ids: SIGNIN_IDS, timeoutMs: 1000, run: async () => [line('signin.oidc', 'ok'), line('media.tmdb', 'problem', { cause: 'x' })] }]);
    const r = await buildSystemcheck(env.ctx);
    expect(r.lines.find((l) => l.id === 'media.tmdb')).toBeUndefined();
    expect(r.lines.find((l) => l.id === 'signin.authentik')).toMatchObject({ status: 'unknown', cause: 'check_failed' });
  });

  it('safeParams drops urls, free text and secrets', () => {
    expect(safeParams({ n: 3, keys: 'PORTAINER_URL,PORTAINER_STACK_ID', code: 'view_flow', url: 'https://auth.example.com/x', t: 'sekret-ak-0000' }))
      .toEqual({ n: 3, keys: 'PORTAINER_URL,PORTAINER_STACK_ID', code: 'view_flow' });
    expect(safeParams({ pct: 91.5, neg: -2, advice: 'no_hw_accel,no_tonemap', obj: { a: 1 }, nan: Number.NaN, path: '/srv/media', sp: 'two words', up: 'Abc' }))
      .toEqual({ pct: 91.5, neg: -2, advice: 'no_hw_accel,no_tonemap' });
    expect(safeParams(undefined)).toBeUndefined();
    expect(safeParams({ url: 'http://x' })).toBeUndefined();
  });

  it('line() sets settingGroup and locked for an env-set key and rejects a docs value \'../x.md\' (dropped)', async () => {
    expect(line('core.publicUrl', 'warning', { settingKey: 'PUBLIC_URL', docs: '../x.md' })).toEqual({ id: 'core.publicUrl', group: 'core', status: 'warning', settingKey: 'PUBLIC_URL', settingGroup: 'general', runs: 'server' });
    expect(line('core.publicUrl', 'warning', { docs: 'setup.md#6-nginx-proxy-manager-portal-proxy-host' }).docs).toBe('setup.md#6-nginx-proxy-manager-portal-proxy-host');
    expect(line('core.publicUrl', 'warning', { settingKey: 'NOT_A_SETTING', href: 'https://friend.example.com/x' })).toEqual({ id: 'core.publicUrl', group: 'core', status: 'warning', runs: 'server' });
    expect(line('signin.flows', 'warning', { href: '/admin/status#login' }).href).toBe('/admin/status#login');
    // PUBLIC_URL from the environment (the test store reports an override as env), REQUESTS_URL a stored setting
    env.ctx.cfg = { ...cfg, PUBLIC_URL: 'https://friend.example.com' };
    resetChecksForTests();
    registerChecks([{
      group: 'core', ids: ['core.publicUrl', 'core.database'], timeoutMs: 1000,
      run: async () => [line('core.publicUrl', 'warning', { cause: 'public_url_http', settingKey: 'PUBLIC_URL', docs: '../x.md' }), line('core.database', 'ok')],
    }, fakeMedia]);
    const r = await buildSystemcheck(env.ctx);
    expect(r.lines.find((l) => l.id === 'core.publicUrl')).toEqual({ id: 'core.publicUrl', group: 'core', status: 'warning', cause: 'public_url_http', settingKey: 'PUBLIC_URL', settingGroup: 'general', locked: true, runs: 'server' });
    expect(r.lines.find((l) => l.id === 'media.requests')).toMatchObject({ settingKey: 'REQUESTS_URL', settingGroup: 'requests' });
    expect(r.lines.find((l) => l.id === 'media.requests')?.locked).toBeUndefined();
  });
});

describe('cache and endpoint', () => {
  it('serves the cached result without running checks within 60 s; refresh=1 reruns', async () => {
    const [a, b] = await Promise.all([as(admin, '/api/admin/systemcheck'), as(admin, '/api/admin/systemcheck')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(runs.core).toBe(1); // single flight
    await systemcheckSettled(env.ctx);
    const c = await as(admin, '/api/admin/systemcheck');
    expect(c.json().at).toBe(a.json().at);
    expect(runs.core).toBe(1);
    const d = await as(admin, '/api/admin/systemcheck?refresh=1');
    expect(d.statusCode).toBe(200);
    expect(runs.core).toBe(2);
  });

  it('a plain build that a refresh replaced does not overwrite the refreshed result in kv', async () => {
    resetChecksForTests();
    let n = 0;
    registerChecks([{ group: 'core', ids: ['core.publicUrl'], timeoutMs: 2000, run: async () => {
      const slow = n++ === 0; // the first (plain) build is the slow one
      await new Promise((res) => setTimeout(res, slow ? 300 : 10));
      return [line('core.publicUrl', slow ? 'warning' : 'ok', slow ? { cause: 'public_url_echo' } : {})];
    } }]);
    const plain = getSystemcheck(env.ctx);
    while (n === 0) await new Promise((res) => setTimeout(res, 5)); // the plain build is running
    const fresh = await getSystemcheck(env.ctx, { refresh: true });
    await plain;
    await systemcheckSettled(env.ctx);
    expect(JSON.parse((await env.kv.get('syscheck:result'))!).lines[0].status).toBe(fresh.lines[0]!.status);
    expect(fresh.lines[0]!.status).toBe('ok');
  });

  it('an entry older than 60 s is served at once and rebuilt in the background', async () => {
    const first = await getSystemcheck(env.ctx);
    const old = { ...first, at: new Date(Date.now() - 70_000).toISOString() };
    await env.kv.set('syscheck:result', JSON.stringify(old), 300);
    const served = await getSystemcheck(env.ctx);
    expect(served.at).toBe(old.at);
    await systemcheckSettled(env.ctx);
    expect(runs.core).toBe(2);
    expect((await getSystemcheck(env.ctx)).at).not.toBe(old.at);
    expect(runs.core).toBe(2);
  });

  it('refresh=1 is limited to 6 per minute per session → 429 rate_limited', async () => {
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 7; i++) codes.push((last = await as(admin, '/api/admin/systemcheck?refresh=1')).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(last!.json()).toEqual({ error: 'rate_limited' });
    expect((await as(admin, '/api/admin/systemcheck')).statusCode).toBe(200); // the cached result is still served
  });

  it('non-admin → 403; no session → 401', async () => {
    await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
    const fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
    expect((await as(fritz, '/api/admin/systemcheck')).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/admin/systemcheck' })).statusCode).toBe(401);
    expect(runs.core).toBe(0);
  });

  it('kv failing: still answers 200', async () => {
    const kv = env.kv;
    const orig = { get: kv.get, set: kv.set, incr: kv.incr };
    const fail = <T extends (...a: never[]) => unknown>(f: T) => (async (key: string, ...rest: unknown[]) => {
      if (key.startsWith('syscheck:')) throw new Error('redis down');
      return (f as unknown as (...a: unknown[]) => unknown).call(kv, key, ...rest);
    }) as unknown as T;
    kv.get = fail(orig.get); kv.set = fail(orig.set); kv.incr = fail(orig.incr);
    try {
      const a = await as(admin, '/api/admin/systemcheck');
      expect(a.statusCode).toBe(200);
      expect(a.json().counts.problem).toBe(1);
      expect((await as(admin, '/api/admin/systemcheck?refresh=1')).statusCode).toBe(200);
    } finally {
      Object.assign(kv, orig);
    }
  });
});
