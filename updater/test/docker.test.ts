// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Docker, StepError, type Program, type RunResult, type Runner } from '../src/docker.js';

type Call = { program: Program; args: string[]; env: Record<string, string> };
const D = 'sha256:' + 'c'.repeat(64);
const ID = 'sha256:' + 'e'.repeat(64);

const LABELS = { 'com.docker.compose.project': 'friendflix', 'com.docker.compose.project.working_dir': '/srv/friendflix',
  'com.docker.compose.project.config_files': '/srv/friendflix/compose.prod.yaml,/srv/friendflix/compose.secrets.yaml' };
const ALL = ['bootstrap', 'backend', 'gateway', 'web', 'updater'];
/** which container inspect a call is (the --format argument) */
const fmt = (c: Call) => (c.args[0] === 'container' && c.args[1] === 'inspect' ? c.args[3]! : '');
const svcOf = (c: Call) => c.args.at(-1)!.replace(/^friendflix-|-1$/g, '');

/**
 * The stack as it runs: every service's container from the updater's project directory, on <project>_default, no published
 * ports; `o` changes the labels, ports and networks of the running containers.
 */
function running(c: Call, o: { labels?: unknown; ports?: Record<string, unknown>; networks?: Record<string, unknown>; services?: string[] } = {}): Partial<RunResult> | undefined {
  if (c.args.includes('ps')) return { stdout: (o.services ?? ALL).map((s) => JSON.stringify({ Service: s, Name: `friendflix-${s}-1`, State: 'running' })).join('\n') };
  const f = fmt(c);
  if (f.includes('PortBindings')) {
    const s = svcOf(c);
    return { stdout: `${JSON.stringify(o.ports?.[s] ?? {})}\t${JSON.stringify(o.networks?.[s] ?? { friendflix_default: {} })}\t${JSON.stringify(o.labels ?? LABELS)}\n` };
  }
  if (f.includes('Config.Labels')) return { stdout: JSON.stringify(o.labels ?? LABELS) };
  if (f.includes('Config.Env')) return { stdout: '[]' };
  return undefined;
}

