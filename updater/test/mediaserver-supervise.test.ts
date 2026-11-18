// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { ImageInfo } from '../src/docker.js';
import type { Ops } from '../src/job.js';
import { Supervisor } from '../src/mediaserver/supervise.js';
import type { Job } from '../src/state.js';
import { BASE, JSPEC, N, PROJECT, SOURCE, SPEC, baseVolume, jellyPin, ferroPin, okFolders, world, type HelperCall } from './media-world.js';

const OLD_SHA = 'a'.repeat(40), NEW_SHA = 'b'.repeat(40);
const MIN = 60_000;

/** FriendFlix's own update: every service changed in the registry, pulls, verifies and gets healthy on the new build */
function coreOps(): Ops {
  const OLD = 'sha256:' + 'a'.repeat(64), NEW = 'sha256:' + 'b'.repeat(64);
  let runs = OLD;
  const repo = (s: string) => `ghcr.io/letsmanu/friendflix-${s === 'bootstrap' ? 'backend' : s}`;
  const info = (sha: string): ImageInfo => ({ repoDigests: [], commit: sha, version: '1.0.0' });
  return {
    images: async (tag, services) => Object.fromEntries(services.map((s) => [s, `${repo(s)}:${tag}`])),
    registryDigest: async () => NEW, pullDigest: async () => undefined, tag: async () => undefined,
    verify: async () => true, up: async () => { runs = NEW; },
    imageInfo: async (ref) => info(ref.endsWith(NEW) ? NEW_SHA : OLD_SHA),
    running: async (s) => ({ ...info(runs === NEW ? NEW_SHA : OLD_SHA), repoDigests: [`${repo(s)}@${runs}`], container: (runs === NEW ? '2' : '1').repeat(64) }),
    spawnSelfUpdate: async () => undefined, healthy: async () => true, ownStack: async () => undefined,
    stop: async () => undefined, rm: async () => undefined, imageRm: async () => undefined, volumeRm: async () => undefined,
    livetvContainer: async () => null, livetvNetwork: async () => undefined,
  };
}

function setup(o: Parameters<typeof world>[0] = {}) {
  const w = world({ ops: coreOps(), ...o });
  const sup = new Supervisor({ ...w.deps, jobs: w.jobs });
  const update = async (): Promise<Job> => {
    const r = w.updater.start('update');
    if (!r.ok) throw new Error(`not started: ${r.error}`);
    await w.updater.idle();
    return w.updater.snapshot().lastJob!;
  };
  /** one supervisor round 60 s later, and the job it may have started */
  const tick = async () => {
    w.clock.t += MIN;
    const r = await sup.tick();
    await w.updater.idle();
    return r;
  };
  /** `n` rounds, each 60 s after the last */
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };
  return { ...w, sup, update, tick, ticks };
}

const gpuAnswer = (gid: number) => (c: HelperCall) => {
  if (c.verb === 'gpu') return { nodes: [{ node: 'renderD128', gid, vendor: 'intel' }] };
  if (c.verb === 'check' && c.args[0] === 'folders') return okFolders(c);
  if (c.verb === 'check' && c.args[0] === 'data') return { owner: 1000 };
  return { error: 'invalid_body' };
};

