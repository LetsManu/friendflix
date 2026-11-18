// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Docker, StepError, type Program, type Runner } from '../src/docker.js';
import { Updater } from '../src/job.js';
import { FF_SERVICES, HEALTH_SERVICES, IMAGE_OF, LIVETV_SERVICE, expectedImage, ffServices, healthServices, parseLivetvBody } from '../src/policy.js';
import { ReplayCache, deriveKey, sign } from '../src/protocol.js';
import { dockerOps, handler, livetvView, status } from '../src/server.js';
import { DEFAULT_STATE, memoryStore, sanitize, type State } from '../src/state.js';

// The optional livetv service (spec §4.2): POST /v1/livetv enable / disable / remove, and livetv inside updates and rollbacks.
// The tests run the real Updater on the real Docker command lines against a fake Docker host (the Runner), so every assertion is
// about the exact commands that would run.

type Call = { program: Program; args: string[]; env: Record<string, string> };
const ID = 'sha256:' + 'e'.repeat(64);
const OTHER_ID = 'sha256:' + 'f'.repeat(64);
/** the image commits: build a (an image from before FF_IMAGE_COMMIT: GIT_SHA only), build b (FF_IMAGE_COMMIT; GIT_SHA another commit) */
const A = 'a'.repeat(40), B = 'b'.repeat(40), RUN_B = '9'.repeat(40);
const GH = 'ghcr.io/letsmanu/friendflix';
const LTV = `${GH}-livetv`;
/** sha256 + 64 × one hex digit */
const dg = (c: string) => `sha256:${c.repeat(64)}`;
const repoOf = (svc: string) => `${GH}-${IMAGE_OF[svc]}`;
/** the service's image pinned to the digest of one hex digit */
const ref = (svc: string, c: string) => `${repoOf(svc)}@${dg(c)}`;
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
  /** tags at which the registry has no livetv image (a build from before livetv) */
  livetvPullFails?: string[];
  /** backend digest digits that never get healthy */
  coreUnhealthy?: string[];
  /** what the core services (and the updater) run: build a (default), b, or a dev build (no digest, no commit) */
  core?: 'a' | 'b' | 'dev';
  /** the digest digit the livetv container runs (default a) */
  livetvRuns?: string;
  /** `<image>:<tag>` -> the digest digit the registry answers; default sha-aaaaaaa -> a, every other tag -> b */
  registry?: Record<string, string>;
  /** digest refs no longer on the host (pruned), and refs the registry no longer serves */
  pruned?: string[];
  gone?: string[];
  /** compose / docker sub-commands that fail (e.g. 'stop', 'up', 'image rm') */
  fails?: string[];
  labels?: unknown;
  /** local tags of the image the livetv container runs */
  imageTags?: string[];
  /** blocks the first pull of each job (the backend's, or livetv's for an enable) until released */
  gate?: boolean;
  /** compose files from before livetv: a command naming livetv fails (no such service), no livetv network anywhere */
  noLivetvService?: boolean;
  /** compose files from 1b, but backend and gateway still run as created by the old files (not on the livetv network yet) */
  notAttached?: boolean;
  /** a one-off `compose run livetv` container listed before the service container */
  oneoff?: boolean;
  /** a local tag a container still uses (image rm refuses it) */
  inUse?: string;
  /** the compose files now publish livetv on other ports than its container runs with */
  livetvDrift?: boolean;
  /** the compose files resolve livetv to another repository's image */
  livetvEvilImage?: boolean;
  /** called when `compose stop` runs (before it changes anything) */
  onStop?: () => void;
}

/**
 * a fake Docker host and registry: the FriendFlix stack runs (each service a digest of its image and a container id), the livetv
 * container as given. Images on the host are build a and b of every image (minus `pruned`), local tags name a digest, `compose up`
 * recreates a service only when its local tag names another digest than it runs.
 */
