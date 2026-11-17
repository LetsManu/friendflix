// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaPinTick } from '../src/mediaserver/pinTick.js';
import { writeManaged } from '../src/mediaserver/store.js';
import { makeEnv, type TestEnv } from './helpers.js';

// Task 15: the media server follows a FriendFlix build the updater did not install (Portainer, compose pull by hand): `pin.changed`
// starts one media update; a recover job of the updater's supervisor is audited once; a pin differing from the running image is
// recorded with the time it was first seen (the Systemcheck's managed_update_pending).
const SECRET = 'internal-secret-123456';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const PIN = `docker.io/jellyfin/jellyfin@sha256:${'b'.repeat(64)}`;

let jobN = 0;
type Job = Record<string, any>;
const job = (action: string, state = 'running'): Job => ({ id: (++jobN).toString(16).padStart(16, '0'), action, state, step: null, from: null, to: 'latest',
  steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' }, startedAt: '2026-11-17T10:00:00.000Z', finishedAt: null, error: null,
  media: { step: 'check', steps: {} } });
const media = () => ({
  available: true, reason: null, base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: { kind: 'jellyfin', folders: [{ rel: 'Filme', target: '/media/filme' }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, run: true },
  container: { state: 'running', health: 'healthy', kind: 'jellyfin', image: { digest: DIGEST, upstream: '10.10.7' }, template: 'current', tampered: false, createdAt: '2026-11-17T10:00:00.000Z' },
  pin: { image: PIN, upstream: '10.11.0', changed: true } as Record<string, any> | null,
  pins: { ferrofin: false, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null, backups: [], hdr: null,
});

const fake = { media: media() as Record<string, any>, job: null as Job | null, busy: false, bodies: [] as Array<Record<string, any>>, statusReads: 0 };
const resetFake = () => Object.assign(fake, { media: media(), job: null, busy: false, bodies: [], statusReads: 0 });

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(input));
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (u.pathname === '/v1/status') {
    fake.statusReads++;
    return j({ updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: fake.busy, job: fake.job, log: [], services: [], mediaserver: fake.media });
  }
  if (u.pathname !== '/v1/mediaserver') return j({ error: 'not_found' }, 404);
  const body = JSON.parse(String(init?.body));
  fake.bodies.push(body);
  if (fake.busy) return j({ error: 'busy' }, 409);
  fake.job = job(`mediaserver-${body.op}`);
  fake.busy = true;
  return j({ job: fake.job }, 202);
}) as typeof fetch;

