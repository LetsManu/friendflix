// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { startBenchmark } from '../src/convbench.js';
import { featureFlags } from '../src/features.js';
import { livetvCall } from '../src/livetv/client.js';
import { detectLivetv, enableBenchmark, livetvDetectTick, livetvInstalled, readLivetvSystem } from '../src/livetv/detect.js';
import { gpuAdvice } from '../src/livetv/gpu.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

vi.mock('../src/convbench.js', async (orig) => ({ ...(await orig<typeof import('../src/convbench.js')>()), startBenchmark: vi.fn(async () => ({ ok: true as const })) }));

// Live TV Phase 1, Task 10: detection (spec §4.1), the enable / disable routes through the updater (§4.2, §4.3), GPU advice (§4.4).
const SECRET = 'internal-secret-123456';
const JOB_ID = '0fedcba987654321';
const SYSTEM = {
  cpu: { model: 'Fictional CPU', cores: 4, loadPct: 3 }, gpu: { devices: ['renderD128'], driver: 'iHD', readable: true, busyPct: null, nvidia: false },
  encoders: ['h264_qsv', 'libx264'], cache: { usedBytes: 0, maxBytes: 1000 }, recordings: null, srt: { ports: [9000] },
};
const fake = {
  /** the job the updater status reports (default none) */
  job: null as unknown,
  livetv: 'down' as 'down' | 'api1' | 'api2' | 'impostor' | 'wrongProof', stack: undefined as 'own' | 'foreign' | undefined, hasUpdater: true, livetvState: undefined as unknown, status: 200,
  calls: [] as Array<{ method: string; path: string; body: string; sigOk: boolean }>, systemCalls: 0,
  reset() { Object.assign(this, { job: null, livetv: 'down', stack: 'own', hasUpdater: true, livetvState: { state: 'disabled', container: null, error: null }, status: 200, calls: [], systemCalls: 0 }); },
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
function sigOk(key: string, label: string, method: string, path: string, body: string, h: Record<string, string>, p: string): boolean {
  const k = createHmac('sha256', SECRET).update(label).digest();
  const canon = [method, path, h[`x-ff-${p}-ts`], h[`x-ff-${p}-nonce`], createHash('sha256').update(body).digest('hex')].join('\n');
  return key === '' || h[`x-ff-${p}-signature`] === `v1=${createHmac('sha256', k).update(canon).digest('hex')}`;
}
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const body = typeof init?.body === 'string' ? init.body : '';
  const method = init?.method ?? 'GET';
  const h = (init?.headers ?? {}) as Record<string, string>;
  if (u.host === 'livetv:8090') {
    if (fake.livetv === 'down') throw new TypeError('fetch failed');
    if (u.pathname === '/healthz') {
      // the real livetv proves its key for the nonce; an impostor (a LAN host named livetv) cannot, a wrong one keys with something else
      const n = u.searchParams.get('n') ?? '';
      const key = fake.livetv === 'wrongProof' ? Buffer.from(SECRET) : createHmac('sha256', SECRET).update('friendflix-livetv/v1').digest();
      const proof = fake.livetv === 'impostor' ? {} : { proof: createHmac('sha256', key).update(`healthz:${n}`).digest('hex') };
      return json({ ok: true, api: fake.livetv === 'api2' ? 2 : 1, version: '1.0.0', bootId: '0123456789abcdef', ...proof });
    }
    if (u.pathname === '/v1/system') { fake.systemCalls++; return sigOk('x', 'friendflix-livetv/v1', method, u.pathname, body, h, 'livetv') ? json(SYSTEM) : json({ error: 'bad_signature' }, 401); }
    return json({ error: 'not_found' }, 404);
  }
  if (u.host !== 'updater:7070') return json({}, 404);
  const ok = sigOk('x', 'friendflix-updater/v1', method, u.pathname, body, h, 'updater');
  fake.calls.push({ method, path: u.pathname, body, sigOk: ok });
  if (u.pathname === '/v1/status') {
    return json({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job: fake.job, log: [], services: [], ...(fake.stack ? { stack: fake.stack } : {}), livetv: fake.livetvState });
  }
  if (u.pathname === '/v1/livetv' && method === 'POST') {
    const op = (JSON.parse(body) as { op: string }).op;
    return json({ job: { id: JOB_ID, action: `livetv-${op}`, state: 'running', step: 'restart', from: null, to: 'latest', steps: { pull: 'skipped', verify: 'skipped', restart: 'running', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-12T04:00:00.000Z', finishedAt: null, error: null } }, 202);
  }
  return json({ error: 'not_found' }, 404);
};

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const posts = () => fake.calls.filter((c) => c.method === 'POST');
const setCfg = (patch: Record<string, unknown>) => { env.ctx.cfg = { ...env.ctx.cfg, ...patch } as typeof env.ctx.cfg; };
const audits = async (action: string) => (await env.pool.query<{ meta: Record<string, unknown> }>('select meta from audit_log where action=$1 order by id', [action])).rows.map((r) => r.meta);
const wanted = () => env.ctx.cfg.LIVETV_WANTED;
/** a fresh app on the same context: its own rate-limit counters */
async function withApp<T>(fn: (call: (method: 'GET' | 'POST', url: string, body?: unknown, cookies?: Record<string, string>) => Promise<Awaited<ReturnType<TestEnv['app']['inject']>>>) => Promise<T>): Promise<T> {
  const app = await buildApp(env.ctx);
  try { return await fn((method, url, body, cookies) => app.inject({ method, url, cookies: cookies ?? s.cookies, headers: { 'x-csrf-token': s.csrf }, ...(body === undefined ? {} : { payload: body as object }) })); } finally { await app.close(); }
}

beforeAll(async () => {
  env = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = fakeFetch as typeof fetch; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; } });
  s = await env.login(ADMIN);
});
afterAll(() => env.close());
beforeEach(async () => {
  fake.reset();
  vi.mocked(startBenchmark).mockClear();
  setCfg({ UPDATER_URL: 'http://updater:7070' });
  await env.pool.query("delete from audit_log where action like 'livetv.%'");
  await env.ctx.settings.save({ LIVETV_WANTED: 'false', LIVETV_OFFER_HIDDEN: 'false' }, null);
  await detectLivetv(env.ctx, 0, { strict: true });
});

describe('detection', () => {
  it('installed needs a reachable livetv with api 1', async () => {
    fake.livetv = 'api1';
    expect(await detectLivetv(env.ctx, 0)).toMatchObject({ reachable: true, installed: true, version: '1.0.0', bootId: '0123456789abcdef' });
    expect(livetvInstalled(env.ctx)).toBe(true);
    fake.livetv = 'api2';
    expect(await detectLivetv(env.ctx, 0)).toMatchObject({ reachable: true, installed: false });
    expect(livetvInstalled(env.ctx)).toBe(false);
    fake.livetv = 'down';
    expect(await detectLivetv(env.ctx, 0)).toMatchObject({ reachable: false, installed: false, version: null, bootId: null });
  });

  it('a host that answers like livetv but proves no key is reachable, never installed, and gets no signed call (1b review I2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const mode of ['impostor', 'wrongProof'] as const) {
        fake.livetv = mode;
        expect(await detectLivetv(env.ctx, 0), mode).toMatchObject({ reachable: true, installed: false, version: null, bootId: null });
        expect(livetvInstalled(env.ctx)).toBe(false);
        expect(featureFlags(env.ctx).livetv).toBe(false);
        await withApp(async (call) => {
          const j = (await call('GET', '/api/admin/livetv/state')).json();
          expect(j).toMatchObject({ installed: false, reachable: true, version: null, gpu: { livetv: null, advice: null } });
        });
      }
      expect(fake.systemCalls).toBe(0);
      // the real one, a minute later: installed
      fake.livetv = 'api1';
      expect(await detectLivetv(env.ctx, 0)).toMatchObject({ reachable: true, installed: true, version: '1.0.0', bootId: '0123456789abcdef' });
      // a success is not cached past the next check: the impostor takes the name again -> not installed at once
      fake.livetv = 'impostor';
      await livetvDetectTick(env.ctx);
      expect(livetvInstalled(env.ctx)).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('one missed check keeps an installed livetv; the second in a row turns it off (bughunt M1)', async () => {
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    expect(livetvInstalled(env.ctx)).toBe(true);
    // a restart between two ticks: the first miss keeps it installed (marked unreachable), version and boot id stay
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    expect(livetvInstalled(env.ctx)).toBe(true);
    expect(featureFlags(env.ctx).livetv).toBe(true);
    expect(await detectLivetv(env.ctx)).toMatchObject({ reachable: false, installed: true, version: '1.0.0', bootId: '0123456789abcdef' });
    // back at the next tick: nothing happened
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    expect(await detectLivetv(env.ctx)).toMatchObject({ reachable: true, installed: true });
    // two misses in a row: gone
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    expect(livetvInstalled(env.ctx)).toBe(true);
    await livetvDetectTick(env.ctx);
    expect(livetvInstalled(env.ctx)).toBe(false);
    expect(featureFlags(env.ctx).livetv).toBe(false);
    // a wrong proof is never tolerated, not even once
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fake.livetv = 'impostor';
      await livetvDetectTick(env.ctx);
      expect(livetvInstalled(env.ctx)).toBe(false);
    } finally { warn.mockRestore(); }
    // a strict caller (an updater job just ended) takes the first miss
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    fake.livetv = 'down';
    expect(await detectLivetv(env.ctx, 0, { strict: true })).toMatchObject({ installed: false, reachable: false });
  });

  it('answers from the last check within maxAge and runs one check at a time', async () => {
    let n = 0;
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (...a: Parameters<typeof fetch>) => { if (new URL(String(a[0])).pathname === '/healthz') n++; await new Promise((r) => setTimeout(r, 20)); return inner(...a); }) as typeof fetch;
    try {
      fake.livetv = 'api1';
      await Promise.all([detectLivetv(env.ctx, 0), detectLivetv(env.ctx, 0), detectLivetv(env.ctx, 0)]);
      expect(n).toBe(1);
      await detectLivetv(env.ctx); // 10 s default: the answer above is fresh
      expect(n).toBe(1);
    } finally { env.ctx.fetchImpl = inner; }
  });

  it('wanted but not reachable', async () => {
    await withApp(async (call) => {
      expect((await call('POST', '/api/admin/livetv/enable')).statusCode).toBe(202);
      const j = (await call('GET', '/api/admin/livetv/state')).json();
      expect(j).toMatchObject({ installed: false, reachable: false, wanted: true });
    });
  });

  it('featureFlags.livetv follows detection', async () => {
    expect(featureFlags(env.ctx).livetv).toBe(false);
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0);
    expect(featureFlags(env.ctx).livetv).toBe(true);
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx); // the second miss in a row (bughunt M1)
    expect(featureFlags(env.ctx).livetv).toBe(false);
  });

  it('first detection after enabling starts the benchmark once', async () => {
    await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
    await livetvDetectTick(env.ctx); // still down
    expect(startBenchmark).not.toHaveBeenCalled();
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx);
    await detectLivetv(env.ctx, 0);
    expect(startBenchmark).toHaveBeenCalledTimes(1);
    expect(startBenchmark).toHaveBeenCalledWith(env.ctx, 'enable');
    // gone and back: a new transition
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx); // the second miss in a row (bughunt M1)
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    expect(startBenchmark).toHaveBeenCalledTimes(2);
  });

  it('no benchmark when it was not asked for, or when the first look already finds it running', async () => {
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx); // not wanted (COMPOSE_PROFILES by hand)
    expect(startBenchmark).not.toHaveBeenCalled();
    await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
    await livetvDetectTick(env.ctx); // already installed, no transition
    expect(startBenchmark).not.toHaveBeenCalled();
  });
});