function world(o: WorldOpts = {}) {
  const calls: Call[] = [];
  const fetches: string[] = [];
  const core = o.core ?? 'a';
  const digit0 = core === 'dev' ? null : core;
  const runs: Record<string, string | null> = { bootstrap: digit0, backend: digit0, gateway: digit0, web: digit0, updater: digit0, livetv: o.livetvRuns ?? 'a' };
  let next = 1;
  /** a new container id (64 hex) */
  const cid = () => (next++).toString(16).padStart(2, '0').repeat(32);
  const containers: Record<string, string> = Object.fromEntries(Object.keys(runs).map((x) => [x, cid()]));
  const local = new Set(['backend', 'gateway', 'web', 'updater', 'livetv'].flatMap((x) => [ref(x, 'a'), ref(x, 'b')]).filter((r) => !o.pruned?.includes(r)));
  const tags = new Map<string, string>([...['backend', 'gateway', 'web', 'updater'].map((x) => [`${repoOf(x)}:latest`, digit0 ?? 'a'] as const), [`${LTV}:latest`, 'a']]);
  const w = { livetv: o.livetv ?? null, imageTags: [...(o.imageTags ?? [`${LTV}:latest`, `${LTV}:sha-aaaaaaa`])], idGone: false, waiting: false, release: () => {}, runs, containers, tags, local };
  const regDigit = (image: string, tag: string) => o.registry?.[`${image}:${tag}`] ?? (tag === 'sha-aaaaaaa' ? 'a' : 'b');
  /** the image id of a repository's digest digit (livetv build a: ID, the image the livetv container runs by default) */
  const idOf = (repo: string, c: string) => (repo === LTV && c === 'a' ? ID : `sha256:${createHash('sha256').update(`${repo}@${c}`).digest('hex')}`);
  const DEV_ID = 'sha256:' + '0'.repeat(64);
  const byId = (id: string) => {
    for (const x of ['backend', 'gateway', 'web', 'updater', 'livetv']) for (const c of 'abcd') if (idOf(repoOf(x), c) === id) return { repo: repoOf(x), c };
    return null;
  };
  /** what a ref names: an image id, repo@digest or repo:tag -> repository and digest digit (null: not on the host) */
  const resolve = (r: string): { repo: string; c: string } | null => {
    if (r.startsWith('sha256:')) return byId(r);
    if (r.includes('@')) return local.has(r) ? { repo: r.slice(0, r.indexOf('@')), c: r.slice(-1) } : null;
    const c = tags.get(r);
    return c ? { repo: r.slice(0, r.lastIndexOf(':')), c } : null;
  };
  const envOf = (c: string) => (c === 'a' ? [`GIT_SHA=${A}`, 'APP_VERSION=1.2.3'] : [`FF_IMAGE_COMMIT=${c === 'b' ? B : c.repeat(40)}`, `GIT_SHA=${RUN_B}`, 'APP_VERSION=1.2.3']);
  const commitOf = (c: string | null) => (c === null ? null : c === 'a' ? A : c === 'b' ? B : c.repeat(40));
  const serviceOf = (name: string) => /^friendflix-([a-z]+)-1$/.exec(name)?.[1] ?? null;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const run: Runner = async (program, args, opts) => {
    const c = { program, args: [...args], env: opts.env };
    calls.push(c);
    if (program === 'cosign') return { code: o.verifyFails && args.at(-1)!.includes(o.verifyFails) ? 1 : 0, stdout: '', stderr: '' };
    const s = sub(c);
    if (o.fails?.includes(s)) return { code: 1, stdout: '', stderr: 'Error: token ghp_secret123 denied' };
    const profiled = args.includes('livetv') && args[args.indexOf('livetv') - 1] === '--profile';
    const tag = opts.env.FF_TAG ?? '';
    const namesLivetv = args.at(-1) === 'livetv' && args[0] === 'compose';
    if (o.noLivetvService && namesLivetv) return { code: 1, stdout: '', stderr: 'no such service: livetv' };
    switch (s) {
      case 'ps': {
        const rows: Array<Record<string, string>> = [...FF_SERVICES, 'updater', 'postgres'].map((x) => ({ Service: x, Name: `friendflix-${x}-1`, State: 'running', Health: x === 'web' || x === 'bootstrap' ? '' : 'healthy', Labels: 'com.docker.compose.oneoff=False' }));
        if (o.oneoff && profiled) rows.unshift({ Service: 'livetv', Name: 'friendflix-livetv-run-0a1b2c', State: 'running', Health: '', Labels: 'com.docker.compose.project=friendflix,com.docker.compose.oneoff=True' });
        if (w.livetv && profiled) rows.push({ Service: 'livetv', Name: 'friendflix-livetv-1', State: w.livetv.state, Health: w.livetv.health, Labels: 'com.docker.compose.oneoff=False' });
        return ok(rows.map((r) => JSON.stringify(r)).join('\n'));
      }
      case 'config': {
        // like compose: a service of an inactive profile is not rendered; backend and gateway join `livetv` (files from 1b on)
        const services: Record<string, { image: string; networks?: Record<string, object> }> = Object.fromEntries([...FF_SERVICES, 'updater'].map((x) => [x, { image: `${repoOf(x)}:${tag}` }]));
        for (const x of ['backend', 'gateway']) services[x]!.networks = o.noLivetvService ? { front: {} } : { front: {}, livetv: {} };
        services.postgres = { image: 'postgres:17-alpine' };
        if (profiled && !o.noLivetvService) {
          services.livetv = { image: o.livetvEvilImage ? `ghcr.io/evil/friendflix-livetv:${tag}` : `${LTV}:${tag}` };
          if (o.livetvDrift) Object.assign(services.livetv, { ports: [{ mode: 'ingress', host_ip: '0.0.0.0', target: 9100, published: '9100', protocol: 'udp' }] });
        }
        const networks: Record<string, object> = { default: { name: 'friendflix_default' }, front: { name: 'friendflix_front' } };
        if (!o.noLivetvService) Object.assign(networks, { livetv: { name: 'friendflix_livetv', internal: true }, 'livetv-egress': { name: 'friendflix_livetv-egress' } });
        return ok(JSON.stringify({ name: 'friendflix', networks, services }));
      }
      case 'pull --quiet': {
        const r = args.at(-1)!;
        // the first pull of a job: an update's (the backend) or an enable's (livetv)
        if (o.gate && /friendflix-(backend|livetv)@/.test(r)) await new Promise<void>((done) => { w.waiting = true; w.release = () => { w.waiting = false; done(); }; });
        if (o.pullFails || o.gone?.includes(r)) return { code: 1, stdout: '', stderr: 'manifest unknown' };
        local.add(r);
        return ok();
      }
      case 'image tag': {
        const [from, to] = [args[2]!, args[3]!];
        if (!local.has(from)) return { code: 1, stdout: '', stderr: 'No such image' };
        tags.set(to, from.slice(-1));
        return ok();
      }
      case 'up': {
        for (const x of args.slice(args.lastIndexOf('never') + 1)) {
          const c2 = tags.get(`${repoOf(x)}:${tag}`);
          if (!c2) return { code: 1, stdout: '', stderr: `No such image: ${repoOf(x)}:${tag}` };
          if (runs[x] !== c2 || (x === 'livetv' && !w.livetv)) { runs[x] = c2; containers[x] = cid(); }
        }
        if (namesLivetv) w.livetv = { state: 'running', health: o.healthAfterUp ?? 'healthy' };
        return ok();
      }
      case 'stop':
        o.onStop?.();
        if (w.livetv) w.livetv = { state: 'exited', health: '' };
        return ok();
      case 'rm':
        w.livetv = null;
        return ok();
      case 'container inspect': {
        const f = args[3]!, name = args.at(-1)!;
        if (f === '{{json .Config.Labels}}') return ok(JSON.stringify(o.labels ?? LABELS));
        if (f.includes('PortBindings')) {
          const peer = name === 'friendflix-backend-1' || name === 'friendflix-gateway-1';
          const nets = !peer ? { friendflix_default: {} } : o.noLivetvService || o.notAttached ? { friendflix_front: {} } : { friendflix_front: {}, friendflix_livetv: {} };
          return ok(`{}\t${JSON.stringify(nets)}\t${JSON.stringify(o.labels ?? LABELS)}`);
        }
        const svc = name.includes('-run-') ? null : serviceOf(name);
        const c2 = svc ? runs[svc] : null;
        const image = !svc ? OTHER_ID : c2 ? idOf(repoOf(svc), c2) : DEV_ID;
        if (f === '{{.Image}}') return ok(`${image}\n`);
        if (f === '{{.Id}}\t{{.Image}}') return ok(`${svc ? containers[svc] : '1'.repeat(64)}\t${image}\n`);
        if (f === '{{json .Config.Env}}') return ok('[]');
        return ok();
      }
      case 'image inspect': {
        const r = args.at(-1)!, f = args[3]!;
        if (f === '{{json .RepoTags}}') return r === ID && !w.idGone ? ok(JSON.stringify(w.imageTags)) : { code: 1, stdout: '', stderr: 'No such image' };
        if (r === DEV_ID || r === OTHER_ID) return ok('[]\t[]');
        const x = resolve(r);
        if (!x) return { code: 1, stdout: '', stderr: 'No such image' };
        return ok(`["${x.repo}@${dg(x.c)}"]\t${JSON.stringify(envOf(x.c))}`);
      }
      case 'image ls':
        // the CLI filters by repository; a look-alike repository and an untagged row are printed anyway to prove the re-check
        return ok([...w.imageTags, `${LTV}-extra:latest`, `${LTV}:<none>`].join('\n'));
      case 'image rm': {
        const refs = args.slice(2);
        if (refs.includes(o.inUse ?? '-')) return { code: 1, stdout: '', stderr: `Error response from daemon: conflict: unable to remove repository reference "${refs[0]}" (must force) - container 0a1b is using its referenced image` };
        if (refs.some((r) => !w.imageTags.includes(r) && r !== ID)) return { code: 1, stdout: '', stderr: `Error response from daemon: No such image: ${refs[0]}` };
        w.imageTags = w.imageTags.filter((t) => !refs.includes(t));
        if (!w.imageTags.length || refs.includes(ID)) w.idGone = true;
        return ok();
      }
      default:
        return ok();
    }
  };
  // the registry (a pull token, then the manifest digest of a tag) and the backend's /health (the image commit it runs, unless
  // that build never gets healthy)
  const health = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://ghcr.io/')) {
      fetches.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.startsWith('https://ghcr.io/token?')) return new Response(JSON.stringify({ token: 'registry-token-0123' }));
      const m = /^https:\/\/ghcr\.io\/v2\/letsmanu\/friendflix-([a-z]+)\/manifests\/([a-z0-9.-]+)$/.exec(url);
      if (!m || (m[1] === 'livetv' && o.livetvPullFails?.includes(m[2]!))) return new Response(null, { status: 404 });
      return new Response(null, { headers: { 'docker-content-digest': dg(regDigit(`${GH}-${m[1]}`, m[2]!)) } });
    }
    const c = runs.backend ?? null;
    return o.coreUnhealthy?.includes(c ?? '') ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ status: 'ok', version: (commitOf(c) ?? '').slice(0, 7) }));
  }) as unknown as typeof fetch;
  return { calls, fetches, w, run, health, idOf };
}

/** lets a gated pull through once a job has reached it */
async function release(m: { w: { waiting: boolean; release: () => void } }): Promise<void> {
  for (let i = 0; i < 200 && !m.w.waiting; i++) await new Promise((r) => setTimeout(r, 5));
  m.w.release();
}

