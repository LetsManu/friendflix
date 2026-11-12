// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Docker, StepError, type Program, type Runner } from '../src/docker.js';
import { Updater } from '../src/job.js';
import { FF_SERVICES, HEALTH_SERVICES, IMAGE_OF, LIVETV_SERVICE, expectedImage, ffServices, healthServices, parseLivetvBody } from '../src/policy.js';
import { ReplayCache, deriveKey, sign } from '../src/protocol.js';
import { dockerOps, handler, livetvView, status } from '../src/server.js';
import { DEFAULT_STATE, memoryStore, sanitize, type State } from '../src/state.js';

// The optional livetv service (spec §4.2): POST /v1/livetv enable / disable / remove. The tests run the real Updater on the real
// Docker command lines against a fake Docker host (the Runner), so every assertion is about the exact commands that would run.

type Call = { program: Program; args: string[]; env: Record<string, string> };
const D = 'sha256:' + 'c'.repeat(64);
const ID = 'sha256:' + 'e'.repeat(64);
const OTHER_ID = 'sha256:' + 'f'.repeat(64);
const SHA = 'b'.repeat(40);
const LTV = 'ghcr.io/letsmanu/friendflix-livetv';
const LABELS = { 'com.docker.compose.project': 'friendflix', 'com.docker.compose.project.working_dir': '/srv/friendflix',
  'com.docker.compose.project.config_files': '/srv/friendflix/compose.prod.yaml' };
const PORTAINER = { ...LABELS, 'com.docker.compose.project.working_dir': '/data/compose/12', 'com.docker.compose.project.config_files': '/data/compose/12/docker-compose.yml' };
const cmd = (c: Call) => [c.program, ...c.args].join(' ');
/** the compose sub-command (after the fixed base arguments) */
const sub = (c: Call): string => (c.args[0] === 'compose' ? c.args[c.args.indexOf('--ansi') + 2] ?? '' : `${c.args[0]} ${c.args[1]}`);

interface WorldOpts {
  /** the livetv container as it is before the job */
  livetv?: { state: string; health: string } | null;
  /** health the livetv container reports after `up` */
  healthAfterUp?: string;
  verifyFails?: string;
  pullFails?: boolean;
  /** compose / docker sub-commands that fail (e.g. 'stop', 'up', 'image rm') */
  fails?: string[];
  labels?: unknown;
  /** tags of the image the livetv container runs */
  imageTags?: string[];
  /** blocks every `pull` until released */
  gate?: boolean;
}

