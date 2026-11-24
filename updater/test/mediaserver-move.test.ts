// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EngineError, type Engine } from '../src/mediaserver/engine.js';
import { MediaService } from '../src/mediaserver/service.js';
import { Supervisor } from '../src/mediaserver/supervise.js';
import { mediaStatusView } from '../src/mediaserver/status.js';
import type { DesiredSpec, Folder, MediaOp, RecordedSource } from '../src/mediaserver/types.js';
import { BASE, N, PROJECT, SOURCE, T0, ferroPin, jellyPin, world, type C, type HelperCall, type InspectMount, type Obj } from './media-world.js';

/** FriendFlix's Jellyfin (its /System/Info/Public Id) and another server */
const OURS = '4f1c2a9b8e7d6c5b4a39281706f5e4d3';
const OTHER = '0123456789abcdef0123456789abcdef';
const CONF = '/srv/jellyfin/config';
const MIN = 60_000;

const bind = (Source: string, Destination: string): InspectMount => ({ Type: 'bind', Source, Destination, RW: false });
const MOUNTS: InspectMount[] = [bind(CONF, '/config'), bind(`${BASE}/Filme`, '/movies'), bind(`${BASE}/Serien`, '/data/tv'), { Type: 'volume', Name: 'jf_cache', Source: '/var/lib/docker/volumes/jf_cache/_data', Destination: '/cache', Driver: 'local', RW: true }];
const FOLDERS: Folder[] = [{ rel: 'Filme', target: '/movies', migrated: true }, { rel: 'Serien', target: '/data/tv', migrated: true }];
const MSPEC: DesiredSpec = { kind: 'ferrofin', migrated: true, folders: FOLDERS, uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: true, tz: 'Europe/Berlin' };
type MigrateOp = Extract<MediaOp, { op: 'migrate' }>;

/**
 * A world with FriendFlix's Jellyfin (bind /config, media inside the base at /movies and /data/tv) and a fake data volume: the copy
 * helper fills it as the uid it runs as, the new Ferrofin adopts the copy when it starts (Ferrofin writes jellyfin.db.pre-ferrofin).
 */
function setup(o: { image?: string; mounts?: InspectMount[] } = {}) {
  const w = world();
  const src = w.foreign({ name: 'jellyfin', image: o.image ?? 'jellyfin/jellyfin:10.11.3', mounts: o.mounts ?? MOUNTS });
  w.cfg.servers.set(CONF, OURS);
  const data = { owner: null as number | null, adopted: false, free: 50_000_000_000, copyAnswer: (_c: HelperCall): Obj | null => null };
  const orig = w.cfg.answer;
  w.cfg.answer = (c) => {
    if (c.verb === 'check' && c.args[0] === 'data') return { owner: data.owner, adopted: data.adopted, free: data.free };
    if (c.verb === 'migrate-copy') {
      const special = data.copyAnswer(c);
      if (special) return special;
      data.owner = Number(c.args[3]);
      return { copied: 3, adjusted: c.args[0] === 'final' ? ['network.xml:BaseUrl'] : [] };
    }
    return orig(c);
  };
  w.cfg.healthOf = (c) => { if (c.name === N.container) data.adopted = true; return 'healthy'; };
  const sup = new Supervisor({ ...w.deps, jobs: w.jobs });
  const op: MigrateOp = { op: 'migrate', source: src.id, trickplay: false, gpu: 'off', uid: 1000, gid: 1000, tz: 'Europe/Berlin', serverId: OURS };
  /** a replaced engine method (the fake engine is a plain object) */
  const patch = <K extends keyof Engine>(k: K, f: (orig: Engine[K]) => Engine[K]): void => {
    const e = w.deps.engine as unknown as Record<K, Engine[K]>;
    e[k] = f(e[k]);
  };
  /** the steps as the job log shows them, in order */
  const stepLog = (): string[] => w.updater.log.tail(200).map((l) => l.slice(25)).filter((l) => /^media (check|pull|verify|snapshot|create|start|health|rollback|copy_bulk|stop_source|copy|adopt)$/.test(l));
  return { ...w, src, data, op, sup, patch, stepLog };
}
type W = ReturnType<typeof setup>;

