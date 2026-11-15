// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiskHealth, HealthSnapshot, ServiceHealth, ServiceId } from '../src/health.js';
import { coreCheck, levelToStatus } from '../src/syscheck/checks/core.js';
import { buildSystemcheck } from '../src/syscheck/engine.js';
import { CHECK_TIMEOUT_MS, SNAPSHOT_TIMEOUT_MS, type CheckId, type SystemcheckResult } from '../src/syscheck/types.js';
import { ADMIN, cfg, fakeHttp, makeEnv, type TestEnv } from './helpers.js';

// Systemcheck Stage 1, Task 2: the core and media lines, read from the health snapshot (plus the public-URL and request-service probes).
let env: TestEnv;
let admin: { cookies: Record<string, string>; csrf: string };
const GiB = 1024 ** 3;
const up = { requests: 200 };
const inner = fakeHttp({
  'GET /health': () => ({ json: { status: 'ok' } }),
  'GET /api/v1/request/count': () => (up.requests === 200 ? { json: { total: 0 } } : { status: up.requests, json: { message: 'bad key seerrkey' } }),
});
// the public-URL probe reaches this backend through PUBLIC_URL: the fake answers its echo like the real route
const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (u.pathname.startsWith('/api/setup/echo/')) return Response.json({ answer: await env.kv.get(`setup:echo:${u.pathname.split('/').pop()}`) });
  return inner(input, init);
}) as typeof fetch;

const SERVICES: ServiceId[] = ['media', 'postgres', 'redis', 'gateway', 'oidc', 'requests', 'tmdb', 'omdb', 'playbackCheck', 'encoder'];
function snap(o: { services?: Partial<Record<ServiceId, Partial<ServiceHealth> | null>>; disks?: DiskHealth[] } = {}): HealthSnapshot {
  const services = SERVICES.flatMap((id): ServiceHealth[] => {
    const over = o.services?.[id];
    return over === null ? [] : [{ id, level: 'ok', ...over }];
  });
  const disks = o.disks ?? [
    { id: 'downloads', level: 'ok', usedPct: 40, ownBytes: 0, totalBytes: 100 * GiB, freeBytes: 60 * GiB },
    { id: 'previews', level: 'ok', usedPct: 40, ownBytes: 0, totalBytes: 100 * GiB, freeBytes: 60 * GiB },
    { id: 'database', level: 'ok', ownBytes: GiB },
  ];
  return { at: new Date().toISOString(), services, disks, errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 }, issues: [], worst: 'ok' };
}
const put = (s: HealthSnapshot) => env.kv.set('health:snap', JSON.stringify(s), 300);
async function run(s: HealthSnapshot = snap()): Promise<SystemcheckResult> {
  await put(s);
  return buildSystemcheck(env.ctx);
}
const get = (r: SystemcheckResult, id: CheckId) => r.lines.find((l) => l.id === id)!;

