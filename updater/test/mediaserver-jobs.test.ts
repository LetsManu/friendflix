// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StepError } from '../src/docker.js';
import { Updater, type Ops } from '../src/job.js';
import { EngineError, type Engine } from '../src/mediaserver/engine.js';
import type { EngineFacts } from '../src/mediaserver/facts.js';
import { TemplateViolation, assertHelper } from '../src/mediaserver/guard.js';
import { MediaJobs } from '../src/mediaserver/jobs.js';
import type { Pin, PinRead } from '../src/mediaserver/pins.js';
import { MediaService } from '../src/mediaserver/service.js';
import { containerSpec, names } from '../src/mediaserver/template.js';
import type { Desired, DesiredSpec, Kind } from '../src/mediaserver/types.js';
import { memoryStore, type MediaState } from '../src/state.js';

type Obj = Record<string, unknown>;
const T0 = Date.UTC(2026, 10, 17, 14, 2, 0);
const PROJECT = 'friendflix';
const N = names(PROJECT);
const SELF = `sha256:${'a'.repeat(64)}`;
const SOURCE = `sha256:${'b'.repeat(64)}`;
const UPSTREAM_LABEL = 'io.github.letsmanu.friendflix.mediaserver.ferrofin';
const sha8 = (p: string): string => createHash('sha256').update(p).digest('hex').slice(0, 8);
const baseVolume = (p: string): string => `${PROJECT}_mediaserver-base-${sha8(p)}`;
const BASE = '/srv/media';
// a first-run password built from pieces (gitleaks)
const PASSWORD = 'Pw' + 'x'.repeat(41);

const ferroPin = (hex = 'f'): Pin => ({ kind: 'ferrofin', image: `ghcr.io/letsmanu/friendflix-mediaserver@sha256:${hex.repeat(64)}`, digest: `sha256:${hex.repeat(64)}`, upstream: null });
const jellyPin = (upstream: string, hex = '1'): Pin => ({ kind: 'jellyfin', image: `docker.io/jellyfin/jellyfin@sha256:${hex.repeat(64)}`, digest: `sha256:${hex.repeat(64)}`, upstream });