const recorded = (w: W): RecordedSource => ({
  id: w.src.id, name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.3', config: { type: 'bind', source: CONF }, serverId: OURS, version: '10.11.3', at: new Date(T0).toISOString(),
});

/** a move that failed or was aborted: the old Jellyfin runs, the new container is gone, the copied data stays for a retry */
function expectAborted(w: W, code: string): void {
  expect(w.src.running, code).toBe(true);
  expect(w.find(N.container), code).toBeUndefined();
  expect(w.volumes.has(N.data('ferrofin')), code).toBe(true);
  expect(w.media().move, code).toMatchObject({ phase: 'aborted' });
  expect(w.media().lastError, code).toBe(code);
  expect(w.media().container, code).toBeNull();
  // only the recorded Jellyfin was ever started
  expect(w.calls.filter((c) => c.startsWith('start ') && c !== `start ${N.container}`).every((c) => c === 'start jellyfin'), code).toBe(true);
}

describe('the move', () => {
  it('the steps run in order and the source is stopped only after copy_bulk', async () => {
    const w = setup();
    const job = await w.run(w.op);
    expect(job).toMatchObject({ action: 'mediaserver-migrate', state: 'succeeded', error: null });
    expect(job.media!.steps).toEqual({ check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'skipped', create: 'ok', start: 'ok', health: 'ok', rollback: 'skipped', copy_bulk: 'ok', stop_source: 'ok', copy: 'ok', adopt: 'ok' });
    // the deploy's own check, pull and verify run again right before the create (the image is checked once more after the copy)
    expect(w.stepLog()).toEqual(['media check', 'media pull', 'media verify', 'media copy_bulk', 'media stop_source', 'media copy', 'media check', 'media pull', 'media verify', 'media create', 'media start', 'media health', 'media adopt']);

    const order = w.calls.filter((c) => c === 'helper migrate-copy' || c === 'stop jellyfin' || c === `create ${N.container}` || c.startsWith('start '));
    expect(order).toEqual(['helper migrate-copy', 'stop jellyfin', 'helper migrate-copy', `create ${N.container}`, `start ${N.container}`]);
    // both passes as the Ferrofin user with that same uid as their argument; /config read-only, the data volume writable
    const copies = w.helperCalls.filter((c) => c.verb === 'migrate-copy');
    expect(copies.map((c) => [c.args, c.user])).toEqual([[['bulk', '0', 'official', '1000'], '1000:1000'], [['final', '0', 'official', '1000'], '1000:1000']]);
    expect(copies[0]!.mounts).toEqual([
      { Type: 'bind', Source: CONF, Target: '/source', ReadOnly: true },
      { Type: 'volume', Source: N.data('ferrofin'), Target: '/data', ReadOnly: false, VolumeOptions: { NoCopy: true } },
    ]);
    expect(w.helperCalls.filter((c) => c.verb === 'migrate-scan').every((c) => c.mounts.every((m) => m.ReadOnly === true))).toBe(true);

    // the migrated Ferrofin: data at /ferrofin-data, media at Jellyfin's own paths, no first-run administrator
    const body = w.find(N.container)!.body as { Env: string[]; HostConfig: { Mounts: Array<{ Target: string }> } };
    expect(body.HostConfig.Mounts.map((m) => m.Target)).toEqual(['/ferrofin-data', '/cache', '/movies', '/data/tv']);
    expect(body.Env).toContain('FERROFIN_DATA_DIR=/ferrofin-data');
    expect(body.Env.some((e) => e.startsWith('FERROFIN_ADMIN_PASSWORD='))).toBe(false);

    // the source stays stopped; the move is ready for the backend's phases; recorded state is the migrated spec
    expect(w.src.running).toBe(false);
    const m = w.media();
    expect(m.move).toEqual({ source: recorded(w), folders: FOLDERS, phase: 'ready', abort: false });
    expect(m.source).toEqual(recorded(w));
    expect(m.desired).toEqual({ ...MSPEC, run: true });
    expect(m.dataUpstream.ferrofin).toBe('v1.5.1');
    expect(m.lastError).toBeNull();
    // the log never names a host path or the server id
    const log = w.updater.log.tail(200).join('\n');
    for (const secret of [CONF, BASE, OURS, w.src.id]) expect(log).not.toContain(secret);
    expect(JSON.stringify(job)).not.toContain(OURS);
  });

  it('the fresh data volume is seeded writable for the Ferrofin user before the first copy', async () => {
    const w = setup();
    const op = { ...w.op, uid: 1500, gid: 1500 };
    w.cfg.answer = ((orig) => (c: HelperCall) => (c.verb === 'check' && c.args[0] === 'data' && w.data.owner === null ? { owner: null, adopted: false, free: w.data.free } : orig(c)))(w.cfg.answer);
    expect(await w.run(op)).toMatchObject({ state: 'succeeded' });
    // the deploy seeds the fresh cache volume itself (stage 1); the move seeds the data volume before its copy
    const seeds = w.created.filter((c) => (c.body.Cmd as string[] | undefined)?.[0] === 'true' && JSON.stringify(c.body).includes(N.data('ferrofin')));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.body).toMatchObject({ Image: ferroPin().image, User: '1500:1500', Cmd: ['true'], HostConfig: { NetworkMode: 'none', Mounts: [{ Type: 'volume', Source: N.data('ferrofin'), Target: '/tmp', ReadOnly: false }] } });
    // labelled when created, seeded before the first copy, the seed never started
    expect(w.volumes.get(N.data('ferrofin'))!.labels).toEqual({ 'friendflix.managed': 'mediaserver-data', 'friendflix.project': PROJECT });
    const at = (s: string): number => w.calls.indexOf(s);
    expect(at(`createVolume ${N.data('ferrofin')}`)).toBeLessThan(at('create helper'));
    expect(at('create helper')).toBeLessThan(at('helper migrate-copy'));
    expect(w.created.indexOf(seeds[0]!)).toBe(0);
    expect(w.calls.includes('start helper')).toBe(false);
    expect(w.helperCalls.filter((c) => c.verb === 'migrate-copy').map((c) => [c.args[3], c.user])).toEqual([['1500', '1500:1500'], ['1500', '1500:1500']]);
  });

  it('trickplay adds its size to the space check and its flag to both passes', async () => {
    const w = setup();
    // 5 MB + 1 MB trickplay, × 1.2 = 7.2 MB
    w.data.free = 7_000_000;
    expect(await w.run({ ...w.op, trickplay: true })).toMatchObject({ state: 'failed', error: 'no_space' });
    w.data.free = 7_300_000;
    expect(await w.run({ ...w.op, trickplay: true })).toMatchObject({ state: 'succeeded' });
    expect(w.helperCalls.filter((c) => c.verb === 'migrate-copy').map((c) => c.args[1])).toEqual(['1', '1']);
  });

  describe('codes before anything is stopped', () => {
    const cases: Array<[string, (w: W) => void | MigrateOp]> = [
      ['no_space', (w) => { w.data.free = 5_900_000; }],
      ['image_missing', (w) => { w.cfg.pins = { source: SOURCE, pins: { jellyfin: jellyPin('10.11.3') }, invalid: [] }; }],
      ['source_mismatch', (w) => ({ ...w.op, serverId: OTHER })],
      ['source_missing', (w) => ({ ...w.op, source: 'e'.repeat(64) })],
      ['source_version', (w) => { (w.src.raw!.Config as Obj).Image = 'jellyfin/jellyfin:10.9.11'; w.src.body.Image = 'jellyfin/jellyfin:10.9.11'; }],
      ['source_version', (w) => { (w.src.raw!.Config as Obj).Image = 'jellyfin/jellyfin:10.12.0'; w.src.body.Image = 'jellyfin/jellyfin:10.12.0'; }],
      ['uid_mismatch', (w) => { w.volumes.set(N.data('ferrofin'), { labels: { 'friendflix.managed': 'mediaserver-data', 'friendflix.project': PROJECT }, options: {} }); w.data.owner = 1200; }],
      ['verify_failed', (w) => { w.cfg.verify = false; }],
      ['pull_failed', (w) => { w.cfg.pull = async () => { throw new EngineError(500, 'pull_failed'); }; }],
    ];
    for (const [code, arrange] of cases) {
      it(`${code}: the source keeps running, nothing created`, async () => {
        const w = setup();
        const op = arrange(w) ?? w.op;
        expect(await w.run(op)).toMatchObject({ state: 'failed', error: code });
        expect(w.src.running).toBe(true);
        expect(w.calls.some((c) => c.startsWith('stop '))).toBe(false);
        expect(w.calls.includes('helper migrate-copy')).toBe(false);
        expect(w.find(N.container)).toBeUndefined();
        expect(w.media().move?.phase ?? null).not.toBe('running');
      });
    }

    it('a linuxserver version label and an unknown version pass the version check', async () => {
      for (const image of ['lscr.io/linuxserver/jellyfin:10.10.3ubu2404-ls45', 'jellyfin/jellyfin:latest']) {
        const w = setup({ image });
        expect(await w.run(w.op), image).toMatchObject({ state: 'succeeded' });
      }
    });

    it('a bind /config with an unknown Docker data root is refused with a fixed log line', async () => {
      const w = setup();
      w.cfg.facts = { ...w.cfg.facts, dockerRoot: null };
      expect(await w.run(w.op)).toMatchObject({ state: 'failed', error: 'template_violation' });
      expect(w.updater.log.tail(200).some((l) => l.endsWith('Docker-Datenordner unbekannt'))).toBe(true);
      expect(w.src.running).toBe(true);
      expect(w.helperCalls.some((c) => c.mounts.some((m) => m.Target === '/source'))).toBe(false);
    });
  });

  describe('every failure point restarts the source', () => {
    const points: Array<[string, string, (w: W) => void]> = [
      ['stop_source', 'helper_failed', (w) => w.patch('stop', (stop) => async (id, t) => {
        // the engine stopped it, then answered an error: the move must still start it again
        if (id === w.src.id) { w.src.running = false; throw new EngineError(500, 'engine_error'); }
        return stop(id, t);
      })],
      ['copy', 'no_space', (w) => { w.data.copyAnswer = (c) => (c.args[0] === 'final' ? { error: 'no_space' } : null); }],
      ['check', 'gpu_missing', (w) => { w.cfg.answer = ((orig) => (c: HelperCall) => (c.verb === 'gpu' && w.calls.includes('stop jellyfin') ? { nodes: [] } : orig(c)))(w.cfg.answer); }],
      ['verify', 'verify_failed', (w) => { w.cfg.verify = true; w.deps.verify = async () => !w.calls.includes('stop jellyfin'); }],
      ['create', 'create_failed', (w) => w.patch('create', (create) => async (req) => { if (req.name === N.container) throw new EngineError(500, 'create_failed'); return create(req); })],
      ['start', 'start_failed', (w) => { w.cfg.failStart = (c: C) => c.name === N.container; }],
      ['health', 'unhealthy', (w) => { w.cfg.healthOf = () => 'unhealthy'; }],
      ['adopt', 'adopt_failed', (w) => { w.cfg.healthOf = () => 'healthy'; }],
    ];
    for (const [step, code, arrange] of points) {
      it(`${step} fails with ${code}`, async () => {
        const w = setup();
        const op: MigrateOp = { ...w.op, gpu: step === 'check' ? 'dri' : 'off' };
        arrange(w);
        const job = await w.run(op);
        expect(job).toMatchObject({ action: 'mediaserver-migrate', state: 'failed', error: code });
        expect(job.media!.steps[step as keyof NonNullable<typeof job.media>['steps']]).toBe('failed');
        expectAborted(w, code);
        // the order: the source was stopped before it was started again, and started after the new container went
        const stopAt = w.calls.lastIndexOf('stop jellyfin');
        expect(stopAt === -1 ? step === 'stop_source' : true).toBe(true);
        expect(w.calls.lastIndexOf('start jellyfin')).toBeGreaterThan(Math.max(stopAt, w.calls.lastIndexOf(`remove ${N.container}`)));
        expect(w.updater.log.tail(200).some((l) => l.endsWith('media source started again'))).toBe(true);
        // a deployed container is gone from the record, the migrated spec is not running anywhere
        expect(w.media().desired?.run ?? false).toBe(false);
        expect(w.removedWith.filter((r) => r.name === N.container).every((r) => r.o.volumes !== true)).toBe(true);
      });
    }

    it('a source start that throws once is retried', async () => {
      const w = setup();
      w.data.copyAnswer = (c) => (c.args[0] === 'final' ? { error: 'helper_failed' } : null);
      let fails = 1;
      w.patch('start', (start) => async (id) => { if (id === w.src.id && fails-- > 0) throw new EngineError(500, 'engine_error'); return start(id); });
      expect(await w.run(w.op)).toMatchObject({ state: 'failed', error: 'helper_failed' });
      expectAborted(w, 'helper_failed');
    });

    it('a source start that keeps failing keeps the move for the supervisor, which starts it later', async () => {
      const w = setup();
      w.data.copyAnswer = (c) => (c.args[0] === 'final' ? { error: 'helper_failed' } : null);
      let broken = true;
      w.patch('start', (start) => async (id) => { if (id === w.src.id && broken) throw new EngineError(500, 'engine_error'); return start(id); });
      expect(await w.run(w.op)).toMatchObject({ state: 'failed', error: 'helper_failed' });
      expect(w.src.running).toBe(false);
      expect(w.media().move).toMatchObject({ phase: 'running', abort: true });
      expect(w.media().lastError).toBe('start_failed');
      // the supervisor never recreates anything while a move is unsettled; it retries the abort
      broken = false;
      w.clock.t += 11 * MIN;
      expect(await w.sup.tick()).toBe('move');
      await w.updater.idle();
      expect(w.updater.snapshot().lastJob).toMatchObject({ action: 'mediaserver-migrate', state: 'succeeded' });
      expect(w.src.running).toBe(true);
      expect(w.media().move).toMatchObject({ phase: 'aborted' });
      expect(w.media().lastError).toBe('move_aborted');
    });
  });

  describe('abort', () => {
    it('during the job: before the source stops, and after', async () => {
      for (const pass of ['bulk', 'final']) {
        const w = setup();
        const answers: unknown[] = [];
        w.data.copyAnswer = (c) => {
          if (c.args[0] === pass) answers.push(w.jobs.start({ op: 'migrate-abort' }));
          return null;
        };
        const job = await w.run(w.op);
        expect(answers, pass).toEqual([{ ok: true, job: expect.objectContaining({ action: 'mediaserver-migrate', state: 'running' }) }]);
        expect(job, pass).toMatchObject({ state: 'failed', error: 'move_aborted' });
        expectAborted(w, 'move_aborted');
        expect(w.calls.includes('stop jellyfin'), pass).toBe(pass === 'final');
        expect(w.calls.includes(`create ${N.container}`), pass).toBe(false);
      }
    });

    it('in ready: its own job removes the new container and starts the source', async () => {
      const w = setup();
      await w.run(w.op);
      const created = w.find(N.container)!;
      const job = await w.run({ op: 'migrate-abort' });
      expect(job).toMatchObject({ action: 'mediaserver-migrate', state: 'succeeded' });
      expect(w.calls.slice(w.calls.indexOf(`stop ${N.container}`))).toEqual(expect.arrayContaining([`remove ${N.container}`, 'start jellyfin']));
      expect(w.containers.has(created.id)).toBe(false);
      expectAborted(w, 'move_aborted');
      expect(w.media().desired).toMatchObject({ migrated: true, run: false });
      // nothing more to abort
      expect(w.jobs.start({ op: 'migrate-abort' })).toEqual({ ok: false, error: 'no_target' });
    });

    it('nothing to abort, and a job of another kind is not aborted', async () => {
      const w = setup();
      expect(w.jobs.start({ op: 'migrate-abort' })).toEqual({ ok: false, error: 'no_target' });
      const { migrated: _m, ...plain } = MSPEC;
      w.existing({ ...plain, folders: [{ rel: 'Filme', target: '/media/filme' }] }, ferroPin(), 'v1.5.1');
      expect(w.jobs.start({ op: 'restart' })).toMatchObject({ ok: true });
      expect(w.jobs.start({ op: 'migrate-abort' })).toEqual({ ok: false, error: 'busy' });
      await w.updater.idle();
    });

    it('a second move while one is not settled is busy', async () => {
      const w = setup();
      w.updater.updateMedia((m) => { m.move = { source: recorded(w), folders: FOLDERS, phase: 'running', abort: true }; });
      expect(w.jobs.start(w.op)).toEqual({ ok: false, error: 'busy' });
      w.updater.updateMedia((m) => { m.move!.phase = 'ready'; });
      expect(w.jobs.start(w.op)).toEqual({ ok: false, error: 'busy' });
    });
  });

  describe('a move found unfinished at start', () => {
    it('restarts the source and removes the new container before anything else runs', async () => {
      for (const deployed of [false, true]) {
        const w = setup();
        w.updater.updateMedia((m) => { m.move = { source: recorded(w), folders: FOLDERS, phase: 'running', abort: false }; });
        w.src.running = false;
        const made = w.existing(MSPEC, ferroPin(), 'v1.5.1');
        if (!deployed) w.updater.updateMedia((m) => { m.container = null; m.desired = null; });
        await w.sup.startup();
        await w.updater.idle();
        expect(w.updater.snapshot().lastJob, String(deployed)).toMatchObject({ action: 'mediaserver-migrate', state: 'succeeded' });
        expect(w.containers.has(made.id), String(deployed)).toBe(false);
        expect(w.src.running, String(deployed)).toBe(true);
        expect(w.media(), String(deployed)).toMatchObject({ move: { phase: 'aborted' }, lastError: 'move_aborted', container: null, tampered: false });
        // never adopted, never recreated
        expect(w.calls.filter((c) => c.startsWith('create ')), String(deployed)).toEqual([]);
        expect(await w.sup.tick(), String(deployed)).toBe('idle');
      }
    });

    it('an earlier Ferrofin that the move did not create stays (a repeated move)', async () => {
      const w = setup();
      const old = w.existing(MSPEC, ferroPin(), 'v1.5.1', { run: false });
      w.updater.updateMedia((m) => { m.move = { source: recorded(w), folders: FOLDERS, phase: 'running', abort: false }; });
      w.src.running = false;
      await w.sup.startup();
      await w.updater.idle();
      expect(w.containers.has(old.id)).toBe(true);
      expect(w.src.running).toBe(true);
    });
  });
});