function make(o: WorldOpts = {}, init: Partial<State> = {}) {
  const wd = world(o);
  let t = 1_760_800_000_000;
  let u: Updater | null = null;
  const docker = new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375', livetv: () => u?.livetv === 'enabled' }, wd.run);
  const store = memoryStore({ ...DEFAULT_STATE, ...init });
  u = new Updater(dockerOps(docker, 'http://backend:3000/health', wd.health), store, { healthTimeoutMs: 20_000, healthIntervalMs: 5_000, now: () => t, sleep: async (ms) => { t += ms; } });
  return { ...wd, docker, store, u, elapsed: () => t - 1_760_800_000_000 };
}
type Made = ReturnType<typeof make>;
const changing = (m: Made) => m.calls.filter((c) => c.program === 'cosign' || ['pull --quiet', 'image tag', 'up', 'stop', 'rm', 'image rm', 'volume rm', 'run'].includes(sub(c))).map(cmd);
const BASE = 'docker compose --project-directory /srv/friendflix -f /srv/friendflix/compose.prod.yaml --profile updater';
const P = `${BASE} --profile livetv --ansi never`;
const COSIGN = 'cosign verify --certificate-identity-regexp ^https://github\\.com/LetsManu/friendflix/\\.github/workflows/publish\\.yml@refs/(heads/main|tags/v[0-9]+\\.[0-9]+\\.[0-9]+)$ --certificate-oidc-issuer https://token.actions.githubusercontent.com';
const logged = (m: Made, line: string) => m.u.log.tail(200).some((l) => l.endsWith(line));
const CORE3 = ['backend', 'gateway', 'web'] as const;
/** the commands of an update that moves every core service to build b (pull, verify, tags, up) */
const corePulled = (c: string) => [...CORE3.map((x) => `docker pull --quiet ${ref(x, c)}`), ...CORE3.map((x) => `${COSIGN} ${ref(x, c)}`)];
const coreTagged = (c: string, tag = 'latest') => CORE3.map((x) => `docker image tag ${ref(x, c)} ${repoOf(x)}:${tag}`);

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
    expect(DEFAULT_STATE).toMatchObject({ livetv: 'absent', livetvError: null, livetvImage: null });
    expect(sanitize({ livetv: 'bogus' }).livetv).toBe('absent');
    expect(sanitize({}).livetv).toBe('absent');
    for (const v of ['enabled', 'disabled', 'absent'] as const) expect(sanitize({ livetv: v }).livetv).toBe(v);
    expect(sanitize({ livetvError: 'unhealthy', livetvImage: ID })).toMatchObject({ livetvError: 'unhealthy', livetvImage: ID });
    expect(sanitize({ livetvError: 'Bad; id', livetvImage: 'friendflix-backend:latest' })).toMatchObject({ livetvError: null, livetvImage: null });
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
    expect(r).toMatchObject({ ok: true, job: { action: 'livetv-enable', state: 'running', from: null } });
    expect(m.u.busy).toBe(true);
    await m.u.idle();
    // the digest the channel's tag names in the registry: pulled by digest, verified, the local tag moved, started
    expect(changing(m)).toEqual([
      `docker pull --quiet ${ref('livetv', 'b')}`,
      `${COSIGN} ${ref('livetv', 'b')}`,
      `docker image tag ${ref('livetv', 'b')} ${LTV}:latest`,
      `${P} up -d --no-deps --pull never livetv`,
    ]);
    expect(m.fetches.filter((f) => f.startsWith('HEAD'))).toEqual(['HEAD https://ghcr.io/v2/letsmanu/friendflix-livetv/manifests/latest']);
    // the image check ran on the rendered config with the profile (compose leaves livetv out without it)
    expect(m.calls.some((c) => sub(c) === 'config' && cmd(c).includes('--profile livetv'))).toBe(true);
    for (const c of m.calls.filter((x) => ['up', 'config'].includes(sub(x)))) expect(c.env.FF_TAG).toBe('latest');
    expect(m.store.state).toMatchObject({ livetv: 'enabled', livetvError: null, livetvImage: m.idOf(LTV, 'b') });
    expect(m.store.state.lastJob).toMatchObject({ action: 'livetv-enable', state: 'succeeded', error: null, step: null, to: 'latest',
      steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } });
    expect(logged(m, 'livetv-enable succeeded')).toBe(true);
  });

  it('livetv enable takes the channel tag\'s digest', async () => {
    const tagOf = async (o: WorldOpts, init: Partial<State>) => {
      const m = make(o, init);
      m.u.startLivetv({ op: 'enable' });
      await m.u.idle();
      return [m.calls.filter((c) => sub(c) === 'pull --quiet' || sub(c) === 'image tag').map((c) => c.args.slice(2).join(' ')), m.store.state.lastJob?.to];
    };
    // whatever the backend runs or was last installed as: the channel's tag, by its registry digest
    expect(await tagOf({ registry: { [`${LTV}:nightly`]: 'c' } }, { current: 'latest', channel: 'nightly' }))
      .toEqual([[ref('livetv', 'c'), `${ref('livetv', 'c')} ${LTV}:nightly`], 'nightly']);
    expect(await tagOf({ core: 'dev' }, { current: 'sha-bbbbbbb' })).toEqual([[ref('livetv', 'b'), `${ref('livetv', 'b')} ${LTV}:latest`], 'latest']);
    expect(await tagOf({}, { channel: 'pinned', version: '1.2.3', current: null })).toEqual([[ref('livetv', 'b'), `${ref('livetv', 'b')} ${LTV}:1.2.3`], '1.2.3']);
    // the registry does not answer: nothing pulled or started
    const m = make({ livetvPullFails: ['latest'] });
    m.u.startLivetv({ op: 'enable' });
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'failed', error: 'registry_failed', steps: { pull: 'failed', verify: 'skipped' } } });
    expect(changing(m)).toEqual([]);
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
    expect(m.store.state.lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy', steps: { restart: 'ok', health: 'failed', rollback: 'ok' } });
    expect(changing(m).slice(-2)).toEqual([`${P} stop livetv`, `${P} rm -f livetv`]);
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
    expect(e.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'unhealthy', steps: { rollback: 'skipped' } } });
    expect(e.calls.some((c) => sub(c) === 'stop' || sub(c) === 'rm')).toBe(false);
  });

  it('disable stops and removes the container', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled', livetvError: 'unhealthy' });
    const r = m.u.startLivetv({ op: 'disable' });
    expect(r).toMatchObject({ ok: true, job: { action: 'livetv-disable', steps: { pull: 'skipped', verify: 'skipped', health: 'skipped' } } });
    await m.u.idle();
    expect(changing(m)).toEqual([`${P} stop livetv`, `${P} rm -f livetv`]);
    expect(m.store.state).toMatchObject({ livetv: 'disabled', livetvError: null });
    expect(m.store.state.lastJob).toMatchObject({ action: 'livetv-disable', state: 'succeeded', steps: { pull: 'skipped', verify: 'skipped', restart: 'ok', health: 'skipped', rollback: 'skipped' } });
    expect(m.w.livetv).toBeNull();
    // a failing stop: state unchanged, a fixed code; a failing rm -f: remove_failed
    const f = make({ livetv: { state: 'running', health: 'healthy' }, fails: ['stop'] }, { livetv: 'enabled' });
    f.u.startLivetv({ op: 'disable' });
    await f.u.idle();
    expect(f.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'stop_failed', steps: { restart: 'failed' } } });
    expect(f.calls.some((c) => sub(c) === 'rm')).toBe(false);
    expect(JSON.stringify(f.store.state) + f.u.log.tail().join('\n')).not.toContain('ghp_secret');
    const g = make({ livetv: { state: 'running', health: 'healthy' }, fails: ['rm'] }, { livetv: 'enabled' });
    g.u.startLivetv({ op: 'disable' });
    await g.u.idle();
    expect(g.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'remove_failed' } });
  });

  it('disable without a livetv container is a no-op success (also on compose files from before livetv)', async () => {
    for (const o of [{}, { noLivetvService: true }]) {
      const m = make(o, { livetv: 'absent' });
      m.u.startLivetv({ op: 'disable' });
      await m.u.idle();
      expect(changing(m), JSON.stringify(o)).toEqual([]);
      expect(m.store.state).toMatchObject({ livetv: 'absent', lastJob: { action: 'livetv-disable', state: 'succeeded' } });
    }
    // enabled, but the container is gone: disabled
    const e = make({}, { livetv: 'enabled' });
    e.u.startLivetv({ op: 'disable' });
    await e.u.idle();
    expect(changing(e)).toEqual([]);
    expect(e.store.state.livetv).toBe('disabled');
    // Docker does not answer: not taken for "no container"
    const b = make({ fails: ['ps'] }, { livetv: 'enabled' });
    b.u.startLivetv({ op: 'disable' });
    await b.u.idle();
    expect(b.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'failed', error: 'compose_config' } });
  });

  it('remove with data deletes the image and the cache volume, never recordings', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    m.u.startLivetv({ op: 'remove', data: true });
    await m.u.idle();
    expect(changing(m)).toEqual([
      `${P} stop livetv`,
      `${P} rm -f livetv`,
      // every local tag of exactly the livetv repository (not the look-alike friendflix-livetv-extra, not <none>)
      `docker image rm ${LTV}:latest`,
      `docker image rm ${LTV}:sha-aaaaaaa`,
      'docker volume rm friendflix_livetv-cache',
    ]);
    for (const c of m.calls) expect(cmd(c)).not.toContain('recordings');
    expect(m.store.state).toMatchObject({ livetv: 'absent', livetvImage: null, lastJob: { action: 'livetv-remove', state: 'succeeded' } });

    // without data: the cache volume stays
    const k = make({ livetv: { state: 'exited', health: '' } }, { livetv: 'disabled' });
    k.u.startLivetv({ op: 'remove', data: false });
    await k.u.idle();
    expect(k.calls.some((c) => sub(c) === 'volume rm')).toBe(false);
    expect(k.calls.filter((c) => sub(c) === 'image rm').map(cmd)).toEqual([`docker image rm ${LTV}:latest`, `docker image rm ${LTV}:sha-aaaaaaa`]);
    expect(k.store.state.livetv).toBe('absent');

    // an image that also carries another repository's tag is never removed by id
    const s = make({ livetv: { state: 'running', health: 'healthy' }, imageTags: ['ghcr.io/letsmanu/friendflix-backend:latest', `${LTV}:sha-aaaaaaa`] }, { livetv: 'enabled' });
    s.u.startLivetv({ op: 'remove', data: false });
    await s.u.idle();
    expect(s.calls.filter((c) => sub(c) === 'image rm').map(cmd)).toEqual([`docker image rm ${LTV}:sha-aaaaaaa`]);
    expect(s.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'succeeded' } });

    // removal fails: the container is gone (disabled), the job says so
    const f = make({ livetv: { state: 'running', health: 'healthy' }, fails: ['volume rm'] }, { livetv: 'enabled' });
    f.u.startLivetv({ op: 'remove', data: true });
    await f.u.idle();
    expect(f.store.state).toMatchObject({ livetv: 'disabled', lastJob: { state: 'failed', error: 'remove_failed' } });
  });

  it('remove after a disable: every livetv tag and the image id recorded when it ran', async () => {
    const m = make({}, { livetv: 'disabled', livetvImage: ID });
    m.u.startLivetv({ op: 'remove', data: false });
    await m.u.idle();
    expect(changing(m)).toEqual([`docker image rm ${LTV}:latest`, `docker image rm ${LTV}:sha-aaaaaaa`]);
    expect(m.w.imageTags).toEqual([]);
    expect(m.store.state).toMatchObject({ livetv: 'absent', livetvImage: null, lastJob: { state: 'succeeded' } });
    // its tags moved on (a newer pull): the recorded image is dangling and removed by id
    const d = make({ imageTags: [] }, { livetv: 'disabled', livetvImage: ID });
    d.u.startLivetv({ op: 'remove', data: false });
    await d.u.idle();
    expect(changing(d)).toEqual([`docker image rm ${ID}`]);
    // on compose files from before livetv, remove on an absent livetv just finds nothing to delete
    const a = make({ noLivetvService: true, imageTags: [] }, { livetv: 'absent' });
    a.u.startLivetv({ op: 'remove', data: true });
    await a.u.idle();
    expect(a.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'succeeded' } });
  });

  it('updates include livetv only while enabled, pulled, verified and started on its own', async () => {
    const on = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    on.u.start('update');
    await on.u.idle();
    expect(on.store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded', error: null,
      services: { backend: 'updated', gateway: 'updated', web: 'updated', livetv: 'updated' } });
    expect(changing(on)).toEqual([
      ...corePulled('b'),
      // livetv after the core services are verified, on its own (its failure never fails the core pull)
      `docker pull --quiet ${ref('livetv', 'b')}`,
      `${COSIGN} ${ref('livetv', 'b')}`,
      ...coreTagged('b'),
      `${P} up -d --no-deps --pull never bootstrap backend gateway web`,
      `docker image tag ${ref('livetv', 'b')} ${LTV}:latest`,
      `${P} up -d --no-deps --pull never livetv`,
    ]);
    // every compose command adds the profile while enabled
    for (const c of on.calls.filter((x) => x.args[0] === 'compose')) expect(cmd(c), cmd(c)).toContain('--profile updater --profile livetv');
    expect(on.store.state).toMatchObject({ livetv: 'enabled', livetvImage: on.idOf(LTV, 'b'), previousDigests: { ...Object.fromEntries(CORE3.map((x) => [x, ref(x, 'a')])), livetv: ref('livetv', 'a') } });

    const off = make({}, { livetv: 'disabled' });
    off.u.start('update');
    await off.u.idle();
    expect(off.store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded' });
    expect(changing(off).filter((c) => c.includes('livetv'))).toEqual([]);
    expect(changing(off)).toContain(`${BASE} --ansi never up -d --no-deps --pull never bootstrap backend gateway web`);
    expect(off.calls.filter((c) => sub(c) === 'config').every((c) => !cmd(c).includes('livetv'))).toBe(true);
  });

  it('livetv enabled: compared like the others; its verify failure drops livetv, the core update goes on', async () => {
    // livetv's digest at the channel tag is the one it runs: no pull, no cosign; its tag is set, `up` leaves the container
    const same = make({ livetv: { state: 'running', health: 'healthy' }, registry: { [`${LTV}:latest`]: 'a' } }, { livetv: 'enabled' });
    const before = same.w.containers.livetv;
    same.u.start('update');
    await same.u.idle();
    expect(changing(same)).toEqual([...corePulled('b'), ...coreTagged('b'), `${P} up -d --no-deps --pull never bootstrap backend gateway web`,
      `docker image tag ${ref('livetv', 'a')} ${LTV}:latest`, `${P} up -d --no-deps --pull never livetv`]);
    expect(same.w.containers.livetv).toBe(before);
    expect(same.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'succeeded', services: { backend: 'updated', livetv: 'unchanged' } } });
    // only livetv changed: it alone is pulled, verified and recreated; the core services keep their containers
    const lt = make({ core: 'b', livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    const core = { ...lt.w.containers };
    lt.u.start('update');
    await lt.u.idle();
    expect(changing(lt)).toEqual([`docker pull --quiet ${ref('livetv', 'b')}`, `${COSIGN} ${ref('livetv', 'b')}`, ...coreTagged('b'),
      `${P} up -d --no-deps --pull never bootstrap backend gateway web`, `docker image tag ${ref('livetv', 'b')} ${LTV}:latest`, `${P} up -d --no-deps --pull never livetv`]);
    expect(lt.w.containers).toMatchObject({ backend: core.backend, gateway: core.gateway, web: core.web });
    expect(lt.store.state.lastJob).toMatchObject({ state: 'succeeded', steps: { verify: 'ok', restart: 'ok', health: 'ok' },
      services: { backend: 'unchanged', gateway: 'unchanged', web: 'unchanged', livetv: 'updated' } });
    // its verify failure: livetv is never tagged or started, it is dropped once the core is up; the core update goes on
    const v = make({ livetv: { state: 'running', health: 'healthy' }, verifyFails: 'friendflix-livetv' }, { livetv: 'enabled' });
    v.u.start('update');
    await v.u.idle();
    expect(changing(v)).toEqual([...corePulled('b'), `docker pull --quiet ${ref('livetv', 'b')}`, `${COSIGN} ${ref('livetv', 'b')}`, ...coreTagged('b'),
      `${P} up -d --no-deps --pull never bootstrap backend gateway web`, `${P} stop livetv`, `${P} rm -f livetv`]);
    expect(v.store.state).toMatchObject({ current: 'latest', livetv: 'disabled', livetvError: 'verify_failed', lastJob: { state: 'succeeded', services: { backend: 'updated' } } });
    expect(v.store.state.lastJob?.services).not.toHaveProperty('livetv');
    // nothing changed but livetv's image cannot be had at the tag: dropped all the same, nothing else moves
    const n = make({ core: 'b', livetv: { state: 'running', health: 'healthy' }, livetvPullFails: ['latest'] }, { livetv: 'enabled' });
    n.u.start('update');
    await n.u.idle();
    expect(changing(n)).toEqual([`${P} stop livetv`, `${P} rm -f livetv`]);
    expect(n.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'pull_failed', lastJob: { state: 'succeeded', steps: { restart: 'skipped' } } });
  });

  it('an update with an unhealthy livetv completes for the core services and disables livetv', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' }, healthAfterUp: 'unhealthy' }, { livetv: 'enabled' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ current: 'latest', previous: null, livetv: 'disabled', livetvError: 'unhealthy',
      lastJob: { action: 'update', state: 'succeeded', error: null, steps: { restart: 'ok', health: 'ok', rollback: 'skipped' } } });
    expect(changing(m).slice(-2)).toEqual([`${P} stop livetv`, `${P} rm -f livetv`]);
    expect(m.elapsed()).toBe(120_000); // the core was healthy at once; livetv got its 2 min
    expect(logged(m, 'livetv disabled: unhealthy at latest')).toBe(true);
    // a livetv image the new build does not have: livetv is dropped before anything restarts, the core is updated
    const n = make({ livetv: { state: 'running', health: 'healthy' }, livetvPullFails: ['latest'] }, { livetv: 'enabled' });
    n.u.start('update');
    await n.u.idle();
    expect(n.store.state).toMatchObject({ current: 'latest', livetv: 'disabled', livetvError: 'pull_failed', lastJob: { state: 'succeeded' } });
    expect(changing(n).some((c) => c.includes('friendflix-livetv@') || c.endsWith('up -d --no-deps --pull never livetv'))).toBe(false);
    // a livetv signature failure: never started, dropped
    const v = make({ livetv: { state: 'running', health: 'healthy' }, verifyFails: 'friendflix-livetv' }, { livetv: 'enabled' });
    v.u.start('update');
    await v.u.idle();
    expect(v.store.state).toMatchObject({ current: 'latest', livetv: 'disabled', livetvError: 'verify_failed', lastJob: { state: 'succeeded' } });
    expect(changing(v).some((c) => c.endsWith('up -d --no-deps --pull never livetv'))).toBe(false);
  });

  it('an explicit rollback to a build without a livetv image rolls the core back and disables livetv', async () => {
    const m = make({ core: 'b', livetvRuns: 'b', livetv: { state: 'running', health: 'healthy' }, livetvPullFails: ['sha-aaaaaaa'] }, { livetv: 'enabled', previous: 'sha-aaaaaaa', current: 'latest' });
    expect(m.u.start('rollback').ok).toBe(true);
    await m.u.idle();
    expect(m.store.state).toMatchObject({ current: 'sha-aaaaaaa', livetv: 'disabled', livetvError: 'pull_failed',
      lastJob: { action: 'rollback', state: 'succeeded', from: 'sha-bbbbbbb', to: 'sha-aaaaaaa' } });
    const ch = changing(m);
    expect(ch).toContain(`${P} up -d --no-deps --pull never bootstrap backend gateway web`);
    expect(ch.some((c) => c.endsWith('up -d --no-deps --pull never livetv'))).toBe(false);
    expect(ch.some((c) => c.includes('friendflix-livetv@'))).toBe(false); // no pull, no cosign for livetv: the registry has none
    // dropped only once the core services were recreated
    const coreUp = ch.indexOf(`${P} up -d --no-deps --pull never bootstrap backend gateway web`);
    expect(ch.slice(coreUp + 1, coreUp + 3)).toEqual([`${P} stop livetv`, `${P} rm -f livetv`]);
    expect(logged(m, 'livetv disabled: pull_failed at sha-aaaaaaa')).toBe(true);
    // an explicit rollback with a livetv image: livetv goes back too
    const k = make({ core: 'b', livetvRuns: 'b', livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled', previous: 'sha-aaaaaaa', current: 'latest' });
    k.u.start('rollback');
    await k.u.idle();
    expect(k.store.state).toMatchObject({ current: 'sha-aaaaaaa', livetv: 'enabled', lastJob: { state: 'succeeded' } });
    expect(changing(k)).toContain(`docker image tag ${ref('livetv', 'a')} ${LTV}:sha-aaaaaaa`);
    expect(changing(k)).toContain(`${P} up -d --no-deps --pull never livetv`);
    expect(k.w.runs.livetv).toBe('a');
    expect(k.calls.filter((c) => sub(c) === 'up').map((c) => c.env.FF_TAG)).toEqual(['sha-aaaaaaa', 'sha-aaaaaaa']);
  });

  it('the automatic rollback: livetv goes back to its previous digest with the core; pruned and gone, or unhealthy there, it is disabled', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' }, coreUnhealthy: ['b'] }, { livetv: 'enabled' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ current: 'latest', livetv: 'enabled', livetvError: null,
      lastJob: { action: 'update', state: 'rolled_back', error: 'unhealthy', steps: { health: 'failed', rollback: 'ok' } } });
    const ch = changing(m);
    const back = ch.slice(ch.indexOf(`${P} up -d --no-deps --pull never livetv`) + 1);
    // nothing to pull (both builds are on the host): the tags go back, compose recreates what moved
    expect(back).toEqual([...coreTagged('a'), `${P} up -d --no-deps --pull never bootstrap backend gateway web`,
      `docker image tag ${ref('livetv', 'a')} ${LTV}:latest`, `${P} up -d --no-deps --pull never livetv`]);
    expect(m.w.runs).toMatchObject({ backend: 'a', gateway: 'a', web: 'a', livetv: 'a' });

    // livetv's previous image was pruned and the registry no longer has it: the core rolls back, livetv is disabled
    const p = make({ livetv: { state: 'running', health: 'healthy' }, coreUnhealthy: ['b'], pruned: [ref('livetv', 'a')], gone: [ref('livetv', 'a')] }, { livetv: 'enabled' });
    p.u.start('update');
    await p.u.idle();
    expect(p.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'pull_failed', lastJob: { state: 'rolled_back', error: 'unhealthy' } });
    expect(p.w.runs).toMatchObject({ backend: 'a', gateway: 'a', web: 'a' });

    const u = make({ livetv: { state: 'running', health: 'healthy' }, coreUnhealthy: ['b'], healthAfterUp: 'unhealthy' }, { livetv: 'enabled' });
    u.u.start('update');
    await u.u.idle();
    expect(u.store.state).toMatchObject({ current: 'latest', livetv: 'disabled', livetvError: 'unhealthy', lastJob: { state: 'rolled_back', error: 'unhealthy' } });
  });

  it('a running livetv the state does not know is adopted as enabled before a job; enabled without a container is reported', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'absent' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'enabled', livetvImage: m.idOf(LTV, 'b'), lastJob: { state: 'succeeded' } });
    expect(changing(m)).toContain(`${P} up -d --no-deps --pull never livetv`);
    expect(logged(m, 'livetv runs without being enabled: state set to enabled')).toBe(true);
    // an exited one is not adopted
    const x = make({ livetv: { state: 'exited', health: '' } }, { livetv: 'disabled' });
    x.u.start('update');
    await x.u.idle();
    expect(x.store.state.livetv).toBe('disabled');
    // enabled without a container: left as it is, logged
    const e = make({}, { livetv: 'enabled' });
    e.u.start('self-update');
    await e.u.idle();
    expect(e.store.state.livetv).toBe('enabled');
    expect(logged(e, 'livetv is enabled but has no container')).toBe(true);
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
    // a livetv action can never run as an update (refused by the type and at run time)
    // @ts-expect-error start() takes update / rollback / self-update only
    expect(() => m.u.start('livetv-enable')).toThrow('invalid action');
    // a channel without a target (an impossible state file aside): nothing starts
    const n = make({}, { channel: 'pinned', version: null });
    expect(n.u.startLivetv({ op: 'enable' })).toEqual({ ok: false, error: 'no_target' });
  });

  it('a livetv job interrupted by a restart is marked failed; the state stays', () => {
    const job = { id: '0123456789abcdef', action: 'livetv-enable' as const, state: 'running' as const, step: 'health' as const, from: null, to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'ok' as const, verify: 'ok' as const, restart: 'ok' as const, health: 'running' as const, rollback: 'skipped' as const }, services: null, media: null };
    const s = memoryStore({ ...DEFAULT_STATE, livetv: 'disabled', lastJob: job });
    const w = world();
    new Updater(dockerOps(new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, w.run), 'http://b/health', w.health), s);
    expect(s.state).toMatchObject({ livetv: 'disabled', lastJob: { state: 'failed', error: 'interrupted' } });
  });
});