describe('the benchmark after enabling', () => {
  it('a refusal is kept for the state, not lost and not retried', async () => {
    vi.mocked(startBenchmark).mockResolvedValue({ ok: false, why: 'busy', reason: 'watching' });
    await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    await vi.waitFor(() => expect(enableBenchmark(env.ctx)).toBe('busy'));
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx);
    expect(startBenchmark).toHaveBeenCalledTimes(1);
    await withApp(async (call) => { expect((await call('GET', '/api/admin/livetv/state')).json().benchmark).toBe('busy'); });
    // a throw is noted too, and the next appearance starts over
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx); // the second miss in a row (bughunt M1)
    vi.mocked(startBenchmark).mockRejectedValueOnce(new Error('boom'));
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    await vi.waitFor(() => expect(enableBenchmark(env.ctx)).toBe('error'));
    vi.mocked(startBenchmark).mockResolvedValue({ ok: true });
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx); // the second miss in a row (bughunt M1)
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    await vi.waitFor(() => expect(enableBenchmark(env.ctx)).toBe('started'));
  });

  it('a tick without an enable starts nothing', async () => {
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    await livetvDetectTick(env.ctx);
    expect(startBenchmark).not.toHaveBeenCalled();
  });
});

describe('the benchmark answer belongs to its appearance (1b review M2)', () => {
  it('an answer that arrives after livetv vanished (and came back first seen at a fresh look) is dropped', async () => {
    let answer!: (v: { ok: true }) => void;
    vi.mocked(startBenchmark).mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx); // the appearance after enabling: launched, no answer yet
    expect(startBenchmark).toHaveBeenCalledTimes(1);
    fake.livetv = 'down';
    await livetvDetectTick(env.ctx); // gone (disabled)
    await livetvDetectTick(env.ctx); // the second miss in a row (bughunt M1)
    answer({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(enableBenchmark(env.ctx)).toBeNull();
    // back again: the old answer does not describe this appearance either
    fake.livetv = 'api1';
    vi.mocked(startBenchmark).mockImplementationOnce(() => new Promise(() => {})); // the new one never answers in this test
    await livetvDetectTick(env.ctx);
    expect(enableBenchmark(env.ctx)).toBeNull();
  });

  it('an answer while the same appearance runs is kept', async () => {
    vi.mocked(startBenchmark).mockResolvedValueOnce({ ok: true });
    await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
    fake.livetv = 'api1';
    await livetvDetectTick(env.ctx);
    await vi.waitFor(() => expect(enableBenchmark(env.ctx)).toBe('started'));
  });
});

describe('enable / disable', () => {
  it('the 202 answers wanted as stored, read back: a store that refuses the write does not claim it (1b review M1)', async () => {
    const save = vi.spyOn(env.ctx.settings, 'save').mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'env_locked' }));
    try {
      await withApp(async (call) => {
        const r = await call('POST', '/api/admin/livetv/enable');
        expect([r.statusCode, r.json().wanted]).toEqual([202, false]);
      });
      expect(wanted()).toBe('false');
    } finally { save.mockRestore(); }
  });

  it('an accepted disable or remove withdraws the proof of key; an enable or a refused disable does not (re-review concern 3)', async () => {
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0); // proven
    let checks = 0;
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (...a: Parameters<typeof fetch>) => { if (new URL(String(a[0])).pathname === '/healthz') checks++; return inner(...a); }) as typeof fetch;
    const system = () => livetvCall(env.ctx, 'GET', '/v1/system');
    try {
      await system();
      expect(checks).toBe(0); // the proof from the detection stands
      await withApp(async (call) => { expect((await call('POST', '/api/admin/livetv/enable')).statusCode).toBe(202); });
      await system();
      expect(checks).toBe(0);
      for (const body of [{ removeImage: false, removeCache: false }, { removeImage: true, removeCache: true }]) {
        await detectLivetv(env.ctx, 0);
        checks = 0;
        await withApp(async (call) => { expect((await call('POST', '/api/admin/livetv/disable', body)).statusCode).toBe(202); });
        await system();
        expect(checks, JSON.stringify(body)).toBe(1); // proved again before the call
      }
      // a refused disable (busy) changes nothing
      await detectLivetv(env.ctx, 0);
      checks = 0;
      const counting = env.ctx.fetchImpl;
      env.ctx.fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).endsWith('/v1/livetv') ? json({ error: 'busy' }, 409) : counting(i, init))) as typeof fetch;
      await withApp(async (call) => { expect((await call('POST', '/api/admin/livetv/disable', { removeImage: false, removeCache: false })).statusCode).toBe(409); });
      env.ctx.fetchImpl = counting;
      await system();
      expect(checks).toBe(0);
    } finally { env.ctx.fetchImpl = inner; }
  });

  it('one signed status read per enable / disable (1b review M14)', async () => {
    await withApp(async (call) => { expect((await call('POST', '/api/admin/livetv/enable')).statusCode).toBe(202); });
    expect(fake.calls.filter((c) => c.path === '/v1/status')).toHaveLength(1);
  });

  it('enable through the updater', async () => {
    await withApp(async (call) => {
      const r = await call('POST', '/api/admin/livetv/enable');
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ job: { id: JOB_ID, action: 'livetv-enable', state: 'running' } });
    });
    expect(posts()).toEqual([{ method: 'POST', path: '/v1/livetv', body: '{"op":"enable"}', sigOk: true }]);
    expect(wanted()).toBe('true');
    expect(await audits('livetv.enable')).toEqual([{ outcome: 'started' }]);
  });

  it('no updater → 409 no_updater with envLine', async () => {
    setCfg({ UPDATER_URL: undefined });
    await withApp(async (call) => {
      const r = await call('POST', '/api/admin/livetv/enable');
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'no_updater', envLine: 'COMPOSE_PROFILES=livetv', wanted: false }]);
      expect(wanted()).toBe('false'); // a refusal changes nothing
      await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
      const d = await call('POST', '/api/admin/livetv/disable', { removeImage: false, removeCache: false });
      expect([d.statusCode, d.json()]).toEqual([409, { error: 'no_updater', envLine: 'COMPOSE_PROFILES=livetv', wanted: true }]);
      expect(wanted()).toBe('true');
    });
    expect(fake.calls).toEqual([]);
    expect(await audits('livetv.enable')).toEqual([{ outcome: 'no_updater' }]);
    expect(await audits('livetv.disable')).toEqual([{ removeImage: false, removeCache: false, outcome: 'no_updater' }]);
  });

  it('an updater from before livetv → 409 updater_outdated, nothing posted, wanted unchanged (1b review I3)', async () => {
    fake.livetvState = undefined;
    await withApp(async (call) => {
      const r = await call('POST', '/api/admin/livetv/enable');
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'updater_outdated', wanted: false }]);
      expect((await call('GET', '/api/admin/livetv/state')).json().updater).toMatchObject({ available: true, livetv: null });
    });
    expect(posts()).toEqual([]);
    expect(wanted()).toBe('false');
    expect(await audits('livetv.enable')).toEqual([{ outcome: 'updater_outdated' }]);
  });

  it('an updater that refuses the signature is named as such, never the .env steps; garbage is updater_error (1b review M7)', async () => {
    const inner = env.ctx.fetchImpl;
    for (const [answer, code] of [[() => json({ error: 'bad_signature' }, 401), 'unauthorized'], [() => new Response('<html>', { status: 200 }), 'updater_error']] as const) {
      env.ctx.fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).includes('updater:7070') ? answer() : inner(i, init))) as typeof fetch;
      try {
        await withApp(async (call) => {
          const r = await call('POST', '/api/admin/livetv/enable');
          expect([r.statusCode, r.json()], code).toEqual([502, { error: code, wanted: false }]);
          const st = (await call('GET', '/api/admin/livetv/state')).json();
          expect(st.updater).toMatchObject({ available: false, error: code === 'unauthorized' ? 'unauthorized' : 'invalid_answer' });
        });
      } finally { env.ctx.fetchImpl = inner; }
    }
    expect(wanted()).toBe('false');
  });

  it('foreign stack → 409 foreign_stack', async () => {
    fake.stack = 'foreign';
    await withApp(async (call) => {
      const r = await call('POST', '/api/admin/livetv/enable');
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'foreign_stack', envLine: 'COMPOSE_PROFILES=livetv', wanted: false }]);
      expect(wanted()).toBe('false');
    });
    expect(posts()).toEqual([]);
    expect(await audits('livetv.enable')).toEqual([{ outcome: 'foreign_stack' }]);
  });

  it('a busy or refusing updater passes its fixed code', async () => {
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).endsWith('/v1/livetv') ? json({ error: 'busy' }, 409) : inner(i, init))) as typeof fetch;
    try {
      await withApp(async (call) => {
        const r = await call('POST', '/api/admin/livetv/enable');
        expect([r.statusCode, r.json()]).toEqual([409, { error: 'busy', wanted: false }]);
        expect(wanted()).toBe('false');
        await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
        const d = await call('POST', '/api/admin/livetv/disable', { removeImage: false, removeCache: false });
        expect([d.statusCode, d.json()]).toEqual([409, { error: 'busy', wanted: true }]); // still on: a refused disable does not turn it off
        expect(wanted()).toBe('true');
      });
      expect(await audits('livetv.enable')).toEqual([{ outcome: 'busy' }]);
    } finally { env.ctx.fetchImpl = inner; }
  });

  it('disable maps the checkboxes', async () => {
    await withApp(async (call) => {
      await env.ctx.settings.save({ LIVETV_WANTED: 'true' }, null);
      const a = await call('POST', '/api/admin/livetv/disable', { removeImage: false, removeCache: false });
      expect(a.statusCode).toBe(202);
      expect(a.json().wanted).toBe(false);
      expect(wanted()).toBe('false');
      const b = await call('POST', '/api/admin/livetv/disable', { removeImage: true, removeCache: false });
      expect(b.statusCode).toBe(202);
      const c = await call('POST', '/api/admin/livetv/disable', { removeImage: true, removeCache: true });
      expect(c.statusCode).toBe(202);
    });
    expect(posts().map((p) => p.body)).toEqual(['{"op":"disable"}', '{"op":"remove","data":false}', '{"op":"remove","data":true}']);
    expect(await audits('livetv.disable')).toEqual([
      { removeImage: false, removeCache: false, outcome: 'started' }, { removeImage: true, removeCache: false, outcome: 'started' }, { removeImage: true, removeCache: true, outcome: 'started' },
    ]);
  });

  it('cache without image is refused, anything else too', async () => {
    for (const body of [{ removeImage: false, removeCache: true }, {}, { removeImage: 'yes', removeCache: false }, { removeImage: true }]) {
      await withApp(async (call) => {
        const r = await call('POST', '/api/admin/livetv/disable', body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        expect(r.json()).toMatchObject({ error: 'invalid' });
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it('3 per 2 minutes, after the admin check', async () => {
    await withApp(async (call) => {
      for (let i = 0; i < 3; i++) expect((await call('POST', '/api/admin/livetv/enable')).statusCode).toBe(202);
      expect((await call('POST', '/api/admin/livetv/enable')).statusCode).toBe(429);
    });
  });

  it('non-admin 403', async () => {
    const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: { role: 'friend', ttlHours: 1 } });
    env.claims.current = { sub: 'sub-fr', email: 'fr@example.com', name: 'Fr', groups: [] };
    const l = await env.app.inject(`/auth/login?invite=${inv.json().link.split('/').pop()}`);
    const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
    const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
    const bob = { cookies: { ff_sid: cb.cookies.find((x) => x.name === 'ff_sid')!.value } };
    env.claims.current = ADMIN;
    await withApp(async (call) => {
      for (const [m, u, b] of [['GET', '/api/admin/livetv/state'], ['POST', '/api/admin/livetv/enable'], ['POST', '/api/admin/livetv/disable', { removeImage: false, removeCache: false }]] as const) {
        expect((await call(m, u, b, bob.cookies)).statusCode, u).toBe(403);
      }
    });
    expect(fake.calls).toEqual([]);
    expect(wanted()).toBe('false');
  });
});

describe('GET /api/admin/livetv/state', () => {
  it('without livetv: updater facts, the env line, no gpu', async () => {
    fake.livetvState = { state: 'stop_failed', container: 'running', error: 'unhealthy' };
    const spy = vi.spyOn(env.ctx.jf.admin, 'encoderSettings').mockResolvedValue({ hwAccel: 'vaapi' } as never);
    await withApp(async (call) => {
      const r = await call('GET', '/api/admin/livetv/state');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.json()).toEqual({
        installed: false, reachable: false, version: null, wanted: false, offerHidden: false, benchmark: null,
        updater: { available: true, stack: 'own', job: null, error: null, livetv: { state: 'stop_failed', container: 'running', error: 'unhealthy' } },
        envLine: 'COMPOSE_PROFILES=livetv',
        gpu: { jellyfin: null, livetv: null, advice: null },
      });
      expect(spy).not.toHaveBeenCalled(); // nothing to compare it with
    });
  });

  it('with livetv: gpu facts and the advice of §4.4; no updater is reported as unavailable', async () => {
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0);
    setCfg({ UPDATER_URL: undefined });
    vi.spyOn(env.ctx.jf.admin, 'encoderSettings').mockResolvedValue({ hwAccel: 'qsv' } as never);
    await withApp(async (call) => {
      const j = (await call('GET', '/api/admin/livetv/state')).json();
      expect(j).toMatchObject({ installed: true, reachable: true, version: '1.0.0', updater: { available: false, stack: null, job: null, error: null, livetv: null } });
      expect(j.gpu).toEqual({ jellyfin: 'qsv', livetv: { driver: 'iHD', devices: 1 }, advice: { level: 'ok', key: 'both', driver: 'iHD' } });
    });
  });

  it('the state and the media server read are cached for 10 s', async () => {
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0);
    const spy = vi.spyOn(env.ctx.jf.admin, 'encoderSettings').mockResolvedValue({ hwAccel: 'qsv' } as never);
    const healthz = vi.fn();
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (...a: Parameters<typeof fetch>) => { if (new URL(String(a[0])).pathname === '/healthz') healthz(); return inner(...a); }) as typeof fetch;
    try {
      await withApp(async (call) => {
        for (let i = 0; i < 3; i++) await call('GET', '/api/admin/livetv/state');
      });
      expect(healthz).not.toHaveBeenCalled(); // the check above is younger than 10 s
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { env.ctx.fetchImpl = inner; }
  });

  it('right after a livetv job ended the state asks detection fresh, so a disable is seen at once (1b review I4)', async () => {
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0);
    const healthz = vi.fn();
    const inner = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (...a: Parameters<typeof fetch>) => { if (new URL(String(a[0])).pathname === '/healthz') healthz(); return inner(...a); }) as typeof fetch;
    const ended = (action: string, agoMs: number) => ({ id: JOB_ID, action, state: 'succeeded', step: null, from: null, to: 'latest',
      steps: { pull: 'skipped', verify: 'skipped', restart: 'ok', health: 'skipped', rollback: 'skipped' }, startedAt: new Date(Date.now() - agoMs - 5_000).toISOString(), finishedAt: new Date(Date.now() - agoMs).toISOString(), error: null });
    try {
      fake.job = ended('livetv-disable', 2_000);
      fake.livetv = 'down'; // stopped by the job, the cached answer still says installed
      await withApp(async (call) => {
        expect((await call('GET', '/api/admin/livetv/state')).json()).toMatchObject({ installed: false, reachable: false });
        await call('GET', '/api/admin/livetv/state');
      });
      expect(healthz).toHaveBeenCalledTimes(2);
      // an older job, or an app update's job: the 10 s cache again
      for (const j of [ended('livetv-disable', 31_000), ended('update', 1_000)]) {
        fake.job = j;
        healthz.mockClear();
        await withApp(async (call) => { for (let i = 0; i < 3; i++) await call('GET', '/api/admin/livetv/state'); });
        expect(healthz).not.toHaveBeenCalled();
      }
    } finally { env.ctx.fetchImpl = inner; }
  });

  it('an unreadable media server leaves the jellyfin side and the advice null; the page still answers', async () => {
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0);
    vi.spyOn(env.ctx.jf.admin, 'encoderSettings').mockRejectedValue(new Error('down'));
    await withApp(async (call) => {
      const j = (await call('GET', '/api/admin/livetv/state')).json();
      expect(j.gpu).toEqual({ jellyfin: null, livetv: { driver: 'iHD', devices: 1 }, advice: null }); // unknown is not "cpu only"
    });
  });
});