/** a fake Docker host: the FriendFlix stack runs, the livetv container as given */
function world(o: WorldOpts = {}) {
  const calls: Call[] = [];
  const w = { livetv: o.livetv ?? null, imageTags: [...(o.imageTags ?? [`${LTV}:latest`, `${LTV}:sha-aaaaaaa`])], idGone: false, waiting: false, release: () => {} };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const run: Runner = async (program, args, opts) => {
    const c = { program, args: [...args], env: opts.env };
    calls.push(c);
    if (program === 'cosign') return { code: o.verifyFails && args.at(-1)!.includes(o.verifyFails) ? 1 : 0, stdout: '', stderr: '' };
    const s = sub(c);
    if (o.fails?.includes(s)) return { code: 1, stdout: '', stderr: 'Error: token ghp_secret123 denied' };
    const profiled = args.includes('livetv') && args[args.indexOf('livetv') - 1] === '--profile';
    switch (s) {
      case 'ps': {
        const rows = [...FF_SERVICES, 'updater', 'postgres'].map((x) => ({ Service: x, Name: `friendflix-${x}-1`, State: 'running', Health: x === 'web' || x === 'bootstrap' ? '' : 'healthy' }));
        if (w.livetv && profiled) rows.push({ Service: 'livetv', Name: 'friendflix-livetv-1', State: w.livetv.state, Health: w.livetv.health });
        return ok(rows.map((r) => JSON.stringify(r)).join('\n'));
      }
      case 'config': {
        // like compose: a service of an inactive profile is not rendered
        const tag = opts.env.FF_TAG!;
        const services: Record<string, { image: string }> = Object.fromEntries([...FF_SERVICES, 'updater'].map((x) => [x, { image: `ghcr.io/letsmanu/friendflix-${IMAGE_OF[x]}:${tag}` }]));
        services.postgres = { image: 'postgres:17-alpine' };
        if (profiled) services.livetv = { image: `${LTV}:${tag}` };
        return ok(JSON.stringify({ services }));
      }
      case 'pull':
        if (o.gate) await new Promise<void>((r) => { w.waiting = true; w.release = () => { w.waiting = false; r(); }; });
        return o.pullFails ? { code: 1, stdout: '', stderr: 'denied' } : ok();
      case 'up':
        if (args.includes('livetv')) w.livetv = { state: 'running', health: o.healthAfterUp ?? 'healthy' };
        return ok();
      case 'stop':
        if (w.livetv) w.livetv = { state: 'exited', health: '' };
        return ok();
      case 'rm':
        w.livetv = null;
        return ok();
      case 'container inspect': {
        const f = args[3]!, name = args.at(-1)!;
        if (f === '{{json .Config.Labels}}') return ok(JSON.stringify(o.labels ?? LABELS));
        if (f.includes('PortBindings')) return ok(`{}\t{"friendflix_default":{}}\t${JSON.stringify(o.labels ?? LABELS)}`);
        if (f === '{{.Image}}') return ok(`${name === 'friendflix-livetv-1' ? ID : OTHER_ID}\n`);
        if (f === '{{json .Config.Env}}') return ok('[]');
        return ok();
      }
      case 'image inspect': {
        const ref = args.at(-1)!, f = args[3]!;
        if (f === '{{json .RepoTags}}') return ref === ID && !w.idGone ? ok(JSON.stringify(w.imageTags)) : { code: 1, stdout: '', stderr: 'No such image' };
        const repo = ref === ID ? LTV : ref.slice(0, ref.lastIndexOf(':'));
        return ok(`["${repo}@${D}"]\t["GIT_SHA=${SHA}","APP_VERSION=1.2.3"]`);
      }
      case 'image rm': {
        const refs = args.slice(2);
        if (refs.some((r) => !w.imageTags.includes(r) && r !== ID)) return { code: 1, stdout: '', stderr: `Error response from daemon: No such image: ${refs[0]}` };
        w.imageTags = w.imageTags.filter((t) => !refs.includes(t));
        if (!w.imageTags.length || refs.includes(ID)) w.idGone = true;
        return ok();
      }
      case 'volume rm':
        return ok();
      default:
        return ok();
    }
  };
  return { calls, w, run };
}

/** lets a gated pull through once a job has reached it */
async function release(m: { w: { waiting: boolean; release: () => void } }): Promise<void> {
  for (let i = 0; i < 200 && !m.w.waiting; i++) await new Promise((r) => setTimeout(r, 5));
  m.w.release();
}
const health = (async () => new Response(JSON.stringify({ status: 'ok', version: SHA.slice(0, 7) }))) as unknown as typeof fetch;

function make(o: WorldOpts = {}, init: Partial<State> = {}) {
  const wd = world(o);
  let t = 1_760_800_000_000;
  let u: Updater | null = null;
  const docker = new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375', livetv: () => u?.livetv === 'enabled' }, wd.run);
  const store = memoryStore({ ...DEFAULT_STATE, ...init });
  u = new Updater(dockerOps(docker, 'http://backend:3000/health', health), store, { healthTimeoutMs: 20_000, healthIntervalMs: 5_000, now: () => t, sleep: async (ms) => { t += ms; } });
  return { ...wd, docker, store, u, elapsed: () => t - 1_760_800_000_000 };
}
type Made = ReturnType<typeof make>;
const changing = (m: Made) => m.calls.filter((c) => c.program === 'cosign' || ['pull', 'up', 'stop', 'rm', 'image rm', 'volume rm', 'run'].includes(sub(c))).map(cmd);
const BASE = 'docker compose --project-directory /srv/friendflix -f /srv/friendflix/compose.prod.yaml --profile updater';