describe('livetv docker commands', () => {
  it('only livetv can be stopped or removed; only livetv images and the livetv cache volume can be deleted', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' } });
    await expect(m.docker.stop(['backend'])).rejects.toThrow('invalid service');
    await expect(m.docker.rm(['livetv', 'postgres'])).rejects.toThrow('invalid service');
    for (const bad of ['ghcr.io/letsmanu/friendflix-backend:latest', 'ghcr.io/evil/friendflix-livetv:latest', `${LTV}-extra:latest`, `${LTV}:latest;id`, 'postgres:17-alpine', ref('livetv', 'c'), 'sha256:abc']) {
      await expect(m.docker.imageRm(bad), bad).rejects.toThrow('invalid image');
    }
    for (const bad of ['friendflix_recordings', 'friendflix_postgres', 'livetv-cache', '_livetv-cache', 'x/../y_livetv-cache', 'Friendflix_livetv-cache']) {
      await expect(m.docker.volumeRm(bad), bad).rejects.toThrow('invalid volume');
    }
    expect(m.calls.filter((c) => ['stop', 'rm', 'image rm', 'volume rm'].includes(sub(c)))).toEqual([]);
    // a volume or image that is not there is fine; anything else is a fixed code
    await make().docker.imageRm(`${LTV}:nightly`);
    const f = make({ fails: ['image rm', 'volume rm', 'image ls'] });
    await expect(f.docker.imageRm(`${LTV}:latest`)).rejects.toEqual(new StepError('remove_failed'));
    await expect(f.docker.volumeRm('friendflix_livetv-cache')).rejects.toEqual(new StepError('remove_failed'));
    await expect(f.docker.livetvTags()).rejects.toEqual(new StepError('remove_failed'));
    expect(await make().docker.livetvTags()).toEqual([`${LTV}:latest`, `${LTV}:sha-aaaaaaa`]);
  });

  it('the cache volume is named after the stack\'s compose project', async () => {
    expect(await make().docker.cacheVolume()).toBe('friendflix_livetv-cache');
    expect(await make({ labels: { ...LABELS, 'com.docker.compose.project': 'ff2' } }).docker.cacheVolume()).toBe('ff2_livetv-cache');
    expect(await make({ labels: { ...LABELS, 'com.docker.compose.project': 'Bad Name' } }).docker.cacheVolume()).toBeNull();
    expect(await make({ labels: { ...LABELS, 'com.docker.compose.project': undefined } }).docker.cacheVolume()).toBeNull();
  });

  it('ps lists livetv (with its profile) and nothing outside FriendFlix; one-off containers are not the service', async () => {
    const m = make({ livetv: { state: 'exited', health: '' }, oneoff: true });
    const ps = await m.docker.ps();
    expect(ps.map((p) => p.service)).toEqual(['bootstrap', 'backend', 'gateway', 'web', 'updater', 'livetv']);
    expect(await m.docker.livetvContainer()).toEqual({ service: 'livetv', name: 'friendflix-livetv-1', state: 'exited', health: '', image: ID });
    expect(await make({ oneoff: true }).docker.livetvContainer()).toBeNull();
    await expect(make({ fails: ['ps'] }).docker.livetvContainer()).rejects.toEqual(new StepError('compose_config'));
    // compose versions that print Labels as a map
    const mapped: Runner = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ Service: 'livetv', Name: 'x', State: 'running', Labels: { 'com.docker.compose.oneoff': 'True' } }) });
    expect(await new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, mapped).livetvContainer()).toBeNull();
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
    expect((await call('POST', '/v1/channel', '{"channel":"nightly"}')).status).toBe(409);
    await release(m);
    await m.u.idle();
    const removed = await call('POST', '/v1/livetv', '{"op":"remove","data":true}');
    expect(removed.status).toBe(202);
    await m.u.idle();
    expect(m.store.state.livetv).toBe('absent');
    m = make({}, { channel: 'pinned', version: null });
    expect(await (await call('POST', '/v1/livetv', '{"op":"enable"}')).json()).toEqual({ error: 'no_target' });
    // the channel route still works on its own
    expect(await (await call('POST', '/v1/channel', '{"channel":"nightly"}')).json()).toEqual({ channel: 'nightly', version: null, targetTag: 'nightly' });
    expect((await call('POST', '/v1/channel', '{"channel":"nightly"}', 'text/plain')).status).toBe(415);
  });

  it('status reports livetv', async () => {
    m = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'enabled' });
    const b = await (await call('GET', '/v1/status')).json();
    expect(b.livetv).toEqual({ state: 'enabled', container: 'running', error: null });
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
    // without a probe (older wiring): the state alone; a livetv a job disabled says why
    const d = make({}, { livetv: 'disabled', livetvError: 'unhealthy' });
    const s = await status({ updater: d.u, verifier: { key, cache: new ReplayCache(), notBefore: 0 }, services: async () => [], self: { version: null, sha: null } });
    expect(s.livetv).toEqual({ state: 'disabled', container: null, error: 'unhealthy' });
  });
});

