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
import { onConfig, recordedStill, rematch, scanSource, type ScanResult, type SourceConfig, type SourceDeps } from './source.js';
import { names, seedSpec, uidSupported, volumeSpec, type HelperMount, type HelperVerb } from './template.js';
import { MEDIA_ERRORS, MOVE_STAGES, type BackupMeta, type DesiredSpec, type Kind, type MediaError, type MediaOp, type MediaStep, type MoveStage, type MoveState, type RecordedSource } from './types.js';

/**
 * The move from an existing Jellyfin (stage 2 "The move", "After the move"): one job `mediaserver-migrate` (check → pull → verify →
 * [snapshot] → copy_bulk → stop_source → copy → the stage 1 deploy of a migrated Ferrofin → adopt), its abort, the way back's
 * `mediaserver-source` job and the settling of a move found unfinished. From `stop_source` on, every way out of the job starts the
 * recorded source again (`finally`); when that fails twice the move stays `running` with `abort` set and the supervisor retries
 * (until the source is gone for good, or 3 tries could not decide which container it is). How far the move got (`reached`), its
 * user and the state before it are recorded in the move, so a settle after a restart does exactly what the job's own would.
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
  /** `verified`: the pin this job pulled and verified already (the deploy skips both for that digest) */
  deploy(job: Job, d: DesiredSpec, o: { reason: 'apply'; verified: { digest: string; upstream: string } }): Promise<void>;
  /** the deploy's `auto` snapshot of a kind's data volume as the user that owns it */
  snapshot(of: { kind: Kind; upstream: string; user: User }): Promise<BackupMeta>;
  labelled(i: Obj, project: string): { id: string; kind: Kind | null; running: boolean } | null;
  now(): number;
  /** an abort asked for while this job runs, also before the move was recorded (in memory) */
  aborted(): boolean;
}

/** the copy passes (spec "Times" has none: metadata on a NAS takes long); the final pass runs with Jellyfin stopped */
export const BULK_COPY_MS = 6 * 3600_000;
export const FINAL_COPY_MS = 2 * 3600_000;
/** free space on the Docker data root against the size of the copy (spec: ≥ copy size × 1.2) */
export const SPACE_FACTOR = 1.2;
/**
 * The oldest Jellyfin whose database the pinned Ferrofin adopts: Ferrofin v1.5 adopts Jellyfin 10.11.8–10.11.11 and 12.0–12.4 (its
 * README "Migrating from Jellyfin"; to confirm on every pin change). Every newer version is let through (owner, 2026-11-25): Ferrofin
 * checks the database's migration set itself and refuses an unknown one, so the move fails at `adopt` or `health` before the switch,
 * the copy is dropped and the old Jellyfin started again, its own data never written.
 */
export const ADOPTS_FROM: [number, number, number] = [10, 11, 8];
const ADJUSTED_RE = /^[a-z]{1,20}\.xml:[A-Za-z]{1,40}$/;
/** undecidable source starts (several containers on its /config, a running sibling) after which a settle ends with source_mismatch */
export const UNDECIDABLE_TRIES = 3;

const fail = (code: MediaError): never => { throw new StepError(code); };
const isMediaError = (c: unknown): c is MediaError => typeof c === 'string' && (MEDIA_ERRORS as readonly string[]).includes(c);
const codeOf = (e: unknown, fallback: MediaError): MediaError => (e instanceof StepError && isMediaError(e.code) ? e.code : fallback);
/** whether a move got at least to `stage` (undefined: not known, a state from before the record) */
const atLeast = (reached: MoveStage | undefined, stage: MoveStage): boolean | undefined =>
  (reached === undefined ? undefined : MOVE_STAGES.indexOf(reached) >= MOVE_STAGES.indexOf(stage));
const userOf = (d: { uid: number; gid: number; mediaGid: number | null } | null | undefined, fallback: User): User =>
  (d ? { uid: d.uid, gid: d.gid, groups: d.mediaGid ? [d.mediaGid] : [] } : fallback);
const DEFAULT_USER: User = { uid: 1000, gid: 1000, groups: [] };

/** the numeric prefix of a version (`10.11.8ubu2404-ls45` → 10.11.8; a missing patch is null); null = not a version (no check) */
function versionParts(v: string | null): [number, number, number | null] | null {
  const m = v === null ? null : /^v?([0-9]{1,4})\.([0-9]{1,4})(?:\.([0-9]{1,4}))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])] : null;
}