describe('livetv policy', () => {
  it('parseLivetvBody accepts exactly three shapes', () => {
    expect(parseLivetvBody({ op: 'enable' })).toEqual({ op: 'enable' });
    expect(parseLivetvBody({ op: 'disable' })).toEqual({ op: 'disable' });
    expect(parseLivetvBody({ op: 'remove', data: true })).toEqual({ op: 'remove', data: true });
    expect(parseLivetvBody({ op: 'remove', data: false })).toEqual({ op: 'remove', data: false });
    for (const bad of [{ op: 'enable', x: 1 }, { op: 'remove' }, { op: 'remove', data: 'yes' }, { op: 'remove', data: 1 }, { op: 'disable', data: true },
      { op: 'enable', data: false }, { op: 'start' }, { op: 'ENABLE' }, {}, [], [{ op: 'enable' }], null, 'enable', 1, { op: 'remove', data: true, image: 'x' }]) {
      expect(parseLivetvBody(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('livetv is a service with its own image; the lists include it only while enabled', () => {
    expect(LIVETV_SERVICE).toBe('livetv');
    expect(IMAGE_OF.livetv).toBe('livetv');
    expect(expectedImage('LetsManu/friendflix', 'livetv', 'latest')).toBe(`${LTV}:latest`);
    expect(ffServices(false)).toEqual([...FF_SERVICES]);
    expect(ffServices(true)).toEqual([...FF_SERVICES, 'livetv']);
    expect(healthServices(false)).toEqual([...HEALTH_SERVICES]);
    expect(healthServices(true)).toEqual([...HEALTH_SERVICES, 'livetv']);
    expect(FF_SERVICES as readonly string[]).not.toContain('livetv');
  });

  it('state file sanitises livetv', () => {
    expect(DEFAULT_STATE.livetv).toBe('absent');
    expect(sanitize({ livetv: 'bogus' }).livetv).toBe('absent');
    expect(sanitize({}).livetv).toBe('absent');
    for (const v of ['enabled', 'disabled', 'absent'] as const) expect(sanitize({ livetv: v }).livetv).toBe(v);
    const job = (action: string) => ({ id: '0123456789abcdef', action, state: 'succeeded', to: 'latest', steps: {}, startedAt: '2026-11-12T00:00:00.000Z' });
    for (const a of ['livetv-enable', 'livetv-disable', 'livetv-remove']) expect(sanitize({ lastJob: job(a) }).lastJob?.action).toBe(a);
    expect(sanitize({ lastJob: job('livetv-exec') }).lastJob).toBeNull();
    expect(sanitize({ lastJob: job('livetv') }).lastJob).toBeNull();
  });
});

describe('livetv jobs', () => {
  it('enable pulls, verifies and starts livetv with the profile', async () => {
    const m = make();
    const r = m.u.startLivetv({ op: 'enable' });
    expect(r).toMatchObject({ ok: true, job: { action: 'livetv-enable', state: 'running', to: 'latest', from: null } });
    expect(m.u.busy).toBe(true);
    await m.u.idle();
    expect(changing(m)).toEqual([
      `${BASE} --profile livetv --ansi never pull --quiet livetv`,
      `cosign verify --certificate-identity-regexp ^https://github\\.com/LetsManu/friendflix/\\.github/workflows/publish\\.yml@refs/(heads/main|tags/v[0-9]+\\.[0-9]+\\.[0-9]+)$ --certificate-oidc-issuer https://token.actions.githubusercontent.com ${LTV}@${D}`,
      `${BASE} --profile livetv --ansi never up -d --no-deps --pull never livetv`,
    ]);
    // the image check ran on the rendered config with the profile (compose leaves livetv out without it)
    expect(m.calls.some((c) => sub(c) === 'config' && cmd(c).includes('--profile livetv'))).toBe(true);
    for (const c of m.calls.filter((x) => ['pull', 'up', 'config'].includes(sub(x)))) expect(c.env.FF_TAG).toBe('latest');
    expect(m.store.state.livetv).toBe('enabled');
    expect(m.store.state.lastJob).toMatchObject({ action: 'livetv-enable', state: 'succeeded', error: null, step: null,
      steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } });
    expect(m.u.log.tail().some((l) => l.endsWith('livetv-enable succeeded'))).toBe(true);
    // the installed FriendFlix build decides the tag (not the channel's moving tag)
    const p = make({}, { current: 'sha-bbbbbbb' });
    p.u.startLivetv({ op: 'enable' });
    await p.u.idle();
    expect(p.calls.filter((c) => sub(c) === 'pull').map((c) => c.env.FF_TAG)).toEqual(['sha-bbbbbbb']);
    expect(p.store.state.lastJob?.to).toBe('sha-bbbbbbb');
  });

  it('a verify failure starts nothing', async () => {
    const m = make({ verifyFails: 'friendflix-livetv' }, { livetv: 'disabled' });
    m.u.startLivetv({ op: 'enable' });
    await m.u.idle();
    expect(m.calls.some((c) => sub(c) === 'up')).toBe(false);
    expect(m.store.state.livetv).toBe('disabled');
    expect(m.store.state.lastJob).toMatchObject({ state: 'failed', error: 'verify_failed', steps: { pull: 'ok', verify: 'failed', restart: 'skipped', health: 'skipped' } });
    // a failed pull: neither verified nor started
    const p = make({ pullFails: true });
    p.u.startLivetv({ op: 'enable' });
    await p.u.idle();
    expect(p.calls.some((c) => c.program === 'cosign' || sub(c) === 'up')).toBe(false);
    expect(p.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'failed', error: 'pull_failed' } });
  });

  it('a failed start or a container that does not get healthy within 2 min: removed again, state unchanged', async () => {
    const m = make({ healthAfterUp: 'unhealthy' }, { livetv: 'disabled' });
    m.u.startLivetv({ op: 'enable' });
    await m.u.idle();
    expect(m.elapsed()).toBe(120_000);
    expect(m.store.state.livetv).toBe('disabled');
    expect(m.store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'health_timeout', steps: { restart: 'ok', health: 'failed', rollback: 'ok' } });
    expect(changing(m).slice(-2)).toEqual([`${BASE} --profile livetv --ansi never stop livetv`, `${BASE} --profile livetv --ansi never rm -f livetv`]);
    expect(m.w.livetv).toBeNull();

    const r = make({ fails: ['up'] });
    r.u.startLivetv({ op: 'enable' });
    await r.u.idle();
    expect(r.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'rolled_back', error: 'restart_failed', steps: { restart: 'failed', health: 'skipped', rollback: 'ok' } } });

    // the clean-up fails too: reported as such
    const f = make({ fails: ['up', 'stop'] });
    f.u.startLivetv({ op: 'enable' });
    await f.u.idle();
    expect(f.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'failed', error: 'rollback_failed' } });

    // already enabled (a repair): an unhealthy result is reported, the container is left as it is
    const e = make({ livetv: { state: 'running', health: 'healthy' }, healthAfterUp: 'starting' }, { livetv: 'enabled' });
    e.u.startLivetv({ op: 'enable' });
    await e.u.idle();
    expect(e.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'health_timeout', steps: { rollback: 'skipped' } } });
    expect(e.calls.some((c) => sub(c) === 'stop' || sub(c) === 'rm')).toBe(false);
  });

  it('disable stops and removes the container', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    const r = m.u.startLivetv({ op: 'disable' });
    expect(r).toMatchObject({ ok: true, job: { action: 'livetv-disable', steps: { pull: 'skipped', verify: 'skipped', health: 'skipped' } } });
    await m.u.idle();
    expect(changing(m)).toEqual([`${BASE} --profile livetv --ansi never stop livetv`, `${BASE} --profile livetv --ansi never rm -f livetv`]);
    expect(m.store.state.livetv).toBe('disabled');
    expect(m.store.state.lastJob).toMatchObject({ action: 'livetv-disable', state: 'succeeded', steps: { pull: 'skipped', verify: 'skipped', restart: 'ok', health: 'skipped', rollback: 'skipped' } });
    expect(m.w.livetv).toBeNull();
    // a failing stop: state unchanged, a fixed code
    const f = make({ livetv: { state: 'running', health: 'healthy' }, fails: ['stop'] }, { livetv: 'enabled' });
    f.u.startLivetv({ op: 'disable' });
    await f.u.idle();
    expect(f.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'stop_failed', steps: { restart: 'failed' } } });
    expect(f.calls.some((c) => sub(c) === 'rm')).toBe(false);
    expect(JSON.stringify(f.store.state) + f.u.log.tail().join('\n')).not.toContain('ghp_secret');
  });

  it('remove with data deletes the image and the cache volume, never recordings', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    m.u.startLivetv({ op: 'remove', data: true });
    await m.u.idle();
    expect(changing(m)).toEqual([
      `${BASE} --profile livetv --ansi never stop livetv`,
      `${BASE} --profile livetv --ansi never rm -f livetv`,
      `docker image rm ${LTV}:latest`,
      // the image the container ran, by its remaining tags (all of them livetv's)
      `docker image rm ${LTV}:sha-aaaaaaa`,
      'docker volume rm friendflix_livetv-cache',
    ]);
    for (const c of m.calls) expect(cmd(c)).not.toContain('recordings');
    expect(m.store.state.livetv).toBe('absent');
    expect(m.store.state.lastJob).toMatchObject({ action: 'livetv-remove', state: 'succeeded' });

    // without data: the cache volume stays
    const k = make({ livetv: { state: 'exited', health: '' } }, { livetv: 'disabled' });
    k.u.startLivetv({ op: 'remove', data: false });
    await k.u.idle();
    expect(k.calls.some((c) => sub(c) === 'volume rm')).toBe(false);
    expect(k.calls.filter((c) => sub(c) === 'image rm').length).toBeGreaterThan(0);
    expect(k.store.state.livetv).toBe('absent');

    // an image that also carries another service's tag is never removed by id; a tag that is not there is fine
    const s = make({ livetv: { state: 'running', health: 'healthy' }, imageTags: ['ghcr.io/letsmanu/friendflix-backend:latest', `${LTV}:sha-aaaaaaa`] }, { livetv: 'enabled' });
    s.u.startLivetv({ op: 'remove', data: false });
    await s.u.idle();
    expect(s.calls.filter((c) => sub(c) === 'image rm').map(cmd)).toEqual([`docker image rm ${LTV}:latest`]);
    expect(s.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'succeeded' } });

    // removal fails: the container is gone (disabled), the job says so
    const f = make({ livetv: { state: 'running', health: 'healthy' }, fails: ['volume rm'] }, { livetv: 'enabled' });
    f.u.startLivetv({ op: 'remove', data: true });
    await f.u.idle();
    expect(f.store.state).toMatchObject({ livetv: 'disabled', lastJob: { state: 'failed', error: 'remove_failed' } });
  });

  it('updates include livetv only while enabled', async () => {
    const on = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    on.u.start('update');
    await on.u.idle();
    expect(on.store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded' });
    const ch = changing(on);
    expect(ch).toContain(`${BASE} --profile livetv --ansi never pull --quiet bootstrap backend gateway web livetv`);
    expect(ch).toContain(`${BASE} --profile livetv --ansi never up -d --no-deps --pull never bootstrap backend gateway web livetv`);
    expect(ch.filter((c) => c.startsWith('cosign')).map((c) => c.split(' ').at(-1))).toEqual(['backend', 'gateway', 'web', 'livetv'].map((s) => `ghcr.io/letsmanu/friendflix-${s}@${D}`));
    // every compose command adds the profile while enabled
    for (const c of on.calls.filter((x) => x.args[0] === 'compose')) expect(cmd(c), cmd(c)).toContain('--profile updater --profile livetv');
    // health waits for livetv too
    const sick = make({ livetv: { state: 'running', health: 'healthy' }, healthAfterUp: 'unhealthy' }, { livetv: 'enabled' });
    sick.u.start('update');
    await sick.u.idle();
    expect(sick.store.state.lastJob).toMatchObject({ state: 'failed', steps: { restart: 'ok', health: 'failed' } });

    const off = make({}, { livetv: 'disabled' });
    off.u.start('update');
    await off.u.idle();
    expect(off.store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded' });
    expect(changing(off).filter((c) => c.includes('livetv'))).toEqual([]);
    expect(changing(off)).toContain(`${BASE} --ansi never up -d --no-deps --pull never bootstrap backend gateway web`);
    expect(off.calls.filter((c) => sub(c) === 'config').every((c) => !cmd(c).includes('livetv'))).toBe(true);
  });

  it('foreign stack refused', async () => {
    for (const op of [{ op: 'enable' }, { op: 'disable' }, { op: 'remove', data: true }] as const) {
      const m = make({ labels: PORTAINER, livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
      m.u.startLivetv(op);
      await m.u.idle();
      expect(changing(m), op.op).toEqual([]);
      expect(m.store.state, op.op).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'foreign_stack' } });
    }
  });

  it('one job at a time: an enable during an update and an update during an enable are refused', async () => {
    const m = make({ gate: true });
    expect(m.u.start('update').ok).toBe(true);
    expect(m.u.startLivetv({ op: 'enable' })).toEqual({ ok: false, error: 'busy' });
    expect(m.u.startLivetv({ op: 'disable' })).toEqual({ ok: false, error: 'busy' });
    await release(m);
    await m.u.idle();
    expect(m.u.startLivetv({ op: 'enable' }).ok).toBe(true);
    for (const a of ['update', 'rollback', 'self-update'] as const) expect(m.u.start(a)).toEqual({ ok: false, error: 'busy' });
    expect(m.u.startLivetv({ op: 'remove', data: true })).toEqual({ ok: false, error: 'busy' });
    await release(m);
    await m.u.idle();
    expect(m.calls.filter((c) => sub(c) === 'up').length).toBe(2);
    expect(m.store.state.livetv).toBe('enabled');
    // a channel without a target (an impossible state file aside): nothing starts
    const n = make({}, { channel: 'pinned', version: null });
    expect(n.u.startLivetv({ op: 'enable' })).toEqual({ ok: false, error: 'no_target' });
  });

  it('a livetv job interrupted by a restart is marked failed; the state stays', () => {
    const job = { id: '0123456789abcdef', action: 'livetv-enable' as const, state: 'running' as const, step: 'health' as const, from: null, to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'running' as const, rollback: 'skipped' as const } };
    const s = memoryStore({ ...DEFAULT_STATE, livetv: 'disabled', lastJob: job });
    new Updater(dockerOps(new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, world().run), 'http://b/health', health), s);
    expect(s.state).toMatchObject({ livetv: 'disabled', lastJob: { state: 'failed', error: 'interrupted' } });
  });
});