const FACTS: EngineFacts = {
  api: '1.47', logs: true, arch: 'amd64', nvidia: false, dockerRoot: '/var/lib/docker', project: PROJECT, mediaNetwork: `${PROJECT}_media`,
  egressNetwork: `${PROJECT}_egress`, stackDir: '/srv/friendflix', selfImage: SELF, reason: null,
};
const SPEC: DesiredSpec = { kind: 'ferrofin', folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien', target: '/media/serien' }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, tz: 'Europe/Berlin' };
const JSPEC: DesiredSpec = { ...SPEC, kind: 'jellyfin', egress: false };

interface C { id: string; name: string; body: Obj; running: boolean; health: string | null; networks: string[]; host: Obj }
interface HelperCall { verb: string; args: string[]; mounts: Obj[]; user: string }
type Answer = Obj | Error;

function okFolders(c: HelperCall): Obj {
  return { folders: (JSON.parse(c.args[1]!) as string[]).map((rel) => ({ rel, code: 'ok', read: true, watch: true, maxWatches: null })) };
}

function world(o: { facts?: Partial<EngineFacts> } = {}) {
  const clock = { t: T0 };
  /** every changing engine call and every helper run, in order */
  const calls: string[] = [];
  const created: Array<{ name: string; body: Obj }> = [];
  const removedWith: Array<{ name: string; o: Obj }> = [];
  const containers = new Map<string, C>();
  const volumes = new Map<string, { labels: Record<string, string>; options: Record<string, string> }>();
  const images = new Map<string, { id: string; repoDigests: string[]; labels: Record<string, string>; env: string[]; entrypoint: string[] | null; cmd: string[] | null; volumes: string[]; user: string }>();
  const store = memoryStore();
  const updater = new Updater({} as Ops, store, { now: () => clock.t });
  let next = 1;
  const cfg = {
    pins: { source: SOURCE, pins: { ferrofin: ferroPin(), jellyfin: jellyPin('10.11.3') }, invalid: [] } as PinRead,
    verify: true,
    facts: { ...FACTS, ...o.facts } as EngineFacts,
    failStart: (_c: C): boolean => false,
    healthOf: (_c: C): string | null => 'healthy',
    pull: null as null | (() => Promise<void>),
    hdr: { exit1: 0, lines2: ['RESULT vpp FAIL the VA driver has no HDR tone mapper', 'RESULT qsv FAIL ffmpeg exit 1'] },
    answer: (c: HelperCall): Answer => {
      if (c.verb === 'check' && c.args[0] === 'folders') return okFolders(c);
      if (c.verb === 'check' && c.args[0] === 'data') return { owner: 1000 };
      if (c.verb === 'gpu') return { nodes: [{ node: 'renderD128', gid: 993, vendor: 'intel' }] };
      if (c.verb === 'backup') return { size: 4096 };
      if (c.verb === 'restore') return { ok: true };
      return { error: 'invalid_body' };
    },
  };
  const find = (idOrName: string): C | undefined => containers.get(idOrName) ?? [...containers.values()].find((c) => c.name === idOrName);
  const isHelper = (body: Obj): boolean => (body.Labels as Obj | undefined)?.['friendflix.managed'] === 'helper';
  const label = (c: C): string => (isHelper(c.body) ? 'helper' : c.name);

  function inspect(c: C): Obj {
    const b = c.body;
    const hc = (b.HostConfig ?? {}) as Obj;
    const mounts = (hc.Mounts ?? []) as Obj[];
    return {
      Id: c.id, Name: `/${c.name}`, Image: b.Image,
      State: { Running: c.running, Status: c.running ? 'running' : 'exited', ...(c.health && c.running ? { Health: { Status: c.health } } : {}) },
      Config: { Hostname: b.Hostname, User: b.User, Image: b.Image, Env: b.Env, Labels: b.Labels ?? {}, StopTimeout: b.StopTimeout, ...(c.health ? { Healthcheck: { Test: ['CMD', 'true'] } } : {}) },
      HostConfig: { ...hc, MaskedPaths: ['/proc/kcore'], ReadonlyPaths: ['/proc/sys'], ...c.host },
      Mounts: mounts.map((m) => ({ Type: 'volume', Name: m.Source, Source: `/var/lib/docker/volumes/${String(m.Source)}/_data`, Destination: m.Target, RW: m.ReadOnly !== true })),
      NetworkSettings: { Networks: Object.fromEntries(c.networks.map((n) => [n, {}])), Ports: {} },
    };
  }

  const engine = {
    inspectContainer: async (idOrName: string) => { const c = find(idOrName); return c ? inspect(c) : null; },
    create: async (req: { name: string; body: Obj }) => {
      if (find(req.name)) throw new EngineError(409, 'name_taken');
      const id = (next++).toString(16).padStart(64, '0');
      const hc = (req.body.HostConfig ?? {}) as Obj;
      const c: C = { id, name: req.name, body: req.body, running: false, health: null, networks: [String(hc.NetworkMode)], host: {} };
      containers.set(id, c);
      created.push({ name: req.name, body: req.body });
      calls.push(`create ${label(c)}`);
      return id;
    },
    start: async (id: string) => {
      const c = find(id)!;
      calls.push(`start ${label(c)}`);
      if (cfg.failStart(c)) throw new EngineError(500, 'engine_error');
      c.running = true;
      c.health = isHelper(c.body) ? null : cfg.healthOf(c);
    },
    stop: async (id: string) => { const c = find(id)!; calls.push(`stop ${label(c)}`); c.running = false; },
    rename: async (id: string, name: string) => {
      if (find(name)) throw new EngineError(409, 'name_taken');
      const c = find(id)!;
      calls.push(`rename ${c.name} -> ${name}`);
      c.name = name;
    },
    remove: async (id: string, ro: Obj = {}) => {
      const c = find(id)!;
      calls.push(`remove ${label(c)}`);
      removedWith.push({ name: label(c), o: ro });
      containers.delete(c.id);
    },
    wait: async (id: string) => {
      const c = find(id)!;
      c.running = false;
      return (c.body.Entrypoint as string[])[0] === '/bin/sh' ? 0 : cfg.hdr.exit1;
    },
    logs: async (id: string) => ((find(id)!.body.Entrypoint as string[])[0] === '/bin/sh' ? cfg.hdr.lines2 : []),
    pull: async (ref: string) => { calls.push(`pull ${ref}`); if (cfg.pull) await cfg.pull(); },
    inspectImage: async (ref: string) => images.get(ref) ?? { id: ref, repoDigests: [], labels: {}, env: [], entrypoint: null, cmd: null, volumes: [], user: '' },
    createVolume: async (v: { Name: string; DriverOpts: Record<string, string>; Labels: Record<string, string> }) => { calls.push(`createVolume ${v.Name}`); volumes.set(v.Name, { labels: v.Labels, options: v.DriverOpts }); },
    inspectVolume: async (name: string) => volumes.get(name) ?? null,
    removeVolume: async (name: string) => {
      const used = [...containers.values()].some((c) => ((c.body.HostConfig as Obj | undefined)?.Mounts as Obj[] | undefined ?? []).some((m) => m.Source === name));
      if (used) throw new EngineError(409, 'conflict');
      calls.push(`removeVolume ${name}`);
      volumes.delete(name);
    },
    connect: async (network: string, id: string) => { const c = find(id)!; calls.push(`connect ${network}`); c.networks.push(network); },
  } as unknown as Engine;

  const deps = {
    engine, updater, repo: 'LetsManu/friendflix', now: () => clock.t, print: () => undefined,
    facts: async () => cfg.facts,
    // the real guard runs on every helper body the jobs build
    helper: async (_e: Engine, req: { body: Obj }, expect: Parameters<typeof assertHelper>[1]) => {
      assertHelper(req.body, expect);
      const cmd = req.body.Cmd as string[];
      const call = { verb: cmd[2]!, args: cmd.slice(3), mounts: ((req.body.HostConfig as Obj).Mounts as Obj[] | undefined) ?? [], user: String(req.body.User) };
      calls.push(`helper ${call.verb}${call.args[0] && call.verb === 'check' ? ` ${call.args[0]}` : ''}`);
      helperCalls.push(call);
      const a = cfg.answer(call);
      if (a instanceof Error) throw a;
      return a;
    },
    pins: async () => cfg.pins,
    verify: async (ref: string) => { verified.push(ref); return cfg.verify; },
    sleep: async (ms: number) => { clock.t += ms; },
  };
  const helperCalls: HelperCall[] = [];
  const verified: string[] = [];
  const jobs = new MediaJobs(deps);

  // the pinned images as the engine sees them after the pull
  images.set(ferroPin().image, { id: `sha256:${'9'.repeat(64)}`, repoDigests: [ferroPin().image], labels: { [UPSTREAM_LABEL]: 'v1.5.1' }, env: ['PATH=/usr/bin'], entrypoint: null, cmd: null, volumes: [], user: '' });
  const jellyImage = (p: Pin): void => { images.set(p.image, { id: `sha256:${'8'.repeat(64)}`, repoDigests: [`jellyfin/jellyfin@${p.digest}`], labels: {}, env: ['PATH=/usr/bin'], entrypoint: null, cmd: null, volumes: ['/config', '/cache'], user: '' }); };
  jellyImage(jellyPin('10.11.3'));
  jellyImage(jellyPin('10.11.2', '2'));
  // a confirmed base
  volumes.set(baseVolume(BASE), { labels: { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': PROJECT }, options: { type: 'none', o: 'bind,ro', device: BASE } });
  volumes.set(N.backup, { labels: { 'friendflix.managed': 'mediaserver-backup' }, options: {} });
  updater.updateMedia((m) => { m.base = { path: BASE, volume: baseVolume(BASE), confirmedAt: new Date(T0).toISOString(), previousVolume: null }; });

  /** a running managed container built from the template, recorded in the state */
  function existing(spec: DesiredSpec, pin: Pin, upstream: string, x: { run?: boolean; host?: Obj } = {}): C {
    const body = containerSpec(spec, { project: PROJECT, image: pin.image, renderGids: [], baseVolume: baseVolume(BASE) }).body;
    const id = (next++).toString(16).padStart(64, '0');
    const c: C = { id, name: N.container, body, running: x.run !== false, health: 'healthy', networks: [`${PROJECT}_media`, ...(spec.egress ? [`${PROJECT}_egress`] : [])], host: x.host ?? {} };
    containers.set(id, c);
    for (const v of [N.data(spec.kind), N.cache(spec.kind)]) volumes.set(v, { labels: { 'friendflix.managed': v.endsWith('cache') ? 'mediaserver-cache' : 'mediaserver-data', 'friendflix.project': PROJECT }, options: {} });
    updater.updateMedia((m) => {
      m.container = { id, kind: spec.kind, digest: pin.digest, upstream, specHash: String((body.Labels as Obj)['friendflix.spec']) };
      m.desired = { ...spec, run: x.run !== false };
    });
    return c;
  }

  return {
    jobs, deps, updater, store, clock, calls, created, removedWith, containers, volumes, images, cfg, helperCalls, verified, existing, find, jellyImage,
    media: (): MediaState => updater.mediaState(),
    /** the engine calls that change something, without helper runs */
    changes: (): string[] => calls.filter((c) => !c.startsWith('helper ')),
    run: async (op: Parameters<MediaJobs['start']>[0]) => {
      const r = jobs.start(op);
      if (!r.ok) throw new Error(`not started: ${r.error}`);
      await updater.idle();
      return updater.snapshot().lastJob!;
    },
  };
}

describe('apply', () => {
  it('first apply creates volumes, container and egress, then is healthy', async () => {
    const w = world();
    const job = await w.run({ op: 'apply', spec: SPEC, firstRun: { password: PASSWORD } });
    expect(job).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded', error: null });
    expect(w.changes()).toEqual([
      `pull ${ferroPin().image}`, `createVolume ${N.data('ferrofin')}`, `createVolume ${N.cache('ferrofin')}`,
      `create ${N.container}`, `connect ${PROJECT}_egress`, `start ${N.container}`,
    ]);
    expect(job.media!.steps).toEqual({ check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'skipped', create: 'ok', start: 'ok', health: 'ok', rollback: 'skipped' });
    expect(w.verified).toEqual([ferroPin().image]);
    const m = w.media();
    const main = w.find(N.container)!;
    expect(m.container).toEqual({ id: main.id, kind: 'ferrofin', digest: ferroPin().digest, upstream: 'v1.5.1', specHash: (main.body.Labels as Obj)['friendflix.spec'] });
    expect(m.desired).toEqual({ ...SPEC, run: true });
    expect(m.pinSource).toBe(SOURCE);
    expect(m.lastError).toBeNull();
    // Ferrofin's first create carries the administrator, or it would seed a passwordless one
    expect(main.body.Env).toEqual(expect.arrayContaining(['FERROFIN_ADMIN_USER=friendflix-admin', `FERROFIN_ADMIN_PASSWORD=${PASSWORD}`]));
    expect(JSON.stringify(w.updater.log.tail(200))).not.toContain(PASSWORD);
    expect(JSON.stringify(w.store.state)).not.toContain(PASSWORD);
    expect(w.updater.log.tail(200).join('\n')).toContain('media server created');
    // the media volumes are labelled, the volume creates run the helpers as the chosen user
    expect(w.volumes.get(N.data('ferrofin'))!.labels).toEqual({ 'friendflix.managed': 'mediaserver-data', 'friendflix.project': PROJECT });
    expect(w.helperCalls.every((c) => c.user === '1000:1000')).toBe(true);
  });

  it('jellyfin seeds its fresh volumes', async () => {
    const w = world();
    const job = await w.run({ op: 'apply', spec: JSPEC });
    expect(job.state).toBe('succeeded');
    expect(w.changes()).toEqual([
      `pull ${jellyPin('10.11.3').image}`,
      `createVolume ${N.data('jellyfin')}`, 'create helper', 'remove helper',
      `createVolume ${N.cache('jellyfin')}`, 'create helper', 'remove helper',
      `create ${N.container}`, `start ${N.container}`,
    ]);
    const seeds = w.created.filter((c) => c.name.startsWith(`${PROJECT}-mediahelper-`));
    expect(seeds).toHaveLength(2);
    for (const s of seeds) {
      expect(s.body.Labels).toEqual({ 'friendflix.managed': 'helper', 'friendflix.project': PROJECT });
      expect(s.body.Cmd).toEqual(['true']);
      expect(s.body.Image).toBe(jellyPin('10.11.3').image);
    }
    expect(((seeds[0]!.body.HostConfig as Obj).Mounts as Obj[])[0]).toMatchObject({ Source: N.data('jellyfin'), Target: '/tmp' });
    expect(((seeds[1]!.body.HostConfig as Obj).Mounts as Obj[])[0]).toMatchObject({ Source: N.cache('jellyfin'), Target: '/tmp' });
    expect(w.removedWith.filter((r) => r.name === 'helper')).toEqual([{ name: 'helper', o: { volumes: true } }, { name: 'helper', o: { volumes: true } }]);
    // jellyfin: verified by the pulled image's repo digest, never through cosign
    expect(w.verified).toEqual([]);
    expect(w.media().container).toMatchObject({ kind: 'jellyfin', upstream: '10.11.3' });
    // Jellyfin gets no password variable
    expect(JSON.stringify(w.find(N.container)!.body.Env)).not.toContain('PASSWORD');
  });

  it('recreate keeps the old container until the new one is healthy', async () => {
    const w = world();
    const old = w.existing(SPEC, ferroPin(), 'v1.5.1');
    const spec = { ...SPEC, folders: [...SPEC.folders, { rel: 'Musik', target: '/media/musik' }] };
    const job = await w.run({ op: 'apply', spec });
    expect(job.state).toBe('succeeded');
    expect(w.changes()).toEqual([
      `pull ${ferroPin().image}`, `stop ${N.container}`, `rename ${N.container} -> ${N.old}`, `create ${N.container}`,
      `connect ${PROJECT}_egress`, `start ${N.container}`, `remove ${N.old}`,
    ]);
    expect(w.containers.has(old.id)).toBe(false);
    // the media server container is never removed with its volumes
    expect(w.removedWith).toEqual([{ name: N.old, o: {} }]);
    expect(w.calls.some((c) => c.startsWith('removeVolume'))).toBe(false);
    expect(w.media().container!.id).toBe(w.find(N.container)!.id);
    expect(w.media().desired!.folders).toHaveLength(3);
    // a recreate without an upstream change takes no snapshot; the existing data volume's owner was checked
    expect(job.media!.steps.snapshot).toBe('skipped');
    expect(w.helperCalls.find((c) => c.verb === 'check' && c.args[0] === 'data')!.mounts).toEqual([{ Type: 'volume', Source: N.data('ferrofin'), Target: '/data', ReadOnly: true, VolumeOptions: { NoCopy: true } }]);
  });

  it('a failed start brings the old one back', async () => {
    const w = world();
    const old = w.existing(SPEC, ferroPin(), 'v1.5.1');
    w.cfg.failStart = (c) => c.id !== old.id;
    const job = await w.run({ op: 'apply', spec: { ...SPEC, tz: 'Europe/Vienna' } });
    expect(job).toMatchObject({ state: 'rolled_back', error: 'start_failed' });
    expect(job.media!.steps).toMatchObject({ create: 'ok', start: 'failed', health: 'skipped', rollback: 'ok' });
    expect(w.changes().slice(-7)).toEqual([
      `create ${N.container}`, `connect ${PROJECT}_egress`, `start ${N.container}`, `stop ${N.container}`, `remove ${N.container}`, `rename ${N.old} -> ${N.container}`, `start ${N.container}`,
    ]);
    expect(w.find(N.container)!.id).toBe(old.id);
    expect(w.find(N.container)!.running).toBe(true);
    expect(w.media().container!.id).toBe(old.id);
    expect(w.media().desired!.tz).toBe('Europe/Berlin');
    expect(w.media().lastError).toBe('start_failed');
    expect(w.updater.log.tail(200).join('\n')).toContain('media server restored to the previous container');
  });

  it('snapshot before an upstream change and restored on failure', async () => {
    const w = world();
    w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2');
    w.cfg.healthOf = (c) => (c.body.Image === jellyPin('10.11.3').image ? 'unhealthy' : 'healthy');
    const job = await w.run({ op: 'apply', spec: JSPEC });
    expect(job).toMatchObject({ state: 'rolled_back', error: 'unhealthy' });
    expect(job.media!.steps).toMatchObject({ snapshot: 'ok', health: 'failed', rollback: 'ok' });
    const seq = w.calls.filter((c) => !c.startsWith('helper check'));
    expect(seq).toEqual([
      `pull ${jellyPin('10.11.3').image}`, `stop ${N.container}`, 'helper backup', `rename ${N.container} -> ${N.old}`, `create ${N.container}`, `start ${N.container}`,
      `stop ${N.container}`, `remove ${N.container}`, 'helper restore', `rename ${N.old} -> ${N.container}`, `start ${N.container}`,
    ]);
    const backup = w.helperCalls.find((c) => c.verb === 'backup')!;
    const id = backup.args[0]!;
    expect(id).toBe('jellyfin-20261117-1402-10.11.2');
    expect(backup.args).toEqual([id, '0', 'jellyfin', '10.11.2']);
    expect(backup.mounts).toEqual([
      { Type: 'volume', Source: N.data('jellyfin'), Target: '/data', ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: N.backup, Target: '/backups', ReadOnly: false },
    ]);
    const restore = w.helperCalls.find((c) => c.verb === 'restore')!;
    expect(restore.args).toEqual([id, 'jellyfin']);
    expect(restore.mounts).toEqual([
      { Type: 'volume', Source: N.data('jellyfin'), Target: '/data', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: N.backup, Target: '/backups', ReadOnly: true },
    ]);
    expect(w.media().backups).toEqual([{ id, kind: 'jellyfin', upstream: '10.11.2', at: new Date(T0).toISOString(), tag: 'auto', size: 4096 }]);
    expect(w.media().container!.upstream).toBe('10.11.2');
  });

  it('downgrade is refused before anything stops', async () => {
    const w = world();
    const old = w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    w.cfg.pins = { source: SOURCE, pins: { jellyfin: jellyPin('10.11.2', '2') }, invalid: [] };
    const job = await w.run({ op: 'apply', spec: JSPEC });
    expect(job).toMatchObject({ state: 'failed', error: 'downgrade_refused' });
    expect(w.changes()).toEqual([`pull ${jellyPin('10.11.2', '2').image}`]);
    expect(w.find(N.container)).toMatchObject({ id: old.id, running: true });
    expect(w.media().lastError).toBe('downgrade_refused');
    expect(w.updater.log.tail(200).join('\n')).toContain('media downgrade_refused');
  });

  it('apply with a vanished folder fails at check and keeps the old container', async () => {
    const w = world();
    const old = w.existing(SPEC, ferroPin(), 'v1.5.1');
    w.cfg.answer = (c) => (c.verb === 'check' && c.args[0] === 'folders'
      ? { folders: [{ rel: 'Filme', code: 'ok', read: true, watch: true, maxWatches: null }, { rel: 'Serien', code: 'folder_missing', read: false, watch: false, maxWatches: null }] }
      : { owner: 1000 });
    const job = await w.run({ op: 'apply', spec: SPEC });
    expect(job).toMatchObject({ state: 'failed', error: 'folder_missing' });
    expect(job.media!.steps).toMatchObject({ check: 'failed', pull: 'skipped', create: 'skipped', rollback: 'skipped' });
    expect(w.changes()).toEqual([]);
    expect(w.find(N.container)).toMatchObject({ id: old.id, running: true });
    // the log names the code, never the folder
    expect(w.updater.log.tail(200).join('\n')).not.toContain('Serien');
  });

  it('a foreign container with our name is never touched', async () => {
    const w = world();
    const foreign: C = { id: 'f'.repeat(64), name: N.container, body: { Image: 'nginx', HostConfig: { NetworkMode: 'bridge' } }, running: true, health: null, networks: ['bridge'], host: {} };
    w.containers.set(foreign.id, foreign);
    for (const op of [{ op: 'apply', spec: SPEC }, { op: 'remove', data: true }, { op: 'stop' }] as const) {
      if (op.op === 'stop') w.updater.updateMedia((m) => { m.desired = { ...SPEC, run: true }; });
      const job = await w.run(op);
      expect(job).toMatchObject({ state: 'failed', error: 'name_taken' });
    }
    expect(w.changes()).toEqual([]);
    expect(w.find(N.container)).toBe(foreign);
  });

  it('template violation is final', async () => {
    const w = world();
    // a render node with gid 0 would hand the media server the root group
    w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [{ node: 'renderD128', gid: 0, vendor: 'intel' }] } : okFolders(c));
    const job = await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri' } });
    expect(job).toMatchObject({ state: 'failed', error: 'template_violation' });
    expect(w.changes()).toEqual([]);
    expect(w.created).toEqual([]);
  });

  it('a guard refusal of a helper body is never read as a folder or GPU code', async () => {
    const w = world();
    // the helper runner's guard refuses the body (as runHelper does before anything is created): the folder check, the GPU check
    for (const verb of ['check', 'gpu']) {
      w.cfg.answer = (c) => (c.verb === verb ? new TemplateViolation('HostConfig.Mounts') : okFolders(c));
      const job = await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri' } });
      expect(job).toMatchObject({ state: 'failed', error: 'template_violation' });
    }
    expect(w.helperCalls.map((c) => c.verb)).toEqual(['check', 'check', 'gpu']);
    expect(w.changes()).toEqual([]);
  });

  it('a password for jellyfin is refused by the template before anything changes', async () => {
    const w = world();
    const job = await w.run({ op: 'apply', spec: JSPEC, firstRun: { password: PASSWORD } });
    expect(job).toMatchObject({ state: 'failed', error: 'template_violation' });
    expect(w.changes()).toEqual([]);
  });

  it('the inspect guard gets the recorded GPU choice (an nvidia default runtime)', async () => {
    const w = world({ facts: { nvidia: true } });
    const nv = { ...SPEC, gpu: 'nvidia' as const };
    w.existing(nv, ferroPin(), 'v1.5.1', { host: { Runtime: 'nvidia' } });
    expect(await w.run({ op: 'apply', spec: nv })).toMatchObject({ state: 'succeeded' });
    // the same runtime on a container recorded without the NVIDIA choice is not ours any more
    const v = world({ facts: { nvidia: true } });
    v.existing(SPEC, ferroPin(), 'v1.5.1', { host: { Runtime: 'nvidia' } });
    expect(await v.run({ op: 'apply', spec: nv })).toMatchObject({ state: 'failed', error: 'managed_tampered' });
  });

  it('render gids are re-read right before the create', async () => {
    const w = world();
    let gid = 993;
    w.cfg.answer = (c) => {
      if (c.verb === 'gpu') return { nodes: [{ node: 'renderD128', gid: gid++, vendor: 'intel' }] };
      return okFolders(c);
    };
    const job = await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri', egress: false } });
    expect(job.state).toBe('succeeded');
    expect(w.helperCalls.filter((c) => c.verb === 'gpu')).toHaveLength(2);
    expect((w.find(N.container)!.body.HostConfig as Obj).GroupAdd).toEqual(['994']);
  });
});

describe('codes from check', () => {
  const tamperedHost = { PortBindings: { '8096/tcp': [{ HostIp: '', HostPort: '8096' }] } };
  const cases: Array<[string, (w: ReturnType<typeof world>) => DesiredSpec]> = [
    ['no_base', (w) => { w.updater.updateMedia((m) => { m.base = null; }); return SPEC; }],
    ['base_missing', (w) => { w.volumes.delete(baseVolume(BASE)); return SPEC; }],
    ['base_missing', (w) => { w.cfg.answer = () => new StepError('helper_failed'); return SPEC; }],
    ['folder_symlink', (w) => { w.cfg.answer = () => ({ folders: [{ rel: 'Filme', code: 'folder_symlink' }, { rel: 'Serien', code: 'ok' }] }); return SPEC; }],
    ['folder_unreadable', (w) => { w.cfg.answer = () => ({ error: 'folder_unreadable' }); return SPEC; }],
    ['folder_nested', () => ({ ...SPEC, folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Filme/Kinder', target: '/media/kinder' }] })],
    ['too_many_folders', () => ({ ...SPEC, folders: Array.from({ length: 21 }, (_, i) => ({ rel: `F${i}`, target: `/media/f${i}` })) })],
    ['folder_missing', () => ({ ...SPEC, folders: [] })],
    ['gpu_missing', (w) => { w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [] } : okFolders(c)); return { ...SPEC, gpu: 'dri' }; }],
    ['nvidia_missing', () => ({ ...SPEC, gpu: 'nvidia' })],
    ['engine_old', (w) => { w.cfg.facts = { ...FACTS, reason: 'engine_old' }; return SPEC; }],
    ['no_logs', (w) => { w.cfg.facts = { ...FACTS, reason: 'no_logs' }; return SPEC; }],
    ['no_project', (w) => { w.cfg.facts = { ...FACTS, reason: 'no_project', project: null }; return SPEC; }],
    ['no_network', (w) => { w.cfg.facts = { ...FACTS, reason: 'no_network' }; return SPEC; }],
    ['no_network', (w) => { w.cfg.facts = { ...FACTS, egressNetwork: null }; return SPEC; }],
    ['name_taken', (w) => { w.existing(SPEC, ferroPin(), 'v1.5.1'); w.containers.set('9'.repeat(64), { id: '9'.repeat(64), name: N.old, body: { Image: 'x' }, running: false, health: null, networks: [], host: {} }); return SPEC; }],
    ['managed_tampered', (w) => { w.existing(SPEC, ferroPin(), 'v1.5.1', { host: tamperedHost }); return SPEC; }],
    ['arch_unsupported', (w) => { w.cfg.facts = { ...FACTS, arch: 'arm64' }; return SPEC; }],
    ['image_missing', (w) => { w.cfg.pins = { source: SOURCE, pins: { jellyfin: jellyPin('10.11.3') }, invalid: [] }; return SPEC; }],
    ['pin_invalid', (w) => { w.cfg.pins = { source: SOURCE, pins: { jellyfin: jellyPin('10.11.3') }, invalid: ['ferrofin'] }; return SPEC; }],
    ['image_missing', (w) => { w.cfg.pins = { error: 'no_backend' }; return SPEC; }],
    ['verify_failed', (w) => { w.cfg.pins = { error: 'verify_failed' }; return SPEC; }],
    ['uid_unsupported', () => ({ ...SPEC, uid: 0 })],
    ['uid_mismatch', (w) => { w.existing(SPEC, ferroPin(), 'v1.5.1'); w.cfg.answer = (c) => (c.args[0] === 'data' ? { owner: 1234 } : okFolders(c)); return SPEC; }],
  ];
  for (const [code, setup] of cases) {
    it(`${code}: nothing pulled, nothing created`, async () => {
      const w = world();
      const spec = setup(w);
      const job = await w.run({ op: 'apply', spec });
      expect(job).toMatchObject({ state: 'failed', error: code });
      expect(job.media!.steps.check).toBe('failed');
      expect(w.calls.filter((c) => c.startsWith('pull') || c.startsWith('create') || c.startsWith('stop'))).toEqual([]);
      expect(w.media().lastError).toBe(code);
    });
  }

  it('a jellyfin image whose repo digest does not match is not verified', async () => {
    const w = world();
    w.images.set(jellyPin('10.11.3').image, { ...w.images.get(jellyPin('10.11.3').image)!, repoDigests: [`jellyfin/jellyfin@sha256:${'7'.repeat(64)}`] });
    const job = await w.run({ op: 'apply', spec: JSPEC });
    expect(job).toMatchObject({ state: 'failed', error: 'verify_failed' });
    expect(w.calls.filter((c) => c.startsWith('create'))).toEqual([]);
  });

  it('ferrofin without a cosign signature is not created', async () => {
    const w = world();
    w.cfg.verify = false;
    const job = await w.run({ op: 'apply', spec: SPEC });
    expect(job).toMatchObject({ state: 'failed', error: 'verify_failed' });
    expect(job.media!.steps).toMatchObject({ pull: 'ok', verify: 'failed' });
    expect(w.calls.filter((c) => c.startsWith('create'))).toEqual([]);
  });

  it('a failed pull changes nothing', async () => {
    const w = world();
    w.cfg.pull = async () => { throw new EngineError(500, 'pull_failed'); };
    const job = await w.run({ op: 'apply', spec: SPEC });
    expect(job).toMatchObject({ state: 'failed', error: 'pull_failed' });
    expect(w.media().pinSource).toBe(SOURCE);
  });
});

describe('start, stop, restart, update', () => {
  it('start, stop, restart set desired.run', async () => {
    const w = world();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1');
    let job = await w.run({ op: 'stop' });
    expect(job).toMatchObject({ action: 'mediaserver-stop', state: 'succeeded' });
    expect(w.changes()).toEqual([`stop ${N.container}`]);
    expect(w.media().desired!.run).toBe(false);
    expect(c.running).toBe(false);
    job = await w.run({ op: 'start' });
    expect(job).toMatchObject({ action: 'mediaserver-start', state: 'succeeded' });
    expect(w.media().desired!.run).toBe(true);
    expect(c.running).toBe(true);
    w.calls.length = 0;
    job = await w.run({ op: 'restart' });
    expect(job).toMatchObject({ action: 'mediaserver-restart', state: 'succeeded' });
    expect(w.changes()).toEqual([`stop ${N.container}`, `start ${N.container}`]);
    expect(w.media().desired!.run).toBe(true);
  });

  it('start refuses a tampered container, stop still narrows', async () => {
    const w = world();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1', { run: false, host: { PortBindings: { '8096/tcp': [{ HostPort: '8096' }] } } });
    expect(await w.run({ op: 'start' })).toMatchObject({ state: 'failed', error: 'managed_tampered' });
    expect(c.running).toBe(false);
    c.running = true;
    expect(await w.run({ op: 'stop' })).toMatchObject({ state: 'succeeded' });
    expect(c.running).toBe(false);
  });

  it('start of a missing container recreates it', async () => {
    const w = world();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1', { run: false });
    w.containers.delete(c.id);
    const job = await w.run({ op: 'start' });
    expect(job.state).toBe('succeeded');
    expect(w.find(N.container)!.running).toBe(true);
    expect(w.media().desired!.run).toBe(true);
  });

  it('nothing to act on without a set-up server', () => {
    const w = world();
    for (const op of ['start', 'restart', 'update', 'finish-setup'] as const) expect(w.jobs.start({ op })).toEqual({ ok: false, error: 'no_target' });
  });

  it('update keeps a stopped server stopped', async () => {
    const w = world();
    w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2', { run: false });
    let job = await w.run({ op: 'update' });
    expect(job).toMatchObject({ action: 'mediaserver-update', state: 'succeeded' });
    expect(Object.values(job.media!.steps).every((s) => s === 'skipped')).toBe(true);
    expect(w.changes()).toEqual([]);
    expect(w.media().desired!.run).toBe(false);
    expect(w.updater.log.tail(200).join('\n')).toContain('media server stopped: update skipped');

    w.updater.updateMedia((m) => { m.desired!.run = true; });
    w.find(N.container)!.running = true;
    job = await w.run({ op: 'update' });
    expect(job.state).toBe('succeeded');
    expect(w.changes()).toContain(`create ${N.container}`);
    expect(w.media()).toMatchObject({ desired: { run: true }, container: { upstream: '10.11.3', digest: jellyPin('10.11.3').digest }, pinSource: SOURCE });
  });

  it('a recreate of a stopped server leaves the new one stopped', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1', { run: false });
    const job = await w.run({ op: 'finish-setup' });
    expect(job).toMatchObject({ action: 'mediaserver-finish', state: 'succeeded' });
    expect(job.media!.steps).toMatchObject({ create: 'ok', start: 'skipped', health: 'skipped' });
    expect(w.find(N.container)!.running).toBe(false);
    expect(w.media().desired!.run).toBe(false);
  });
});

describe('remove', () => {
  it('remove clears a tampered container', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1', { host: { PortBindings: { '8096/tcp': [{ HostIp: '', HostPort: '8096' }] } } });
    const job = await w.run({ op: 'remove', data: false });
    expect(job).toMatchObject({ action: 'mediaserver-remove', state: 'succeeded' });
    expect(w.changes()).toEqual([`stop ${N.container}`, `remove ${N.container}`]);
    expect(w.removedWith).toEqual([{ name: N.container, o: {} }]);
    expect(w.volumes.has(N.data('ferrofin'))).toBe(true);
  });

  it('remove keeps data unless asked', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    let job = await w.run({ op: 'remove', data: false });
    expect(job.state).toBe('succeeded');
    expect(w.find(N.container)).toBeUndefined();
    for (const v of [N.data('ferrofin'), N.cache('ferrofin'), baseVolume(BASE), N.backup]) expect(w.volumes.has(v)).toBe(true);
    expect(w.media()).toMatchObject({ desired: null, container: null, base: { path: BASE } });

    w.existing(SPEC, ferroPin(), 'v1.5.1');
    job = await w.run({ op: 'remove', data: true });
    expect(job.state).toBe('succeeded');
    expect(w.volumes.has(N.data('ferrofin'))).toBe(false);
    expect(w.volumes.has(N.cache('ferrofin'))).toBe(false);
    for (const v of [baseVolume(BASE), N.backup]) expect(w.volumes.has(v)).toBe(true);
    expect(w.media()).toMatchObject({ desired: null, container: null });
  });

  it('remove never deletes a volume that is not ours', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    w.volumes.set(N.data('ferrofin'), { labels: {}, options: {} });
    const job = await w.run({ op: 'remove', data: true });
    expect(job.state).toBe('succeeded');
    expect(w.volumes.has(N.data('ferrofin'))).toBe(true);
    expect(w.volumes.has(N.cache('ferrofin'))).toBe(false);
  });
});

