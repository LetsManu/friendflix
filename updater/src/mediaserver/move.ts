// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { StepError } from '../docker.js';
import type { Updater } from '../job.js';
import type { Job } from '../state.js';
import type { Engine } from './engine.js';
import type { EngineFacts } from './facts.js';
import { assertHelper } from './guard.js';
import type { Pin, PinRead } from './pins.js';
import { SCAN_HELPER_MS, SYNC_HELPER_MS } from './service.js';
import { rematch, scanSource, type ScanResult, type SourceConfig, type SourceDeps } from './source.js';
import { names, seedSpec, uidSupported, volumeSpec, type HelperMount, type HelperVerb } from './template.js';
import type { BackupMeta, DesiredSpec, Kind, MediaError, MediaOp, MediaStep, RecordedSource } from './types.js';

/**
 * The move from an existing Jellyfin (stage 2 "The move", "After the move"): one job `mediaserver-migrate` (check → pull → verify →
 * [snapshot] → copy_bulk → stop_source → copy → the stage 1 deploy of a migrated Ferrofin → adopt), its abort, the way back's
 * `mediaserver-source` job and the settling of a move found unfinished. From `stop_source` on, every way out of the job starts the
 * recorded source again (`finally`); when that fails twice the move stays `running` with `abort` set and the supervisor retries.
 * The updater stops and starts only the recorded source, matched by its /config mount source and server id (source.ts rematch).
 * Log lines are fixed messages: never a host path, a container id or the server id.
 */

type Obj = Record<string, unknown>;
type User = { uid: number; gid: number; groups: number[] };
type Runner = { project: string; image: string };
type MigrateOp = Extract<MediaOp, { op: 'migrate' }>;

/** what the move needs of the media jobs (jobs.ts builds it) */
export interface MoveKit {
  updater: Updater;
  engine: Engine;
  step<T>(job: Job, name: MediaStep, fn: () => Promise<T>): Promise<T>;
  ready(): Promise<{ facts: EngineFacts; project: string; runner: Runner }>;
  helper(r: Runner, u: User, verb: HelperVerb, args: string[], mounts: HelperMount[], limitMs?: number, source?: { expect: SourceConfig; dockerRoot: string | null }): Promise<Obj>;
  pins(): Promise<PinRead>;
  verifyImage(pin: Pin): Promise<string>;
  renderGids(r: Runner, d: Pick<DesiredSpec, 'uid' | 'gid' | 'mediaGid' | 'gpu'>): Promise<number[]>;
  deploy(job: Job, d: DesiredSpec, o: { reason: 'apply' }): Promise<void>;
  /** the deploy's `auto` snapshot of a kind's data volume as the user that owns it */
  snapshot(of: { kind: Kind; upstream: string; user: User }): Promise<BackupMeta>;
  labelled(i: Obj, project: string): { id: string; kind: Kind | null; running: boolean } | null;
  now(): number;
}

/** the copy passes (spec "Times" has none: metadata on a NAS takes long); the final pass runs with Jellyfin stopped */
export const BULK_COPY_MS = 6 * 3600_000;
export const FINAL_COPY_MS = 2 * 3600_000;
/** free space on the Docker data root against the size of the copy (spec: ≥ copy size × 1.2) */
export const SPACE_FACTOR = 1.2;
/**
 * The Jellyfin versions (major.minor, inclusive) whose database the pinned Ferrofin adopts: Ferrofin follows Jellyfin 10.11, which
 * upgrades a 10.10 database and nothing older. To confirm against Ferrofin's release notes on every pin change (NAS checklist).
 */
export const ADOPTS: { from: [number, number]; to: [number, number] } = { from: [10, 10], to: [10, 11] };
const ADJUSTED_RE = /^[a-z]{1,20}\.xml:[A-Za-z]{1,40}$/;