describe('livetv docker commands', () => {
  it('only livetv can be stopped or removed; only livetv images and the livetv cache volume can be deleted', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } });
    await expect(m.docker.stop(['backend'])).rejects.toThrow('invalid service');
    await expect(m.docker.rm(['livetv', 'postgres'])).rejects.toThrow('invalid service');
    for (const bad of ['ghcr.io/letsmanu/friendflix-backend:latest', 'ghcr.io/evil/friendflix-livetv:latest', `${LTV}:latest;id`, 'postgres:17-alpine', `${LTV}@${D}`, 'sha256:abc']) {
      await expect(m.docker.imageRm(bad), bad).rejects.toThrow('invalid image');
    }
    for (const bad of ['friendflix_recordings', 'friendflix_postgres', 'livetv-cache', '_livetv-cache', 'x/../y_livetv-cache', 'Friendflix_livetv-cache']) {
      await expect(m.docker.volumeRm(bad), bad).rejects.toThrow('invalid volume');
    }
    expect(m.calls.filter((c) => ['stop', 'rm', 'image rm', 'volume rm'].includes(sub(c)))).toEqual([]);
    // a volume or image that is not there is fine; anything else is a fixed code
    const gone = make({ fails: [] });
    await gone.docker.imageRm(`${LTV}:nightly`);
    const f = make({ fails: ['image rm', 'volume rm'] });
    await expect(f.docker.imageRm(`${LTV}:latest`)).rejects.toEqual(new StepError('remove_failed'));
    await expect(f.docker.volumeRm('friendflix_livetv-cache')).rejects.toEqual(new StepError('remove_failed'));
  });

  it('the cache volume is named after the stack\'s compose project', async () => {
    expect(await make().docker.cacheVolume()).toBe('friendflix_livetv-cache');
    expect(await make({ labels: { ...LABELS, 'com.docker.compose.project': 'ff2' } }).docker.cacheVolume()).toBe('ff2_livetv-cache');
    expect(await make({ labels: { ...LABELS, 'com.docker.compose.project': 'Bad Name' } }).docker.cacheVolume()).toBeNull();
    expect(await make({ labels: { ...LABELS, 'com.docker.compose.project': undefined } }).docker.cacheVolume()).toBeNull();
  });

  it('ps lists livetv (with its profile) and nothing outside FriendFlix', async () => {
    const m = make({ livetv: { state: 'exited', health: '' } });
    const ps = await m.docker.ps();
    expect(ps.map((p) => p.service)).toEqual(['bootstrap', 'backend', 'gateway', 'web', 'updater', 'livetv']);
    expect(await m.docker.livetvContainer()).toEqual({ service: 'livetv', name: 'friendflix-livetv-1', state: 'exited', health: '', image: ID });
    expect(await make().docker.livetvContainer()).toBeNull();
  });
});

