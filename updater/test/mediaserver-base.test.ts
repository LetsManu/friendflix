// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StepError } from '../src/docker.js';
import { Updater, type Ops } from '../src/job.js';
import { hashBaseCode } from '../src/mediaserver/code.js';
import { EngineError, type Engine } from '../src/mediaserver/engine.js';
import type { EngineFacts } from '../src/mediaserver/facts.js';
import { assertHelper } from '../src/mediaserver/guard.js';
import { redactLine } from '../src/mediaserver/logs.js';
import { MediaService, SYNC_HELPER_MS } from '../src/mediaserver/service.js';
import { DEFAULT_STATE, memoryStore, type Job } from '../src/state.js';

const T0 = Date.UTC(2026, 10, 17, 14, 2, 0);
const MIN = 60_000;
const IMAGE = `sha256:${'a'.repeat(64)}`;
const OLD_BASE = '/srv/old';
const sha8 = (p: string): string => createHash('sha256').update(p).digest('hex').slice(0, 8);
const volumeOf = (p: string): string => `friendflix_mediaserver-base-${sha8(p)}`;

const FACTS: EngineFacts = {
  api: '1.47', logs: true, arch: 'amd64', nvidia: true, dockerRoot: '/var/lib/docker', project: 'friendflix', mediaNetwork: 'friendflix_media', egressNetwork: 'friendflix_egress',
  stackDir: '/srv/friendflix', selfImage: IMAGE, reason: null,
};
const DESIRED = { kind: 'ferrofin' as const, folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien', target: '/media/serien' }], uid: 1000, gid: 1000, gpu: 'off' as const, mediaGid: null, egress: false, tz: 'Europe/Berlin', run: true };
const CONTAINER = { id: 'c'.repeat(64), kind: 'ferrofin' as const, digest: `sha256:${'d'.repeat(64)}`, upstream: '1.5.1', specHash: 'e'.repeat(64) };

type HelperCall = { verb: string; args: string[]; mounts: Array<Record<string, unknown>>; limit: number };
type Answer = Record<string, unknown> | Error;

function world(o: { facts?: Partial<EngineFacts>; answer?: (c: HelperCall) => Answer } = {}) {
  const clock = { t: T0 };
  const printed: string[] = [];
  const helperCalls: HelperCall[] = [];
  const created: unknown[] = [];
  const removed: string[] = [];
  const volumes = new Map<string, { labels: Record<string, string>; options: Record<string, string> }>();
  const store = memoryStore();
  const updater = new Updater({} as Ops, store, { now: () => clock.t });
  let logs: string[] = [];
  let labels: Record<string, string> | null = { 'friendflix.managed': 'mediaserver', 'friendflix.project': 'friendflix' };
  /** the volumes the containers under our names mount, and whether Docker refuses a volume removal */
  const mounted: string[] = [];
  const refuse = { removeVolume: false };
  const engine = {
    inspectVolume: async (name: string) => volumes.get(name) ?? null,
    createVolume: async (v: { Name: string; DriverOpts: Record<string, string>; Labels: Record<string, string> }) => { created.push(v); volumes.set(v.Name, { labels: v.Labels, options: v.DriverOpts }); },
    removeVolume: async (name: string) => {
      if (refuse.removeVolume) throw new EngineError(409, 'conflict');
      removed.push(name); volumes.delete(name);
    },
    inspectContainer: async () => (labels ? { Config: { Labels: labels }, HostConfig: { Mounts: mounted.map((Source) => ({ Type: 'volume', Source })) } } : null),
    logs: async () => logs,
  } as unknown as Engine;
  const answer = o.answer ?? ((c: HelperCall): Answer => {
    if (c.verb === 'check' && c.args[0] === 'base') return { exists: true, dir: true, listable: true, looksSystem: false };
    return { error: 'helper_failed' };
  });
  const svc = new MediaService({
    engine, updater, repo: 'LetsManu/friendflix', now: () => clock.t, print: (l) => { printed.push(l); },
    facts: async () => ({ ...FACTS, ...o.facts }),
    // the real guard runs on every body the service builds
    helper: async (_e, req, expect, limit) => {
      assertHelper(req.body, expect);
      const cmd = (req.body as { Cmd: string[] }).Cmd;
      const mounts = ((req.body as { HostConfig: { Mounts?: Array<Record<string, unknown>> } }).HostConfig.Mounts) ?? [];
      const call = { verb: cmd[2]!, args: cmd.slice(3), mounts, limit };
      helperCalls.push(call);
      const a = answer(call);
      if (a instanceof Error) throw a;
      return a;
    },
  });
  return {
    svc, updater, clock, printed, helperCalls, created, removed, volumes, store, mounted, refuse,
    setLogs: (l: string[]) => { logs = l; },
    setLabels: (l: Record<string, string> | null) => { labels = l; },
    /** the code of the last printed line */
    code: (): string => /enter the code ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}) in Admin/.exec(printed[printed.length - 1]!)![1]!,
  };
}