describe('the media phase of an update', () => {
  it('the phase moves the container to the new pin and records the source', async () => {
    // a new pin: recreated on it (reason update), the source recorded
    const w = setup();
    w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2');
    const deploy = vi.spyOn(w.jobs, 'deploy');
    const job = await w.update();
    expect(job).toMatchObject({ action: 'update', state: 'succeeded', error: null });
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy.mock.calls[0]![2]).toEqual({ reason: 'update' });
    expect(job.media!.steps).toMatchObject({ check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'ok', create: 'ok', start: 'ok', health: 'ok', rollback: 'skipped' });
    expect(w.media().container).toMatchObject({ digest: jellyPin('10.11.3').digest, upstream: '10.11.3' });
    expect(w.media().pinSource).toBe(SOURCE);
    expect(w.find(N.container)!.body.Image).toBe(jellyPin('10.11.3').image);

    // the same pin: nothing moves, the source is recorded all the same
    const s = setup();
    s.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    const sameDeploy = vi.spyOn(s.jobs, 'deploy');
    const same = await s.update();
    expect(same).toMatchObject({ state: 'succeeded', media: null });
    expect(sameDeploy).not.toHaveBeenCalled();
    expect(s.media().pinSource).toBe(SOURCE);
    expect(s.changes()).toEqual([]);

    // the same pin, but the render node's group changed on the host: the pending template is applied with this update
    const g = setup();
    g.cfg.answer = gpuAnswer(993);
    const dri = { ...JSPEC, gpu: 'dri' as const };
    g.existing(dri, jellyPin('10.11.3'), '10.11.3', { renderGids: [992] });
    // the status view compares with the gids recorded at the deploy (no helper); the phase reads them fresh through a helper
    expect(await g.sup.templateState()).toBe('current');
    expect(g.helperCalls).toEqual([]);
    expect(await g.jobs.templateState()).toBe('update_pending');
    expect(g.helperCalls.map((c) => c.verb)).toEqual(['gpu']);
    const gpuDeploy = vi.spyOn(g.jobs, 'deploy');
    const regid = await g.update();
    expect(regid.state).toBe('succeeded');
    expect(gpuDeploy).toHaveBeenCalledTimes(1);
    expect((g.find(N.container)!.body.HostConfig as { GroupAdd: string[] }).GroupAdd).toEqual(['993']);
    expect(g.media().renderGids).toEqual([993]);
    expect(await g.sup.templateState()).toBe('current');
    expect(await g.jobs.templateState()).toBe('current');

    // a server stopped on purpose is not moved (its status keeps the pending update)
    const st = setup();
    st.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2', { run: false });
    const stoppedDeploy = vi.spyOn(st.jobs, 'deploy');
    const stopped = await st.update();
    expect(stopped).toMatchObject({ state: 'succeeded', media: null });
    expect(stoppedDeploy).not.toHaveBeenCalled();
    expect(st.changes()).toEqual([]);

    // no managed media server at all: nothing to do
    const none = setup();
    expect(await none.update()).toMatchObject({ state: 'succeeded', media: null });
    expect(none.changes()).toEqual([]);
  });

  it('a failed phase rolls back only the media server', async () => {
    const w = setup();
    const old = w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2');
    w.cfg.healthOf = (c) => (c.body.Image === jellyPin('10.11.3').image ? 'unhealthy' : 'healthy');
    const job = await w.update();
    expect(job).toMatchObject({ action: 'update', state: 'succeeded_mediaserver_failed', error: 'unhealthy', steps: { health: 'ok', rollback: 'skipped' } });
    expect(job.media!.steps).toMatchObject({ health: 'failed', rollback: 'ok' });
    // FriendFlix stays on the new build, the old media server runs again
    expect(w.updater.snapshot()).toMatchObject({ current: 'latest', previous: null, previousDigests: { backend: `ghcr.io/letsmanu/friendflix-backend@sha256:${'a'.repeat(64)}` } });
    expect(w.find(N.container)).toMatchObject({ id: old.id, running: true });
    expect(w.find(N.old)).toBeUndefined();
    expect(w.media()).toMatchObject({ lastError: 'unhealthy', container: { id: old.id, upstream: '10.11.2' } });
  });

  it('a downgrade is refused and leaves the container', async () => {
    const w = setup();
    const old = w.existing(JSPEC, jellyPin('10.11.4', '4'), '10.11.4');
    const job = await w.update();
    expect(job).toMatchObject({ state: 'succeeded_mediaserver_failed', error: 'downgrade_refused' });
    expect(w.changes()).toEqual([`pull ${jellyPin('10.11.3').image}`]);
    expect(w.find(N.container)).toMatchObject({ id: old.id, running: true });
    expect(w.media().lastError).toBe('downgrade_refused');
  });

  it('a FriendFlix rollback never moves the media server', async () => {
    const w = setup({ state: { previous: 'sha-aaaaaaa', current: 'latest' } });
    w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2');
    const phase = vi.spyOn(w.jobs, 'phase');
    const r = w.updater.start('rollback');
    expect(r.ok).toBe(true);
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'rollback', media: null });
    expect(phase).not.toHaveBeenCalled();
    expect(w.changes()).toEqual([]);
  });
});