describe('finish-setup and hdr-test', () => {
  it('finish-setup recreates without the password', async () => {
    const w = world();
    await w.run({ op: 'apply', spec: SPEC, firstRun: { password: PASSWORD } });
    const first = w.find(N.container)!;
    const job = await w.run({ op: 'finish-setup' });
    expect(job).toMatchObject({ action: 'mediaserver-finish', state: 'succeeded' });
    const second = w.find(N.container)!;
    expect(second.id).not.toBe(first.id);
    expect(JSON.stringify(second.body.Env)).not.toContain('FERROFIN_ADMIN_PASSWORD');
    expect((second.body.Labels as Obj)['friendflix.spec']).not.toBe((first.body.Labels as Obj)['friendflix.spec']);
    expect(w.media().container!.specHash).toBe((second.body.Labels as Obj)['friendflix.spec']);
    expect(w.media().desired!.run).toBe(true);
  });

  it('hdr-test records pass and fail per test', async () => {
    const w = world();
    const job = await w.run({ op: 'hdr-test', kind: 'ferrofin' });
    expect(job).toMatchObject({ action: 'mediaserver-hdr-test', state: 'succeeded' });
    expect(w.media().hdr).toEqual({ kind: 'ferrofin', opencl: 'pass', qsv: 'fail', at: new Date(T0).toISOString() });
    const runs = w.created.filter((c) => c.body.Entrypoint);
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect((r.body.HostConfig as Obj).NetworkMode).toBe('none');
      expect(r.body.Image).toBe(ferroPin().image);
      expect((r.body.HostConfig as Obj).GroupAdd).toEqual(['993']);
    }
    expect(w.calls).toContain(`pull ${ferroPin().image}`);
    expect(w.verified).toEqual([ferroPin().image]);
    // an hdr test is no deploy: the pin source stays unread
    expect(w.media().pinSource).toBeNull();

    w.cfg.hdr = { exit1: 1, lines2: ['RESULT qsv PASS h264 yuv420p bt709'] };
    await w.run({ op: 'hdr-test', kind: 'ferrofin' });
    expect(w.media().hdr).toMatchObject({ opencl: 'fail', qsv: 'pass' });
  });

  it('hdr-test needs a render node', async () => {
    const w = world();
    w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [] } : {});
    expect(await w.run({ op: 'hdr-test', kind: 'jellyfin' })).toMatchObject({ state: 'failed', error: 'gpu_missing' });
    expect(w.created).toEqual([]);
  });
});