describe('livetv HTTP API and status', () => {
  const key = deriveKey('livetv-test-secret-0123456789');
  let server: Server, base: string, m: Made;
  beforeAll(async () => {
    server = createServer((req, res) => { void handler({ get updater() { return m.u; }, verifier: { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 },
      services: async () => [], self: { version: null, sha: null }, livetv: livetvView(m.docker) } as never)(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const call = (method: string, path: string, body = '', type = 'application/json') =>
    fetch(base + path, { method, body: method === 'GET' ? undefined : body, headers: { ...sign(key, method, path, body), ...(body ? { 'content-type': type } : {}) } });

  it('POST /v1/livetv: a strict JSON body, 202 with the job, 409 while a job runs', async () => {
    m = make({ gate: true });
    for (const b of ['', '{}', '{"op":"enable","x":1}', '{"op":"remove"}', '{"op":"remove","data":"yes"}', '[{"op":"enable"}]', '{broken']) {
      expect((await call('POST', '/v1/livetv', b)).status, b).toBe(b === '' ? 415 : 400);
    }
    expect((await call('POST', '/v1/livetv', '{"op":"enable"}', 'text/plain')).status).toBe(415);
    expect((await call('GET', '/v1/livetv')).status).toBe(405);
    const r = await call('POST', '/v1/livetv', '{"op":"enable"}');
    expect(r.status).toBe(202);
    expect((await r.json()).job).toMatchObject({ action: 'livetv-enable', state: 'running' });
    expect((await call('POST', '/v1/livetv', '{"op":"disable"}')).status).toBe(409);
    expect((await call('POST', '/v1/update')).status).toBe(409);
    await release(m);
    await m.u.idle();
    const removed = await call('POST', '/v1/livetv', '{"op":"remove","data":true}');
    expect(removed.status).toBe(202);
    await m.u.idle();
    expect(m.store.state.livetv).toBe('absent');
    const pinned = make({}, { channel: 'pinned', version: null });
    m = pinned;
    expect(await (await call('POST', '/v1/livetv', '{"op":"enable"}')).json()).toEqual({ error: 'no_target' });
  });

  it('status reports livetv', async () => {
    m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    const b = await (await call('GET', '/v1/status')).json();
    expect(b.livetv).toEqual({ state: 'enabled', container: 'running' });
    // the view: running, any other state = exited, none = null; a Docker failure = null
    let t = 0;
    const v = (state: string | null) => livetvView({ livetvContainer: async () => (state ? { service: 'livetv', name: 'x', state, health: '', image: null } : null) }, 10_000, () => t);
    expect(await v('running')()).toBe('running');
    expect(await v('exited')()).toBe('exited');
    expect(await v('restarting')()).toBe('exited');
    expect(await v(null)()).toBeNull();
    expect(await livetvView({ livetvContainer: async () => { throw new Error('x'); } })()).toBeNull();
    let n = 0;
    const cached = livetvView({ livetvContainer: async () => { n++; return null; } }, 10_000, () => t);
    await cached(); await cached();
    expect(n).toBe(1);
    t = 20_000;
    await cached();
    expect(n).toBe(2);
    // without a probe (older wiring): the state alone
    const s = await status({ updater: m.u, verifier: { key, cache: new ReplayCache(), notBefore: 0 }, services: async () => [], self: { version: null, sha: null } });
    expect(s.livetv).toEqual({ state: 'enabled', container: null });
  });
});
