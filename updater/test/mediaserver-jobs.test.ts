// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { StepError } from '../src/docker.js';
import { EngineError } from '../src/mediaserver/engine.js';
import { TemplateViolation } from '../src/mediaserver/guard.js';
import { MediaService } from '../src/mediaserver/service.js';
import type { Desired, DesiredSpec, Kind } from '../src/mediaserver/types.js';
import type { MediaState } from '../src/state.js';
import { BASE, FACTS, JSPEC, N, FIRST_RUN_SEED, PROJECT, SOURCE, SPEC, T0, UPSTREAM_LABEL, baseVolume, ferroPin, jellyPin, okFolders, world, type C, type Obj } from './media-world.js';

describe('apply', () => {
  it('first apply creates volumes, container and egress, then is healthy', async () => {
    const w = world();
    const job = await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } });
    expect(job).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded', error: null });
    expect(w.changes()).toEqual([
      `pull ${ferroPin().image}`, `createVolume ${N.data('ferrofin')}`, `createVolume ${N.cache('ferrofin')}`,
      `create ${N.container}`, `connect ${PROJECT}_egress`, `start ${N.container}`,
    ]);
    expect(job.media!.steps).toEqual({ check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'skipped', create: 'ok', start: 'ok', health: 'ok', rollback: 'skipped', copy_bulk: 'skipped', stop_source: 'skipped', copy: 'skipped', adopt: 'skipped' });
    expect(w.verified).toEqual([ferroPin().image]);
    const m = w.media();
    const main = w.find(N.container)!;
    expect(m.container).toEqual({ id: main.id, kind: 'ferrofin', digest: ferroPin().digest, upstream: 'v1.5.1', specHash: (main.body.Labels as Obj)['friendflix.spec'] });
    expect(m.desired).toEqual({ ...SPEC, run: true });
    expect(m.pinSource).toBe(SOURCE);
    expect(m.lastError).toBeNull();
    // Ferrofin's first create carries the administrator, or it would seed a passwordless one
    expect(main.body.Env).toEqual(expect.arrayContaining(['FERROFIN_ADMIN_USER=friendflix-admin', `FERROFIN_ADMIN_PASSWORD=${FIRST_RUN_SEED}`]));
    expect(JSON.stringify(w.updater.log.tail(200))).not.toContain(FIRST_RUN_SEED);
    expect(JSON.stringify(w.store.state)).not.toContain(FIRST_RUN_SEED);
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
    expect(JSON.stringify(w.find(N.container)!.body.Env)).not.toContain('FIRST_RUN_SEED');
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

  it('a failed restore still gives the old container its name back, but does not start it', async () => {
    const w = world();
    const old = w.existing(JSPEC, jellyPin('10.11.2', '2'), '10.11.2');
    w.cfg.healthOf = (c) => (c.body.Image === jellyPin('10.11.3').image ? 'unhealthy' : 'healthy');
    const answer = w.cfg.answer;
    w.cfg.answer = (c) => (c.verb === 'restore' ? new StepError('helper_timeout') : answer(c));
    const job = await w.run({ op: 'apply', spec: JSPEC });
    expect(job).toMatchObject({ state: 'failed', error: 'unhealthy' });
    expect(job.media!.steps).toMatchObject({ snapshot: 'ok', health: 'failed', rollback: 'failed' });
    expect(w.calls.slice(-4)).toEqual([`stop ${N.container}`, `remove ${N.container}`, 'helper restore', `rename ${N.old} -> ${N.container}`]);
    // the real name is ours again (the next apply can recreate), the half-restored data is not started on
    expect(w.find(N.container)).toMatchObject({ id: old.id, running: false });
    expect(w.find(N.old)).toBeUndefined();
    expect(w.media()).toMatchObject({ container: { id: old.id }, lastError: 'unhealthy' });
    expect(w.updater.log.tail(200).join('\n')).toContain('media rollback failed');
  });

  it('a failed remove of the new container does not stop the rollback', async () => {
    const w = world();
    const old = w.existing(SPEC, ferroPin(), 'v1.5.1');
    w.cfg.failStart = (c) => c.id !== old.id;
    w.cfg.failRemove = (c) => c.id !== old.id;
    const job = await w.run({ op: 'apply', spec: { ...SPEC, tz: 'Europe/Vienna' } });
    expect(job).toMatchObject({ state: 'failed', error: 'start_failed' });
    expect(job.media!.steps.rollback).toBe('failed');
    expect(w.changes().slice(-3)).toEqual([`remove ${N.container}`, `rename ${N.old} -> ${N.container}`, `start ${N.container}`]);
    expect(w.find(N.container)).toMatchObject({ id: old.id, running: true });
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

  // the never-down rule and the snapshot follow the data volume, not the container: a remove without data or a kind switch keeps it
  describe('the data volume\'s upstream', () => {
    const ferro = (w: ReturnType<typeof world>, hex: string, upstream: string) => {
      const p = ferroPin(hex);
      w.images.set(p.image, { ...w.images.get(ferroPin().image)!, repoDigests: [p.image], labels: { [UPSTREAM_LABEL]: upstream } });
      w.cfg.pins = { ...w.cfg.pins, pins: { ...(w.cfg.pins as { pins: object }).pins, ferrofin: p } } as typeof w.cfg.pins;
      return p;
    };
    const jelly = (w: ReturnType<typeof world>, p: ReturnType<typeof jellyPin>) => {
      w.jellyImage(p);
      w.cfg.pins = { ...w.cfg.pins, pins: { ...(w.cfg.pins as { pins: object }).pins, jellyfin: p } } as typeof w.cfg.pins;
    };

    it('a deploy records it per kind', async () => {
      const w = world();
      expect((await w.run({ op: 'apply', spec: JSPEC })).state).toBe('succeeded');
      expect(w.media().dataUpstream).toEqual({ jellyfin: '10.11.3' });
    });

    it('remove {data: false}, then an older pin: downgrade_refused, nothing created', async () => {
      const w = world();
      expect((await w.run({ op: 'apply', spec: JSPEC })).state).toBe('succeeded');
      expect((await w.run({ op: 'remove', data: false })).state).toBe('succeeded');
      expect(w.media()).toMatchObject({ container: null, dataUpstream: { jellyfin: '10.11.3' } });
      jelly(w, jellyPin('10.11.2', '2'));
      const before = w.changes().length;
      const job = await w.run({ op: 'apply', spec: JSPEC });
      expect(job).toMatchObject({ state: 'failed', error: 'downgrade_refused' });
      expect(w.changes().slice(before)).toEqual([`pull ${jellyPin('10.11.2', '2').image}`]);
      expect(w.find(N.container)).toBeUndefined();
    });

    it('remove {data: false}, then a newer pin: the data is snapshotted first, as the version it is', async () => {
      const w = world();
      expect((await w.run({ op: 'apply', spec: JSPEC })).state).toBe('succeeded');
      expect((await w.run({ op: 'remove', data: false })).state).toBe('succeeded');
      jelly(w, jellyPin('10.11.4', '4'));
      const job = await w.run({ op: 'apply', spec: JSPEC });
      expect(job).toMatchObject({ state: 'succeeded' });
      expect(job.media!.steps.snapshot).toBe('ok');
      const backup = w.helperCalls.find((c) => c.verb === 'backup')!;
      expect(backup.args.slice(1)).toEqual(['0', 'jellyfin', '10.11.3']);
      expect(backup.mounts[0]).toMatchObject({ Source: N.data('jellyfin'), ReadOnly: true });
      expect(w.media().backups).toEqual([expect.objectContaining({ kind: 'jellyfin', upstream: '10.11.3', tag: 'auto' })]);
      expect(w.media().dataUpstream).toEqual({ jellyfin: '10.11.4' });
    });

    it('ferrofin -> jellyfin -> ferrofin onto the surviving volume: older refused, newer snapshotted first', async () => {
      const w = world();
      expect((await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } })).state).toBe('succeeded');
      expect((await w.run({ op: 'apply', spec: JSPEC })).state).toBe('succeeded');
      expect(w.media()).toMatchObject({ container: { kind: 'jellyfin' }, dataUpstream: { ferrofin: 'v1.5.1', jellyfin: '10.11.3' } });
      expect(w.volumes.has(N.data('ferrofin'))).toBe(true);

      ferro(w, 'e', 'v1.5.0');
      let job = await w.run({ op: 'apply', spec: SPEC });
      expect(job).toMatchObject({ state: 'failed', error: 'downgrade_refused' });
      expect(w.find(N.container)).toMatchObject({ running: true });
      expect(w.media().container!.kind).toBe('jellyfin');

      ferro(w, 'd', 'v1.6.0');
      job = await w.run({ op: 'apply', spec: SPEC });
      expect(job).toMatchObject({ state: 'succeeded' });
      expect(job.media!.steps.snapshot).toBe('ok');
      const backup = w.helperCalls.find((c) => c.verb === 'backup')!;
      expect(backup.args.slice(1)).toEqual(['0', 'ferrofin', 'v1.5.1']);
      expect(backup.mounts[0]).toMatchObject({ Source: N.data('ferrofin'), ReadOnly: true });
      expect(w.media().dataUpstream).toEqual({ ferrofin: 'v1.6.0', jellyfin: '10.11.3' });
    });

    it('a kind switch back that fails restores its snapshot as the user that owns that data', async () => {
      const w = world();
      expect((await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } })).state).toBe('succeeded');
      expect((await w.run({ op: 'apply', spec: { ...JSPEC, uid: 1001, gid: 1001 } })).state).toBe('succeeded');
      const p = ferro(w, 'd', 'v1.6.0');
      w.cfg.healthOf = (c) => (c.body.Image === p.image ? 'unhealthy' : 'healthy');
      const job = await w.run({ op: 'apply', spec: SPEC });
      expect(job).toMatchObject({ state: 'rolled_back', error: 'unhealthy' });
      expect(w.helperCalls.filter((c) => c.verb === 'backup' || c.verb === 'restore').map((c) => [c.verb, c.args[1], c.user])).toEqual([['backup', '0', '1000:1000'], ['restore', 'ferrofin', '1000:1000']]);
      expect(w.media()).toMatchObject({ container: { kind: 'jellyfin' }, dataUpstream: { ferrofin: 'v1.5.1' } });
    });

    it('a data volume of unknown upstream is snapshotted before a deploy uses it', async () => {
      const w = world();
      w.volumes.set(N.data('jellyfin'), { labels: { 'friendflix.managed': 'mediaserver-data', 'friendflix.project': PROJECT }, options: {} });
      const job = await w.run({ op: 'apply', spec: JSPEC });
      expect(job).toMatchObject({ state: 'succeeded' });
      expect(job.media!.steps.snapshot).toBe('ok');
      expect(w.helperCalls.find((c) => c.verb === 'backup')!.args.slice(1)).toEqual(['0', 'jellyfin', 'unknown']);
    });

    it('remove {data: true} forgets it', async () => {
      const w = world();
      expect((await w.run({ op: 'apply', spec: JSPEC })).state).toBe('succeeded');
      expect((await w.run({ op: 'remove', data: true })).state).toBe('succeeded');
      expect(w.media().dataUpstream).toEqual({});
      jelly(w, jellyPin('10.11.2', '2'));
      expect((await w.run({ op: 'apply', spec: JSPEC })).state).toBe('succeeded');
    });
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

  it('a deploy records the render gids it built the container with; remove forgets them', async () => {
    const w = world();
    const answer = w.cfg.answer;
    w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [{ node: 'renderD128', gid: 993, vendor: 'intel' }, { node: 'renderD129', gid: 994, vendor: 'amd' }] } : answer(c));
    expect((await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri' }, firstRun: { password: FIRST_RUN_SEED } })).state).toBe('succeeded');
    expect(w.media().renderGids).toEqual([993, 994]);
    // a failed deploy keeps the record of the container that still runs
    w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [] } : answer(c));
    expect((await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri' } }))).toMatchObject({ state: 'failed', error: 'gpu_missing' });
    expect(w.media().renderGids).toEqual([993, 994]);
    // without the dri GPU: none
    w.cfg.answer = answer;
    expect((await w.run({ op: 'apply', spec: SPEC })).state).toBe('succeeded');
    expect(w.media().renderGids).toEqual([]);
    expect((await w.run({ op: 'remove', data: false })).state).toBe('succeeded');
    expect(w.media().renderGids).toBeUndefined();
  });

  it('template violation is final', async () => {
    const w = world();
    // a render node with gid 0 would hand the media server the root group
    w.cfg.answer = (c) => (c.verb === 'gpu' ? { nodes: [{ node: 'renderD128', gid: 0, vendor: 'intel' }] } : okFolders(c));
    const job = await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri' }, firstRun: { password: FIRST_RUN_SEED } });
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
    const job = await w.run({ op: 'apply', spec: JSPEC, firstRun: { password: FIRST_RUN_SEED } });
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
    const job = await w.run({ op: 'apply', spec: { ...SPEC, gpu: 'dri', egress: false }, firstRun: { password: FIRST_RUN_SEED } });
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
    // a Ferrofin without data creates its administrator from the first-run password: never one without
    ['admin_missing', () => SPEC],
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
    const job = await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } });
    expect(job).toMatchObject({ state: 'failed', error: 'verify_failed' });
    expect(job.media!.steps).toMatchObject({ pull: 'ok', verify: 'failed' });
    expect(w.calls.filter((c) => c.startsWith('create'))).toEqual([]);
  });

  it('a failed pull changes nothing', async () => {
    const w = world();
    w.cfg.pull = async () => { throw new EngineError(500, 'pull_failed'); };
    const job = await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } });
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

  it('remove {data: true} also removes the data of a kind the state no longer knows', async () => {
    const w = world();
    // a jellyfin server, and the ferrofin volumes a remove without data left behind earlier
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    for (const [v, label] of [[N.data('ferrofin'), 'mediaserver-data'], [N.cache('ferrofin'), 'mediaserver-cache']] as const) w.volumes.set(v, { labels: { 'friendflix.managed': label, 'friendflix.project': PROJECT }, options: {} });
    w.updater.updateMedia((m) => { m.dataUpstream = { ferrofin: 'v1.5.1', jellyfin: '10.11.3' }; });
    expect((await w.run({ op: 'remove', data: true })).state).toBe('succeeded');
    for (const k of ['ferrofin', 'jellyfin'] as const) {
      expect(w.volumes.has(N.data(k)), k).toBe(false);
      expect(w.volumes.has(N.cache(k)), k).toBe(false);
    }
    expect(w.media().dataUpstream).toEqual({});
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
    await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } });
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
    expect(w.jobs.start({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } })).toMatchObject({ ok: true });
    expect(w.jobs.start({ op: 'stop' })).toEqual({ ok: false, error: 'busy' });
    expect(w.jobs.start({ op: 'remove', data: false })).toEqual({ ok: false, error: 'busy' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await w.updater.idle();
    expect(w.updater.snapshot().lastJob!.state).toBe('succeeded');
  });

  it('the job state survives in the state file without secrets', async () => {
    const w = world();
    await w.run({ op: 'apply', spec: SPEC, firstRun: { password: FIRST_RUN_SEED } });
    const saved = w.store.state.media as MediaState;
    expect(saved.desired as Desired).toEqual({ ...SPEC, run: true });
    expect(saved.container!.kind as Kind).toBe('ferrofin');
  });
});