describe('base-request', () => {
  it('issues one code, logs one line to stdout only', async () => {
    const w = world();
    const r = await w.svc.request('/srv/media');
    expect(r).toEqual({ ok: true, expiresAt: new Date(T0 + 30 * MIN).toISOString(), warning: null });
    expect(w.printed).toHaveLength(1);
    expect(w.printed[0]).toMatch(/^FriendFlix media folder: to allow \/srv\/media as the media base folder, enter the code [0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4} in Admin \(valid until 14:32 UTC\)\.$/);
    const display = w.code();
    const normalized = display.replaceAll('-', '');
    for (const where of [JSON.stringify(w.updater.log.tail()), JSON.stringify(w.updater.snapshot()), JSON.stringify(w.updater.mediaState()), JSON.stringify(r), JSON.stringify(w.store.state)]) {
      expect(where).not.toContain(display);
      expect(where).not.toContain(normalized);
    }
    const pending = w.updater.mediaState().pending!;
    expect(pending.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.codeHash).toBe(hashBaseCode(normalized));
    expect(pending).toMatchObject({ path: '/srv/media', failures: 0, expiresAt: new Date(T0 + 30 * MIN).toISOString() });
    // the helper ran on a read-only bind of the path itself, within the synchronous limit
    expect(w.helperCalls).toEqual([{ verb: 'check', args: ['base'], mounts: [{ Type: 'bind', Source: '/srv/media', Target: '/base', ReadOnly: true }], limit: SYNC_HELPER_MS }]);
  });

  it('a base that looks like a system root issues no code', async () => {
    const w = world({ answer: () => ({ exists: true, dir: true, listable: true, looksSystem: true }) });
    expect(await w.svc.request('/srv/media')).toEqual({ ok: false, status: 400, error: 'path_refused' });
    expect(w.printed).toEqual([]);
    expect(w.updater.mediaState().pending).toBeNull();
  });

  it('refusals before any helper, then the helper findings', async () => {
    let answer: Answer = { exists: true, dir: false, listable: false, looksSystem: false };
    const w = world({ answer: () => answer });
    expect(await w.svc.request('/etc')).toEqual({ ok: false, status: 400, error: 'path_refused' });
    expect(await w.svc.request('srv/media')).toEqual({ ok: false, status: 400, error: 'path_invalid' });
    expect(await w.svc.request('/var/lib/docker/volumes')).toMatchObject({ error: 'path_refused' });
    expect(await w.svc.request('/srv/friendflix')).toMatchObject({ error: 'path_refused' });
    expect(w.helperCalls).toHaveLength(0);
    // not a directory
    expect(await w.svc.request('/srv/media')).toEqual({ ok: false, status: 409, error: 'base_missing' });
    // the bind source does not exist: the helper's create is refused (as an engine error, or already as a step error)
    answer = new EngineError(400, 'create_failed');
    expect(await w.svc.request('/srv/media')).toMatchObject({ error: 'base_missing' });
    answer = new StepError('create_failed');
    expect(await w.svc.request('/srv/media')).toMatchObject({ error: 'base_missing' });
    // other helper failures are not a missing folder
    answer = new StepError('helper_timeout');
    expect(await w.svc.request('/srv/media')).toMatchObject({ error: 'not_available' });
    answer = { error: 'helper_failed' };
    expect(await w.svc.request('/srv/media')).toMatchObject({ error: 'not_available' });
    answer = { exists: true };
    expect(await w.svc.request('/srv/media')).toMatchObject({ error: 'not_available' });
    expect(w.printed).toEqual([]);
    // a folder the container user cannot list is a warning, not a refusal
    answer = { exists: true, dir: true, listable: false, looksSystem: false };
    expect(await w.svc.request('/srv/media')).toMatchObject({ ok: true, warning: 'base_unreadable' });
    expect(w.printed).toHaveLength(1);
  });

  it('not available without a usable engine', async () => {
    for (const facts of [{ reason: 'no_logs' as const }, { project: null }, { selfImage: null }]) {
      const w = world({ facts });
      expect(await w.svc.request('/srv/media')).toEqual({ ok: false, status: 409, error: 'not_available' });
      expect(w.helperCalls).toHaveLength(0);
    }
  });

  it('rate limit 3 per 10 minutes', async () => {
    const w = world();
    for (let i = 0; i < 3; i++) { expect(await w.svc.request('/srv/media')).toMatchObject({ ok: true }); w.clock.t += 1000; }
    expect(await w.svc.request('/srv/media')).toEqual({ ok: false, status: 429, error: 'rate_limited' });
    expect(w.printed).toHaveLength(3);
    w.clock.t = T0 + 10 * MIN;
    expect(await w.svc.request('/srv/media')).toMatchObject({ ok: true });
  });

  it('concurrent requests cannot get past the limit while the helper is slow', async () => {
    const gate: Array<() => void> = [];
    const w = world({ answer: () => ({ exists: true, dir: true, listable: true, looksSystem: false }) });
    // a helper that answers late
    const slow = new MediaService({
      engine: {} as Engine, updater: w.updater, repo: 'LetsManu/friendflix', now: () => w.clock.t, print: (l) => { w.printed.push(l); },
      facts: async () => FACTS,
      helper: () => new Promise((res) => { gate.push(() => res({ exists: true, dir: true, listable: true, looksSystem: false })); }),
    });
    const all = Promise.all([1, 2, 3, 4].map(() => slow.request('/srv/media')));
    await new Promise((r) => setTimeout(r, 10));
    expect(gate).toHaveLength(3);
    gate.forEach((g) => g());
    const res = await all;
    expect(res.filter((x) => x.ok)).toHaveLength(3);
    expect(res.filter((x) => !x.ok)).toEqual([{ ok: false, status: 429, error: 'rate_limited' }]);
    expect(w.printed).toHaveLength(3);
    // a refused attempt gives its slot back
    const f = world({ answer: () => new StepError('helper_timeout') });
    for (let i = 0; i < 5; i++) expect(await f.svc.request('/srv/media')).toMatchObject({ error: 'not_available' });
  });

  it('one pending request; a new one replaces it', async () => {
    const w = world();
    await w.svc.request('/srv/media');
    const first = w.code();
    w.clock.t += 1000;
    await w.svc.request('/srv/other');
    expect(w.updater.mediaState().pending!.path).toBe('/srv/other');
    expect(await w.svc.confirm(first)).toEqual({ result: 'wrong' });
    expect(await w.svc.confirm(w.code())).toMatchObject({ result: 'ok', path: '/srv/other' });
  });
});