describe('summary', () => {
  it('carries installed, offerHidden and failedSources', async () => {
    const get = async () => (await env.app.inject({ url: '/api/admin/summary', cookies: s.cookies })).json().livetv;
    expect(await get()).toEqual({ installed: false, offerHidden: false, failedSources: 0 });
    fake.livetv = 'api1';
    await detectLivetv(env.ctx, 0);
    await env.ctx.settings.save({ LIVETV_OFFER_HIDDEN: 'true' }, null);
    expect(await get()).toEqual({ installed: true, offerHidden: true, failedSources: 0 });
  });
});

describe('gpuAdvice', () => {
  const sys = (o: { devices?: string[]; readable?: boolean; driver?: string | null; nvidia?: boolean } = {}) => ({
    gpu: { devices: o.devices ?? [], readable: o.readable ?? false, driver: o.driver ?? null, nvidia: o.nvidia ?? false },
  });
  it('follows the five rows', () => {
    expect(gpuAdvice('qsv', sys())).toEqual({ level: 'warn', key: 'needsOverlay' });
    expect(gpuAdvice('vaapi', sys())).toEqual({ level: 'warn', key: 'needsOverlay' });
    expect(gpuAdvice('vaapi', sys({ devices: ['renderD128'] }))).toEqual({ level: 'warn', key: 'needsRenderGid' });
    expect(gpuAdvice('nvenc', sys())).toEqual({ level: 'warn', key: 'needsNvidia' });
    expect(gpuAdvice('none', sys())).toEqual({ level: 'info', key: 'cpuOnly' });
    // a GPU type livetv has no overlay for, and nothing on its side: it runs on the processor (never "both")
    for (const hw of ['amf', 'v4l2m2m', 'rkmpp', 'videotoolbox']) expect(gpuAdvice(hw, sys()), hw).toEqual({ level: 'info', key: 'cpuOnly' });
    expect(gpuAdvice('amf', sys({ devices: ['renderD128'], readable: true, driver: 'radeonsi' }))).toEqual({ level: 'ok', key: 'both', driver: 'radeonsi' });
    expect(gpuAdvice(null, sys())).toEqual({ level: 'info', key: 'cpuOnly' });
    expect(gpuAdvice('qsv', sys({ devices: ['renderD128'], readable: true, driver: 'iHD' }))).toEqual({ level: 'ok', key: 'both', driver: 'iHD' });
    expect(gpuAdvice('nvenc', sys({ nvidia: true, driver: 'nvidia' }))).toEqual({ level: 'ok', key: 'both', driver: 'nvidia' });
  });
  it('rows are checked in order: no devices comes before unreadable; a device-less nvenc box is not told about overlays', () => {
    expect(gpuAdvice('qsv', sys({ readable: true }))).toEqual({ level: 'warn', key: 'needsOverlay' });
    expect(gpuAdvice('nvenc', sys({ devices: ['renderD128'], readable: true, driver: 'i915' }))).toEqual({ level: 'warn', key: 'needsNvidia' });
  });
  it('NVIDIA is decided by the device node, not by encoders compiled into ffmpeg (1b review I5)', () => {
    // what jellyfin-ffmpeg lists on any host: the old check read nvenc from here and answered "both" without the overlay
    const compiled = { encoders: ['h264_qsv', 'h264_vaapi', 'h264_nvenc', 'libx264'] };
    expect(gpuAdvice('nvenc', { ...sys(), ...compiled })).toEqual({ level: 'warn', key: 'needsNvidia' });
    expect(gpuAdvice('qsv', { ...sys(), ...compiled })).toEqual({ level: 'warn', key: 'needsOverlay' });
    expect(gpuAdvice('amf', { ...sys(), ...compiled })).toEqual({ level: 'info', key: 'cpuOnly' });
    // NVIDIA plus Intel: nvenc names NVIDIA, not the render node's i915 (re-review minor); qsv on the same host names i915
    const both = sys({ devices: ['renderD128'], readable: true, driver: 'i915', nvidia: true });
    expect(gpuAdvice('nvenc', both)).toEqual({ level: 'ok', key: 'both', driver: 'nvidia' });
    expect(gpuAdvice('qsv', both)).toEqual({ level: 'ok', key: 'both', driver: 'i915' });
    expect(gpuAdvice('nvenc', sys({ nvidia: true }))).toEqual({ level: 'ok', key: 'both', driver: 'nvidia' });
    // an NVIDIA device makes an unknown GPU type "both" (it may well use it), never cpuOnly
    expect(gpuAdvice('amf', sys({ nvidia: true, driver: 'nvidia' }))).toEqual({ level: 'ok', key: 'both', driver: 'nvidia' });
  });
});

