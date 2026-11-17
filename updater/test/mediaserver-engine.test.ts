// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Engine, EngineError } from '../src/mediaserver/engine.js';
import { readFacts } from '../src/mediaserver/facts.js';

interface Call { method: string; url: string; body: unknown }
type Handler = (c: Call) => Response | undefined;

function fake(api: string, handler: Handler = () => undefined): { engine: Engine; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url: String(url).replace('http://docker-proxy:2375', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (/^(\/v[0-9.]+)?\/version$/.test(c.url)) return Response.json({ ApiVersion: api, Arch: 'amd64' });
    return handler(c) ?? Response.json({});
  }) as unknown as typeof fetch;
  return { engine: new Engine('tcp://docker-proxy:2375', f), calls };
}

const frame = (type: number, text: string | Buffer): Buffer => {
  const b = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(b.length, 4);
  return Buffer.concat([h, b]);
};
const caught = async (p: Promise<unknown>): Promise<EngineError> => {
  try { await p; } catch (e) { return e as EngineError; }
  throw new Error('did not throw');
};
const codeOf = async (p: Promise<unknown>): Promise<[number, string]> => {
  try { await p; } catch (e) { if (e instanceof EngineError) return [e.status, e.code]; throw e; }
  throw new Error('did not throw');
};

describe('Engine client', () => {
  it('negotiates the API version and refuses below 1.45', async () => {
    const a = fake('1.47');
    expect(await a.engine.negotiate()).toEqual({ api: '1.47', ok: true });
    await a.engine.inspectContainer('abc');
    expect(a.calls.map((c) => c.url)).toEqual(['/version', '/v1.47/containers/abc/json']);
    const b = fake('1.60');
    await b.engine.info();
    expect(b.calls[1]!.url).toBe('/v1.52/info');
    const c = fake('1.44');
    expect(await c.engine.negotiate()).toEqual({ api: '1.44', ok: false });
    expect(await codeOf(c.engine.info())).toEqual([0, 'engine_old']);
    expect(c.calls).toHaveLength(1);
  });

  it('create sends the body unchanged with the name in the query', async () => {
    const body = { Image: 'x@sha256:' + 'a'.repeat(64), Labels: { a: 'b' } };
    const ok = fake('1.47', () => Response.json({ Id: 'c'.repeat(64) }, { status: 201 }));
    expect(await ok.engine.create({ name: 'friendflix-mediaserver', body })).toBe('c'.repeat(64));
    expect(ok.calls[1]).toEqual({ method: 'POST', url: '/v1.47/containers/create?name=friendflix-mediaserver', body });
    const dup = fake('1.47', () => Response.json({ message: 'secret detail' }, { status: 409 }));
    const err = await caught(dup.engine.create({ name: 'n', body }));
    expect([err.status, err.code, err.message]).toEqual([409, 'name_taken', 'engine 409 name_taken']);
  });

  it('logs decodes multiplexed frames', async () => {
    const mk = (parts: Buffer[]) => fake('1.47', () => new Response(Buffer.concat(parts)));
    const a = mk([frame(1, 'a\nb'), frame(2, 'c\n')]);
    expect(await a.engine.logs('id', 100)).toEqual(['a', 'b', 'c']);
    expect(a.calls[1]!.url).toBe('/v1.47/containers/id/logs?stdout=1&stderr=1&tail=100');
    const big = 'x'.repeat(40_000);
    const b = mk([frame(1, big.slice(0, 16384)), frame(1, big.slice(16384, 32768)), frame(1, big.slice(32768) + '\n')]);
    expect(await b.engine.logs('id', 50)).toEqual([big]);
    const c = mk([frame(1, 'out\n'), frame(2, 'err\n')]);
    expect(await c.engine.logs('id', 50, 'stdout')).toEqual(['out']);
    expect(c.calls[1]!.url).toContain('stdout=1&stderr=0');
    // a multi-byte character split across two frames survives
    const euro = Buffer.from('€\n');
    expect(await mk([frame(1, euro.subarray(0, 1)), frame(1, euro.subarray(1))]).engine.logs('id', 5)).toEqual(['€']);
  });

  it('logsAllowed is true on 200 and false on 403; remove with volumes sets ?v=1', async () => {
    expect(await fake('1.47').engine.logsAllowed('abc')).toBe(true);
    expect(await fake('1.47', () => new Response('', { status: 403 })).engine.logsAllowed('abc')).toBe(false);
    const r = fake('1.47');
    await r.engine.remove('id', { volumes: true });
    expect(r.calls[1]).toMatchObject({ method: 'DELETE', url: '/v1.47/containers/id?v=1' });
    await r.engine.remove('id', { force: true });
    expect(r.calls[2]!.url).toBe('/v1.47/containers/id?force=1');
  });

  it('refuses names and ids that are not plain', async () => {
    const f = fake('1.47');
    expect(await codeOf(f.engine.inspectContainer('../x'))).toEqual([0, 'invalid_name']);
    expect(await codeOf(f.engine.rename('id', 'x y'))).toEqual([0, 'invalid_name']);
    expect(await codeOf(f.engine.pull('docker.io/a/b:latest'))).toEqual([0, 'invalid_ref']);
    expect(f.calls).toHaveLength(0);
  });

  it('pull splits repo and digest and hides the daemon message', async () => {
    const f = fake('1.47', () => new Response('{"status":"Pulling"}\n'));
    await f.engine.pull('docker.io/jellyfin/jellyfin@sha256:' + 'b'.repeat(64));
    expect(f.calls[1]).toMatchObject({ method: 'POST', url: '/v1.47/images/create?fromImage=docker.io%2Fjellyfin%2Fjellyfin&tag=sha256%3A' + 'b'.repeat(64) });
    const bad = fake('1.47', () => new Response('{"status":"x"}\n{"error":"secret detail"}\n'));
    const err = await caught(bad.engine.pull('a/b@sha256:' + 'b'.repeat(64)));
    expect(err.code).toBe('pull_failed');
    expect(err.message).not.toContain('secret');
  });

  it('maps 404 to null and reads the shapes', async () => {
    const nf = fake('1.47', () => new Response('', { status: 404 }));
    expect(await nf.engine.inspectContainer('x')).toBeNull();
    expect(await nf.engine.inspectImage('a/b@sha256:' + 'b'.repeat(64))).toBeNull();
    expect(await nf.engine.inspectVolume('v')).toBeNull();
    const f = fake('1.47', (c) => {
      if (c.url.startsWith('/v1.47/images/')) return Response.json({ Id: 'sha256:i', RepoDigests: ['r@sha256:d'], Config: { Labels: { k: 'v' }, Env: ['A=1'], Entrypoint: ['/e'], Cmd: null, Volumes: { '/cache': {} }, User: '1000' } });
      if (c.url.startsWith('/v1.47/containers/json')) return Response.json([{ Id: 'i1', Names: ['/n1'], State: 'running', Labels: { l: 'm' } }]);
      if (c.url.startsWith('/v1.47/networks')) return Response.json([{ Id: 'n1', Name: 'p_media', Containers: { c1: {}, c2: {} } }]);
      if (c.url === '/v1.47/info') return Response.json({ DockerRootDir: '/var/lib/docker', Runtimes: { runc: {}, nvidia: {} } });
      return undefined;
    });
    expect(await f.engine.inspectImage('a/b@sha256:' + 'b'.repeat(64))).toEqual({ id: 'sha256:i', repoDigests: ['r@sha256:d'], labels: { k: 'v' }, env: ['A=1'], entrypoint: ['/e'], cmd: null, volumes: ['/cache'], user: '1000' });
    expect(await f.engine.listContainers({ a: 'b' }, true)).toEqual([{ id: 'i1', names: ['n1'], state: 'running', labels: { l: 'm' } }]);
    expect(f.calls.at(-1)!.url).toBe('/v1.47/containers/json?all=1&filters=' + encodeURIComponent('{"label":["a=b"]}'));
    expect(await f.engine.listNetworks({ a: 'b' })).toEqual([{ id: 'n1', name: 'p_media', containers: ['c1', 'c2'] }]);
    expect(await f.engine.info()).toEqual({ dockerRoot: '/var/lib/docker', nvidia: true });
  });
});