const fail = (code: MediaError): never => { throw new StepError(code); };
const codeOf = (e: unknown, fallback: MediaError): MediaError => (e instanceof StepError ? (e.code as MediaError) : fallback);
const userOf = (d: { uid: number; gid: number; mediaGid: number | null } | null | undefined, fallback: User): User =>
  (d ? { uid: d.uid, gid: d.gid, groups: d.mediaGid ? [d.mediaGid] : [] } : fallback);
const DEFAULT_USER: User = { uid: 1000, gid: 1000, groups: [] };

/** the numeric prefix of a version (`10.10.3ubu2404-ls45` → 10.10); null = not a version (no check) */
function majorMinor(v: string | null): [number, number] | null {
  const m = v === null ? null : /^v?([0-9]{1,4})\.([0-9]{1,4})/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** whether the pinned Ferrofin adopts this Jellyfin version; an unknown version is not checked */
export function adoptable(version: string | null): boolean {
  const v = majorMinor(version);
  if (!v) return true;
  const n = (x: [number, number]): number => x[0] * 10_000 + x[1];
  return n(v) >= n(ADOPTS.from) && n(v) <= n(ADOPTS.to);
}

const sameSource = (a: RecordedSource, b: RecordedSource): boolean => a.serverId === b.serverId && a.config.type === b.config.type && a.config.source === b.config.source;

/** the scan helper on a /config (read-only at /source, the guard checks the mount against it and the Docker data root) as `user` */
function sourceDeps(k: MoveKit, r: { facts: EngineFacts; runner: Runner }, user: User, base: { path: string } | null): SourceDeps {
  return {
    engine: k.engine, base, now: () => k.now(),
    scan: async (config, mode) => {
      // a bind source is checked against the Docker data root; an unknown one refuses every bind (fail closed)
      if (config.type === 'bind' && !r.facts.dockerRoot) {
        k.updater.log.add('Docker-Datenordner unbekannt');
        fail('template_violation');
      }
      return k.helper(r.runner, user, 'migrate-scan', mode === 'id' ? ['id'] : [], [{ kind: 'source', type: config.type, source: config.source }],
        mode === 'id' ? SYNC_HELPER_MS : SCAN_HELPER_MS, { expect: config, dockerRoot: r.facts.dockerRoot });
    },
  };
}

interface Ctx { project: string; runner: Runner; facts: EngineFacts; baseVolume: string; pin: Pin; user: User; scan: ScanResult; empty: boolean; known: string | undefined }

/** everything that can be known before anything changes (the data volume is created when missing, labelled, empty) */
async function check(k: MoveKit, op: MigrateOp): Promise<Ctx> {
  const m = k.updater.mediaState();
  const base = m.base ?? fail('no_base');
  const r = await k.ready();
  if (!r.facts.egressNetwork) fail('no_network');
  if (r.facts.arch !== 'amd64') fail('arch_unsupported');
  if (!uidSupported('ferrofin', op.uid, op.gid)) fail('uid_unsupported');
  const read: PinRead = await k.pins().catch((): PinRead => ({ error: 'no_backend' }));
  if ('error' in read) return fail(read.error === 'verify_failed' ? 'verify_failed' : 'image_missing');
  const pin = read.pins.ferrofin ?? fail(read.invalid.includes('ferrofin') ? 'pin_invalid' : 'image_missing');
  const user: User = { uid: op.uid, gid: op.gid, groups: [] };

  // the source: the candidate scanned now, FriendFlix's server, the one recorded by an earlier move, a version Ferrofin adopts
  const scan = await scanSource(sourceDeps(k, r, user, { path: base.path }), op.source, op.serverId);
  if (m.source && !sameSource(m.source, scan.source)) fail('source_mismatch');
  if (!adoptable(scan.source.version)) fail('source_version');
  if (op.gpu === 'nvidia' && !r.facts.nvidia) fail('nvidia_missing');
  await k.renderGids(r.runner, { uid: op.uid, gid: op.gid, mediaGid: null, gpu: op.gpu });

  // the data volume (ours, labelled) and the free space on the Docker data root it lives on
  const data = names(r.project).data('ferrofin');
  if (!(await k.engine.inspectVolume(data))) await k.engine.createVolume(volumeSpec(r.project, 'data', { kind: 'ferrofin' }));
  const a = await k.helper(r.runner, user, 'check', ['data'], [{ kind: 'data', volume: data, rw: false }]);
  if (typeof a.owner === 'number' && a.owner !== op.uid) fail('uid_mismatch');
  const free = typeof a.free === 'number' && Number.isSafeInteger(a.free) && a.free >= 0 ? a.free : fail('helper_failed');
  if (free < (scan.bytes + (op.trickplay ? scan.trickplayBytes : 0)) * SPACE_FACTOR) fail('no_space');
  const known = m.dataUpstream.ferrofin ?? (m.container?.kind === 'ferrofin' ? m.container.upstream : undefined);
  return { project: r.project, runner: r.runner, facts: r.facts, baseVolume: base.volume, pin, user, scan, empty: a.owner === null, known };
}

/** a move abort asked for while the job runs (checked between steps) */
function between(k: MoveKit): void {
  if (k.updater.mediaState().move?.abort) fail('move_aborted');
}

/** our Ferrofin under the real name is stopped before anything writes its data volume (FriendFlix does not use it: the backend gate) */
async function quiesce(k: MoveKit, project: string): Promise<void> {
  const i = await k.engine.inspectContainer(names(project).container);
  const own = i ? k.labelled(i, project) : null;
  if (!own || own.kind !== 'ferrofin' || !own.running) return;
  k.updater.updateMedia((s) => { if (s.desired) s.desired.run = false; });
  await k.engine.stop(own.id);
  k.updater.log.add('media server stopped for the move');
}

/** an empty data volume gets the owner and mode of the Ferrofin image's /tmp (root, 1777) from a never-started seed: the copy user can write it */
async function seed(k: MoveKit, c: Ctx, spec: DesiredSpec): Promise<void> {
  const req = seedSpec('ferrofin', 'data', spec, { project: c.project, image: c.pin.image, renderGids: [], baseVolume: c.baseVolume });
  assertHelper(req.body, { project: c.project, uid: spec.uid, gid: spec.gid, image: c.pin.image, verb: 'seed', kind: 'ferrofin' });
  const id = await k.engine.create(req);
  await k.engine.remove(id, { volumes: true }).catch(() => undefined);
}

/** one copy pass as the Ferrofin user (its uid also the helper's argument: the helper refuses another, and root); the adjusted keys are logged by name */
async function copy(k: MoveKit, c: Ctx, pass: 'bulk' | 'final', trickplay: boolean): Promise<void> {
  const config = c.scan.source.config;
  const a = await k.helper(c.runner, c.user, 'migrate-copy', [pass, trickplay ? '1' : '0', c.scan.layout, String(c.user.uid)],
    [{ kind: 'source', type: config.type, source: config.source }, { kind: 'data', volume: names(c.project).data('ferrofin'), rw: true }],
    pass === 'bulk' ? BULK_COPY_MS : FINAL_COPY_MS, { expect: config, dockerRoot: c.facts.dockerRoot });
  if (Array.isArray(a.adjusted)) for (const key of a.adjusted.slice(0, 20)) if (typeof key === 'string' && ADJUSTED_RE.test(key)) k.updater.log.add(`media copy adjusted ${key}`);
}

/**
 * The recorded source started: rematched (same /config mount source and server id; a recreated one replaces the recorded id, which
 * is logged without it), then started unless it runs. source_missing when no container is the source today.
 */
export async function startSource(k: MoveKit, rec: RecordedSource, user?: User): Promise<'started' | 'running'> {
  const r = await k.ready();
  const m = k.updater.mediaState();
  const id = (await rematch(sourceDeps(k, r, user ?? userOf(m.desired, DEFAULT_USER), null), rec)) ?? fail('source_missing');
  if (id !== rec.id) {
    k.updater.updateMedia((s) => {
      for (const x of [s.source, s.move?.source]) if (x && sameSource(x, rec)) x.id = id;
    });
    k.updater.log.add('media source recreated: the recorded container replaced');
  }
  const i = await k.engine.inspectContainer(id);
  if (i && typeof i.State === 'object' && i.State !== null && (i.State as Obj).Running === true) return 'running';
  await k.engine.start(id);
  return 'started';
}

/** the source start of an abort: tried twice; the code of the last failure, null when it runs */
async function startAgain(k: MoveKit, rec: RecordedSource, user?: User): Promise<MediaError | null> {
  let code: MediaError = 'start_failed';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((await startSource(k, rec, user)) === 'started') k.updater.log.add('media source started again');
      return null;
    } catch (e) {
      code = codeOf(e, 'start_failed');
    }
  }
  k.updater.log.add('media source could not be started: retried by the supervisor');
  return code;
}