/**
 * whether the move may try this Jellyfin version: ADOPTS_FROM or newer; an unknown version, or a tag without a patch on the minimum's
 * own line (`10.11`), is left to Ferrofin's own check
 */
export function adoptable(version: string | null): boolean {
  const v = versionParts(version);
  if (!v) return true;
  const [major, minor, patch] = v;
  const [fMajor, fMinor, fPatch] = ADOPTS_FROM;
  if (major !== fMajor) return major > fMajor;
  if (minor !== fMinor) return minor > fMinor;
  return patch === null || patch >= fPatch;
}

const sameSource = (a: RecordedSource, b: RecordedSource): boolean => a.serverId === b.serverId && a.config.type === b.config.type && a.config.source === b.config.source;

/** the scan helper on a /config (read-only at /source, the guard checks the mount against it and the Docker data root) as `user` */
function sourceDeps(k: MoveKit, r: { facts: EngineFacts; runner: Runner }, user: User, base: { path: string } | null): SourceDeps {
  return {
    engine: k.engine, base, now: () => k.now(),
    scan: async (config, mode) => {
      // a bind source is checked against the Docker data root; an unknown one refuses every bind (fail closed)
      if (config.type === 'bind' && !r.facts.dockerRoot) {
        k.updater.log.add('Docker data root unknown');
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
  // a volume holding a move's copy has no known version (never "the recorded container's"): it is not snapshotted
  const known = m.moveCopy ? undefined : m.dataUpstream.ferrofin ?? (m.container?.kind === 'ferrofin' ? m.container.upstream : undefined);
  return { project: r.project, runner: r.runner, facts: r.facts, baseVolume: base.volume, pin, user, scan, empty: a.owner === null, known };
}

/** a move abort asked for while the job runs (checked between steps) */
function between(k: MoveKit): void {
  if (k.aborted() || k.updater.mediaState().move?.abort) fail('move_aborted');
}

/** records how far the move got (only forward); `durably`: the state file must have it before the caller goes on (else throws) */
function reach(k: MoveKit, stage: MoveStage, durably = false): void {
  const write = (m: { move?: MoveState }): void => {
    if (m.move && !atLeast(m.move.reached, stage)) m.move.reached = stage;
  };
  if (durably) k.updater.updateMediaDurably(write);
  else k.updater.updateMedia(write);
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

/** the user a move recorded (its copy and rematch scans run as it); undefined in a state from before the record */
const moveUser = (mv: MoveState | undefined): User | undefined =>
  (mv?.uid !== undefined && mv.gid !== undefined ? { uid: mv.uid, gid: mv.gid, groups: [] } : undefined);

/**
 * The recorded source started: rematched (same /config mount source and server id; a recreated one replaces the recorded id, which
 * is logged without it), then started unless it runs. `source_missing`: no container mounts its /config any more (gone for good);
 * `source_mismatch`: containers do, but none is decidably the source (several, another server id, a running sibling). A scan or
 * inspect that fails throws its own code (helper_timeout, helper_failed, …): only the two above count toward the settle's tries.
 */
export async function startSource(k: MoveKit, rec: RecordedSource, user?: User): Promise<'started' | 'running'> {
  const r = await k.ready();
  const m = k.updater.mediaState();
  // the recorded container still on its /config, nothing else there running: no scan helper needed (one that keeps failing, a bind
  // /config with an unknown Docker data root, would otherwise keep the source stopped); anything else is rematched with the scan
  const id = (await recordedStill(k.engine, rec))
    ? rec.id
    : await rematch(sourceDeps(k, r, user ?? moveUser(m.move) ?? userOf(m.desired, DEFAULT_USER), null), rec, { strict: true });
  if (id === null) return fail((await onConfig(k.engine, rec.config)) === 0 ? 'source_missing' : 'source_mismatch');
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

type Started = { r: 'ok' | 'gone' | 'undecidable' | 'failed'; code: MediaError | null };

/** the source start of a settle: tried twice (a source that is gone for good is not tried again) */
async function startAgain(k: MoveKit, rec: RecordedSource, user?: User): Promise<Started> {
  let code: MediaError = 'start_failed';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((await startSource(k, rec, user)) === 'started') k.updater.log.add('media source started again');
      return { r: 'ok', code: null };
    } catch (e) {
      code = codeOf(e, 'start_failed');
      if (code === 'source_missing') {
        k.updater.log.add('media source is gone: nothing to start');
        return { r: 'gone', code };
      }
    }
  }
  k.updater.log.add('media source could not be started');
  return { r: code === 'source_mismatch' ? 'undecidable' : 'failed', code };
}

/**
 * The container under the real name goes when it is ours and not `keep` (the one recorded before the move: whatever else is there
 * now, the move's deploy made it, finished or not). `legacy` (a move recorded before `before`): ours and either not the recorded one
 * or running. The data volume stays. The id removed, or null.
 */
async function removeNew(k: MoveKit, keep: string | null | 'legacy'): Promise<string | null> {
  const { project } = await k.ready();
  const i = await k.engine.inspectContainer(names(project).container);
  const own = i ? k.labelled(i, project) : null;
  if (!own) return null;
  if (keep === 'legacy') {
    if (k.updater.mediaState().container?.id === own.id && !own.running) return null;
  } else if (own.id === keep) {
    return null;
  }
  await k.engine.stop(own.id).catch(() => undefined);
  await k.engine.remove(own.id, { force: true });
  k.updater.log.add('media move: the new container was removed');
  return own.id;
}

/**
 * The end of every move that did not reach `ready`, and of an abort, from what the move recorded (`reached`, `before`): the
 * container its deploy made goes; the source is started when its stop had begun; the desired spec and container from before the
 * move come back (a Ferrofin whose data volume now holds the copy is not set to run on it); a begun copy marks the volume
 * (`moveCopy`). The move is `aborted` with `code` as lastError. When the source cannot be started it stays `running` with
 * `abort` (the supervisor retries), unless it is gone for good (`source_missing`) or 3 settles could not decide which container
 * it is (`source_mismatch`). Returns null when the source runs (or was never stopped), else the code. Never throws on the engine.
 */
async function settle(k: MoveKit, o: { code: MediaError; user?: User }): Promise<MediaError | null> {
  const move = k.updater.mediaState().move;
  if (!move) return null;
  const reached = move.reached ?? (move.phase === 'ready' ? 'deployed' : undefined);
  let removed: string | null = null;
  if (reached === undefined || atLeast(reached, 'deploy')) {
    try { removed = await removeNew(k, move.before && reached !== undefined ? move.before.container?.id ?? null : 'legacy'); } catch { k.updater.log.add('media move: the new container could not be removed'); }
  }
  const started: Started = reached === undefined || atLeast(reached, 'stop') ? await startAgain(k, move.source, o.user ?? moveUser(move)) : { r: 'ok', code: null };
  // the container from before comes back only while it exists (a finished deploy removed it); an engine that does not answer keeps it
  let container = move.before?.container ?? null;
  if (container) {
    const id = container.id;
    if ((await k.engine.inspectContainer(id).catch(() => undefined)) === null) container = null;
  }
  const touched = atLeast(reached, 'copy') === true;
  k.updater.updateMedia((s) => {
    if (touched) { delete s.dataUpstream.ferrofin; s.moveCopy = true; }
    if (move.before) {
      const d = move.before.desired;
      s.desired = d && touched && d.kind === 'ferrofin' ? { ...d, run: false } : d;
      s.container = container;
    } else if (removed !== null) {
      if (s.container?.id === removed) s.container = null;
      if (s.desired) s.desired.run = false;
    }
    if (removed !== null) s.tampered = false;
    if (!s.move) return;
    s.move.code = o.code;
    const tries = (s.move.tries ?? 0) + (started.r === 'undecidable' ? 1 : 0);
    if (started.r === 'ok' || started.r === 'gone' || tries >= UNDECIDABLE_TRIES) {
      s.move.phase = 'aborted';
      s.move.abort = false;
      delete s.move.tries;
      s.lastError = started.r === 'ok' ? o.code : started.r === 'gone' ? 'source_missing' : 'source_mismatch';
    } else {
      s.move.phase = 'running';
      s.move.abort = true;
      if (tries > 0) s.move.tries = tries;
      s.lastError = o.code;
    }
  });
  const after = k.updater.mediaState();
  k.updater.log.add(after.move?.phase === 'aborted' ? `media move ended: ${after.lastError ?? o.code}` : 'media move not settled: retried by the supervisor');
  return started.r === 'ok' ? null : after.move?.phase === 'aborted' ? after.lastError : started.code ?? 'start_failed';
}

/** the move job; throws StepError(code) after settling (the source runs again whenever its stop had begun) */
export async function migrateJob(k: MoveKit, job: Job, op: MigrateOp): Promise<void> {
  const c = await k.step(job, 'check', () => check(k, op));
  const spec: DesiredSpec = { kind: 'ferrofin', migrated: true, folders: c.scan.folders, uid: op.uid, gid: op.gid, gpu: op.gpu, mediaGid: null, egress: true, tz: op.tz };
  // from here on the move is recorded (with its user and the state an abort restores): a restart settles it before anything else
  k.updater.updateMedia((m) => {
    m.move = {
      source: c.scan.source, folders: c.scan.folders, phase: 'running', abort: false, uid: op.uid, gid: op.gid, reached: 'recorded',
      before: { desired: structuredClone(m.desired), container: structuredClone(m.container) },
    };
    m.lastError = null;
  });
  k.updater.log.add('media move started');
  let done = false;
  let code: MediaError = 'helper_failed';
  try {
    // an abort asked for while the check ran
    between(k);
    await k.step(job, 'pull', () => k.engine.pull(c.pin.image));
    const upstream = await k.step(job, 'verify', () => k.verifyImage(c.pin));
    between(k);
    // an earlier Ferrofin's data (a repeated move) is saved before the copy replaces it; never a volume holding a move's copy
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
      reach(k, 'copy');
      k.updater.updateMedia((m) => { delete m.dataUpstream.ferrofin; m.moveCopy = true; });
      await copy(k, c, 'bulk', op.trickplay);
    });
    between(k);
    await k.step(job, 'stop_source', async () => {
      // the scanned container is still the source (and nothing else runs on its /config)
      const id = await rematch(sourceDeps(k, { facts: c.facts, runner: c.runner }, c.user, null), c.scan.source, { strict: true });
      if (id === null || id !== c.scan.source.id) return fail('source_missing');
      // the record that this source gets stopped is on disk first (a restart must find it), else nothing is stopped
      reach(k, 'stop', true);
      await k.engine.stop(id);
      k.updater.log.add('media source stopped');
    });
    between(k);
    await k.step(job, 'copy', () => copy(k, c, 'final', op.trickplay));
    between(k);
    // the copy is the data the pinned Ferrofin adopts: no snapshot of it, no downgrade rule against an earlier Ferrofin's version
    k.updater.updateMedia((m) => { m.dataUpstream.ferrofin = upstream; });
    reach(k, 'deploy');
    await k.deploy(job, spec, { reason: 'apply', verified: { digest: c.pin.digest, upstream } });
    reach(k, 'deployed');
    between(k);
    await k.step(job, 'adopt', async () => {
      const a = await k.helper(c.runner, c.user, 'check', ['data'], [{ kind: 'data', volume: names(c.project).data('ferrofin'), rw: false }]);
      if (a.adopted !== true) fail('adopt_failed');
    });
    between(k);
    // the source stays stopped (nothing may keep writing to it); the backend's phases follow, then migrate-done or migrate-abort.
    // The volume is Ferrofin's now (adopted at the deployed version). The source is recorded for the way back only by migrate-done
    // (the backend switched): until then the move holds it, and a move that ends aborted leaves no record that would refuse the next
    // move's source.
    k.updater.updateMedia((m) => {
      delete m.moveCopy;
      if (!m.move) return;
      m.move.phase = 'ready';
      m.lastError = null;
    });
    k.updater.log.add('media move ready');
    done = true;
  } catch (e) {
    code = codeOf(e, 'helper_failed');
    throw new StepError(code);
  } finally {
    if (!done) await settle(k, { code, user: c.user });
  }
}

/**
 * migrate-abort as its own job: a move in `ready` (the backend's phases failed: `move_aborted`) or one left `running` (a restart,
 * a source that could not be started: its own code stays). Fails with the code when the source does not run afterwards.
 */
export async function abortJob(k: MoveKit): Promise<void> {
  const move = k.updater.mediaState().move;
  if (!move || (move.phase !== 'running' && move.phase !== 'ready')) return;
  const failed = await settle(k, { code: move.phase === 'ready' ? 'move_aborted' : move.code ?? 'move_aborted' });
  if (failed !== null) fail(failed);
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