describe('supervision', () => {
  it('missing container is recreated, stopped one is left', async () => {
    const w = setup();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1');
    w.containers.delete(c.id);
    expect(await w.tick()).toBe('recover');
    const job = w.updater.snapshot().lastJob!;
    expect(job).toMatchObject({ action: 'mediaserver-recover', state: 'succeeded' });
    expect(w.find(N.container)).toMatchObject({ running: true });
    expect(w.media().container!.id).toBe(w.find(N.container)!.id);
    // healthy again: the next round has nothing to do
    expect(await w.tick()).toBe('idle');
    expect(w.updater.snapshot().lastJob!.id).toBe(job.id);

    // a stopped container is never started or recreated (Docker's restart policy handles a crash); only its reason is checked
    const s = setup();
    s.existing(SPEC, ferroPin(), 'v1.5.1').running = false;
    expect(await s.tick()).toBe('idle');
    expect(await s.tick()).toBe('idle');
    expect(s.updater.snapshot().lastJob).toBeNull();
    expect(s.changes()).toEqual([]);
    expect(s.helperCalls.map((c) => c.verb)).toEqual(['check']);
    expect(s.media().lastError).toBeNull();

    // stopped on purpose and then deleted: not recreated
    const d = setup();
    d.containers.delete(d.existing(SPEC, ferroPin(), 'v1.5.1', { run: false }).id);
    expect(await d.tick()).toBe('idle');
    expect(d.updater.snapshot().lastJob).toBeNull();
  });

  it('missing base: no recreate loop, error reported, container untouched', async () => {
    const w = setup();
    w.containers.delete(w.existing(SPEC, ferroPin(), 'v1.5.1').id);
    w.volumes.delete(baseVolume(BASE));
    expect(await w.tick()).toBe('recover');
    const job = w.updater.snapshot().lastJob!;
    expect(job).toMatchObject({ action: 'mediaserver-recover', state: 'failed', error: 'base_missing' });
    expect(w.media().lastError).toBe('base_missing');
    // within the retry interval: no new job, no helper
    const helpers = w.helperCalls.length;
    for (let i = 0; i < 8; i++) expect(await w.tick()).toBe('idle');
    expect(w.updater.snapshot().lastJob!.id).toBe(job.id);
    expect(w.helperCalls.length).toBe(helpers);
    expect(w.calls.filter((c) => c.startsWith('removeVolume') || c.startsWith('createVolume'))).toEqual([]);
    expect(w.media().lastError).toBe('base_missing');
    // the share is back: the retry 10 minutes after the failed recover recreates it and clears the error
    w.volumes.set(baseVolume(BASE), { labels: { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': PROJECT }, options: { type: 'none', o: 'bind,ro', device: BASE } });
    for (let i = 0; i < 3 && w.updater.snapshot().lastJob!.id === job.id; i++) await w.tick();
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-recover', state: 'succeeded' });
    expect(w.media().lastError).toBeNull();

    // with the container still running, nothing is checked: the container is not stopped or removed
    const u = setup();
    u.existing(SPEC, ferroPin(), 'v1.5.1');
    u.volumes.delete(baseVolume(BASE));
    await u.ticks(20);
    expect(u.media().lastError).toBeNull();
    expect(u.helperCalls).toEqual([]);
    expect(u.changes()).toEqual([]);
    expect(u.find(N.container)!.running).toBe(true);
  });

  it('a running, healthy server starts no helper', async () => {
    for (const spec of [SPEC, { ...SPEC, gpu: 'dri' as const }, { ...SPEC, gpu: 'nvidia' as const }]) {
      const w = setup();
      w.existing(spec, ferroPin(), 'v1.5.1', { renderGids: [993] });
      for (let i = 0; i < 30; i++) expect(await w.tick()).toBe('idle');
      // no helper ran and nothing was created (an NVIDIA server without the toolkit is no longer flagged on its own)
      expect(w.helperCalls).toEqual([]);
      expect(w.calls).toEqual([]);
      expect(w.media().lastError).toBeNull();
    }
  });

  it('a missing server whose recover failed is retried every 10 minutes, never while held or busy', async () => {
    const w = setup();
    w.containers.delete(w.existing(SPEC, ferroPin(), 'v1.5.1').id);
    let serien: 'ok' | 'folder_missing' = 'folder_missing';
    w.cfg.answer = (c) => {
      if (c.verb === 'check' && c.args[0] === 'folders') return { folders: (JSON.parse(c.args[1]!) as string[]).map((rel) => ({ rel, code: rel === 'Serien' ? serien : 'ok' })) };
      if (c.verb === 'check' && c.args[0] === 'data') return { owner: 1000 };
      return { error: 'invalid_body' };
    };
    const recover = vi.spyOn(w.jobs, 'recover');
    const hostCheck = vi.spyOn(w.jobs, 'hostCheck');
    expect(await w.tick()).toBe('recover');
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-recover', state: 'failed', error: 'folder_missing' });
    expect(w.media().lastError).toBe('folder_missing');
    // not before 10 minutes
    for (let i = 0; i < 9; i++) expect(await w.tick()).toBe('idle');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await w.tick()).toBe('recover');
    expect(recover).toHaveBeenCalledTimes(2);
    expect(w.media().lastError).toBe('folder_missing');
    // the folder is back: the next retry recreates the server and clears the error
    serien = 'ok';
    for (let i = 0; i < 9; i++) expect(await w.tick()).toBe('idle');
    expect(await w.tick()).toBe('recover');
    expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-recover', state: 'succeeded' });
    expect(w.media().lastError).toBeNull();
    expect(w.find(N.container)!.running).toBe(true);
    // the recover ran the checks itself, the supervisor never did
    expect(hostCheck).not.toHaveBeenCalled();
    const helpers = w.helperCalls.length;
    await w.ticks(15);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(w.helperCalls.length).toBe(helpers);

    // after a failed rollback: never retried (its data may be half restored)
    const h = setup();
    h.containers.delete(h.existing(SPEC, ferroPin(), 'v1.5.1').id);
    const media = { step: 'rollback' as const, steps: { check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'ok', create: 'ok', start: 'ok', health: 'failed', rollback: 'failed' } as const };
    h.updater.startMediaJob('mediaserver-update', async (job) => { job.media = structuredClone(media); h.updater.finishJob(job, 'failed', 'unhealthy'); });
    await h.updater.idle();
    h.updater.updateMedia((m) => { m.lastError = 'unhealthy'; });
    const heldRecover = vi.spyOn(h.jobs, 'recover');
    for (let i = 0; i < 25; i++) expect(await h.tick()).toBe('idle');
    expect(heldRecover).not.toHaveBeenCalled();
    expect(h.helperCalls).toEqual([]);

    // while a job runs: nothing
    const b = setup();
    b.containers.delete(b.existing(SPEC, ferroPin(), 'v1.5.1').id);
    b.updater.updateMedia((m) => { m.lastError = 'folder_missing'; });
    const busyRecover = vi.spyOn(b.jobs, 'recover');
    let release!: () => void;
    b.updater.startMediaJob('mediaserver-stop', () => new Promise<void>((r) => { release = r; }));
    b.clock.t += 11 * MIN;
    expect(await b.sup.tick()).toBe('busy');
    release();
    await b.updater.idle();
    expect(busyRecover).not.toHaveBeenCalled();
  });

  it('an unexpected stop is checked once per stop', async () => {
    const w = setup();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1');
    let serien: 'ok' | 'folder_missing' = 'folder_missing';
    w.cfg.answer = (x) => (x.verb === 'check' && x.args[0] === 'folders'
      ? { folders: (JSON.parse(x.args[1]!) as string[]).map((rel) => ({ rel, code: rel === 'Serien' ? serien : 'ok' })) }
      : { error: 'invalid_body' });
    const hostCheck = vi.spyOn(w.jobs, 'hostCheck');
    // the server stopped on its own (desired.run stays true)
    c.running = false;
    c.finishedAt = '2026-11-17T14:05:00.000Z';
    expect(await w.tick()).toBe('idle');
    expect(hostCheck).toHaveBeenCalledTimes(1);
    expect(w.media().lastError).toBe('folder_missing');
    // the same stop: not again
    await w.ticks(12);
    expect(hostCheck).toHaveBeenCalledTimes(1);
    // Docker restarted it and it stopped again: checked again
    c.status = 'restarting';
    c.finishedAt = '2026-11-17T14:20:00.000Z';
    await w.tick();
    expect(hostCheck).toHaveBeenCalledTimes(2);
    c.status = 'dead';
    c.finishedAt = '2026-11-17T14:21:00.000Z';
    await w.tick();
    expect(hostCheck).toHaveBeenCalledTimes(3);
    expect(w.media().lastError).toBe('folder_missing');
    // running again: the host code goes, without a helper
    delete c.status;
    c.running = true;
    await w.tick();
    expect(w.media().lastError).toBeNull();
    expect(hostCheck).toHaveBeenCalledTimes(3);
    // a check that finds nothing leaves the error as it is
    serien = 'ok';
    w.updater.updateMedia((m) => { m.lastError = 'interrupted'; });
    c.running = false;
    c.finishedAt = '2026-11-17T15:00:00.000Z';
    await w.tick();
    expect(hostCheck).toHaveBeenCalledTimes(4);
    expect(w.media().lastError).toBe('interrupted');
    // running again: any other code stays
    c.running = true;
    await w.ticks(3);
    expect(w.media().lastError).toBe('interrupted');
    expect(w.changes()).toEqual([]);
    expect(w.updater.snapshot().lastJob).toBeNull();

    // a chosen GPU that went away; an NVIDIA server without the toolkit
    const g = setup();
    g.cfg.answer = (x) => (x.verb === 'gpu' ? { nodes: [] } : okFolders(x));
    g.existing({ ...SPEC, gpu: 'dri' }, ferroPin(), 'v1.5.1', { renderGids: [993] }).running = false;
    await g.tick();
    expect(g.media().lastError).toBe('gpu_missing');
    const nv = setup();
    nv.existing({ ...SPEC, gpu: 'nvidia' }, ferroPin(), 'v1.5.1').running = false;
    await nv.tick();
    expect(nv.media().lastError).toBe('nvidia_missing');
    expect(nv.changes()).toEqual([]);
    // a vanished base
    const u = setup();
    u.existing(SPEC, ferroPin(), 'v1.5.1').running = false;
    u.volumes.delete(baseVolume(BASE));
    await u.tick();
    expect(u.media().lastError).toBe('base_missing');
  });

  it("a stop by the admin is never diagnosed", async () => {
    const w = setup();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    expect((await w.run({ op: 'stop' })).state).toBe('succeeded');
    expect(w.find(N.container)!.running).toBe(false);
    const hostCheck = vi.spyOn(w.jobs, 'hostCheck');
    await w.ticks(15);
    expect(hostCheck).not.toHaveBeenCalled();
    expect(w.helperCalls).toEqual([]);
    expect(w.changes()).toEqual([`stop ${N.container}`]);
  });

  it('nothing runs while a job does', async () => {
    const w = setup();
    w.containers.delete(w.existing(SPEC, ferroPin(), 'v1.5.1').id);
    let release!: () => void;
    w.updater.startMediaJob('mediaserver-stop', () => new Promise<void>((r) => { release = r; }));
    expect(await w.sup.tick()).toBe('busy');
    release();
    await w.updater.idle();
    expect(w.calls).toEqual([]);
  });
});

describe('recovery after an interrupted recreate', () => {
  /** the state after a crash between "rename aside" and "create": only `-old` (stopped) is left */
  const aside = (o: { run?: boolean } = {}) => {
    const w = setup();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1', { name: N.old, ...(o.run === false ? { run: false } : {}) });
    c.running = false;
    return { w, c };
  };

  it('an -old container without a main one is renamed back and started', async () => {
    const { w, c } = aside();
    await w.sup.startup();
    expect(w.changes()).toEqual([`rename ${N.old} -> ${N.container}`, `start ${N.container}`]);
    expect(w.find(N.container)).toMatchObject({ id: c.id, running: true });
    expect(w.media().lastError).toBe('interrupted');

    const s = aside({ run: false });
    await s.w.sup.startup();
    expect(s.w.changes()).toEqual([`rename ${N.old} -> ${N.container}`]);
    expect(s.w.find(N.container)!.running).toBe(false);
  });

  it('after a failed rollback the old container gets its name back but is not started', async () => {
    const { w, c } = aside();
    const media = { step: 'rollback' as const, steps: { check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'ok', create: 'ok', start: 'ok', health: 'failed', rollback: 'failed' } as const };
    w.updater.startMediaJob('mediaserver-update', async (job) => { job.media = structuredClone(media); w.updater.finishJob(job, 'failed', 'unhealthy'); });
    await w.updater.idle();
    w.updater.updateMedia((m) => { m.lastError = 'unhealthy'; });
    expect(await w.tick()).toBe('aside');
    expect(w.changes()).toEqual([`rename ${N.old} -> ${N.container}`]);
    expect(w.find(N.container)).toMatchObject({ id: c.id, running: false });
    expect(w.media().lastError).toBe('unhealthy');
    // and it stays stopped: a stopped container is never started by the supervisor
    expect(await w.tick()).toBe('idle');
    expect(w.find(N.container)!.running).toBe(false);
    expect(w.updater.snapshot().lastJob!.action).toBe('mediaserver-update');

    // nor recreated when it goes missing, also once its error was cleared: Admin decides
    w.containers.delete(c.id);
    w.updater.updateMedia((m) => { m.lastError = null; });
    expect(await w.tick()).toBe('idle');
    expect(w.updater.snapshot().lastJob!.action).toBe('mediaserver-update');
    expect(w.find(N.container)).toBeUndefined();
  });

  it('a healthy new container lets the -old one go, never with its volumes', async () => {
    const w = setup();
    const old = w.existing(SPEC, ferroPin(), 'v1.5.1', { name: N.old });
    old.running = false;
    // the new container was created and got healthy, the crash came before the state was written
    const spec = { ...SPEC, tz: 'Europe/Vienna' };
    const fresh = w.existing(spec, ferroPin(), 'v1.5.1');
    w.updater.updateMedia((m) => { m.container = { ...m.container!, id: old.id }; m.desired = { ...SPEC, run: true }; });
    expect(await w.tick()).toBe('aside');
    expect(w.changes()).toEqual([`remove ${N.old}`]);
    expect(w.removedWith).toEqual([{ name: N.old, o: { force: true } }]);
    expect(w.find(N.container)!.id).toBe(fresh.id);
    expect(w.media().container!.id).toBe(fresh.id);
    expect(w.media().desired).toEqual({ ...spec, run: true });
  });

  it('an -old next to a main container that is not healthy or not ours is left and reported', async () => {
    const w = setup();
    w.existing(SPEC, ferroPin(), 'v1.5.1', { name: N.old }).running = false;
    w.existing(SPEC, ferroPin(), 'v1.5.1').health = 'starting';
    expect(await w.tick()).toBe('aside');
    expect(w.changes()).toEqual([]);
    expect(w.media().lastError).toBe('name_taken');
    // healthy a minute later: settled
    w.find(N.container)!.health = 'healthy';
    expect(await w.tick()).toBe('aside');
    expect(w.changes()).toEqual([`remove ${N.old}`]);

    const f = setup();
    f.existing(SPEC, ferroPin(), 'v1.5.1', { name: N.old }).running = false;
    f.containers.set('f'.repeat(64), { id: 'f'.repeat(64), name: N.container, body: { Image: 'nginx', HostConfig: { NetworkMode: 'bridge' } }, running: true, health: null, networks: ['bridge'], host: {} });
    expect(await f.tick()).toBe('aside');
    expect(f.changes()).toEqual([]);
    expect(f.find(N.old)).toBeDefined();
  });
});

describe('overlapping rounds', () => {
  it('a round while another (or the startup) still runs is skipped', async () => {
    const w = world({ ops: coreOps() });
    let facts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sup = new Supervisor({ ...w.deps, jobs: w.jobs, facts: async () => { facts++; await gate; return w.cfg.facts; } });
    const first = sup.tick();
    expect(await sup.tick()).toBe('busy');
    const boot = sup.startup();
    release();
    expect(await first).toBe('idle');
    await boot;
    expect(facts).toBe(1);
    // once it ended, the next round runs
    expect(await sup.tick()).toBe('idle');
    expect(facts).toBe(2);
  });
});

describe('adoption and ownership', () => {
  it('adoption after a lost state volume', async () => {
    const w = setup();
    const c = w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    w.updater.updateMedia((m) => { m.container = null; m.desired = null; m.base = null; m.dataUpstream = { ferrofin: 'v1.5.1' }; });
    await w.sup.startup();
    const m = w.media();
    // the adopted server's version is its data's (a newer record stays)
    expect(m.dataUpstream).toEqual({ ferrofin: 'v1.5.1', jellyfin: '10.11.3' });
    expect(m.container).toEqual({ id: c.id, kind: 'jellyfin', digest: jellyPin('10.11.3').digest, upstream: '10.11.3', specHash: (c.body.Labels as Record<string, string>)['friendflix.spec'] });
    expect(m.desired).toEqual({ ...JSPEC, run: true });
    expect(m.base).toMatchObject({ path: '/srv/media', volume: baseVolume(BASE), previousVolume: null });
    expect(m.tampered).toBe(false);
    expect(w.changes()).toEqual([]);
    expect(await w.sup.templateState()).toBe('current');

    // the render group is told apart from the media group by the host's render nodes
    const g = setup();
    g.cfg.answer = gpuAnswer(993);
    const dri = { ...SPEC, gpu: 'dri' as const, mediaGid: 1001 };
    g.existing(dri, ferroPin(), 'v1.5.1', { renderGids: [993] });
    g.images.get(ferroPin().image)!.labels['io.github.letsmanu.friendflix.mediaserver.ferrofin'] = 'v1.5.1';
    g.updater.updateMedia((m) => { m.container = null; m.desired = null; delete m.renderGids; });
    expect(await g.tick()).toBe('idle');
    expect(g.media().desired).toEqual({ ...dri, run: true });
    // the render gids the container was built with are recorded (the media group is not one)
    expect(g.media().renderGids).toEqual([993]);
    expect(await g.sup.templateState()).toBe('current');
    expect(g.media().container).toMatchObject({ kind: 'ferrofin', upstream: 'v1.5.1' });
    const h = setup();
    h.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    h.updater.updateMedia((m) => { m.container = null; m.desired = null; m.dataUpstream = { jellyfin: '10.11.4' }; });
    expect(await h.tick()).toBe('idle');
    expect(h.media().dataUpstream).toEqual({ jellyfin: '10.11.4' });
  });

  it('a tampered container is flagged, never started', async () => {
    const w = setup();
    const c = w.existing(SPEC, ferroPin(), 'v1.5.1', { host: { PortBindings: { '8096/tcp': [{ HostPort: '8096' }] } } });
    c.running = false;
    w.updater.updateMedia((m) => { m.container = null; m.desired = null; });
    expect(await w.tick()).toBe('tampered');
    expect(w.media()).toMatchObject({ tampered: true, container: null, desired: null });
    expect(w.changes()).toEqual([]);
    expect(w.updater.snapshot().lastJob).toBeNull();

    // an adopted one changed later: flagged, not started, no recover job
    const a = setup();
    a.existing(SPEC, ferroPin(), 'v1.5.1', { host: { Privileged: true } }).running = false;
    expect(await a.tick()).toBe('tampered');
    expect(a.media().tampered).toBe(true);
    expect(a.changes()).toEqual([]);
    expect(a.updater.snapshot().lastJob).toBeNull();
  });

  it('the guard sees the recorded GPU choice', async () => {
    // an NVIDIA default runtime is fine for a server set up with the NVIDIA choice
    const w = setup();
    w.existing({ ...SPEC, gpu: 'nvidia' }, ferroPin(), 'v1.5.1', { host: { Runtime: 'nvidia' } });
    expect(await w.tick()).toBe('idle');
    expect(w.media().tampered).toBe(false);
    // the same runtime under a server set up without a GPU is a change from outside
    const o = setup();
    o.existing(SPEC, ferroPin(), 'v1.5.1', { host: { Runtime: 'nvidia' } });
    expect(await o.tick()).toBe('tampered');
    expect(o.media().tampered).toBe(true);
  });

  it("another project's or an unlabelled container is ignored", async () => {
    for (const labels of [{ 'friendflix.managed': 'mediaserver', 'friendflix.project': 'other', 'friendflix.kind': 'ferrofin' }, {}]) {
      const w = setup();
      const c = w.existing(SPEC, ferroPin(), 'v1.5.1');
      c.body = { ...c.body, Labels: labels };
      const o = w.existing(SPEC, ferroPin(), 'v1.5.1', { name: N.old });
      o.body = { ...o.body, Labels: labels };
      o.running = false;
      w.updater.updateMedia((m) => { m.container = null; m.desired = null; });
      await w.sup.startup();
      expect(await w.tick()).toBe('idle');
      expect(w.media()).toMatchObject({ container: null, desired: null, tampered: false });
      expect(w.changes()).toEqual([]);
    }
  });

  it('startup removes leftover helpers of this project only', async () => {
    const w = setup();
    const helper = { 'friendflix.managed': 'helper', 'friendflix.project': PROJECT };
    w.containers.set('1'.repeat(64), { id: '1'.repeat(64), name: `${PROJECT}-mediahelper-0a0b0c0d`, body: { Labels: helper }, running: false, health: null, networks: [], host: {} });
    w.containers.set('2'.repeat(64), { id: '2'.repeat(64), name: 'other-mediahelper-0a0b0c0d', body: { Labels: { ...helper, 'friendflix.project': 'other' } }, running: false, health: null, networks: [], host: {} });
    await w.sup.startup();
    expect(w.removedWith).toEqual([{ name: 'helper', o: { force: true, volumes: true } }]);
    expect(w.containers.has('2'.repeat(64))).toBe(true);
  });

  it('template change is reported, never applied on its own', async () => {
    const w = setup();
    w.existing(SPEC, ferroPin(), 'v1.5.1');
    expect(await w.sup.templateState()).toBe('current');
    w.updater.updateMedia((m) => { m.desired!.tz = 'Europe/Vienna'; });
    expect(await w.sup.templateState()).toBe('update_pending');
    for (let i = 0; i < 12; i++) expect(await w.tick()).toBe('idle');
    expect(w.updater.snapshot().lastJob).toBeNull();
    expect(w.changes()).toEqual([]);
    // nothing to compare without a recorded container
    w.updater.updateMedia((m) => { m.container = null; });
    expect(await w.sup.templateState()).toBeNull();
  });
});