describe('GET /v1/system', () => {
  it('an encoder this backend does not know is left out, never a reason to refuse the answer', async () => {
    fake.livetv = 'api1';
    const saved = SYSTEM.encoders;
    try {
      SYSTEM.encoders = ['h264_qsv', 'av1_qsv', 'libx264', 'h264_qsv', 'hevc_future_encoder_with_a_rather_long_name'];
      const sys = await readLivetvSystem(env.ctx);
      expect(sys.encoders).toEqual(['h264_qsv', 'libx264']);
      expect(sys.srt.ports).toEqual([9000]);
      SYSTEM.encoders = ['av1_qsv'];
      expect((await readLivetvSystem(env.ctx)).encoders).toEqual([]);
      // a shape that is not a list still is an unexpected answer
      SYSTEM.encoders = 'libx264' as unknown as string[];
      await expect(readLivetvSystem(env.ctx)).rejects.toMatchObject({ code: 'invalid_answer' });
    } finally {
      SYSTEM.encoders = saved;
    }
  });
});

describe('wire.ts', () => {
  it('Encoder and LivetvSystem are the declarations of livetv/src/system.ts, field for field', () => {
    const norm = (x: string) => x.replace(/\s+/g, ' ').replace(/ ?; ?}/g, ' }').trim();
    const theirs = readFileSync(new URL('../../livetv/src/system.ts', import.meta.url), 'utf8');
    const ours = readFileSync(new URL('../src/livetv/wire.ts', import.meta.url), 'utf8');
    const encoders = (src: string) => [...src.matchAll(/'(h264_[a-z]+|libx264)'/g)].map((m) => m[1]);
    expect(encoders(ours)).toEqual(encoders(theirs.slice(theirs.indexOf('ENCODERS'))).slice(0, 4));
    const fields = (src: string, from: string) => {
      const i = src.indexOf(from);
      return norm(src.slice(src.indexOf('{', i), src.indexOf('\n}', i) + 2));
    };
    const flat = (src: string) => norm(src).replace(/CpuInfo/g, '{ model: string; cores: number; loadPct: number }').replace(/GpuInfo/g, '{ devices: string[]; driver: string | null; readable: boolean; busyPct: number | null; nvidia: boolean }');
    expect(flat(fields(ours, 'interface LivetvSystem'))).toBe(flat(fields(theirs, 'interface SystemView')));
  });

  it('Mode and StreamView are the declarations of livetv/src/streams.ts, field for field (F4)', () => {
    const norm = (x: string) => x.replace(/\s+/g, ' ').replace(/ ?; ?}/g, ' }').trim();
    const theirs = readFileSync(new URL('../../livetv/src/streams.ts', import.meta.url), 'utf8');
    const ours = readFileSync(new URL('../src/livetv/wire.ts', import.meta.url), 'utf8');
    const block = (src: string, from: string, close: string) => { const i = src.indexOf(from); return norm(src.slice(i, src.indexOf(close, i) + close.length)); };
    expect(block(ours, 'export type Mode', ';')).toBe(block(theirs, 'export type Mode', ';'));
    expect(block(ours, 'export interface StreamView', '\n}')).toBe(block(theirs, 'export interface StreamView', '\n}'));
  });
});