describe('the source op (the way back)', () => {
  it('starts only the recorded source, refuses any other container', async () => {
    const w = setup();
    w.updater.updateMedia((m) => { m.source = recorded(w); });
    w.src.running = false;
    // a copy of the server on another /config, another server, and a look-alike image on the same /config that is not Jellyfin
    const copy = w.foreign({ name: 'jellyfin-copy', image: 'jellyfin/jellyfin:10.11.3', mounts: [bind('/srv/copy/config', '/config')], running: false });
    const other = w.foreign({ name: 'jellyfin-2', image: 'jellyfin/jellyfin:10.11.3', mounts: [bind('/srv/other/config', '/config')], running: false });
    const fake = w.foreign({ name: 'not-jellyfin', image: 'example/jellyfin-proxy:1', mounts: [bind(CONF, '/config')], running: false });
    w.cfg.servers.set('/srv/copy/config', OURS).set('/srv/other/config', OTHER);
    const job = await w.run({ op: 'source-start' });
    expect(job).toMatchObject({ action: 'mediaserver-source', state: 'succeeded' });
    expect(w.src.running).toBe(true);
    for (const c of [copy, other, fake]) expect(c.running).toBe(false);
    expect(w.calls.filter((c) => c.startsWith('start '))).toEqual(['start jellyfin']);

    // the recorded one gone: source_missing, the others stay untouched
    w.containers.delete(w.src.id);
    expect(await w.run({ op: 'source-start' })).toMatchObject({ state: 'failed', error: 'source_missing' });
    for (const c of [copy, other, fake]) expect(c.running).toBe(false);
    // a container on the recorded /config whose server id changed is not the source either
    const swapped = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.3', mounts: [bind(CONF, '/config')], running: false });
    w.cfg.servers.set(CONF, OTHER);
    expect(await w.run({ op: 'source-start' })).toMatchObject({ state: 'failed', error: 'source_missing' });
    expect(swapped.running).toBe(false);
  });

  it('source-start rematches a recreated source and records its new id', async () => {
    const w = setup();
    w.updater.updateMedia((m) => { m.source = recorded(w); });
    w.containers.delete(w.src.id);
    const again = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.4', mounts: MOUNTS, running: false });
    expect(await w.run({ op: 'source-start' })).toMatchObject({ state: 'succeeded' });
    expect(again.running).toBe(true);
    expect(w.media().source).toMatchObject({ id: again.id, config: { type: 'bind', source: CONF }, serverId: OURS });
    const log = w.updater.log.tail(200).join('\n');
    expect(log).toContain('media source recreated: the recorded container replaced');
    expect(log).not.toContain(again.id);
  });

  it('nothing recorded: no target', () => {
    const w = setup();
    expect(w.jobs.start({ op: 'source-start' })).toEqual({ ok: false, error: 'no_target' });
  });

  it('the way back and a second move: the earlier Ferrofin data is saved first, the record follows the new move', async () => {
    const w = setup();
    await w.run(w.op);
    expect(w.jobs.migrateDone()).toBe(true);
    expect(w.media().move).toBeUndefined();
    expect(w.media().source).toEqual(recorded(w));
    expect(w.jobs.migrateDone()).toBe(false);

    // the way back as the backend runs it: the source first, then the managed server stops
    expect(await w.run({ op: 'source-start' })).toMatchObject({ state: 'succeeded' });
    expect(await w.run({ op: 'stop' })).toMatchObject({ state: 'succeeded' });
    expect(w.src.running).toBe(true);
    expect(w.media().desired).toEqual({ ...MSPEC, run: false });
    // a recover or an update still matches the migrated record
    expect(await w.jobs.templateState()).toBe('current');

    w.data.adopted = false;
    const second = await w.run(w.op);
    expect(second).toMatchObject({ state: 'succeeded' });
    expect(second.media!.steps.snapshot).toBe('ok');
    expect(w.helperCalls.filter((c) => c.verb === 'backup')).toHaveLength(1);
    expect(w.calls.indexOf('helper backup')).toBeLessThan(w.calls.indexOf('helper migrate-copy', w.calls.indexOf('helper backup')));
    expect(w.media()).toMatchObject({ desired: { ...MSPEC, run: true }, move: { phase: 'ready' }, source: { id: w.src.id } });
    expect(w.src.running).toBe(false);
  });

  it('a second move from another server is refused', async () => {
    const w = setup();
    w.updater.updateMedia((m) => { m.source = { ...recorded(w), config: { type: 'bind', source: '/srv/other/config' } }; });
    expect(await w.run(w.op)).toMatchObject({ state: 'failed', error: 'source_mismatch' });
    expect(w.src.running).toBe(true);
  });
});