/**
 * The managed container the move created goes (stopped, removed; the data volume stays for a retry), and the migrated spec no longer
 * runs. `recorded`: the move's deploy succeeded, the recorded container is the new one. `guess` (a move found unfinished, or the
 * container cannot be told): the container under the real name when it is ours and either not the recorded one (a create the
 * deploy did not finish) or running (the recorded one of a finished deploy; an earlier Ferrofin of a repeated move is stopped).
 */
async function removeNew(k: MoveKit, mode: 'recorded' | 'guess'): Promise<void> {
  const { project } = await k.ready();
  const i = await k.engine.inspectContainer(names(project).container);
  const own = i ? k.labelled(i, project) : null;
  if (!own) return;
  const recorded = k.updater.mediaState().container?.id === own.id;
  if (mode === 'recorded' ? !recorded : recorded && !own.running) return;
  await k.engine.stop(own.id).catch(() => undefined);
  await k.engine.remove(own.id, { force: true });
  k.updater.updateMedia((s) => {
    if (s.container?.id === own.id) s.container = null;
    if (s.desired) s.desired.run = false;
    s.tampered = false;
  });
  k.updater.log.add('media move: the new container was removed');
}

/**
 * The end of every move that did not reach `ready`, and of an abort: the new container goes, the source is started (when it was
 * stopped, or may have been), the move is `aborted` with `code` as lastError. Never throws. When the source cannot be started, the
 * move stays `running` with `abort` set and the source start's code: the supervisor (and the next start) try again.
 */
