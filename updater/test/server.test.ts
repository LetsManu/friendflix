// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../src/docker.js';
import { Updater, type Ops } from '../src/job.js';
import { ReplayCache, deriveKey, sign, type Verifier } from '../src/protocol.js';
import { MAX_BODY_FOR, ROUTES, handler, healthProbe, servicesView, stackView, status } from '../src/server.js';
import { DEFAULT_STATE, memoryStore } from '../src/state.js';

const key = deriveKey('server-test-secret-0123456789');
let server: Server, base: string, updater: Updater, verifier: Verifier, warnings: string[], started: string[];
let release: () => void = () => {};
let media: unknown;

function ops(): Ops {
  const D = 'sha256:' + 'd'.repeat(64);
  const info: ImageInfo = { repoDigests: [], commit: 'a'.repeat(40), version: '1.0.0' };
  return {
    // the job waits in its first step until the test releases it
    images: async (tag, s) => { started.push(tag); await new Promise<void>((r) => { release = r; }); return Object.fromEntries(s.map((x) => [x, `ghcr.io/letsmanu/friendflix-${x}:${tag}`])); },
    // every service already runs the registry's digest
    registryDigest: async () => D, pullDigest: async () => {}, tag: async () => {},
    running: async (s) => ({ ...info, repoDigests: [`ghcr.io/letsmanu/friendflix-${s}@${D}`], container: '1'.repeat(64) }),
    verify: async () => true, up: async () => {}, imageInfo: async () => info, spawnSelfUpdate: async () => {}, healthy: async () => true,
    ownStack: async () => {}, stop: async () => {}, rm: async () => {}, imageRm: async () => {}, volumeRm: async () => {}, livetvContainer: async () => null, livetvNetwork: async () => {},
  };
}