beforeAll(async () => {
  env = await makeEnv();
  admin = await env.login(ADMIN);
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  env.ctx.fetchImpl = http;
  up.requests = 200;
  for (const p of ['health:', 'syscheck:', 'flowcheck:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
});

describe('status mapping', () => {
  it('levelToStatus follows the snapshot level (no two truths between banner and Systemcheck)', () => {
    expect(levelToStatus('err')).toBe('problem');
    expect(levelToStatus('warn', 'slow')).toBe('warning');
    expect(levelToStatus('ok')).toBe('ok');
    expect(levelToStatus('off', 'not_set')).toBe('not_set_up');
    expect(levelToStatus('off', 'unavailable')).toBe('unknown');
    expect(levelToStatus('off')).toBe('unknown');
  });
});

describe('core lines', () => {
  it('a healthy instance: every core and media line ok, in catalogue order', async () => {
    const r = await run();
    const ids: CheckId[] = ['core.publicUrl', 'core.database', 'core.redis', 'core.redisPersistence', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env',
      'media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder'];
    const mine = r.lines.filter((l) => l.group === 'core' || l.group === 'media');
    expect(mine.map((l) => l.id)).toEqual(ids);
    expect(mine.filter((l) => l.status !== 'ok').map((l) => [l.id, l.status, l.cause])).toEqual([]);
  });

  it('database down → core.database problem db_down; redis slow → warning', async () => {
    const r = await run(snap({ services: { postgres: { level: 'err', reason: 'down', ms: 3000 }, redis: { level: 'warn', reason: 'slow', ms: 450 } } }));
    expect(get(r, 'core.database')).toMatchObject({ status: 'problem', cause: 'db_down', docs: 'operations.md', ms: 3000 });
    expect(get(r, 'core.redis')).toMatchObject({ status: 'warning', cause: 'redis_slow', ms: 450 });
    expect(get(r, 'core.gateway').status).toBe('ok');
  });

  it('Redis without its append-only file → core.redisPersistence warning redis_not_persistent with the docs; with it → ok; not known → unknown', async () => {
    try {
      env.kv.aof = false;
      const off = await run();
      expect(get(off, 'core.redisPersistence')).toEqual({
        id: 'core.redisPersistence', group: 'core', status: 'warning', cause: 'redis_not_persistent', fix: 'redis_not_persistent',
        docs: 'operations.md#redis-volume-redis-data', runs: 'server',
      });
      // Redis itself answers: only the persistence line warns
      expect(get(off, 'core.redis').status).toBe('ok');
      env.kv.aof = true;
      expect(get(await run(), 'core.redisPersistence')).toEqual({ id: 'core.redisPersistence', group: 'core', status: 'ok', runs: 'server' });
      env.kv.aof = null;
      expect(get(await run(), 'core.redisPersistence')).toMatchObject({ status: 'unknown', cause: 'check_unavailable' });
    } finally { env.kv.aof = true; }
  });

  it('PUBLIC_URL http → core.publicUrl warning public_url_http, settingKey PUBLIC_URL', async () => {
    env.ctx.cfg = { ...cfg, PUBLIC_URL: 'http://friend.example.com' };
    expect(get(await run(), 'core.publicUrl')).toMatchObject({ status: 'warning', cause: 'public_url_http', settingKey: 'PUBLIC_URL', settingGroup: 'general' });
  });

  it('public URL that does not reach this backend → warning public_url_echo; an https URL that does → ok', async () => {
    expect(get(await run(), 'core.publicUrl')).toEqual({ id: 'core.publicUrl', group: 'core', status: 'ok', runs: 'server' });
    env.ctx.fetchImpl = inner; // the echo is not answered (NAT loopback)
    expect(get(await run(), 'core.publicUrl')).toMatchObject({ status: 'warning', cause: 'public_url_echo', settingKey: 'PUBLIC_URL' });
  });

  it('disks: full with pct, a database over its limit, unreadable → unknown; a shared filesystem gives both lines from one entry', async () => {
    const r = await run(snap({ disks: [
      { id: 'downloads', level: 'err', reason: 'full', usedPct: 96, ownBytes: 0, totalBytes: 100 * GiB, freeBytes: 4 * GiB, sharedWith: 'previews', sharedBytes: GiB },
      { id: 'database', level: 'warn', reason: 'large', ownBytes: 12 * GiB },
    ] }));
    expect(get(r, 'core.disk.downloads')).toMatchObject({ status: 'problem', cause: 'disk_full', params: { pct: 96 }, settingKey: 'HEALTH_DISK_WARN_PCT' });
    expect(get(r, 'core.disk.previews')).toMatchObject({ status: 'problem', cause: 'disk_full', params: { pct: 96, sharedWith: 'downloads' } });
    expect(get(r, 'core.disk.database')).toMatchObject({ status: 'warning', cause: 'db_large', params: { n: 12 }, settingKey: 'HEALTH_DB_WARN_GB' });
    const cap = await run(snap({ disks: [
      { id: 'downloads', level: 'warn', reason: 'cap', usedPct: 40, ownBytes: 46 * GiB, capBytes: 50 * GiB },
      { id: 'previews', level: 'off', reason: 'unavailable', ownBytes: 0 },
      { id: 'database', level: 'ok', ownBytes: GiB },
    ] }));
    expect(get(cap, 'core.disk.downloads')).toMatchObject({ status: 'warning', cause: 'disk_cap', params: { pct: 92 }, settingKey: 'DOWNLOAD_CACHE_MAX_GB' });
    expect(get(cap, 'core.disk.previews')).toMatchObject({ status: 'unknown', cause: 'disk_unreadable' });
  });

  it('downloads disabled → core.disk.downloads not_set_up', async () => {
    env.ctx.cfg = { ...cfg, DOWNLOADS_ENABLED: 'false' };
    const r = await run(snap({ disks: [{ id: 'previews', level: 'ok', usedPct: 10, ownBytes: 0 }, { id: 'database', level: 'ok', ownBytes: GiB }] }));
    expect(get(r, 'core.disk.downloads')).toMatchObject({ status: 'not_set_up', cause: 'downloads_off', settingKey: 'DOWNLOADS_ENABLED' });
    expect(get(r, 'core.disk.previews').status).toBe('ok');
    expect(r.counts.problem + r.counts.warning).toBe(0);
  });
});

describe('media lines', () => {
  it('no request service → media.requests not_set_up settingKey REQUESTS_URL; counts.problem and counts.warning are 0 for it', async () => {
    const r = await run(snap({ services: { requests: { level: 'off', reason: 'not_set' } } }));
    expect(get(r, 'media.requests')).toMatchObject({ status: 'not_set_up', cause: 'requests_not_set', settingKey: 'REQUESTS_URL' });
    expect(r.counts.problem).toBe(0);
    expect(r.counts.warning).toBe(0);
    expect(r.lines.filter((l) => l.status === 'not_set_up' && (l.group === 'core' || l.group === 'media')).map((l) => l.id)).toEqual(['media.requests']);
  });

  it('request service answers 401 → media.requests warning requests_key_invalid settingKey REQUESTS_API_KEY', async () => {
    up.requests = 401;
    const r = await run(snap({ services: { requests: { level: 'warn', reason: 'down' } } }));
    expect(get(r, 'media.requests')).toMatchObject({ status: 'warning', cause: 'requests_key_invalid', settingKey: 'REQUESTS_API_KEY' });
    expect(JSON.stringify(r)).not.toContain('seerrkey');
    up.requests = 503;
    expect(get(await run(snap({ services: { requests: { level: 'warn', reason: 'down' } } })), 'media.requests')).toMatchObject({ status: 'warning', cause: 'requests_down', settingKey: 'REQUESTS_URL' });
  });

  it('TMDB key invalid → media.tmdb warning settingKey TMDB_API_KEY; no key value in JSON.stringify(result)', async () => {
    env.ctx.cfg = { ...cfg, TMDB_API_KEY: 'sekret-tmdb-0000', OMDB_API_KEY: 'sekret-omdb-0000' };
    const r = await run(snap({ services: { tmdb: { level: 'warn', reason: 'invalid_key' }, omdb: { level: 'warn', reason: 'budget', detail: { n: 950, pct: 95 } } } }));
    expect(get(r, 'media.tmdb')).toMatchObject({ status: 'warning', cause: 'source_key_invalid', settingKey: 'TMDB_API_KEY' });
    expect(get(r, 'media.omdb')).toMatchObject({ status: 'warning', cause: 'source_budget', params: { pct: 95 } });
    expect(JSON.stringify(r)).not.toMatch(/sekret/);
    const none = await run(snap({ services: { tmdb: { level: 'off', reason: 'not_set' }, omdb: { level: 'off', reason: 'not_set' } } }));
    expect(get(none, 'media.tmdb')).toMatchObject({ status: 'not_set_up', settingKey: 'TMDB_API_KEY' });
    expect(get(none, 'media.omdb')).toMatchObject({ status: 'not_set_up', settingKey: 'OMDB_API_KEY' });
  });

  it('media server down with MEDIA_SERVER=plex → settingKey PLEX_URL (Jellyfin: JELLYFIN_URL)', async () => {
    const down = snap({ services: { media: { level: 'err', reason: 'down', ms: 3000 } } });
    expect(get(await run(down), 'media.server')).toMatchObject({ status: 'problem', cause: 'media_down', settingKey: 'JELLYFIN_URL' });
    env.ctx.cfg = { ...cfg, MEDIA_SERVER: 'plex' };
    expect(get(await run(down), 'media.server')).toMatchObject({ status: 'problem', cause: 'media_down', settingKey: 'PLEX_URL', settingGroup: 'media' });
  });

  it('encoder advice no_hw_accel, no_tonemap → media.encoder warning cause no_hw_accel, params.advice \'no_hw_accel,no_tonemap\'', async () => {
    const r = await run(snap({ services: { encoder: { level: 'warn', reason: 'no_hw_accel', advice: ['no_hw_accel', 'no_tonemap'] } } }));
    expect(get(r, 'media.encoder')).toMatchObject({ status: 'warning', cause: 'no_hw_accel', params: { advice: 'no_hw_accel,no_tonemap' } });
    const hevc = await run(snap({ services: { encoder: { level: 'warn', reason: 'hevc_slow', advice: ['hevc_slow'], hevc: { state: 'slow', speed: 1.2 } } } }));
    expect(get(hevc, 'media.encoder')).toMatchObject({ status: 'warning', cause: 'hevc_slow', settingKey: 'HEVC_STREAMS', params: { advice: 'hevc_slow', hevc: 'slow', speed: 1.2 } });
    // a media server without encoder settings (Plex) has no row: neutral, never red
    expect(get(await run(snap({ services: { encoder: null } })), 'media.encoder')).toMatchObject({ status: 'not_set_up', cause: 'encoder_unsupported' });
  });

  it('playback check never ran → media.playback unknown playback_never href /admin/playback', async () => {
    const r = await run(snap({ services: { playbackCheck: { level: 'off' } } }));
    expect(get(r, 'media.playback')).toMatchObject({ status: 'unknown', cause: 'playback_never', href: '/admin/playback' });
    const failed = await run(snap({ services: { playbackCheck: { level: 'warn', reason: 'failed_titles', detail: { n: 2 } } } }));
    expect(get(failed, 'media.playback')).toMatchObject({ status: 'warning', cause: 'playback_failed', params: { n: 2 }, href: '/admin/playback' });
    const empty = await run(snap({ services: { playbackCheck: { level: 'err', reason: 'empty_media', detail: { n: 3 } } } }));
    expect(get(empty, 'media.playback')).toMatchObject({ status: 'problem', cause: 'playback_empty', params: { n: 3 } });
  });
});

describe('one hung dependency', () => {
  // ctx.db is a proxy over the pool: the pool's own query is replaced (and the prototype's restored by deleting it)
  const pool = () => env.pool as unknown as { query?: unknown; connect?: unknown };
  // never answers: plain queries and the probes' own connections (probeQuery checks a connection out of the pool)
  const stallDb = () => { pool().query = () => new Promise(() => undefined); pool().connect = () => new Promise(() => undefined); };
  const unstallDb = () => { delete pool().query; delete pool().connect; };
  const noTimeouts = (r: SystemcheckResult) => r.lines.filter((l) => l.cause === 'check_timeout').map((l) => l.id);

  it('Postgres stalled (Jetzt prüfen): core.database problem db_down, every other line filled, answer < 8.5 s', async () => {
    stallDb();
    try {
      const t0 = performance.now();
      const r = await buildSystemcheck(env.ctx, { fresh: true });
      expect(performance.now() - t0).toBeLessThan(8_500);
      expect(noTimeouts(r)).toEqual([]);
      expect(get(r, 'core.database')).toMatchObject({ status: 'problem', cause: 'db_down' });
      expect(get(r, 'core.redis').status).toBe('ok');
      expect(get(r, 'media.server').status).toBe('ok');
      expect(get(r, 'media.playback')).toMatchObject({ status: 'unknown', cause: 'check_unavailable' });
      expect(r.lines.filter((l) => l.group === 'signin').length).toBe(6);
    } finally {
      unstallDb();
    }
  }, 15_000);

  it('a snapshot that does not come in time: core asks the database and Redis itself, the rest reads check_unavailable (not check_timeout)', async () => {
    const kv = env.kv;
    const orig = kv.get;
    kv.get = async (key: string) => (key.startsWith('health:') ? new Promise<string | null>(() => undefined) : orig.call(kv, key));
    try {
      const t0 = performance.now();
      const r = await buildSystemcheck(env.ctx);
      expect(performance.now() - t0).toBeLessThan(4_500);
      expect(noTimeouts(r)).toEqual([]);
      expect(get(r, 'core.database').status).toBe('ok');
      expect(get(r, 'core.redis').status).toBe('ok');
      expect(get(r, 'core.publicUrl').status).toBe('ok');
      for (const id of ['core.gateway', 'core.disk.previews', 'media.server', 'media.requests', 'signin.oidc'] as const) expect(get(r, id), id).toMatchObject({ status: 'unknown', cause: 'check_unavailable' });
      // the database stalled as well: its own probe says so
      stallDb();
      try {
        expect(get(await buildSystemcheck(env.ctx), 'core.database')).toMatchObject({ status: 'problem', cause: 'db_down' });
      } finally {
        unstallDb();
      }
    } finally {
      kv.get = orig;
    }
  }, 15_000);

  it('no snapshot and the database stalled: core still answers with ≥ 500 ms to spare before its limit', async () => {
    stallDb();
    try {
      const t0 = performance.now();
      const lines = await coreCheck.run({
        ctx: env.ctx, fresh: false, timeoutMs: CHECK_TIMEOUT_MS,
        // the snapshot wait runs out at its full limit
        snapshot: () => new Promise((res) => setTimeout(() => res(null), SNAPSHOT_TIMEOUT_MS)),
        login: () => new Promise(() => undefined),
      });
      expect(performance.now() - t0).toBeLessThan(CHECK_TIMEOUT_MS - 500);
      expect(lines.find((l) => l.id === 'core.database')).toMatchObject({ status: 'problem', cause: 'db_down' });
      expect(lines.find((l) => l.id === 'core.redis')?.status).toBe('ok');
    } finally {
      unstallDb();
    }
  }, 15_000);

  it('request service never answers (Jetzt prüfen): media.requests warning requests_down, the other media lines filled', async () => {
    const seerr = env.ctx.seerr!;
    const origCount = seerr.requestCount;
    seerr.requestCount = () => new Promise(() => undefined);
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (new URL(String(input)).host === 'requests:5055' ? new Promise<Response>(() => undefined) : http(input, init))) as typeof fetch;
    try {
      const t0 = performance.now();
      const r = await buildSystemcheck(env.ctx, { fresh: true });
      expect(performance.now() - t0).toBeLessThan(4_500);
      expect(get(r, 'media.requests')).toMatchObject({ status: 'warning', cause: 'requests_down', settingKey: 'REQUESTS_URL' });
      for (const id of ['media.server', 'media.tmdb', 'media.omdb', 'media.encoder'] as const) expect(get(r, id).cause, id).not.toBe('check_timeout');
      expect(noTimeouts(r)).toEqual([]);
    } finally {
      seerr.requestCount = origCount;
    }
  }, 15_000);
});

describe('without kv', () => {
  it('Redis down: the endpoint still answers (built in-process), core.redis = problem', async () => {
    const kv = env.kv;
    const orig = { get: kv.get, set: kv.set, incr: kv.incr, ping: kv.ping };
    const down = (key: string) => !key.startsWith('sess:') && !key.startsWith('dev:') && !key.startsWith('user:');
    kv.get = async (key: string) => { if (down(key)) throw new Error('redis down'); return orig.get.call(kv, key); };
    kv.set = async (key: string, v: string, ttl?: number) => { if (down(key)) throw new Error('redis down'); return orig.set.call(kv, key, v, ttl); };
    kv.incr = async () => { throw new Error('redis down'); };
    kv.ping = async () => false;
    try {
      const r = await env.app.inject({ method: 'GET', url: '/api/admin/systemcheck', cookies: admin.cookies });
      expect(r.statusCode).toBe(200);
      expect(r.json().lines.find((l: { id: string }) => l.id === 'core.redis')).toMatchObject({ status: 'problem', cause: 'redis_down' });
    } finally {
      Object.assign(kv, orig);
    }
  });
});

describe('docs links', () => {
  // GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens
  const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const docsDir = new URL('../../docs/', import.meta.url);
  const srcDir = new URL('../src/syscheck/', import.meta.url);

  it('every docs value names an existing docs/<file>.md heading', () => {
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const values = new Set<string>();
    for (const f of files) for (const m of readFileSync(new URL(f, srcDir), 'utf8').matchAll(/docs: '([^']+)'/g)) values.add(m[1]!);
    expect(values.size).toBeGreaterThan(0);
    for (const v of values) {
      expect(v, v).toMatch(/^[a-z-]+\.md(#[a-z0-9-]+)?$/);
      const [file, anchor] = v.split('#');
      const text = readFileSync(new URL(file!, docsDir), 'utf8');
      if (!anchor) continue;
      const anchors = [...text.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1]!));
      expect(anchors, v).toContain(anchor);
    }
  });
});