describe('livetv in the docs', () => {
  const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  it('the docs count seven updater routes and name every route', () => {
    const sec = read('docs/security.md');
    for (const r of ['/v1/status', '/v1/channel', '/v1/update', '/v1/rollback', '/v1/self-update', '/v1/livetv', '/v1/mediaserver']) expect(sec).toContain(r);
    for (const f of ['docs/security.md', 'docs/setup.md']) {
      expect(read(f), f).toMatch(/\bseven\b (fixed|signed)/i);
      expect(read(f), f).not.toMatch(/\b(five|six)\b (fixed|signed)/i);
    }
    expect(read('docs/de/setup.md')).toMatch(/\bsieben\b/);
    expect(read('docs/de/setup.md')).not.toMatch(/\b(fünf|sechs)\b/);
  });
});

describe('livetv inside updates: re-review', () => {
  it('a livetv image that does not resolve as expected keeps its real code and logs the detail', async () => {
    const d = make({ livetv: { state: 'running', health: 'healthy' }, livetvDrift: true }, { livetv: 'enabled' });
    d.u.start('update');
    await d.u.idle();
    expect(d.store.state).toMatchObject({ current: 'latest', livetv: 'disabled', livetvError: 'config_mismatch', lastJob: { state: 'succeeded' } });
    expect(logged(d, 'livetv: config_mismatch (livetv ports)')).toBe(true);
    expect(changing(d).some((c) => c.includes('friendflix-livetv@') || c.endsWith('never livetv'))).toBe(false);
    const e = make({ livetv: { state: 'running', health: 'healthy' }, livetvEvilImage: true }, { livetv: 'enabled' });
    e.u.start('update');
    await e.u.idle();
    expect(e.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'unexpected_image', lastJob: { state: 'succeeded' } });
    expect(logged(e, 'livetv: unexpected_image')).toBe(true);
    const p = make({ livetv: { state: 'running', health: 'healthy' }, livetvPullFails: ['latest'] }, { livetv: 'enabled' });
    p.u.start('update');
    await p.u.idle();
    expect(logged(p, 'livetv: pull_failed (registry_failed)')).toBe(true);
  });

  it('livetv is dropped only after the core services were recreated; a core failure that restarts nothing leaves it alone', async () => {
    // a dev build (no previous build to roll back to) whose core recreate fails: livetv keeps running, enabled, no reason set
    const m = make({ core: 'dev', livetv: { state: 'running', health: 'healthy' }, livetvPullFails: ['latest'], fails: ['up'] }, { livetv: 'enabled' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'enabled', livetvError: null, lastJob: { state: 'failed', error: 'restart_failed' } });
    expect(m.calls.some((c) => sub(c) === 'stop' || sub(c) === 'rm')).toBe(false);
    expect(m.w.livetv).toEqual({ state: 'running', health: 'healthy' });
    // a transient registry error on livetv's pull still disables it once the core is up (ruling M5)
    const n = make({ livetv: { state: 'running', health: 'healthy' }, livetvPullFails: ['latest'] }, { livetv: 'enabled' });
    n.u.start('update');
    await n.u.idle();
    const ch = changing(n);
    expect(ch.indexOf(`${P} up -d --no-deps --pull never bootstrap backend gateway web`)).toBeLessThan(ch.indexOf(`${P} stop livetv`));
    expect(n.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'pull_failed', lastJob: { state: 'succeeded' } });
  });

  it('a livetv that cannot be stopped is stop_failed: the next job stops it again instead of adopting it, the reason stays', async () => {
    const fails = ['stop'];
    const m = make({ livetv: { state: 'running', health: 'healthy' }, healthAfterUp: 'unhealthy', fails }, { livetv: 'enabled' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'stop_failed', livetvError: 'unhealthy', lastJob: { state: 'succeeded' } });
    expect(logged(m, 'livetv could not be stopped')).toBe(true);
    // still not stoppable: stays stop_failed, never adopted, never part of the update
    m.calls.length = 0;
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'stop_failed', livetvError: 'unhealthy' });
    expect(changing(m).some((c) => c.includes('friendflix-livetv@') || c.endsWith('never livetv'))).toBe(false);
    // the stop works again: the next job stops and removes it first; the reason is kept for the admin
    fails.length = 0;
    m.calls.length = 0;
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'unhealthy', lastJob: { state: 'succeeded' } });
    expect(changing(m).slice(0, 2)).toEqual([`${P} stop livetv`, `${P} rm -f livetv`]);
    expect(m.w.livetv).toBeNull();
    // the status shows it
    const s = await status({ updater: make({}, { livetv: 'stop_failed', livetvError: 'unhealthy' }).u, verifier: { key: deriveKey('x'.repeat(20)), cache: new ReplayCache(), notBefore: 0 }, services: async () => [], self: { version: null, sha: null } });
    expect(s.livetv).toEqual({ state: 'stop_failed', container: null, error: 'unhealthy' });
    expect(sanitize({ livetv: 'stop_failed' }).livetv).toBe('stop_failed');
  });

  it('removal reports a tag in use as remove_failed, even when another one was simply gone', async () => {
    const m = make({ livetv: { state: 'running', health: 'healthy' }, inUse: `${LTV}:sha-aaaaaaa` }, { livetv: 'enabled' });
    m.u.startLivetv({ op: 'remove', data: false });
    await m.u.idle();
    expect(m.calls.filter((c) => sub(c) === 'image rm').map(cmd)).toEqual([`docker image rm ${LTV}:latest`, `docker image rm ${LTV}:sha-aaaaaaa`]);
    expect(m.w.imageTags).toEqual([`${LTV}:sha-aaaaaaa`]);
    expect(m.store.state).toMatchObject({ livetv: 'disabled', lastJob: { state: 'failed', error: 'remove_failed' } });
    // a tag that is gone and one in use, one call each: the gone one is fine, the one in use fails the removal
    const d = make({ imageTags: [`${LTV}:sha-aaaaaaa`], inUse: `${LTV}:sha-aaaaaaa` });
    await expect(d.docker.imageRm(`${LTV}:latest`)).resolves.toBeUndefined();
    await expect(d.docker.removeLivetvImages([])).rejects.toEqual(new StepError('remove_failed'));
  });

  it('a foreign stack is refused before the livetv state is reconciled', async () => {
    for (const run of [(u: Updater) => u.start('update'), (u: Updater) => u.start('self-update'), (u: Updater) => u.startLivetv({ op: 'enable' }), (u: Updater) => u.startLivetv({ op: 'disable' })]) {
      const m = make({ labels: PORTAINER, livetv: { state: 'running', health: 'healthy' } }, { livetv: 'absent' });
      run(m.u);
      await m.u.idle();
      expect(m.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'failed', error: 'foreign_stack' } });
      expect(logged(m, 'livetv runs without being enabled: state set to enabled')).toBe(false);
    }
  });
});