beforeAll(async () => {
  server = createServer((req, res) => { void handler({
    get updater() { return updater; }, get verifier() { return verifier; }, get media() { return media; },
    services: async () => [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-aaaaaaa', version: '1.0.0' }],
    self: { version: '1.0.0', sha: null }, warn: (m: string) => warnings.push(m),
  } as never)(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  release();
  warnings = []; started = []; media = undefined;
  updater = new Updater(ops(), memoryStore(DEFAULT_STATE), { sleep: async () => {} });
  verifier = { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 };
});

const call = (method: string, path: string, body = '', o: { headers?: Record<string, string>; unsigned?: boolean } = {}) =>
  fetch(base + path, { method, body: method === 'GET' ? undefined : body, headers: { ...(o.unsigned ? {} : sign(key, method, path, body)), ...(body.startsWith('{') ? { 'content-type': 'application/json' } : {}), ...o.headers } });

describe('updater HTTP API', () => {
  it('healthz is open, everything else needs a signature', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const r = await call('GET', '/v1/status', '', { unsigned: true });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing' });
    expect(warnings).toEqual(['refused status: missing']);
  });

  it('status (signed)', async () => {
    const r = await call('GET', '/v1/status');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ channel: 'stable', targetTag: 'latest', current: 'sha-aaaaaaa', previous: null, busy: false, job: null, services: [{ service: 'backend' }], updater: { version: '1.0.0' }, mediaserver: null });
  });

  it('a replayed request is refused', async () => {
    const h = sign(key, 'POST', '/v1/update', '');
    expect((await fetch(`${base}/v1/update`, { method: 'POST', headers: h })).status).toBe(202);
    release();
    await updater.idle();
    const again = await fetch(`${base}/v1/update`, { method: 'POST', headers: h });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'replay' });
  });

  it('unknown paths and wrong methods; no other action exists', async () => {
    for (const p of ['/v1/exec', '/v1/run', '/v1/update/../exec', '/v1/services/postgres', '/', '/v1/mediaserver/exec', '/v1/mediaserver/backups', '/v1/mediaserver/backups/x/download']) {
      expect((await call('POST', p)).status, p).toBe(404);
    }
    expect((await call('GET', '/v1/update')).status).toBe(405);
    expect((await call('POST', '/v1/status')).status).toBe(405);
    expect((await call('GET', '/v1/mediaserver')).status).toBe(405);
    // the seven routes; without the media part (tests) the media route has nothing to run
    const routes = [['GET', '/v1/status'], ['POST', '/v1/channel'], ['POST', '/v1/update'], ['POST', '/v1/rollback'], ['POST', '/v1/self-update'], ['POST', '/v1/livetv'], ['POST', '/v1/mediaserver']];
    expect(Object.entries(ROUTES).map(([p, r]) => [r.method, p])).toEqual(routes);
    expect(ROUTES['/v1/mediaserver']).toEqual({ method: 'POST', route: 'mediaserver' });
    expect(MAX_BODY_FOR).toEqual({ status: 1024, channel: 1024, update: 1024, rollback: 1024, 'self-update': 1024, livetv: 1024, mediaserver: 8192 });
    for (const [m, p] of routes) expect((await call(m === 'GET' ? 'POST' : 'GET', p!)).status, p).toBe(405);
    expect((await call('POST', '/v1/mediaserver', '{"op":"gpu"}')).status).toBe(404);
  });

  it('update: 202 with the job, then 409 while it runs', async () => {
    const r = await call('POST', '/v1/update');
    expect(r.status).toBe(202);
    expect((await r.json()).job).toMatchObject({ action: 'update', to: 'latest', state: 'running' });
    expect((await call('POST', '/v1/update')).status).toBe(409);
    expect((await call('POST', '/v1/channel', '{"channel":"nightly"}')).status).toBe(409);
    release();
    await updater.idle();
    expect(started).toEqual(['latest']);
  });

  it('job actions take no parameters (no image, service or tag can be passed)', async () => {
    for (const b of ['{"tag":"evil"}', '{"services":["postgres"]}', 'x']) expect((await call('POST', '/v1/update', b)).status, b).toBe(400);
    expect((await call('POST', '/v1/rollback', '{}')).status).toBe(400); // no previous build recorded
    expect(await (await call('POST', '/v1/rollback')).json()).toEqual({ error: 'no_previous' });
  });

  it('channel: strict body, JSON only', async () => {
    const ok = await call('POST', '/v1/channel', '{"channel":"pinned","version":"1.2.3"}');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ channel: 'pinned', version: '1.2.3', targetTag: '1.2.3' });
    expect(updater.snapshot()).toMatchObject({ channel: 'pinned', version: '1.2.3' });
    for (const b of ['{"channel":"pinned","version":"latest"}', '{"channel":"stable","tag":"x"}', '{"channel":"edge"}', '{broken', '[]']) {
      expect((await call('POST', '/v1/channel', b, { headers: { 'content-type': 'application/json' } })).status, b).toBe(400);
    }
    expect((await call('POST', '/v1/channel', 'channel=stable', { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });

  it('a body over 1 KB is refused before the signature check', async () => {
    const big = `{"channel":"stable","x":"${'a'.repeat(2000)}"}`;
    const r = await fetch(`${base}/v1/channel`, { method: 'POST', body: big, headers: { 'content-type': 'application/json' } }).catch(() => null);
    expect(r === null || r.status === 413).toBe(true);
  });

  it('the media route takes up to 8 KB', async () => {
    media = { service: { gpu: async () => ({ dri: [], nvidia: false }) }, status: async () => ({ available: true, reason: null }) };
    // JSON allows the padding: exactly n bytes, signed over all of them
    const body = (n: number) => `{"op":"gpu"${' '.repeat(n - 12)}}`;
    expect(body(8192)).toHaveLength(8192);
    const r = await call('POST', '/v1/mediaserver', body(8192));
    expect([r.status, await r.json()]).toEqual([200, { dri: [], nvidia: false }]);
    const big = await call('POST', '/v1/mediaserver', body(8193)).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
    // the other routes stay at 1 KB
    const l = await call('POST', '/v1/livetv', `{"op":"enable"${' '.repeat(1100)}}`).catch(() => null);
    expect(l === null || l.status === 413).toBe(true);
  });

  it('status says whose stack it is and why (own / foreign / null = could not tell), for the backend and the page', async () => {
    const b = await (await call('GET', '/v1/status')).json();
    expect([b.stack, b.stackReason, b.stackDir, b.projectDir]).toEqual([null, null, null, null]); // no stack probe: unknown
    const info = { stack: 'foreign' as const, reason: 'working_dir' as const, workingDir: '/volume1/docker/friendflix', projectDir: '/project' };
    const s = await status({ updater, verifier, services: async () => [], self: { version: null, sha: null }, stack: async () => info });
    expect([s.stack, s.stackReason, s.stackDir, s.projectDir]).toEqual(['foreign', 'working_dir', '/volume1/docker/friendflix', '/project']);
    expect((await status({ updater, verifier, services: async () => [], self: { version: null, sha: null }, stack: async () => { throw new Error('x'); } })).stack).toBeNull();
  });

  it('stackView caches the probe and turns a failure into null', async () => {
    let n = 0, t = 0;
    const own = { stack: 'own' as const, reason: 'own' as const, workingDir: '/srv/ff', projectDir: '/srv/ff' };
    const v = stackView({ stackInfo: async () => { n++; return n === 1 ? own : null; } }, 10_000, () => t);
    expect(await v()).toEqual(own);
    expect(await v()).toEqual(own);
    expect(n).toBe(1);
    t = 20_000;
    expect(await v()).toBeNull();
  });

  it('self-update starts only on its explicit action', async () => {
    const r = await call('POST', '/v1/self-update');
    expect(r.status).toBe(202);
    expect((await r.json()).job.action).toBe('self-update');
    release();
    await updater.idle();
  });
});

describe('health probe and service view', () => {
  const ps = (rows: Array<{ service: string; state: string; health: string }>) => ({ ps: async () => rows.map((r) => ({ ...r, name: `ff-${r.service}-1` })) });
  const up = [{ service: 'backend', state: 'running', health: 'healthy' }, { service: 'gateway', state: 'running', health: 'healthy' }, { service: 'web', state: 'running', health: '' }];
  const answer = (b: unknown, status = 200) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch;

  it('healthy only when every service runs (healthy where checked) and the backend reports the new build', async () => {
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({ status: 'ok', version: 'bbbbbbb' }))('bbbbbbb')).toBe(true);
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({ status: 'ok', version: 'aaaaaaa' }))('bbbbbbb')).toBe(false);
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({ status: 'ok', version: 'aaaaaaa' }))(null)).toBe(true);
    expect(await healthProbe(ps(up), 'http://backend:3000/health', answer({}, 503))(null)).toBe(false);
    expect(await healthProbe(ps(up.map((u) => (u.service === 'gateway' ? { ...u, health: 'starting' } : u))), 'http://b/health', answer({}))(null)).toBe(false);
    expect(await healthProbe(ps(up.slice(0, 2)), 'http://b/health', answer({}))(null)).toBe(false);
  });

  it('service view is cached', async () => {
    let n = 0, t = 0;
    const d = { psView: async () => { n++; return [{ service: 'backend', name: 'ff-backend-1', state: 'running', health: 'healthy' }]; },
      containerImage: async () => 'sha256:' + 'e'.repeat(64), imageInfo: async () => ({ repoDigests: [], commit: 'c'.repeat(40), version: '1.1.0' }) };
    const view = servicesView(d, 'example/friendflix', () => false, 10_000, () => t);
    const v = await view();
    expect(v.find((s) => s.service === 'backend')).toEqual({ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-ccccccc', version: '1.1.0', commit: 'c'.repeat(40), digests: [] });
    expect(v.find((s) => s.service === 'web')).toEqual({ service: 'web', state: 'missing', health: '', sha: null, version: null, commit: null, digests: [] });
    await view();
    expect(n).toBe(1);
    t = 20_000;
    await view();
    expect(n).toBe(2);
  });

  it('status lists digest, commit, registry digest and changed per service; registry errors give null', async () => {
    const D = (c: string) => `sha256:${c.repeat(64)}`;
    const repo = (svc: string) => `ghcr.io/example/friendflix-${svc === 'bootstrap' ? 'backend' : svc}`;
    // what each service's image carries: an own digest (plus a foreign one that never counts), none for a dev build
    const carries: Record<string, string[]> = {
      backend: [`ghcr.io/evil/friendflix-backend@${D('9')}`, `${repo('backend')}@${D('1')}`], gateway: [`${repo('gateway')}@${D('2')}`],
      web: [`${repo('web')}@${D('3')}`], updater: [], livetv: [`${repo('livetv')}@${D('5')}`],
    };
    let livetv = false;
    const d = {
      psView: async () => ['backend', 'gateway', 'web', 'updater', 'livetv'].map((s) => ({ service: s, name: `ff-${s}-1`, state: 'running', health: 'healthy' })),
      containerImage: async (name: string) => `sha256:${name.slice(3, 4)}${'0'.repeat(63)}`,
      imageInfo: async (id: string) => {
        const svc = ['backend', 'gateway', 'web', 'updater', 'livetv'].find((s) => s[0] === id[7])!;
        return { repoDigests: carries[svc]!, commit: svc === 'updater' ? null : '4'.repeat(40), version: '3.6.0' };
      },
    };
    const view = servicesView(d, 'example/friendflix', () => livetv, 0);
    expect((await view()).map((s) => s.service)).toEqual(['bootstrap', 'backend', 'gateway', 'web', 'updater']);
    // the registry: backend as running, web moved on, gateway's lookup failed (null); asked for the channel's tag only
    const asked: string[] = [];
    const registry = async (svc: string, tag: string) => { asked.push(`${svc}:${tag}`); return ({ backend: D('1'), bootstrap: D('1'), web: D('6'), updater: D('7'), livetv: D('5') } as Record<string, string>)[svc] ?? null; };
    // livetv enabled: listed and looked up
    livetv = true;
    const withLivetv = new Updater(ops(), memoryStore({ ...DEFAULT_STATE, livetv: 'enabled' }), { sleep: async () => {} });
    const s = await status({ updater: withLivetv, verifier, services: view, registry, self: { version: null, sha: null } });
    expect(asked.every((a) => a.endsWith(':latest'))).toBe(true);
    const by = Object.fromEntries(s.services.map((x) => [x.service, x]));
    expect(by.backend).toEqual({ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-4444444', version: '3.6.0', commit: '4'.repeat(40), digest: D('1'), registry: D('1'), changed: false });
    expect(by.web).toMatchObject({ digest: D('3'), registry: D('6'), changed: true, version: null }); // version: the backend's only
    expect(by.gateway).toMatchObject({ digest: D('2'), registry: null, changed: null });
    expect(by.updater).toMatchObject({ digest: null, registry: D('7'), changed: null, commit: null, sha: null });
    expect(by.livetv).toMatchObject({ digest: D('5'), registry: D('5'), changed: false }); // listed while enabled
    expect(JSON.stringify(s.services)).not.toContain('evil');
    expect(JSON.stringify(s.services)).not.toContain('digests');
    // pinned without a version: no tag, nothing asked
    asked.length = 0;
    const pinned = new Updater(ops(), memoryStore({ ...DEFAULT_STATE, channel: 'pinned', version: null }), { sleep: async () => {} });
    const none = await status({ updater: pinned, verifier, services: view, registry, self: { version: null, sha: null } });
    expect(asked).toEqual([]);
    expect(none.services.every((x) => x.registry === null && x.changed === null)).toBe(true);
  });

  it('a slow registry never holds the status: past the bound the last answer (none yet: null), the lookup goes on', async () => {
    const D = 'sha256:' + '1'.repeat(64);
    const services = async () => [{ service: 'backend', state: 'running', health: 'healthy', sha: null, version: null, commit: null, digests: [D] }];
    let answer: (d: string) => void = () => {};
    const pending = new Promise<string | null>((r) => { answer = r; });
    const slow = () => pending;
    const deps = { updater, verifier, services, self: { version: null, sha: null }, limits: { registryMs: 20 } };
    const t0 = Date.now();
    const first = await status({ ...deps, registry: slow });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(first.services[0]).toMatchObject({ registry: null, changed: null });
    answer(D);
    await new Promise((r) => setTimeout(r, 0));
    // the next read is late again: it shows what the last lookup answered
    expect((await status({ ...deps, registry: slow })).services[0]).toMatchObject({ registry: D, changed: false });
    // a registry that throws: null
    expect((await status({ ...deps, registry: async () => { throw new Error('x'); } })).services[0]).toMatchObject({ registry: null, changed: null });
  });

  it('status passes the job report through and says whether a rollback is possible (never the digests)', async () => {
    const st = (over: Partial<typeof DEFAULT_STATE>) => new Updater(ops(), memoryStore({ ...DEFAULT_STATE, ...over }), { sleep: async () => {} });
    const base = { verifier, services: async () => [], self: { version: null, sha: null } };
    expect((await status({ ...base, updater: st({}) })).rollback).toEqual({ available: false });
    expect((await status({ ...base, updater: st({ previous: 'sha-1234567' }) })).rollback).toEqual({ available: true });
    const ref = `ghcr.io/example/friendflix-web@sha256:${'3'.repeat(64)}`;
    const s = await status({ ...base, updater: st({ previousDigests: { web: ref } }) });
    expect(s.rollback).toEqual({ available: true });
    expect(JSON.stringify(s)).not.toContain('sha256:');
    const job = { id: '0123456789abcdef', action: 'update' as const, state: 'succeeded' as const, step: null, steps: { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'ok' as const, rollback: 'skipped' as const },
      from: null, to: 'latest', startedAt: '2026-11-17T10:00:00.000Z', finishedAt: '2026-11-17T10:01:00.000Z', error: null, services: { backend: 'unchanged' as const, web: 'updated' as const }, media: null };
    expect((await status({ ...base, updater: st({ lastJob: job }) })).job?.services).toEqual({ backend: 'unchanged', web: 'updated' });
  });
});
