// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { commitTime, installedBuild } from '../src/installed.js';
import { MemoryKV } from '../src/kv.js';
import { healthProof, livetvKey } from '../src/livetv/client.js';
import { cfg as testCfg } from './helpers.js';

// The installed build (installed.ts): with images built only when they changed, the services of one stack carry different image
// commits; "which build runs" is the newest of them, from the updater's listing, else from asking the services, else the own one.
const SECRET = testCfg.INTERNAL_SECRET;
const REPO = 'example/friendflix';
const B = '1'.repeat(40), G = '2'.repeat(40), W = '3'.repeat(40), L = '4'.repeat(40), U = '5'.repeat(40);
const dig = (d: string) => `sha256:${d.repeat(64)}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

interface Fake { status: unknown; web: unknown; gateway: unknown; livetv: string | null; times: Record<string, string | 'fail'>; calls: string[] }
function ctxOf(cfg: Record<string, unknown>, f: Fake) {
  const kv = new MemoryKV();
  const ttls: Record<string, number> = {};
  const set = kv.set.bind(kv);
  kv.set = async (k: string, v: string, ttl?: number) => { ttls[k] = ttl ?? -1; return set(k, v, ttl); };
  const fetchImpl = async (input: unknown) => {
    const u = new URL(String(input));
    f.calls.push(u.host + u.pathname);
    if (u.host === 'api.github.com') {
      const m = /^\/repos\/example\/friendflix\/commits\/([0-9a-f]{40})$/.exec(u.pathname);
      const t = m ? f.times[m[1]!] : undefined;
      if (t === 'fail') return json({}, 500);
      return t ? json({ sha: m![1], commit: { committer: { date: t }, author: { date: '2000-01-01T00:00:00Z' } } }) : json({ message: 'Not Found' }, 404);
    }
    if (u.host === 'updater:7070' && u.pathname === '/v1/status') return f.status ? json(f.status) : json({}, 500);
    if (u.host === 'web:3000' && u.pathname === '/_app/version.json') return f.web ? json(f.web) : json({}, 404);
    if (u.host === 'gateway:4000' && u.pathname === '/health') return f.gateway ? json(f.gateway) : json({}, 404);
    if (u.host === 'livetv:8090' && u.pathname === '/healthz') {
      if (f.livetv === null) throw new TypeError('fetch failed');
      const proof = healthProof(livetvKey(SECRET), u.searchParams.get('n') ?? '');
      return json({ ok: true, api: 1, version: f.livetv, image: f.livetv, bootId: '0123456789abcdef', proof });
    }
    return json({}, 404);
  };
  const ctx = {
    kv, fetchImpl,
    cfg: { GIT_SHA: B, UPDATE_REPO: REPO, INTERNAL_SECRET: SECRET, GATEWAY_URL: 'http://gateway:4000', WEB_INTERNAL_URL: 'http://web:3000', LIVETV_URL: 'http://livetv:8090', LIVETV_WANTED: 'false', ...cfg },
  } as unknown as Ctx;
  return { ctx, kv, ttls };
}
const fake = (o: Partial<Fake> = {}): Fake => ({ status: null, web: null, gateway: null, livetv: null, times: {}, calls: [], ...o });
const svc = (service: string, commit: string | null, digest: string | null) => ({ service, state: 'running', health: 'healthy', sha: commit ? `sha-${commit.slice(0, 7)}` : null, version: null, commit, digest, registry: null, changed: null });
const listing = (services: unknown[]) => ({ updater: { version: null, sha: U }, channel: 'nightly', version: null, targetTag: 'nightly', current: null, previous: null, busy: false, job: null, log: [], services });
const TIMES = { [B]: '2026-11-01T00:00:00Z', [G]: '2026-10-01T00:00:00Z', [W]: '2026-11-10T00:00:00Z', [L]: '2026-11-05T00:00:00Z', [U]: '2026-11-15T00:00:00Z' };

describe('installed build', () => {
  it('installed build from the updater: the newest service commit', async () => {
    const f = fake({
      times: { ...TIMES },
      // the updater itself and bootstrap are not part of the build an update installs (the updater has its own update)
      status: listing([svc('bootstrap', U, dig('9')), svc('backend', B, dig('a')), svc('gateway', G, dig('b')), svc('web', W, dig('c')), svc('livetv', L, dig('d')), svc('updater', U, dig('e'))]),
    });
    const { ctx, kv, ttls } = ctxOf({ UPDATER_URL: 'http://updater:7070' }, f);
    const b = await installedBuild(ctx);
    expect(b).toEqual({
      commit: W, time: '2026-11-10T00:00:00Z', source: 'updater',
      services: [{ service: 'backend', commit: B, digest: dig('a') }, { service: 'gateway', commit: G, digest: dig('b') }, { service: 'web', commit: W, digest: dig('c') }, { service: 'livetv', commit: L, digest: dig('d') }],
    });
    // the services were not asked, the updater's commit time was not looked up
    expect(f.calls.filter((c) => !c.startsWith('api.github.com') && c !== 'updater:7070/v1/status')).toEqual([]);
    expect(f.calls).not.toContain(`api.github.com/repos/${REPO}/commits/${U}`);
    // cached: the build for 10 minutes, each commit time for a week
    expect(ttls[`update:installed:${REPO}`]).toBe(600);
    expect(ttls[`update:commit:${REPO}:${W}`]).toBe(604_800);
    const n = f.calls.length;
    expect(await installedBuild(ctx)).toEqual(b);
    expect(f.calls.length).toBe(n);
    // fresh: asked again, commit times still from the cache
    f.status = listing([svc('backend', B, dig('a')), svc('gateway', G, dig('b')), svc('web', B, dig('f'))]);
    expect(await installedBuild(ctx, { fresh: true })).toMatchObject({ commit: B, time: '2026-11-01T00:00:00Z', source: 'updater' });
    expect(f.calls.slice(n)).toEqual(['updater:7070/v1/status']);
    expect(JSON.parse((await kv.get(`update:installed:${REPO}`))!).commit).toBe(B);
  });

  it('from the probes without an updater', async () => {
    const f = fake({ times: { ...TIMES }, web: { version: W }, gateway: { status: 'ok', image: G }, livetv: null });
    const { ctx } = ctxOf({}, f);
    expect(await installedBuild(ctx)).toEqual({
      commit: W, time: '2026-11-10T00:00:00Z', source: 'probes',
      services: [{ service: 'backend', commit: B, digest: null }, { service: 'gateway', commit: G, digest: null }, { service: 'web', commit: W, digest: null }],
    });
    expect(f.calls).toEqual(expect.arrayContaining(['web:3000/_app/version.json', 'gateway:4000/health', 'livetv:8090/healthz']));
    // livetv installed: its image commit counts too (newer here); FF_IMAGE_COMMIT is the backend's own, not GIT_SHA
    const g = fake({ times: { ...TIMES, [U]: '2026-12-01T00:00:00Z' }, web: { version: W }, gateway: { status: 'ok', image: G }, livetv: L });
    const { ctx: c2 } = ctxOf({ FF_IMAGE_COMMIT: U }, g);
    expect(await installedBuild(c2)).toEqual({
      commit: U, time: '2026-12-01T00:00:00Z', source: 'probes',
      services: [{ service: 'backend', commit: U, digest: null }, { service: 'gateway', commit: G, digest: null }, { service: 'web', commit: W, digest: null }, { service: 'livetv', commit: L, digest: null }],
    });
    // an updater that does not answer: the probes
    const h = fake({ times: { ...TIMES }, web: { version: W }, gateway: { status: 'ok', image: G } });
    const { ctx: c3 } = ctxOf({ UPDATER_URL: 'http://updater:7070' }, h);
    expect(await installedBuild(c3)).toMatchObject({ commit: W, source: 'probes' });
  });

  it('own commit when a time is unknown', async () => {
    // GitHub fails for the web's commit: not "the newest of the rest", the own commit (its time when known); the failure is kept 1 min
    const f = fake({ times: { ...TIMES, [W]: 'fail' }, status: listing([svc('backend', B, dig('a')), svc('gateway', G, dig('b')), svc('web', W, dig('c'))]) });
    const { ctx, ttls } = ctxOf({ UPDATER_URL: 'http://updater:7070' }, f);
    expect(await installedBuild(ctx)).toMatchObject({ commit: B, time: '2026-11-01T00:00:00Z', source: 'self' });
    expect(ttls[`update:commit:${REPO}:${W}`]).toBe(60);
    // the fallback is cached like any installed build (10 min): a failing commit time is not asked again every minute
    expect(ttls[`update:installed:${REPO}`]).toBe(600);
    expect(await commitTime(ctx, W)).toBeNull();
    expect(f.calls.filter((c) => c.endsWith(`/commits/${W}`))).toHaveLength(1);
    // a service without a commit (an older image, a web that names its build otherwise, an unknown commit on GitHub): own commit
    for (const [web, times] of [[{ version: '1731234567890' }, TIMES], [null, TIMES], [{ version: W }, { ...TIMES, [W]: undefined }]] as const) {
      const g = fake({ times: { ...times } as Fake['times'], web, gateway: { status: 'ok', image: G } });
      expect(await installedBuild(ctxOf({}, g).ctx), JSON.stringify(web)).toMatchObject({ commit: B, source: 'self' });
    }
    // a local build: its own 'dev', nothing asked at all
    const d = fake({ web: { version: W }, gateway: { status: 'ok', image: G } });
    expect(await installedBuild(ctxOf({ GIT_SHA: 'dev' }, d).ctx)).toEqual({ commit: 'dev', time: null, source: 'self', services: [{ service: 'backend', commit: 'dev', digest: null }] });
    expect(d.calls).toEqual([]);
  });
});
