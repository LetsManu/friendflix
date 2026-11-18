// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** the fake Docker world of the media server tests: an engine that keeps containers, volumes and images by name, the real guard on every helper body */
import { createHash } from 'node:crypto';
import { Updater, type Ops } from '../src/job.js';
import { EngineError, type Engine } from '../src/mediaserver/engine.js';
import type { EngineFacts } from '../src/mediaserver/facts.js';
import { assertHelper } from '../src/mediaserver/guard.js';
import { MediaJobs } from '../src/mediaserver/jobs.js';
import type { Pin, PinRead } from '../src/mediaserver/pins.js';
import { containerSpec, names } from '../src/mediaserver/template.js';
import type { DesiredSpec } from '../src/mediaserver/types.js';
import { DEFAULT_STATE, memoryStore, type MediaState, type State } from '../src/state.js';

export type Obj = Record<string, unknown>;
export const T0 = Date.UTC(2026, 10, 17, 14, 2, 0);
export const PROJECT = 'friendflix';
export const N = names(PROJECT);
export const SELF = `sha256:${'a'.repeat(64)}`;
export const SOURCE = `sha256:${'b'.repeat(64)}`;
export const UPSTREAM_LABEL = 'io.github.letsmanu.friendflix.mediaserver.ferrofin';
export const sha8 = (p: string): string => createHash('sha256').update(p).digest('hex').slice(0, 8);
export const baseVolume = (p: string): string => `${PROJECT}_mediaserver-base-${sha8(p)}`;
export const BASE = '/srv/media';
// a first-run password built from pieces (gitleaks)
export const PASSWORD = 'Pw' + 'x'.repeat(41);

export const ferroPin = (hex = 'f'): Pin => ({ kind: 'ferrofin', image: `ghcr.io/letsmanu/friendflix-mediaserver@sha256:${hex.repeat(64)}`, digest: `sha256:${hex.repeat(64)}`, upstream: null });
export const jellyPin = (upstream: string, hex = '1'): Pin => ({ kind: 'jellyfin', image: `docker.io/jellyfin/jellyfin@sha256:${hex.repeat(64)}`, digest: `sha256:${hex.repeat(64)}`, upstream });