describe('base change and the job lock', () => {
  it('confirm on a new base with a container starts the recreate', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    const printed: string[] = [];
    const svc = new MediaService({ ...w.deps, print: (l) => { printed.push(l); } }, w.jobs);
    w.cfg.answer = (c) => {
      if (c.verb === 'check' && c.args[0] === 'base') return { exists: true, dir: true, listable: true, looksSystem: false };
      if (c.verb === 'check' && c.args[0] === 'data') return { owner: 1000 };
      return okFolders(c);
    };
    expect(await svc.request('/srv/neu')).toMatchObject({ ok: true });
    const code = /enter the code ([0-9A-Z-]{14}) in Admin/.exec(printed[0]!)![1]!;
    const r = await svc.confirm(code);
    expect(r).toMatchObject({ result: 'ok', path: '/srv/neu', kept: ['Filme', 'Serien'], dropped: [], job: { action: 'mediaserver-apply', state: 'running' } });
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded' });
    const mounts = (w.find(N.container)!.body.HostConfig as Obj).Mounts as Obj[];
    expect(mounts.filter((m) => String(m.Target).startsWith('/media/')).every((m) => m.Source === baseVolume('/srv/neu'))).toBe(true);
    // the old base volume goes once nothing uses it
    expect(w.volumes.has(baseVolume(BASE))).toBe(false);
    expect(w.calls).toContain(`removeVolume ${baseVolume(BASE)}`);
    expect(w.media().base).toMatchObject({ path: '/srv/neu', volume: baseVolume('/srv/neu'), previousVolume: null });
  });

  it('a confirm keeps a stopped server stopped', async () => {
    const w = world();
    w.existing(SPEC, ferroPin(), 'v1.5.1', { run: false });
    const printed: string[] = [];
    const svc = new MediaService({ ...w.deps, print: (l) => { printed.push(l); } }, w.jobs);
    w.cfg.answer = (c) => (c.args[0] === 'base' ? { exists: true, dir: true, listable: true, looksSystem: false } : c.args[0] === 'data' ? { owner: 1000 } : okFolders(c));
    await svc.request('/srv/neu');
    await svc.confirm(/enter the code ([0-9A-Z-]{14}) in Admin/.exec(printed[0]!)![1]!);
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded' });
    expect(w.find(N.container)!.running).toBe(false);
    expect(w.media().desired!.run).toBe(false);
  });

  it('busy', async () => {
    const w = world();
    let release!: () => void;
    w.cfg.pull = () => new Promise<void>((r) => { release = r; });
    expect(w.jobs.start({ op: 'apply', spec: SPEC })).toMatchObject({ ok: true });
    expect(w.jobs.start({ op: 'stop' })).toEqual({ ok: false, error: 'busy' });
    expect(w.jobs.start({ op: 'remove', data: false })).toEqual({ ok: false, error: 'busy' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob!.state).toBe('succeeded');
  });

  it('the job state survives in the state file without secrets', async () => {
    const w = world();
    await w.run({ op: 'apply', spec: SPEC, firstRun: { password: PASSWORD } });
    const saved = w.store.state.media as MediaState;
    expect(saved.desired as Desired).toEqual({ ...SPEC, run: true });
    expect(saved.container!.kind as Kind).toBe('ferrofin');
  });
});