describe('carried over from the earlier tasks', () => {
  it('the inspect guard takes the move folders for the new container and the record for the old one', async () => {
    const w = setup();
    const { migrated: _m, ...plain } = MSPEC;
    const stage1: DesiredSpec = { ...plain, folders: [{ rel: 'Filme', target: '/media/filme' }] };
    // the move's new container (not recorded yet), then the stage 1 one the state records
    const made = w.existing(MSPEC, ferroPin(), 'v1.5.1', { name: `${PROJECT}-other` });
    const old = w.existing(stage1, ferroPin(), 'v1.5.1');
    w.updater.updateMedia((m) => { m.move = { source: recorded(w), folders: FOLDERS, phase: 'running', abort: false }; });
    const inspect = async (c: C): Promise<Obj> => (await w.deps.engine.inspectContainer(c.id))!;
    await expect(w.jobs.guardInspect(await inspect(old), PROJECT, 'off')).resolves.toBeUndefined();
    await expect(w.jobs.guardInspect(await inspect(made), PROJECT, 'off')).resolves.toBeUndefined();
    // without the running move, a migrated container under a stage 1 record is tampered
    w.updater.updateMedia((m) => { m.move!.phase = 'aborted'; });
    await expect(w.jobs.guardInspect(await inspect(made), PROJECT, 'off')).rejects.toThrow('managed_tampered');
  });

  it('the whole base (rel "") is the parent of every other folder', async () => {
    const w = setup({ mounts: [bind(CONF, '/config'), bind(BASE, '/media')] });
    expect(await w.run(w.op)).toMatchObject({ state: 'succeeded' });
    expect(w.media().desired!.folders).toEqual([{ rel: '', target: '/media', migrated: true }]);
    // the folder check got the whole base too
    expect(w.helperCalls.filter((c) => c.verb === 'check' && c.args[0] === 'folders').map((c) => c.args[1])).toContain('[""]');
    const spec = { ...w.media().desired!, folders: [...w.media().desired!.folders, { rel: 'Filme', target: '/ffmedia/filme' }] };
    const { run: _run, ...apply } = spec;
    expect(await w.run({ op: 'apply', spec: apply })).toMatchObject({ state: 'failed', error: 'folder_nested' });
  });

  it('a base change while a migrated server exists is refused', async () => {
    const w = setup();
    await w.run(w.op);
    const service = new MediaService(w.deps, w.jobs);
    w.updater.updateMedia((m) => { m.pending = { path: '/srv/other', codeHash: 'a'.repeat(64), expiresAt: new Date(T0 + 10 * MIN).toISOString(), failures: 0 }; });
    // the code is not even compared: no base change can be committed
    expect(await service.confirm('AAAA-BBBB-CCCC')).toEqual({ error: 'template_violation' });
    expect(w.media().base!.path).toBe(BASE);
  });

  it('the status view shows the move and the source without paths or the server id', async () => {
    const w = setup();
    const view = () => mediaStatusView({ updater: w.updater, engine: w.deps.engine, jobs: w.jobs, facts: w.deps.facts, pins: w.deps.pins, templateState: async () => null, now: () => w.clock.t, ttlMs: 0 })();
    expect(await view()).toMatchObject({ move: null, source: null });
    await w.run(w.op);
    const v = await view();
    // a job that succeeded is at no step any more
    expect(v.move).toEqual({ phase: 'ready', step: null, source: { name: 'jellyfin', version: '10.11.3' }, folders: FOLDERS, abort: false });
    expect(v.source).toEqual({ name: 'jellyfin', state: 'exited', version: '10.11.3' });
    expect(v.container).toMatchObject({ tampered: false });
    const text = JSON.stringify(v);
    for (const secret of [CONF, OURS, w.src.id]) expect(text).not.toContain(secret);
    w.containers.delete(w.src.id);
    expect((await view()).source).toEqual({ name: 'jellyfin', state: 'missing', version: '10.11.3' });
    // a failed move shows the step it stopped at
    await w.run({ op: 'migrate-abort' }).catch(() => undefined);
    const f = setup();
    f.cfg.healthOf = () => 'healthy';
    await f.run(f.op);
    const fv = await mediaStatusView({ updater: f.updater, engine: f.deps.engine, jobs: f.jobs, facts: f.deps.facts, pins: f.deps.pins, templateState: async () => null, now: () => f.clock.t, ttlMs: 0 })();
    expect(fv.move).toMatchObject({ phase: 'aborted', step: 'adopt' });
    expect(fv.source).toMatchObject({ state: 'running' });
  });
});