export const FACTS: EngineFacts = {
  api: '1.47', logs: true, arch: 'amd64', nvidia: false, dockerRoot: '/var/lib/docker', project: PROJECT, mediaNetwork: `${PROJECT}_media`,
  egressNetwork: `${PROJECT}_egress`, stackDir: '/srv/friendflix', selfImage: SELF, reason: null,
};
export const SPEC: DesiredSpec = { kind: 'ferrofin', folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien', target: '/media/serien' }], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, tz: 'Europe/Berlin' };
export const JSPEC: DesiredSpec = { ...SPEC, kind: 'jellyfin', egress: false };

/** `status` overrides the Docker status (`restarting`, `dead`); `finishedAt` is State.FinishedAt (set by stop) */
export interface C { id: string; name: string; body: Obj; running: boolean; health: string | null; networks: string[]; host: Obj; status?: string; finishedAt?: string }
export interface HelperCall { verb: string; args: string[]; mounts: Obj[]; user: string }
export type Answer = Obj | Error;

export function okFolders(c: HelperCall): Obj {
  return { folders: (JSON.parse(c.args[1]!) as string[]).map((rel) => ({ rel, code: 'ok', read: true, watch: true, maxWatches: null })) };
}

export function world(o: { facts?: Partial<EngineFacts>; ops?: Ops; state?: Partial<State> } = {}) {
  const clock = { t: T0 };
  /** every changing engine call and every helper run, in order */
  const calls: string[] = [];
  const created: Array<{ name: string; body: Obj }> = [];
  const removedWith: Array<{ name: string; o: Obj }> = [];
  const containers = new Map<string, C>();
  const volumes = new Map<string, { labels: Record<string, string>; options: Record<string, string> }>();
  const images = new Map<string, { id: string; repoDigests: string[]; labels: Record<string, string>; env: string[]; entrypoint: string[] | null; cmd: string[] | null; volumes: string[]; user: string }>();
  const store = memoryStore({ ...DEFAULT_STATE, ...o.state });
  // the update job's media phase goes to the media jobs, as server.ts wires it
  const updater: Updater = new Updater(o.ops ?? ({} as Ops), store, { now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, healthIntervalMs: 5_000, healthTimeoutMs: 20_000, mediaPhase: (job) => jobs.phase(job) });
  let next = 1;
  const cfg = {
    pins: { source: SOURCE, pins: { ferrofin: ferroPin(), jellyfin: jellyPin('10.11.3') }, invalid: [] } as PinRead,
    verify: true,
    facts: { ...FACTS, ...o.facts } as EngineFacts,
    failStart: (_c: C): boolean => false,
    healthOf: (_c: C): string | null => 'healthy',
    pull: null as null | (() => Promise<void>),
    /** remove() of this container fails after the engine let it go (a removal already in progress answers an error) */
    failRemove: (_c: C): boolean => false,
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
      State: { Running: c.running, Status: c.status ?? (c.running ? 'running' : 'exited'), FinishedAt: c.finishedAt ?? '0001-01-01T00:00:00Z', ...(c.health && c.running ? { Health: { Status: c.health } } : {}) },
      Config: { Hostname: b.Hostname, User: b.User, Image: b.Image, Env: b.Env, Labels: b.Labels ?? {}, StopTimeout: b.StopTimeout, ...(c.health ? { Healthcheck: { Test: ['CMD', 'true'] } } : {}) },
      HostConfig: { ...hc, MaskedPaths: ['/proc/kcore'], ReadonlyPaths: ['/proc/sys'], ...c.host },
      Mounts: mounts.map((m) => ({ Type: 'volume', Name: m.Source, Source: `/var/lib/docker/volumes/${String(m.Source)}/_data`, Destination: m.Target, RW: m.ReadOnly !== true })),
      NetworkSettings: { Networks: Object.fromEntries(c.networks.map((n) => [n, {}])), Ports: {} },
    };
  }

  const engine = {
    inspectContainer: async (idOrName: string) => { const c = find(idOrName); return c ? inspect(c) : null; },
    listContainers: async (labels: Record<string, string>) => [...containers.values()]
      .filter((c) => Object.entries(labels).every(([k, v]) => (c.body.Labels as Obj | undefined)?.[k] === v))
      .map((c) => ({ id: c.id, names: [c.name], state: c.running ? 'running' : 'exited', labels: (c.body.Labels ?? {}) as Record<string, string> })),
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
    stop: async (id: string) => { const c = find(id)!; calls.push(`stop ${label(c)}`); c.running = false; c.finishedAt = new Date(clock.t).toISOString(); },
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
      if (cfg.failRemove(c)) throw new EngineError(409, 'conflict');
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
  const jobs: MediaJobs = new MediaJobs(deps);

  // the pinned images as the engine sees them after the pull
  images.set(ferroPin().image, { id: `sha256:${'9'.repeat(64)}`, repoDigests: [ferroPin().image], labels: { [UPSTREAM_LABEL]: 'v1.5.1' }, env: ['PATH=/usr/bin'], entrypoint: null, cmd: null, volumes: [], user: '' });
  const jellyImage = (p: Pin): void => { images.set(p.image, { id: `sha256:${'8'.repeat(64)}`, repoDigests: [`jellyfin/jellyfin@${p.digest}`], labels: {}, env: ['PATH=/usr/bin'], entrypoint: null, cmd: null, volumes: ['/config', '/cache'], user: '' }); };
  jellyImage(jellyPin('10.11.3'));
  jellyImage(jellyPin('10.11.2', '2'));
  // a confirmed base
  volumes.set(baseVolume(BASE), { labels: { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': PROJECT }, options: { type: 'none', o: 'bind,ro', device: BASE } });
  volumes.set(N.backup, { labels: { 'friendflix.managed': 'mediaserver-backup' }, options: {} });
  updater.updateMedia((m) => { m.base = { path: BASE, volume: baseVolume(BASE), confirmedAt: new Date(T0).toISOString(), previousVolume: null }; });

  /** a running managed container built from the template, recorded in the state (with the render gids it was built with) */
  function existing(spec: DesiredSpec, pin: Pin, upstream: string, x: { run?: boolean; host?: Obj; renderGids?: number[]; name?: string } = {}): C {
    const body = containerSpec(spec, { project: PROJECT, image: pin.image, renderGids: x.renderGids ?? [], baseVolume: baseVolume(BASE) }).body;
    const id = (next++).toString(16).padStart(64, '0');
    const c: C = { id, name: x.name ?? N.container, body, running: x.run !== false, health: 'healthy', networks: [`${PROJECT}_media`, ...(spec.egress ? [`${PROJECT}_egress`] : [])], host: x.host ?? {} };
    containers.set(id, c);
    for (const v of [N.data(spec.kind), N.cache(spec.kind)]) volumes.set(v, { labels: { 'friendflix.managed': v.endsWith('cache') ? 'mediaserver-cache' : 'mediaserver-data', 'friendflix.project': PROJECT }, options: {} });
    updater.updateMedia((m) => {
      m.container = { id, kind: spec.kind, digest: pin.digest, upstream, specHash: String((body.Labels as Obj)['friendflix.spec']) };
      m.desired = { ...spec, run: x.run !== false };
      m.renderGids = spec.gpu === 'dri' ? [...(x.renderGids ?? [])] : [];
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