describe('base-confirm', () => {
  it('right, wrong, expired, locked', async () => {
    const w = world();
    expect(await w.svc.confirm('ABCD-EFGH-JKMN')).toEqual({ result: 'no_pending' });
    await w.svc.request('/srv/media');
    // typed in lower case with spaces
    const typed = w.code().toLowerCase().replaceAll('-', ' ');
    const r = await w.svc.confirm(typed);
    expect(r).toEqual({ result: 'ok', path: '/srv/media', kept: [], dropped: [], job: null });
    const m = w.updater.mediaState();
    expect(m.base).toMatchObject({ path: '/srv/media', volume: volumeOf('/srv/media'), previousVolume: null });
    expect(m.base!.volume).toMatch(/^friendflix_mediaserver-base-[0-9a-f]{8}$/);
    expect(new Date(m.base!.confirmedAt).toISOString()).toBe(m.base!.confirmedAt);
    expect(m.pending).toBeNull();
    // the base volume is a read-only bind volume of the path, labelled for this project
    expect(w.created).toEqual([{ Name: volumeOf('/srv/media'), Driver: 'local', DriverOpts: { type: 'none', o: 'bind,ro', device: '/srv/media' }, Labels: { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': 'friendflix' } }]);
    expect(JSON.stringify(w.updater.log.tail())).not.toContain(w.code());

    // four wrong attempts, the fifth locks and clears the request, the right code is then no use
    await w.svc.request('/srv/media');
    const right = w.code();
    for (let i = 0; i < 4; i++) {
      expect(await w.svc.confirm('0000-0000-000' + i)).toEqual({ result: 'wrong' });
      expect(w.updater.mediaState().pending!.failures).toBe(i + 1);
    }
    expect(await w.svc.confirm('0000-0000-0009')).toEqual({ result: 'locked' });
    expect(w.updater.mediaState().pending).toBeNull();
    expect(await w.svc.confirm(right)).toEqual({ result: 'no_pending' });

    // expired after 30 minutes (and cleared)
    w.clock.t += MIN;
    await w.svc.request('/srv/media');
    const late = w.code();
    w.clock.t += 30 * MIN;
    expect(await w.svc.confirm(late)).toEqual({ result: 'expired' });
    expect(await w.svc.confirm(late)).toEqual({ result: 'no_pending' });
  });

  it('a confirm while a job runs is busy and keeps the code', async () => {
    const w = world();
    await w.svc.request('/srv/media');
    let release!: () => void;
    expect(w.updater.startMediaJob('mediaserver-start', () => new Promise<void>((r) => { release = r; }))).toMatchObject({ ok: true });
    const before = w.updater.mediaState().pending;
    expect(await w.svc.confirm('0000-0000-0000')).toEqual({ error: 'busy' });
    expect(await w.svc.confirm(w.code())).toEqual({ error: 'busy' });
    expect(w.updater.mediaState().pending).toEqual(before);
    expect(w.updater.mediaState().base).toBeNull();
    release();
    await w.updater.idle();
    expect(await w.svc.confirm(w.code())).toMatchObject({ result: 'ok' });
  });

  it('changing the base keeps folders that exist below the new one', async () => {
    const w = world({
      answer: (c) => (c.verb === 'check' && c.args[0] === 'folders'
        ? { folders: [{ rel: 'Filme', code: 'ok', read: true, watch: true, maxWatches: null }, { rel: 'Serien', code: 'folder_missing', read: false, watch: false, maxWatches: null }] }
        : { exists: true, dir: true, listable: true, looksSystem: false }),
    });
    const oldVolume = volumeOf(OLD_BASE);
    w.updater.updateMedia((m) => {
      m.base = { path: OLD_BASE, volume: oldVolume, confirmedAt: new Date(T0 - MIN).toISOString(), previousVolume: null };
      m.desired = structuredClone(DESIRED);
    });
    await w.svc.request('/srv/new');
    const r = await w.svc.confirm(w.code());
    expect(r).toEqual({ result: 'ok', path: '/srv/new', kept: ['Filme'], dropped: ['Serien'], job: null });
    expect(w.updater.mediaState().base).toMatchObject({ path: '/srv/new', volume: volumeOf('/srv/new'), previousVolume: oldVolume });
    // the folders were looked at below the new base volume, read-only
    const check = w.helperCalls.find((c) => c.args[0] === 'folders')!;
    expect(check.args[1]).toBe('["Filme","Serien"]');
    expect(check.mounts).toEqual([{ Type: 'volume', Source: volumeOf('/srv/new'), Target: '/base', ReadOnly: true, VolumeOptions: { NoCopy: true } }]);
    // the choice is narrowed to the kept folders: the status no longer lists the dropped one
    expect(w.updater.mediaState().desired!.folders).toEqual([{ rel: 'Filme', target: '/media/filme' }]);
    expect(JSON.stringify(w.updater.mediaState())).not.toContain('Serien');
  });

  it('a helper that fails, or a base volume that exists for another path, commits nothing', async () => {
    const w = world({ answer: (c) => (c.args[0] === 'folders' ? new StepError('helper_failed') : { exists: true, dir: true, listable: true, looksSystem: false }) });
    w.updater.updateMedia((m) => { m.desired = structuredClone(DESIRED); });
    await w.svc.request('/srv/media');
    expect(await w.svc.confirm(w.code())).toEqual({ error: 'not_available' });
    expect(w.updater.mediaState().pending).not.toBeNull();
    expect(w.updater.mediaState().base).toBeNull();

    const v = world();
    v.volumes.set(volumeOf('/srv/media'), { labels: {}, options: { device: '/elsewhere' } });
    await v.svc.request('/srv/media');
    expect(await v.svc.confirm(v.code())).toEqual({ error: 'not_available' });
    expect(v.created).toEqual([]);
  });

  it('previousVolume is never the current base (A, B, A) and a never applied base volume is removed (A, B, C)', async () => {
    const w = world();
    const go = async (p: string) => { w.clock.t += 11 * MIN; await w.svc.request(p); return w.svc.confirm(w.code()); };
    const [A, B, C] = ['/srv/a', '/srv/b', '/srv/c'];
    await go(A);
    await go(B);
    expect(w.updater.mediaState().base).toMatchObject({ volume: volumeOf(B), previousVolume: volumeOf(A) });
    expect(w.removed).toEqual([]);
    // back to A: nothing to remove later (previousVolume null), B was never used and goes
    await go(A);
    expect(w.updater.mediaState().base).toMatchObject({ volume: volumeOf(A), previousVolume: null });
    expect(w.removed).toEqual([volumeOf(B)]);
    // A, B, C: A is what the container uses, B was never applied and is removed, C is the base
    await go(B);
    await go(C);
    expect(w.updater.mediaState().base).toMatchObject({ volume: volumeOf(C), previousVolume: volumeOf(A) });
    expect(w.removed).toEqual([volumeOf(B), volumeOf(B)]);
    // a volume without our labels, or a failing removal, is never an error
    const x = world();
    await x.svc.request(A); await x.svc.confirm(x.code());
    x.clock.t += 11 * MIN; await x.svc.request(B); await x.svc.confirm(x.code());
    x.volumes.set(volumeOf(B), { labels: { 'friendflix.managed': 'other' }, options: { device: B } });
    x.clock.t += 11 * MIN; await x.svc.request(C); expect(await x.svc.confirm(x.code())).toMatchObject({ result: 'ok' });
    expect(x.removed).toEqual([]);
  });

  it('confirming the same base again reuses its volume and keeps the previous one', async () => {
    const w = world();
    await w.svc.request('/srv/media');
    await w.svc.confirm(w.code());
    w.clock.t += 1000;
    await w.svc.request('/srv/media');
    expect(await w.svc.confirm(w.code())).toMatchObject({ result: 'ok' });
    expect(w.created).toHaveLength(1);
    expect(w.updater.mediaState().base!.previousVolume).toBeNull();
  });
});

describe('base-clear', () => {
  it('only without a container or a running job', async () => {
    const w = world();
    await w.svc.request('/srv/media');
    await w.svc.confirm(w.code());
    await w.svc.request('/srv/media');
    w.updater.updateMedia((m) => { m.container = { ...CONTAINER }; });
    expect(await w.svc.clear()).toEqual({ error: 'container_exists' });
    expect(w.updater.mediaState().base).not.toBeNull();
    w.updater.updateMedia((m) => { m.container = null; });
    let release!: () => void;
    w.updater.startMediaJob('mediaserver-stop', () => new Promise<void>((r) => { release = r; }));
    expect(await w.svc.clear()).toEqual({ error: 'busy' });
    expect(w.removed).toEqual([]);
    release();
    await w.updater.idle();
    expect(await w.svc.clear()).toEqual({ ok: true });
    expect(w.updater.mediaState()).toMatchObject({ base: null, pending: null });
    expect(w.removed).toEqual([volumeOf('/srv/media')]);
  });

  it('clearing the base removes its volumes: only ours, never while mounted, failures only logged', async () => {
    const ours = { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': 'friendflix' };
    const setup = (prevLabels: Record<string, string>) => {
      const w = world();
      w.volumes.set(volumeOf('/srv/media'), { labels: ours, options: { device: '/srv/media' } });
      w.volumes.set(volumeOf(OLD_BASE), { labels: prevLabels, options: { device: OLD_BASE } });
      w.updater.updateMedia((m) => { m.base = { path: '/srv/media', volume: volumeOf('/srv/media'), confirmedAt: new Date(T0).toISOString(), previousVolume: volumeOf(OLD_BASE) }; });
      return w;
    };
    // the base volume and the one the last container used
    const a = setup(ours);
    expect(await a.svc.clear()).toEqual({ ok: true });
    expect(a.removed).toEqual([volumeOf('/srv/media'), volumeOf(OLD_BASE)]);

    // a volume of another project (or none of ours) stays
    const b = setup({ ...ours, 'friendflix.project': 'other' });
    await b.svc.clear();
    expect(b.removed).toEqual([volumeOf('/srv/media')]);

    // a volume a container under our names still mounts stays; the answer is ok, the log says so in a fixed line
    const c = setup(ours);
    c.mounted.push(volumeOf(OLD_BASE));
    expect(await c.svc.clear()).toEqual({ ok: true });
    expect(c.removed).toEqual([volumeOf('/srv/media')]);
    expect(c.updater.log.tail().filter((l) => l.endsWith('media base volume could not be removed'))).toHaveLength(1);

    // Docker refuses (another user of the volume): swallowed, logged, the base is cleared all the same
    const d = setup(ours);
    d.refuse.removeVolume = true;
    expect(await d.svc.clear()).toEqual({ ok: true });
    expect(d.updater.mediaState().base).toBeNull();
    expect(d.updater.log.tail().filter((l) => l.endsWith('media base volume could not be removed'))).toHaveLength(2);
    expect(d.updater.log.tail().join('\n')).not.toContain('/srv/');
  });
});

describe('browse and gpu', () => {
  const BASE = { path: '/srv/media', volume: volumeOf('/srv/media'), confirmedAt: new Date(T0).toISOString(), previousVolume: null };
  const withBase = (answer: (c: HelperCall) => Answer) => {
    const w = world({ answer });
    w.updater.updateMedia((m) => { m.base = { ...BASE }; });
    return w;
  };

  it('lists through a helper on the base volume and maps its errors', async () => {
    expect(await world().svc.browse('')).toEqual({ error: 'no_base' });
    let answer: Answer = { entries: [{ name: 'Filme', symlink: false, unreadable: false }, { name: 'x', symlink: 'no' }, 'junk', { name: 'link', symlink: true, unreadable: false }], truncated: false };
    const w = withBase(() => answer);
    expect(await w.svc.browse('Filme')).toEqual({ entries: [{ name: 'Filme', symlink: false, unreadable: false }, { name: 'link', symlink: true, unreadable: false }], truncated: false });
    expect(w.helperCalls[0]).toMatchObject({ verb: 'browse', args: ['Filme'], mounts: [{ Type: 'volume', Source: BASE.volume, ReadOnly: true }] });
    expect(await w.svc.browse('../x')).toEqual({ error: 'invalid_body' });
    expect(await w.svc.browse('a/b/c/d')).toEqual({ error: 'invalid_body' });
    answer = { error: 'folder_missing' };
    expect(await w.svc.browse('Weg')).toEqual({ error: 'base_missing' });
    answer = { error: 'folder_symlink' };
    expect(await w.svc.browse('link')).toEqual({ error: 'invalid_body' });
    answer = { error: 'invalid_body' };
    expect(await w.svc.browse('a/b/c')).toEqual({ error: 'invalid_body' });
    answer = new StepError('helper_failed');
    expect(await w.svc.browse('')).toEqual({ error: 'base_missing' });
    answer = { nonsense: true };
    expect(await w.svc.browse('')).toEqual({ error: 'base_missing' });
  });

  it('gpu: render nodes from the helper, NVIDIA from the engine', async () => {
    const w = world({ answer: () => ({ nodes: [{ node: 'renderD128', gid: 105, vendor: 'intel' }, { node: 'renderD129', gid: 44, vendor: 'weird' }, { node: '../x', gid: 1, vendor: 'amd' }, { node: 'renderD130', gid: 'x', vendor: 'amd' }] }) });
    expect(await w.svc.gpu()).toEqual({ dri: [{ node: 'renderD128', gid: 105, vendor: 'intel' }, { node: 'renderD129', gid: 44, vendor: 'other' }], nvidia: true });
    expect(w.helperCalls[0]!.mounts).toEqual([
      { Type: 'bind', Source: '/dev/dri', Target: '/dev/dri', ReadOnly: true },
      { Type: 'bind', Source: '/sys/class/drm', Target: '/sys-drm', ReadOnly: true },
    ]);
    // no /dev/dri on the host: the helper's create fails, there is simply no node
    expect(await world({ answer: () => new StepError('create_failed'), facts: { nvidia: false } }).svc.gpu()).toEqual({ dri: [], nvidia: false });
    expect(await world({ facts: { reason: 'no_logs' } }).svc.gpu()).toEqual({ dri: [], nvidia: true });
  });

  it('the helpers run as the chosen container user and group', async () => {
    const w = withBase(() => ({ entries: [], truncated: false }));
    w.updater.updateMedia((m) => { m.desired = { ...DESIRED, uid: 1234, gid: 4321, mediaGid: 777 }; });
    await w.svc.browse('');
    // assertHelper already checked User and GroupAdd against the expectation; the call went through
    expect(w.helperCalls).toHaveLength(1);
  });
});

describe('logs', () => {
  it('are redacted', async () => {
    const w = world();
    expect(await w.svc.logs(100)).toEqual({ error: 'no_container' });
    w.updater.updateMedia((m) => { m.container = { ...CONTAINER }; });
    w.setLogs(['GET /Items?api_key=abc123 200', '\x1b[32mInfo\x1b[0m X-Emby-Token: zzz', '{"Pw":"hunter2-fixture"}', 'x'.repeat(900)]);
    expect(await w.svc.logs(100)).toEqual({ lines: ['GET /Items?api_key=… 200', 'Info X-Emby-Token: …', '{"Pw":"…"}', 'x'.repeat(500)] });
    // only a container that carries this project's labels
    w.setLabels({ 'friendflix.managed': 'mediaserver', 'friendflix.project': 'other' });
    expect(await w.svc.logs(100)).toEqual({ error: 'no_container' });
    w.setLabels(null);
    expect(await w.svc.logs(100)).toEqual({ error: 'no_container' });
  });

  it('redactLine covers each key, each separator and a scheme word', () => {
    expect(redactLine('a apikey=k1&b=2')).toBe('a apikey=…&b=2');
    expect(redactLine('Authorization: Bearer abc.def ok')).toBe('Authorization: … ok');
    expect(redactLine('X-MediaBrowser-Token: t1, next')).toBe('X-MediaBrowser-Token: …, next');
    expect(redactLine('{"password": "pw1","user":"a"}')).toBe('{"password": "…","user":"a"}');
    expect(redactLine('PASSWORD=s3 TOKEN=t3')).toBe('PASSWORD=… TOKEN=…');
    expect(redactLine('Authorization: MediaBrowser Client="x", Token="abc"')).toBe('Authorization: … Client="x", Token="…"');
    expect(redactLine('a token was refreshed, pwd ok')).toBe('a token was refreshed, pwd ok');
    expect(redactLine('\x1b]0;title\x07plain')).toBe('plain');
    // the cut comes after the redaction: a secret that straddles the limit does not survive as a half value
    expect(redactLine('x'.repeat(495) + 'api_key=SECRETVALUE')).toBe('x'.repeat(495) + 'api_k');
    expect(redactLine('x'.repeat(480) + ' api_key=SECRETVALUE tail')).toBe('x'.repeat(480) + ' api_key=… tail');
  });
});

describe('media jobs in the Updater', () => {
  it('startMediaJob: busy check, target, skipped core steps, pending media steps; finishJob ends it', async () => {
    const store = memoryStore({ ...DEFAULT_STATE, current: 'sha-abcdef1' });
    const u = new Updater({} as Ops, store, { now: () => T0 });
    let release!: () => void;
    let live!: Job;
    const first = u.startMediaJob('mediaserver-apply', (job) => { live = job; return new Promise<void>((r) => { release = r; }); });
    expect(first.ok && first.job).toMatchObject({
      action: 'mediaserver-apply', state: 'running', to: 'sha-abcdef1', from: null, error: null,
      steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' },
      media: { step: null, steps: { check: 'pending', pull: 'pending', verify: 'pending', snapshot: 'pending', create: 'pending', start: 'pending', health: 'pending', rollback: 'pending', copy_bulk: 'pending', stop_source: 'pending', copy: 'pending', adopt: 'pending' } },
    });
    expect(u.busy).toBe(true);
    expect(u.startMediaJob('mediaserver-stop', async () => undefined)).toEqual({ ok: false, error: 'busy' });
    expect(u.start('update')).toEqual({ ok: false, error: 'busy' });
    live.media!.step = 'check'; live.media!.steps.check = 'ok'; u.persistNow();
    expect(store.state.lastJob!.media!.steps.check).toBe('ok');
    u.finishJob(live, 'succeeded_mediaserver_failed', 'unhealthy');
    release();
    await u.idle();
    expect(u.busy).toBe(false);
    expect(store.state.lastJob).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'unhealthy', media: { steps: { check: 'ok', pull: 'skipped', rollback: 'skipped' } } });
    expect(u.log.tail().join('\n')).toContain('mediaserver-apply succeeded_mediaserver_failed (unhealthy)');
    // the state survives a restart with the job intact
    expect(new Updater({} as Ops, store, { now: () => T0 }).snapshot().lastJob!.state).toBe('succeeded_mediaserver_failed');
  });

  it('without an installed tag the target is the channel tag', () => {
    const u = new Updater({} as Ops, memoryStore(), { now: () => T0 });
    expect(u.startMediaJob('mediaserver-start', async () => undefined)).toMatchObject({ ok: true, job: { to: 'latest' } });
  });

  it('a run that throws fails the job with a fixed code and releases the lock', async () => {
    const u = new Updater({} as Ops, memoryStore(), { now: () => T0 });
    u.startMediaJob('mediaserver-start', async () => { throw new StepError('start_failed'); });
    await u.idle();
    expect(u.snapshot().lastJob).toMatchObject({ state: 'failed', error: 'start_failed' });
    u.startMediaJob('mediaserver-start', async () => { throw new Error('boom: /srv/secret'); });
    await u.idle();
    expect(u.snapshot().lastJob).toMatchObject({ state: 'failed', error: 'helper_failed' });
    expect(u.busy).toBe(false);
  });

  it('a media job interrupted by a restart is marked failed / interrupted', () => {
    const store = memoryStore();
    const u = new Updater({} as Ops, store, { now: () => T0 });
    u.startMediaJob('mediaserver-restore', () => new Promise<void>(() => undefined));
    store.state.lastJob!.media!.step = 'snapshot';
    store.state.lastJob!.media!.steps.snapshot = 'running';
    const after = new Updater({} as Ops, store, { now: () => T0 + MIN });
    expect(after.snapshot().lastJob).toMatchObject({ state: 'failed', error: 'interrupted', finishedAt: new Date(T0 + MIN).toISOString(), media: { step: 'snapshot', steps: { snapshot: 'failed', check: 'pending' } } });
  });
});