describe('enable on an install from before Live TV (1b review I3)', () => {
  it('compose files without the livetv service: compose_outdated before anything is pulled or started (never unexpected_image)', async () => {
    const m = make({ noLivetvService: true }, { livetv: 'absent' });
    m.u.startLivetv({ op: 'enable' });
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'absent', lastJob: { action: 'livetv-enable', state: 'failed', error: 'compose_outdated',
      steps: { pull: 'failed', verify: 'skipped', restart: 'skipped', health: 'skipped' } } });
    expect(changing(m)).toEqual([]);
    expect(logged(m, 'step pull: compose_outdated (livetv no_service)')).toBe(true);
  });

  it('new compose files, but backend and gateway not recreated yet: network_missing, nothing pulled or started', async () => {
    const m = make({ notAttached: true }, { livetv: 'absent' });
    m.u.startLivetv({ op: 'enable' });
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetv: 'absent', lastJob: { state: 'failed', error: 'network_missing', steps: { pull: 'failed', restart: 'skipped' } } });
    expect(changing(m)).toEqual([]);
    expect(logged(m, 'step pull: network_missing (backend not_attached)')).toBe(true);
    // after `docker compose up -d` (attached): the same enable goes through
    const ok = make({}, { livetv: 'absent' });
    ok.u.startLivetv({ op: 'enable' });
    await ok.u.idle();
    expect(ok.store.state).toMatchObject({ livetv: 'enabled', lastJob: { state: 'succeeded' } });
  });

  it('an update on refreshed compose files is not refused for the new livetv network alone: the recreate attaches backend and gateway', async () => {
    const m = make({ notAttached: true }, { livetv: 'absent' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state.lastJob).toMatchObject({ action: 'update', state: 'succeeded', error: null });
    expect(changing(m)).toContain(`${BASE} --ansi never up -d --no-deps --pull never bootstrap backend gateway web`);
  });

  it('the drift guard still refuses leaving a network or joining any other than livetv', async () => {
    const { configDrift } = await import('../src/stack.js');
    const cfg = (nets: string[]) => ({ name: 'friendflix', networks: { livetv: { name: 'friendflix_livetv' }, front: { name: 'friendflix_front' }, media: { name: 'friendflix_media' } },
      services: { backend: { networks: Object.fromEntries(nets.map((n) => [n, {}])) } } });
    const running = (nets: string[]) => ({ ports: {}, networks: Object.fromEntries(nets.map((n) => [`friendflix_${n}`, {}])), project: 'friendflix' });
    expect(configDrift(cfg(['front', 'livetv']), 'backend', running(['front']), ['livetv'])).toBeNull();
    expect(configDrift(cfg(['front', 'livetv']), 'backend', running(['front']))).toBe('networks'); // only where allowed
    expect(configDrift(cfg(['front', 'livetv', 'media']), 'backend', running(['front']), ['livetv'])).toBe('networks');
    expect(configDrift(cfg(['livetv']), 'backend', running(['front']), ['livetv'])).toBe('networks');
    expect(configDrift(cfg(['front', 'livetv']), 'backend', running(['front', 'livetv']), ['livetv'])).toBeNull();
  });

  it('an update with livetv enabled on compose files that lost the service drops livetv as compose_outdated', async () => {
    const m = make({ noLivetvService: true }, { livetv: 'enabled' });
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state).toMatchObject({ livetvError: 'compose_outdated', lastJob: { action: 'update', state: 'succeeded' } });
  });
});

