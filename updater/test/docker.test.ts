// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Docker, StepError, type Program, type RunResult, type Runner } from '../src/docker.js';

type Call = { program: Program; args: string[]; env: Record<string, string> };
const D = 'sha256:' + 'c'.repeat(64);
const ID = 'sha256:' + 'e'.repeat(64);

function fake(answer: (c: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const run: Runner = async (program, args, opts) => {
    const c = { program, args: [...args], env: opts.env };
    calls.push(c);
    return { code: 0, stdout: '', stderr: '', ...answer(c) };
  };
  const docker = new Docker({ projectDir: '/srv/friendflix', files: ['compose.prod.yaml', 'compose.secrets.yaml'], repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375' }, run);
  return { calls, docker };
}
const config = (tag: string, over: Record<string, string> = {}) => JSON.stringify({ services: Object.fromEntries(['bootstrap', 'backend', 'gateway', 'web', 'updater', 'postgres'].map((s) => [s, {
  image: over[s] ?? (s === 'postgres' ? 'postgres:17-alpine' : `ghcr.io/letsmanu/friendflix-${s === 'bootstrap' ? 'backend' : s}:${tag}`),
}])) });

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
    const { docker } = fake(() => ({ code: 1, stderr: 'Error: token ghp_secret123 denied' }));
    await expect(docker.pull('latest', ['backend'])).rejects.toEqual(new StepError('pull_failed'));
    await expect(docker.up('latest', ['backend'])).rejects.toEqual(new StepError('restart_failed'));
    await expect(docker.spawnSelfUpdate('latest')).rejects.toEqual(new StepError('restart_failed'));
    await expect(docker.images('latest', ['backend'])).rejects.toEqual(new StepError('compose_config'));
  });

  it('images: every service must resolve to exactly this repository\'s image with the requested tag', async () => {
    expect(await fake(() => ({ stdout: config('1.2.3') })).docker.images('1.2.3', ['bootstrap', 'backend', 'gateway', 'web'])).toEqual({
      bootstrap: 'ghcr.io/letsmanu/friendflix-backend:1.2.3', backend: 'ghcr.io/letsmanu/friendflix-backend:1.2.3',
      gateway: 'ghcr.io/letsmanu/friendflix-gateway:1.2.3', web: 'ghcr.io/letsmanu/friendflix-web:1.2.3',
    });
    for (const evil of ['ghcr.io/evil/friendflix-web:1.2.3', 'ghcr.io/letsmanu/friendflix-web:latest', 'docker.io/library/nginx', 'ghcr.io/letsmanu/friendflix-web@' + D]) {
      await expect(fake(() => ({ stdout: config('1.2.3', { web: evil }) })).docker.images('1.2.3', ['web']), evil).rejects.toEqual(new StepError('unexpected_image'));
    }
    await expect(fake(() => ({ stdout: 'not json' })).docker.images('1.2.3', ['web'])).rejects.toEqual(new StepError('compose_config'));
    await expect(fake(() => ({ stdout: '{}' })).docker.images('1.2.3', ['web'])).rejects.toEqual(new StepError('unexpected_image'));
  });

  it('images: refuses (before any pull) compose files that would recreate a Plex backend or gateway as Jellyfin, and the reverse', async () => {
    const withEnv = (env: Record<string, Record<string, string> | string[]>) => {
      const c = JSON.parse(config('latest')) as { services: Record<string, { environment?: unknown }> };
      for (const [s, e] of Object.entries(env)) c.services[s]!.environment = e;
      return JSON.stringify(c);
    };
    const stack = (rendered: string, running: Record<string, string[] | null>) => fake((c) => {
      if (c.args.includes('config')) return { stdout: rendered };
      if (c.args.includes('ps')) return { stdout: Object.keys(running).map((s) => JSON.stringify({ Service: s, Name: `friendflix-${s}-1`, State: s === 'gateway' ? 'exited' : 'running' })).join('\n') };
      if (c.args[0] === 'container') {
        const svc = c.args.at(-1)!.replace(/^friendflix-|-1$/g, '');
        const env = running[svc];
        return env ? { stdout: JSON.stringify(env) } : { code: 1 };
      }
      return {};
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
    // anything that does not qualify falls back to the configured list
    for (const bad of [L('/srv/friendflix/compose.prod.yaml', '/elsewhere'), L('/srv/other/compose.prod.yaml'), L('/srv/friendflix/sub/compose.yaml'), L('/srv/friendflix/../x.yaml'),
      L('/srv/friendflix/a.yaml,/srv/friendflix/a.yaml'), L(Array.from({ length: 9 }, (_, i) => `/srv/friendflix/c${i}.yaml`).join(',')), L('/srv/friendflix/compose.json'), L(''), {}, null, 'x']) {
      const d = auto(bad).docker;
      expect(await d.refreshFiles(), JSON.stringify(bad)).toEqual(['compose.prod.yaml']);
    }
    expect(await auto(L('/srv/friendflix/compose.prod.yaml,/srv/friendflix/compose.plex.yaml'), { ps: false }).docker.refreshFiles()).toEqual(['compose.prod.yaml']);
    expect(await auto(L('/srv/friendflix/compose.prod.yaml,/srv/friendflix/compose.plex.yaml'), { code: 1 }).docker.refreshFiles()).toEqual(['compose.prod.yaml']);
    // a later refresh follows a changed stack, and an explicit list is never replaced
    const d = auto(L('/srv/friendflix/compose.prod.yaml , /srv/friendflix/compose.secrets.yaml'));
    expect(await d.docker.refreshFiles()).toEqual(['compose.prod.yaml', 'compose.secrets.yaml']);
    const fixed = fake(() => ({ stdout: JSON.stringify(L('/srv/friendflix/compose.prod.yaml')) }));
    expect(await fixed.docker.refreshFiles()).toEqual(['compose.prod.yaml', 'compose.secrets.yaml']);
    expect(fixed.calls).toEqual([]);
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
    expect(calls[0]!.args.slice(11)).toEqual(['run', '-d', '--rm', '--no-deps', '--pull', 'never', '-e', 'FF_TAG=1.2.3', 'updater', 'node', 'updater/dist/selfUpdate.js']);
  });
});