async function settle(k: MoveKit, o: { code: MediaError; remove: 'none' | 'recorded' | 'guess'; start: boolean; touched: boolean; user?: User }): Promise<void> {
  const move = k.updater.mediaState().move;
  if (!move) return;
  if (o.remove !== 'none') {
    try { await removeNew(k, o.remove); } catch { k.updater.log.add('media move: the new container could not be removed'); }
  }
  const failed = o.start ? await startAgain(k, move.source, o.user) : null;
  k.updater.updateMedia((s) => {
    // the copied data is no Ferrofin's (or one this move made): no version is known for it
    if (o.touched) delete s.dataUpstream.ferrofin;
    if (!s.move) return;
    if (failed === null) {
      s.move.phase = 'aborted';
      s.move.abort = false;
      s.lastError = o.code;
    } else {
      s.move.phase = 'running';
      s.move.abort = true;
      s.lastError = failed;
    }
  });
  k.updater.log.add(failed === null ? `media move ended: ${o.code}` : 'media move not settled');
}

/** the move job; throws StepError(code) after settling (the source runs again whenever it was stopped) */
export async function migrateJob(k: MoveKit, job: Job, op: MigrateOp): Promise<void> {
  const c = await k.step(job, 'check', () => check(k, op));
  const spec: DesiredSpec = { kind: 'ferrofin', migrated: true, folders: c.scan.folders, uid: op.uid, gid: op.gid, gpu: op.gpu, mediaGid: null, egress: true, tz: op.tz };
  // from here on the move is recorded: a restart of the updater settles it before anything else (supervise.ts)
  k.updater.updateMedia((m) => { m.move = { source: c.scan.source, folders: c.scan.folders, phase: 'running', abort: false }; m.lastError = null; });
  k.updater.log.add('media move started');
  const t = { touched: false, stopped: false, deployed: false };
  let done = false;
  let code: MediaError = 'helper_failed';
  try {
    await k.step(job, 'pull', () => k.engine.pull(c.pin.image));
    const upstream = await k.step(job, 'verify', () => k.verifyImage(c.pin));
    between(k);
    // an earlier Ferrofin's data (a repeated move) is saved before the copy replaces it
    if (!c.empty && c.known !== undefined) {
      const m = k.updater.mediaState();
      const known = c.known;
      await k.step(job, 'snapshot', async () => {
        await quiesce(k, c.project);
        await k.snapshot({ kind: 'ferrofin', upstream: known, user: userOf(m.desired, c.user) });
      });
      between(k);
    }
    await k.step(job, 'copy_bulk', async () => {
      await quiesce(k, c.project);
      if (c.empty) await seed(k, c, spec);
      t.touched = true;
      await copy(k, c, 'bulk', op.trickplay);
    });
    between(k);
    await k.step(job, 'stop_source', async () => {
      // the scanned container is still the source (and nothing else runs on its /config)
      const id = await rematch(sourceDeps(k, { facts: c.facts, runner: c.runner }, c.user, null), c.scan.source);
      if (id === null || id !== c.scan.source.id) return fail('source_missing');
      t.stopped = true;
      await k.engine.stop(id);
      k.updater.log.add('media source stopped');
    });
    between(k);
    await k.step(job, 'copy', () => copy(k, c, 'final', op.trickplay));
    between(k);
    // the copy is the data the pinned Ferrofin adopts: no snapshot of it, no downgrade rule against an earlier Ferrofin's version
    k.updater.updateMedia((m) => { m.dataUpstream.ferrofin = upstream; });
    await k.deploy(job, spec, { reason: 'apply' });
    t.deployed = true;
    between(k);
    await k.step(job, 'adopt', async () => {
      const a = await k.helper(c.runner, c.user, 'check', ['data'], [{ kind: 'data', volume: names(c.project).data('ferrofin'), rw: false }]);
      if (a.adopted !== true) fail('adopt_failed');
    });
    between(k);
    // the source stays stopped (nothing may keep writing to it); the backend's phases follow, then migrate-done or migrate-abort
    k.updater.updateMedia((m) => {
      if (!m.move) return;
      m.move.phase = 'ready';
      m.source = m.move.source;
      m.lastError = null;
    });
    k.updater.log.add('media move ready');
    done = true;
  } catch (e) {
    code = codeOf(e, 'helper_failed');
    throw new StepError(code);
  } finally {
    if (!done) await settle(k, { code, remove: t.deployed ? 'recorded' : 'none', start: t.stopped, touched: t.touched, user: c.user });
  }
}

/**
 * migrate-abort as its own job: a move in `ready` (the backend's phases failed) or one left `running` by a restart. The new
 * container goes, the source is started; fails with the source start's code when it does not run.
 */
export async function abortJob(k: MoveKit): Promise<void> {
  const move = k.updater.mediaState().move;
  if (!move) return;
  await settle(k, { code: 'move_aborted', remove: move.phase === 'ready' ? 'recorded' : 'guess', start: true, touched: move.phase === 'ready' });
  const after = k.updater.mediaState();
  if (after.move?.phase !== 'aborted') fail(after.lastError ?? 'start_failed');
}

/** source-start (the way back): only the recorded source, rematched; started when it is stopped */
export async function sourceJob(k: MoveKit, job: Job): Promise<void> {
  const m = k.updater.mediaState();
  const rec = m.source ?? m.move?.source ?? fail('source_missing');
  await k.step(job, 'start', async () => {
    const r = await startSource(k, rec);
    k.updater.log.add(r === 'started' ? 'media source started' : 'media source already running');
  });
}