describe('dropLivetv persists first (1b review M13)', () => {
  it('the reason and stop_failed are stored before the stop runs, so a crash during it neither loses the reason nor re-enables livetv', async () => {
    const seen: Array<Partial<State>> = [];
    let m: Made | null = null;
    m = make({ livetv: { state: 'running', health: 'healthy' }, healthAfterUp: 'unhealthy', onStop: () => { if (m) seen.push({ livetv: m.store.state.livetv, livetvError: m.store.state.livetvError }); } }, { livetv: 'enabled' });
    m.u.start('update');
    await m.u.idle();
    expect(seen[0]).toEqual({ livetv: 'stop_failed', livetvError: 'unhealthy' });
    expect(m.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'unhealthy', lastJob: { action: 'update', state: 'succeeded' } });
    // what a restarted updater would find had it died during the stop: the next job stops livetv again, never adopts it
    const after = make({ livetv: { state: 'running', health: 'healthy' } }, { livetv: 'stop_failed', livetvError: 'unhealthy' });
    after.u.start('update');
    await after.u.idle();
    expect(after.store.state).toMatchObject({ livetv: 'disabled', livetvError: 'unhealthy' });
    expect(changing(after)).toContain(`${P} stop livetv`);
  });
});

describe('updates by digest on the real command lines', () => {
  it('backend changed: health waits for the new backend commit7 (FF_IMAGE_COMMIT; GIT_SHA for an old image)', async () => {
    // build b carries FF_IMAGE_COMMIT=B (and GIT_SHA of another commit): /health must answer B's commit7
    const m = make();
    m.u.start('update');
    await m.u.idle();
    expect(m.store.state.lastJob).toMatchObject({ state: 'succeeded', services: { backend: 'updated', gateway: 'updated', web: 'updated' } });
    expect(m.w.runs.backend).toBe('b');
    // a backend answering with the GIT_SHA of build b is not the new build: rolled back to build a, which only has GIT_SHA
    const g = make();
    const health = g.health;
    const docker = new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, g.run);
    const answers: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://ghcr.io/')) return health(input, init);
      const v = g.w.runs.backend === 'b' ? RUN_B.slice(0, 7) : A.slice(0, 7);
      answers.push(v);
      return new Response(JSON.stringify({ status: 'ok', version: v }));
    }) as unknown as typeof fetch;
    let t = 0;
    const u = new Updater(dockerOps(docker, 'http://backend:3000/health', fetchImpl), memoryStore(DEFAULT_STATE), { healthTimeoutMs: 20_000, healthIntervalMs: 5_000, now: () => t, sleep: async (ms) => { t += ms; } });
    u.start('update');
    await u.idle();
    expect(u.snapshot().lastJob).toMatchObject({ state: 'rolled_back', error: 'unhealthy', steps: { rollback: 'ok' } });
    expect(answers.at(-1)).toBe('aaaaaaa');
    expect(g.w.runs).toMatchObject({ backend: 'a', gateway: 'a', web: 'a' });
  });

  it('only the changed service is pulled, verified, re-tagged and recreated; the registry token never reaches a log or the state', async () => {
    const m = make({ registry: { [`${GH}-backend:latest`]: 'a', [`${GH}-gateway:latest`]: 'a' } });
    const before = { ...m.w.containers };
    m.u.start('update');
    await m.u.idle();
    expect(changing(m)).toEqual([`docker pull --quiet ${ref('web', 'b')}`, `${COSIGN} ${ref('web', 'b')}`,
      `docker image tag ${ref('backend', 'a')} ${GH}-backend:latest`, `docker image tag ${ref('gateway', 'a')} ${GH}-gateway:latest`, `docker image tag ${ref('web', 'b')} ${GH}-web:latest`,
      `${BASE} --ansi never up -d --no-deps --pull never bootstrap backend gateway web`]);
    expect(m.w.containers).toMatchObject({ backend: before.backend, gateway: before.gateway });
    expect(m.w.containers.web).not.toBe(before.web);
    expect(m.store.state.lastJob).toMatchObject({ state: 'succeeded', services: { backend: 'unchanged', gateway: 'unchanged', web: 'updated' } });
    // anonymous pull token + manifest HEAD per image, nothing else
    expect(m.fetches).toEqual(['backend', 'gateway', 'web'].flatMap((x) => [`GET https://ghcr.io/token?scope=repository:letsmanu/friendflix-${x}:pull&service=ghcr.io`,
      `HEAD https://ghcr.io/v2/letsmanu/friendflix-${x}/manifests/latest`]));
    expect(JSON.stringify(m.store.state) + m.u.log.tail(200).join('\n')).not.toContain('registry-token');
    // a registry that does not answer: registry_failed before any pull
    const down = make({ registry: {} });
    down.health = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const docker = new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, down.run);
    const u = new Updater(dockerOps(docker, 'http://backend:3000/health', down.health), memoryStore(DEFAULT_STATE), { sleep: async () => {} });
    u.start('update');
    await u.idle();
    expect(u.snapshot().lastJob).toMatchObject({ state: 'failed', error: 'registry_failed', steps: { pull: 'failed' } });
    expect(changing({ ...down, docker, store: memoryStore(), u, elapsed: () => 0 })).toEqual([]);
  });
});