/** `answer` decides a call; undefined = the running stack above, else an empty success */
function fake(answer: (c: Call) => Partial<RunResult> | undefined = () => undefined, files = ['compose.prod.yaml', 'compose.secrets.yaml']) {
  const calls: Call[] = [];
  const run: Runner = async (program, args, opts) => {
    const c = { program, args: [...args], env: opts.env };
    calls.push(c);
    return { code: 0, stdout: '', stderr: '', ...(answer(c) ?? running(c) ?? {}) };
  };
  const docker = new Docker({ projectDir: '/srv/friendflix', files, repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, run);
  return { calls, docker };
}
const config = (tag: string, over: Record<string, string> = {}) => JSON.stringify({ services: Object.fromEntries(['bootstrap', 'backend', 'gateway', 'web', 'updater', 'postgres'].map((s) => [s, {
  image: over[s] ?? (s === 'postgres' ? 'postgres:17-alpine' : `ghcr.io/letsmanu/friendflix-${s === 'bootstrap' ? 'backend' : s}:${tag}`),
}])) });
/** answers `compose config` with this rendered config, everything else from the running stack */
const rendered = (stdout: string, more: (c: Call) => Partial<RunResult> | undefined = () => undefined) => (c: Call) => (c.args.includes('config') ? { stdout } : more(c));
describe('docker command lines', () => {
  it('compose runs with fixed arguments, the tag only via FF_TAG, and an environment without secrets', async () => {
    process.env.INTERNAL_SECRET = 'must-never-reach-a-child-process';
    const { calls, docker } = fake();
    await docker.pull('nightly', ['backend', 'web']);
    await docker.up('nightly', ['backend', 'web']);
    expect(calls[0]!.args).toEqual(['compose', '--project-directory', '/srv/friendflix', '-f', '/srv/friendflix/compose.prod.yaml', '-f', '/srv/friendflix/compose.secrets.yaml',
      '--profile', 'updater', '--ansi', 'never', 'pull', '--quiet', 'backend', 'web']);
    expect(calls[1]!.args.slice(11)).toEqual(['up', '-d', '--no-deps', '--pull', 'never', 'backend', 'web']);
    for (const c of calls) {
      expect(c.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', PWD: '/srv/friendflix', DOCKER_HOST: 'tcp://docker-proxy:2375', DOCKER_CONFIG: '/tmp/.docker', FF_TAG: 'nightly' });
      expect(JSON.stringify(c)).not.toContain('must-never-reach');
    }
    delete process.env.INTERNAL_SECRET;
    expect(() => docker.env('latest;id')).toThrow('invalid tag');
    await expect(docker.pull('$(id)', ['backend'])).rejects.toThrow('invalid tag');
  });

  it('a failing command is a step error with a fixed code', async () => {
    const { docker } = fake((c) => (c.args.includes('ps') || fmt(c) ? undefined : { code: 1, stderr: 'Error: token ghp_secret123 denied' }));
    await expect(docker.pull('latest', ['backend'])).rejects.toEqual(new StepError('pull_failed'));
    await expect(docker.up('latest', ['backend'])).rejects.toEqual(new StepError('restart_failed'));
    await expect(docker.spawnSelfUpdate('latest')).rejects.toEqual(new StepError('restart_failed'));
    await expect(docker.images('latest', ['backend'])).rejects.toEqual(new StepError('compose_config'));
  });

  it('images: every service must resolve to exactly this repository\'s image with the requested tag', async () => {
    expect(await fake(rendered(config('1.2.3'))).docker.images('1.2.3', ['bootstrap', 'backend', 'gateway', 'web'])).toEqual({
      bootstrap: 'ghcr.io/letsmanu/friendflix-backend:1.2.3', backend: 'ghcr.io/letsmanu/friendflix-backend:1.2.3',
      gateway: 'ghcr.io/letsmanu/friendflix-gateway:1.2.3', web: 'ghcr.io/letsmanu/friendflix-web:1.2.3',
    });
    for (const evil of ['ghcr.io/evil/friendflix-web:1.2.3', 'ghcr.io/letsmanu/friendflix-web:latest', 'docker.io/library/nginx', 'ghcr.io/letsmanu/friendflix-web@' + D]) {
      await expect(fake(rendered(config('1.2.3', { web: evil }))).docker.images('1.2.3', ['web']), evil).rejects.toEqual(new StepError('unexpected_image'));
    }
    await expect(fake(rendered('not json')).docker.images('1.2.3', ['web'])).rejects.toEqual(new StepError('compose_config'));
    await expect(fake(rendered('{}')).docker.images('1.2.3', ['web'])).rejects.toEqual(new StepError('unexpected_image'));
  });

  it('images: refuses (before any pull) compose files that would recreate a Plex backend or gateway as Jellyfin, and the reverse', async () => {
    const withEnv = (env: Record<string, Record<string, string> | string[]>) => {
      const c = JSON.parse(config('latest')) as { services: Record<string, { environment?: unknown }> };
      for (const [s, e] of Object.entries(env)) c.services[s]!.environment = e;
      return JSON.stringify(c);
    };
    const stack = (out: string, envs: Record<string, string[] | null>) => fake((c) => {
      if (c.args.includes('config')) return { stdout: out };
      if (c.args.includes('ps')) return { stdout: ['backend', ...Object.keys(envs)].map((s) => JSON.stringify({ Service: s, Name: `friendflix-${s}-1`, State: s === 'gateway' ? 'exited' : 'running' })).join('\n') };
      if (fmt(c).includes('Config.Env')) {
        const env = envs[svcOf(c)];
        return env ? { stdout: JSON.stringify(env) } : { code: 1 };
      }
      return undefined;
    });
    const svcs = ['bootstrap', 'backend', 'gateway', 'web'];
    const plexNow = { backend: ['PATH=/x', 'MEDIA_SERVER=plex'], gateway: ['MEDIA_SERVER=plex'] };
    // compose.prod.yaml alone (no compose.plex.yaml in UPDATER_COMPOSE_FILES) on a Plex stack
    const mismatch = stack(withEnv({ backend: { MEDIA_SERVER: 'jellyfin' }, gateway: { MEDIA_SERVER: 'jellyfin' } }), plexNow);
    await expect(mismatch.docker.images('latest', svcs)).rejects.toEqual(new StepError('media_server_mismatch'));
    expect(mismatch.calls.some((c) => c.args.includes('pull'))).toBe(false);
    // only the gateway differs (a stopped container counts too)
    await expect(stack(withEnv({ backend: { MEDIA_SERVER: 'plex' }, gateway: {} }), plexNow).docker.images('latest', svcs)).rejects.toEqual(new StepError('media_server_mismatch'));
    // Jellyfin stack whose files now say plex
    await expect(stack(withEnv({ backend: ['MEDIA_SERVER=plex'], gateway: ['MEDIA_SERVER=plex'] }), { backend: ['PATH=/x'], gateway: [] }).docker.images('latest', svcs)).rejects.toEqual(new StepError('media_server_mismatch'));
    // same kind: fine (case, spaces and an unset value = jellyfin follow the backend's rule)
    expect(Object.keys(await stack(withEnv({ backend: { MEDIA_SERVER: ' Plex ' }, gateway: ['MEDIA_SERVER=plex'] }), plexNow).docker.images('latest', svcs))).toEqual(svcs);
    expect(Object.keys(await stack(withEnv({ backend: { MEDIA_SERVER: 'jellyfin' }, gateway: {} }), { backend: ['MEDIA_SERVER='], gateway: [] }).docker.images('latest', svcs))).toEqual(svcs);
    // no container yet, or one that cannot be inspected: nothing to compare with
    expect(Object.keys(await stack(withEnv({ backend: { MEDIA_SERVER: 'jellyfin' } }), {}).docker.images('latest', svcs))).toEqual(svcs);
    expect(Object.keys(await stack(withEnv({ backend: { MEDIA_SERVER: 'jellyfin' } }), { backend: null }).docker.images('latest', svcs))).toEqual(svcs);
    // web alone is never compared
    expect(await stack(withEnv({}), plexNow).docker.images('latest', ['web'])).toEqual({ web: 'ghcr.io/letsmanu/friendflix-web:latest' });
  });

  it('without UPDATER_COMPOSE_FILES: the files the backend container was started with (compose labels), validated, else the fallback', async () => {
    const auto = (labels: unknown, opts: { ps?: boolean; code?: number } = {}) => {
      const calls: Call[] = [];
      const run: Runner = async (program, args, o) => {
        calls.push({ program, args: [...args], env: o.env });
        if (args.includes('ps')) return { code: 0, stderr: '', stdout: opts.ps === false ? '' : JSON.stringify({ Service: 'backend', Name: 'friendflix-backend-1', State: 'running' }) };
        if (args[0] === 'container') return { code: opts.code ?? 0, stderr: '', stdout: JSON.stringify(labels) };
        if (args.includes('config')) return { code: 0, stderr: '', stdout: config('latest') };
        return { code: 0, stdout: '', stderr: '' };
      };
      return { calls, docker: new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml'], autoFiles: true, repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, run) };
    };
    const L = (files: string, dir = '/srv/friendflix') => ({ 'com.docker.compose.project': 'friendflix', 'com.docker.compose.project.working_dir': dir, 'com.docker.compose.project.config_files': files });
    // a Plex stack started with -f compose.prod.yaml -f compose.plex.yaml (or COMPOSE_FILE): the pull uses both files
    const plex = auto(L('/srv/friendflix/compose.prod.yaml,/srv/friendflix/compose.plex.yaml'));
    await plex.docker.images('latest', ['web']);
    await plex.docker.pull('latest', ['web']);
    expect(plex.docker.files).toEqual(['compose.prod.yaml', 'compose.plex.yaml']);
    expect(plex.calls.at(-1)!.args.slice(0, 7)).toEqual(['compose', '--project-directory', '/srv/friendflix', '-f', '/srv/friendflix/compose.prod.yaml', '-f', '/srv/friendflix/compose.plex.yaml']);
    // our own stack with a file list that does not qualify: the configured list
    for (const bad of [L('/srv/other/compose.prod.yaml'), L('/srv/friendflix/sub/compose.yaml'), L('/srv/friendflix/../x.yaml'),
      L('/srv/friendflix/a.yaml,/srv/friendflix/a.yaml'), L(Array.from({ length: 9 }, (_, i) => `/srv/friendflix/c${i}.yaml`).join(',')), L('/srv/friendflix/compose.json'), L('')]) {
      const d = auto(bad).docker;
      expect(await d.refreshFiles(), JSON.stringify(bad)).toEqual(['compose.prod.yaml']);
    }
    // started from another directory, no compose labels, no backend container, labels not readable: not our stack, refused
    for (const [labels, opts] of [[L('/srv/friendflix/compose.prod.yaml', '/elsewhere'), {}], [{}, {}], [null, {}], ['x', {}],
      [L('/srv/friendflix/compose.prod.yaml'), { ps: false }], [L('/srv/friendflix/compose.prod.yaml'), { code: 1 }]] as const) {
      await expect(auto(labels, opts).docker.refreshFiles(), JSON.stringify([labels, opts])).rejects.toMatchObject({ code: 'foreign_stack' });
    }
    // a later refresh follows a changed stack, and an explicit list is never replaced
    const d = auto(L('/srv/friendflix/compose.prod.yaml , /srv/friendflix/compose.secrets.yaml'));
    expect(await d.docker.refreshFiles()).toEqual(['compose.prod.yaml', 'compose.secrets.yaml']);
    const fixed = fake((c) => (fmt(c).includes('Config.Labels') ? { stdout: JSON.stringify(L('/srv/friendflix/compose.prod.yaml')) } : undefined));
    expect(await fixed.docker.refreshFiles()).toEqual(['compose.prod.yaml', 'compose.secrets.yaml']);
    expect(await d.docker.startedWith('../x')).toBeNull();
  });

  it('verify: cosign gets the digest-pinned reference and the publish workflow identity, never a tag', async () => {
    const { calls, docker } = fake((c) => (c.program === 'docker' ? { stdout: `["ghcr.io/letsmanu/friendflix-web@${D}"]\t["GIT_SHA=${'a'.repeat(40)}","APP_VERSION=1.2.3"]\n` } : {}));
    expect(await docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(true);
    const cos = calls.find((c) => c.program === 'cosign')!;
    expect(cos.args).toEqual(['verify', '--certificate-identity-regexp',
      '^https://github\\.com/LetsManu/friendflix/\\.github/workflows/publish\\.yml@refs/(heads/main|tags/v[0-9]+\\.[0-9]+\\.[0-9]+)$',
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', `ghcr.io/letsmanu/friendflix-web@${D}`]);
    expect(cos.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' });
  });

  it('verify fails without a matching digest or when cosign fails', async () => {
    expect(await fake(() => ({ stdout: `["ghcr.io/evil/friendflix-web@${D}"]\t[]` })).docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(false);
    expect(await fake((c) => (c.program === 'docker' ? { stdout: `["ghcr.io/letsmanu/friendflix-web@${D}"]\t[]` } : { code: 1 })).docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(false);
    expect(await fake(() => ({ code: 1 })).docker.verify('ghcr.io/letsmanu/friendflix-web:latest')).toBe(false);
  });

  it('ps, running image and image info', async () => {
    const { docker } = fake((c) => {
      if (c.args.includes('ps')) return { stdout: [{ Service: 'backend', Name: 'friendflix-backend-1', State: 'running', Health: 'healthy' }, { Service: 'web', Name: 'friendflix-web-1', State: 'exited', Health: '' }].map((x) => JSON.stringify(x)).join('\n') };
      if (c.args[0] === 'container') return { stdout: `${ID}\n` };
      return { stdout: `["ghcr.io/letsmanu/friendflix-backend@${D}"]\t["PATH=/x","GIT_SHA=${'a'.repeat(40)}","APP_VERSION=1.2.3"]` };
    });
    expect(await docker.ps()).toEqual([{ service: 'backend', name: 'friendflix-backend-1', state: 'running', health: 'healthy' }, { service: 'web', name: 'friendflix-web-1', state: 'exited', health: '' }]);
    expect(await docker.running('backend')).toEqual({ repoDigests: [`ghcr.io/letsmanu/friendflix-backend@${D}`], gitSha: 'a'.repeat(40), version: '1.2.3' });
    expect(await docker.running('web')).toBeNull(); // not running
    expect(await docker.imageInfo('bad ref; id')).toBeNull();
    expect(await docker.containerImage('../x')).toBeNull();
  });

  it('ps tolerates an array answer and failures', async () => {
    expect(await fake(() => ({ stdout: JSON.stringify([{ Service: 'web', Name: 'w', State: 'running' }]) })).docker.ps()).toEqual([{ service: 'web', name: 'w', state: 'running', health: '' }]);
    expect(await fake(() => ({ code: 1 })).docker.ps()).toEqual([]);
    expect(await fake(() => ({ stdout: 'garbage' })).docker.ps()).toEqual([]);
    expect(await fake(() => ({ code: 1 })).docker.imageInfo('x')).toBeNull();
    expect(await fake(() => ({ stdout: 'x\ty' })).docker.imageInfo('x')).toBeNull();
    expect(await fake(() => ({ stdout: 'not-a-digest' })).docker.containerImage('c')).toBeNull();
  });

  it('self-update spawns the helper from the updater service definition', async () => {
    const { calls, docker } = fake();
    await docker.spawnSelfUpdate('1.2.3');
    expect(calls.at(-1)!.args.slice(11)).toEqual(['run', '-d', '--rm', '--no-deps', '--pull', 'never', '-e', 'FF_TAG=1.2.3', 'updater', 'node', 'updater/dist/selfUpdate.js']);
  });
});

describe('foreign stacks and config drift: refused before anything is pulled or recreated', () => {
  const FF = ['bootstrap', 'backend', 'gateway', 'web'];
  const PORTAINER = { ...LABELS, 'com.docker.compose.project.working_dir': '/data/compose/12', 'com.docker.compose.project.config_files': '/data/compose/12/docker-compose.yml' };
  const touched = (calls: Call[]) => calls.filter((c) => ['pull', 'up', 'run', 'config'].some((a) => c.args.includes(a)));
  /** compose.prod.yaml as compose renders it: web/backend/gateway publish on BIND_ADDR, the given host ip */
  const prod = (tag: string, hostIp: string) => {
    const c = JSON.parse(config(tag)) as { name?: string; networks?: unknown; services: Record<string, Record<string, unknown>> };
    c.name = 'friendflix';
    c.networks = { front: { name: 'friendflix_front' }, db: { name: 'friendflix_db', internal: true }, media: { name: 'friendflix_media', internal: true } };
    c.services.bootstrap!.network_mode = 'none';
    const port = (published: string, target: number) => [{ mode: 'ingress', host_ip: hostIp, target, published, protocol: 'tcp' }];
    Object.assign(c.services.web!, { ports: port('3080', 3000), networks: { front: null } });
    Object.assign(c.services.backend!, { ports: port('3081', 3000), networks: { front: null, db: null, media: null } });
    Object.assign(c.services.gateway!, { ports: port('3082', 4000), networks: { front: null, media: null } });
    Object.assign(c.services.updater!, { networks: { front: null } });
    return JSON.stringify(c);
  };
  /** the running Portainer-era containers: published on the NAS address */
  const nas = (ip = '192.0.2.7'): { ports: Record<string, unknown>; networks: Record<string, unknown> } => ({
    ports: { web: { '3000/tcp': [{ HostIp: ip, HostPort: '3080' }] }, backend: { '3000/tcp': [{ HostIp: ip, HostPort: '3081' }] }, gateway: { '4000/tcp': [{ HostIp: ip, HostPort: '3082' }] } },
    networks: { bootstrap: { none: {} }, web: { friendflix_front: {} }, backend: { friendflix_front: {}, friendflix_db: {}, friendflix_media: {} }, gateway: { friendflix_media: {}, friendflix_front: {} }, updater: { friendflix_front: {} } },
  });

  it('a Portainer stack (working dir /data/compose/<id>): foreign_stack, nothing rendered, pulled or recreated, the self-update helper is not spawned', async () => {
    const f = fake((c) => running(c, { labels: PORTAINER }));
    await expect(f.docker.images('latest', FF)).rejects.toMatchObject({ code: 'foreign_stack' });
    await expect(f.docker.images('latest', ['updater'])).rejects.toMatchObject({ code: 'foreign_stack' });
    await expect(f.docker.spawnSelfUpdate('latest')).rejects.toMatchObject({ code: 'foreign_stack' });
    expect(touched(f.calls)).toEqual([]);
    expect(await f.docker.origin()).toMatchObject({ stack: 'foreign', manager: 'portainer' });
  });

  it('another working directory alone is enough (also with an explicit UPDATER_COMPOSE_FILES)', async () => {
    const f = fake((c) => running(c, { labels: { ...LABELS, 'com.docker.compose.project.working_dir': '/opt/stacks/friendflix' } }), ['compose.prod.yaml']);
    const e = await f.docker.images('latest', FF).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StepError);
    expect(e).toMatchObject({ code: 'foreign_stack' });
    expect((e as StepError).detail).toBe('working_dir');
    expect(touched(f.calls)).toEqual([]);
    expect(await f.docker.origin()).toMatchObject({ stack: 'foreign', manager: null });
  });

  it('no backend container in this project: foreign; compose ps failing: compose_config and an unknown origin', async () => {
    const none = fake((c) => running(c, { services: ['web'] }));
    await expect(none.docker.images('latest', FF)).rejects.toMatchObject({ code: 'foreign_stack' });
    const broken = fake((c) => (c.args.includes('ps') ? { code: 1 } : undefined));
    await expect(broken.docker.images('latest', FF)).rejects.toEqual(new StepError('compose_config'));
    expect(touched(broken.calls)).toEqual([]);
    expect(await broken.docker.stackKind()).toBeNull();
    expect(await fake().docker.stackKind()).toBe('own');
    expect(await fake((c) => running(c, { labels: PORTAINER })).docker.stackKind()).toBe('foreign');
  });

  it('the incident: the files render 127.0.0.1 (BIND_ADDR default) while the containers publish on the NAS address: config_mismatch, nothing pulled', async () => {
    const f = fake(rendered(prod('latest', '127.0.0.1'), (c) => running(c, nas())));
    const e = await f.docker.images('latest', FF).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StepError);
    expect(e).toMatchObject({ code: 'config_mismatch' });
    expect((e as StepError).detail).toMatch(/^(web|backend|gateway) ports$/);
    expect(f.calls.filter((c) => c.args.includes('pull') || c.args.includes('up'))).toEqual([]);
  });

  it('a changed network set is refused too', async () => {
    const n = nas();
    n.networks.web = { friendflix_front: {}, proxy: {} };
    const e = await fake(rendered(prod('latest', '192.0.2.7'), (c) => running(c, n))).docker.images('latest', FF).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'config_mismatch', detail: 'web networks' });
  });

  it('configs that only differ in what compose normalises proceed: "" vs 0.0.0.0, the project prefix, order', async () => {
    const f = fake(rendered(prod('latest', ''), (c) => running(c, nas('0.0.0.0'))));
    expect(Object.keys(await f.docker.images('latest', FF))).toEqual(FF);
    const g = fake(rendered(prod('latest', '192.0.2.7'), (c) => running(c, nas())));
    expect(Object.keys(await g.docker.images('latest', FF))).toEqual(FF);
    // a container that is not there yet (or cannot be inspected) has nothing to compare
    const h = fake(rendered(prod('latest', '127.0.0.1'), (c) => (fmt(c).includes('PortBindings') ? { code: 1 } : running(c, nas()))));
    expect(Object.keys(await h.docker.images('latest', FF))).toEqual(FF);
  });

  it('self-update: the updater service is compared the same way', async () => {
    const n = nas();
    n.networks.updater = { friendflix_updater: {} };
    await expect(fake(rendered(prod('latest', '192.0.2.7'), (c) => running(c, n))).docker.images('latest', ['updater'])).rejects.toMatchObject({ code: 'config_mismatch' });
    expect(Object.keys(await fake(rendered(prod('latest', '192.0.2.7'), (c) => running(c, nas()))).docker.images('latest', ['updater']))).toEqual(['updater']);
  });
});