describe('readFacts', () => {
  const self = 'a'.repeat(64);
  const SELF_C = { Id: self, Image: 'sha256:img', Config: { Labels: { 'com.docker.compose.project': 'friendflix' } } };
  interface World { api: string; logs: number; own: unknown; networks: unknown[]; attached: string[] }
  const world = (o: Partial<World> = {}) => {
    const w: World = { api: '1.47', logs: 200, own: SELF_C, networks: [{ Id: 'nm', Name: 'friendflix_media', Containers: { b1: {}, g1: {} } }], attached: ['b1', 'g1'], ...o };
    return fake(w.api, (c) => {
      if (c.url.includes('/logs')) return new Response('', { status: w.logs });
      if (c.url === `/v1.47/containers/${self}/json`) return w.own ? Response.json(w.own) : new Response('', { status: 404 });
      if (c.url.startsWith('/v1.47/containers/json')) {
        const svc = /service%3D(\w+)/.exec(c.url)?.[1] ?? /service=(\w+)/.exec(decodeURIComponent(c.url))?.[1];
        return Response.json([{ Id: svc === 'backend' ? 'b1' : 'g1', Names: [], State: 'running', Labels: { 'com.docker.compose.project.working_dir': '/srv/friendflix' } }]);
      }
      if (c.url.startsWith('/v1.47/networks')) {
        const media = decodeURIComponent(c.url).includes('network=media');
        return Response.json(media ? w.networks : [{ Id: 'ne', Name: 'friendflix_egress', Containers: {} }]);
      }
      if (c.url === '/v1.47/info') return Response.json({ DockerRootDir: '/var/lib/docker', Runtimes: { runc: {} } });
      return undefined;
    });
  };

  it('reasons in order', async () => {
    expect((await readFacts(world({ api: '1.44' }).engine, self)).reason).toBe('engine_old');
    expect((await readFacts(world({ logs: 403, own: null }).engine, self)).reason).toBe('no_logs');
    expect((await readFacts(world({ own: { Id: self, Config: { Labels: {} } } }).engine, self)).reason).toBe('no_project');
    expect((await readFacts(world({ networks: [] }).engine, self)).reason).toBe('no_network');
    expect((await readFacts(world({ networks: [{ Id: 'nm', Name: 'friendflix_media', Containers: { g1: {} } }] }).engine, self)).reason).toBe('no_network');
    expect((await readFacts(world().engine, undefined)).reason).toBe('no_logs');
    expect(await readFacts(world().engine, self)).toEqual({
      api: '1.47', logs: true, arch: 'amd64', nvidia: false, dockerRoot: '/var/lib/docker', project: 'friendflix',
      mediaNetwork: 'friendflix_media', egressNetwork: 'friendflix_egress', stackDir: '/srv/friendflix', selfImage: 'sha256:img', reason: null,
    });
  });
});