describe('mediaPinTick', () => {
  let env: TestEnv;
  const audits = async (action: string) => (await env.pool.query<{ actor: string | null; meta: Record<string, unknown> }>('select actor, meta from audit_log where action = $1 order by id', [action])).rows;

  beforeAll(async () => {
    env = await makeEnv({}, { ctxPatch: (c) => { c.fetchImpl = fetchImpl; c.cfg = { ...c.cfg, UPDATER_URL: 'http://updater:7070', INTERNAL_SECRET: SECRET }; } });
  });
  afterAll(() => env.close());
  beforeEach(async () => {
    resetFake();
    await env.pool.query('delete from audit_log; delete from media_managed');
    for (const prefix of ['updater:pending:', 'media:']) for (const k of await env.kv.keys(prefix)) await env.kv.del(k);
    await writeManaged(env.ctx, { kind: 'jellyfin', setup: 'done', setupError: null, adminUser: 'friendflix-admin' });
  });

  it('a changed pin starts one media update', async () => {
    expect(await mediaPinTick(env.ctx)).toBe('started');
    expect(fake.bodies).toEqual([{ op: 'update' }]);
    const rows = await audits('mediaserver.action');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: null, meta: { op: 'update' } });
    // the job runs: the next tick sends nothing
    expect(await mediaPinTick(env.ctx)).toBe('busy');
    expect(fake.bodies).toHaveLength(1);
    // the result is audited like any media job when it ends
    fake.job = { ...fake.job!, state: 'succeeded' };
    fake.busy = false;
    fake.media.pin.changed = false;
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    expect(await audits('mediaserver.result')).toEqual([{ actor: null, meta: { action: 'mediaserver-update', result: 'succeeded', error: null } }]);
    expect(fake.bodies).toHaveLength(1);
  });

  it('busy → nothing', async () => {
    fake.busy = true;
    fake.job = job('update');
    expect(await mediaPinTick(env.ctx)).toBe('busy');
    expect(fake.bodies).toEqual([]);
  });

  it('changed:false → nothing', async () => {
    fake.media.pin.changed = false;
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    expect(fake.bodies).toEqual([]);
    expect(await audits('mediaserver.action')).toEqual([]);
  });

  it('desired.run:false → nothing (a stopped server is never updated on its own)', async () => {
    fake.media.desired.run = false;
    fake.media.container.state = 'exited';
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    expect(fake.bodies).toEqual([]);
  });

  it('no container or no desired state → nothing', async () => {
    fake.media.container = null;
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    fake.media = media();
    fake.media.desired = null;
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    expect(fake.bodies).toEqual([]);
  });

  it('the first run owns the server until its setup is done: no update while setup runs or failed', async () => {
    for (const setup of ['applying', 'first_run', 'finishing'] as const) {
      await writeManaged(env.ctx, { setup, setupError: null });
      expect(await mediaPinTick(env.ctx), setup).toBe('idle');
    }
    await writeManaged(env.ctx, { setup: 'done', setupError: 'unhealthy' });
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    await writeManaged(env.ctx, { kind: null, setup: 'none', setupError: null });
    expect(await mediaPinTick(env.ctx)).toBe('idle');
    expect(fake.bodies).toEqual([]);
    await writeManaged(env.ctx, { kind: 'jellyfin', setup: 'done', setupError: null });
    expect(await mediaPinTick(env.ctx)).toBe('started');
  });

  it('a refused start is retried on the next tick (nothing audited)', async () => {
    const warns: Array<Record<string, unknown>> = [];
    const log = { warn: (o: object) => { warns.push(o as Record<string, unknown>); } };
    const real = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input)).pathname === '/v1/mediaserver'
      ? new Response(JSON.stringify({ error: 'no_base' }), { status: 409 }) : real(input, init))) as typeof fetch;
    try {
      expect(await mediaPinTick(env.ctx, log)).toBe('idle');
      expect(await mediaPinTick(env.ctx, log)).toBe('idle');
    } finally { env.ctx.fetchImpl = real; }
    expect(await audits('mediaserver.action')).toEqual([]);
    // told once, not every minute
    expect(warns).toEqual([{ code: 'no_base' }]);
    expect(await mediaPinTick(env.ctx, log)).toBe('started');
  });

  it('a start refused while the updater has not read the media status yet (starting) is retried quietly', async () => {
    const warns: Array<Record<string, unknown>> = [];
    const log = { warn: (o: object) => { warns.push(o as Record<string, unknown>); } };
    const real = env.ctx.fetchImpl;
    env.ctx.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input)).pathname === '/v1/mediaserver'
      ? new Response(JSON.stringify({ error: 'starting' }), { status: 409 }) : real(input, init))) as typeof fetch;
    try {
      expect(await mediaPinTick(env.ctx, log)).toBe('idle');
    } finally { env.ctx.fetchImpl = real; }
    expect(warns).toEqual([]);
    expect(await mediaPinTick(env.ctx, log)).toBe('started');
  });

  it('without an updater (or one from before the media server) → off', async () => {
    const real = env.ctx.cfg;
    env.ctx.cfg = { ...real, UPDATER_URL: undefined };
    try { expect(await mediaPinTick(env.ctx)).toBe('off'); } finally { env.ctx.cfg = real; }
    fake.media = null as unknown as Record<string, any>;
    expect(await mediaPinTick(env.ctx)).toBe('off');
    expect(fake.bodies).toEqual([]);
  });

  it('a recover job is audited once', async () => {
    fake.media.pin.changed = false;
    fake.job = job('mediaserver-recover');
    fake.busy = true;
    for (let i = 0; i < 3; i++) await mediaPinTick(env.ctx);
    fake.job = { ...fake.job, state: 'succeeded' };
    fake.busy = false;
    await mediaPinTick(env.ctx);
    expect(fake.statusReads).toBe(4);
    expect(await audits('mediaserver.recover')).toEqual([{ actor: null, meta: {} }]);
    // another recover job is another row
    fake.job = job('mediaserver-recover', 'failed');
    await mediaPinTick(env.ctx);
    expect(await audits('mediaserver.recover')).toHaveLength(2);
  });

  it('a pin differing from the running image is recorded with the time it was first seen', async () => {
    fake.media.pin.changed = false;
    const t0 = Date.now();
    await mediaPinTick(env.ctx);
    const first = await env.kv.get(`media:pindiff:${PIN}`);
    expect(Date.parse(first!)).toBeGreaterThanOrEqual(t0 - 1000);
    await new Promise((r) => setTimeout(r, 5));
    await mediaPinTick(env.ctx);
    expect(await env.kv.get(`media:pindiff:${PIN}`)).toBe(first);
    // a difference that lasts: the first-seen time stays and its ttl is renewed on every read (it never lapses and starts over)
    const old = new Date(Date.now() - 29 * 86_400_000).toISOString();
    await env.kv.set(`media:pindiff:${PIN}`, old, 60);
    const replace = vi.spyOn(env.kv, 'replace');
    try {
      await mediaPinTick(env.ctx);
      expect(replace).toHaveBeenCalledWith(`media:pindiff:${PIN}`, old, 30 * 86_400);
    } finally { replace.mockRestore(); }
    expect(await env.kv.get(`media:pindiff:${PIN}`)).toBe(old);
    // the running image is the pin: nothing recorded
    for (const k of await env.kv.keys('media:pindiff:')) await env.kv.del(k);
    fake.media.container.image.digest = `sha256:${'b'.repeat(64)}`;
    await mediaPinTick(env.ctx);
    expect(await env.kv.keys('media:pindiff:')).toEqual([]);
  });
});
