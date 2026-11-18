// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { StepError, type ImageInfo, type LivetvContainer, type Running } from './docker.js';
import { FF_SERVICES, LIVETV_SERVICE, SELF_SERVICE, SHA_TAG_RE, channelTag, imageRepo, isDigest, pinnedRef, shaTag, type Channel, type LivetvOp } from './policy.js';
import { MEDIA_ERRORS, MEDIA_STEPS, type MediaError, type MediaJobAction } from './mediaserver/types.js';
import { LIVETV_ERRORS, type Job, type JobAction, type JobServiceResult, type JobState, type LivetvError, type LivetvState, type MediaState, type State, type StateStore, type StepName } from './state.js';

/**
 * one service of a job: the image name compose runs (`<repo>:<tag>`), the digest ref that name must point at, what the service
 * ran before the job (null: not running) and whether that differs from the ref
 */
interface Target { service: string; image: string; ref: string; before: Running | null; changed: boolean }
type Targets = Record<string, Target>;
/** what a job does with livetv: nothing (not enabled), bring it to this target (pulled and verified), or drop it for this reason */
type LivetvPlan = 'off' | Target | LivetvError;

/** What a job needs from Docker (docker.ts in production, a fake in the tests). */
export interface Ops {
  /** the image each service runs with `tag` (exactly this repository's), after the checks of the stack, media server and config */
  images(tag: string, services: readonly string[]): Promise<Record<string, string>>;
  /** the registry digest the service's image has at `tag` now (uncached); StepError registry_failed */
  registryDigest(service: string, tag: string): Promise<string>;
  /** `docker pull` of this repository's image by digest ref */
  pullDigest(ref: string): Promise<void>;
  /** points the local tag `image` (what compose runs) at the digest ref `ref` */
  tag(ref: string, image: string): Promise<void>;
  /** cosign verify of a digest ref */
  verify(ref: string): Promise<boolean>;
  up(tag: string, services: readonly string[]): Promise<void>;
  imageInfo(ref: string): Promise<ImageInfo | null>;
  running(service: string): Promise<Running | null>;
  spawnSelfUpdate(tag: string): Promise<void>;
  /** one health round: every FriendFlix service up (and healthy where it has a check), the backend answering with `commit7` */
  healthy(commit7: string | null): Promise<boolean>;
  /** the compose files the last images() call settled on (file names only; for the job log) */
  composeFiles?(): readonly string[];
  /** refuses a foreign stack (StepError foreign_stack) and settles on the compose files, like the first step of every job */
  ownStack(): Promise<void>;
  /** compose stop / rm -f of the livetv service (stop refuses a foreign stack first) */
  stop(services: readonly string[]): Promise<void>;
  rm(services: readonly string[]): Promise<void>;
  /** removes every local tag of exactly the livetv repository, then these image ids (each only when it is livetv's alone) */
  imageRm(ids: readonly string[]): Promise<void>;
  /** removes this stack's livetv cache volume (<project>_livetv-cache); never another volume */
  volumeRm(): Promise<void>;
  /** the livetv service container (any state, never a one-off) with its image id; null when there is none; throws when Docker does not answer */
  livetvContainer(): Promise<LivetvContainer | null>;
  /** enable only: backend and gateway sit on the livetv network (StepError compose_outdated / network_missing otherwise) */
  livetvNetwork(tag: string): Promise<void>;
}

/** In-memory job log: our own fixed messages, tags, digests and error codes only (never command output, never a secret). */
export class JobLog {
  private lines: string[] = [];
  constructor(private readonly max = 200, private readonly now: () => number = Date.now) {}
  add(msg: string): void {
    this.lines.push(`${new Date(this.now()).toISOString()} ${msg}`);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
  tail(n = 50): string[] { return this.lines.slice(-n); }
}

export interface UpdaterOpts {
  healthTimeoutMs?: number;
  /** how long an enabled livetv container may take to get healthy (spec §4.2: 2 min) */
  livetvHealthTimeoutMs?: number;
  healthIntervalMs?: number;
  selfUpdateTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: JobLog;
  /**
   * the managed media server's phase of an update job (MediaJobs.phase): runs once FriendFlix's own health check passed, never in
   * a rollback job and never when the update rolls back. A code = the media server failed (and was rolled back on its own): the
   * job ends `succeeded_mediaserver_failed`; 'ok' or null (nothing to do) = `succeeded`.
   */
  mediaPhase?: (job: Job) => Promise<'ok' | MediaError | null>;
}

export type StartResult = { ok: true; job: Job } | { ok: false; error: 'busy' | 'no_target' | 'no_previous' };

const newJob = (action: JobAction, from: string | null, to: string, now: number): Job => ({
  id: randomBytes(8).toString('hex'), action, state: 'running', step: null, from, to,
  steps: { pull: 'pending', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' },
  startedAt: new Date(now).toISOString(), finishedAt: null, error: null, services: null, media: null,
});

const LIVETV = [LIVETV_SERVICE] as const;
/** the services an update compares and reports (bootstrap runs the backend's image: it follows the backend) */
const CORE: readonly string[] = FF_SERVICES.filter((s) => s !== 'bootstrap');

/** the livetv code of a failure: its own code when it is one, else pull_failed (a registry failure, a pull, anything else) */
const livetvCode = (e: unknown): LivetvError => LIVETV_ERRORS.find((c) => e instanceof StepError && c === e.code) ?? 'pull_failed';

/** `image`'s repository pinned to `digest` (images() checked the repository) */
function refOf(image: string, digest: string): string {
  if (!isDigest(digest)) throw new StepError('registry_failed');
  return `${imageRepo(image)}@${digest}`;
}

/**
 * One job at a time: update (compare each service's registry digest at the channel tag with what it runs; only the changed ones
 * are pulled by digest -> cosign verified -> their local tags moved -> `up` recreates them -> health, automatic rollback to the
 * previous digests when the new build does not get healthy), rollback (to the recorded previous digests, or a legacy sha tag),
 * self-update (explicit only), and the livetv jobs (enable: the same pull -> verify -> start -> health for the livetv service
 * alone; disable; remove). A verify failure aborts before any tag moves or anything is restarted. Every job, livetv ones
 * included, runs alone: a second start answers busy.
 */
export class Updater {
  readonly log: JobLog;
  private state: State;
  private current: Promise<void> | null = null;
  private readonly o: Required<Omit<UpdaterOpts, 'log' | 'mediaPhase'>>;
  private readonly mediaPhase: UpdaterOpts['mediaPhase'];

  constructor(private readonly ops: Ops, private readonly store: StateStore, opts: UpdaterOpts = {}) {
    this.o = {
      healthTimeoutMs: opts.healthTimeoutMs ?? 180_000, livetvHealthTimeoutMs: opts.livetvHealthTimeoutMs ?? 120_000, healthIntervalMs: opts.healthIntervalMs ?? 5_000,
      selfUpdateTimeoutMs: opts.selfUpdateTimeoutMs ?? 180_000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: opts.now ?? Date.now,
    };
    this.log = opts.log ?? new JobLog(200, this.o.now);
    this.mediaPhase = opts.mediaPhase;
    this.state = store.load();
    this.recover();
  }

  /** a job still marked running after a restart: a self-update that got to its restart step succeeded (we are the new process) */
  private recover(): void {
    const j = this.state.lastJob;
    if (!j || j.state !== 'running') return;
    if (j.action === 'self-update' && j.step === 'restart') {
      j.steps.restart = 'ok'; j.steps.health = 'ok'; j.step = null; j.state = 'succeeded';
      this.log.add(`self-update to ${j.to} finished`);
    } else if (j.action === 'update' && j.steps.rollback === 'skipped' && (j.steps.health === 'ok' || (j.steps.health === 'skipped' && j.services !== null))) {
      // interrupted after FriendFlix got healthy on the new build, or found nothing changed (in the media server phase, maybe
      // before it recorded a step)
      if (j.media?.step) j.media.steps[j.media.step] = 'failed';
      j.state = 'succeeded_mediaserver_failed'; j.error = 'interrupted';
      this.log.add(`job ${j.action} was interrupted by a restart in the media server phase`);
    } else {
      if (j.step) j.steps[j.step] = 'failed';
      if (j.media?.step) j.media.steps[j.media.step] = 'failed';
      j.state = 'failed'; j.error = 'interrupted';
      this.log.add(`job ${j.action} was interrupted by a restart`);
    }
    j.finishedAt = new Date(this.o.now()).toISOString();
    this.persist();
  }

  get busy(): boolean { return this.current !== null; }
  /** the livetv state (docker.ts adds the livetv profile to every compose command while it is enabled) */
  get livetv(): LivetvState { return this.state.livetv; }
  snapshot(): State { return structuredClone(this.state); }
  /** resolves when the running job (if any) is done */
  async idle(): Promise<void> { await this.current; }

  setChannel(channel: Channel, version: string | null): State {
    this.state.channel = channel;
    this.state.version = channel === 'pinned' ? version : null;
    this.persist();
    this.log.add(`channel set to ${channel}${channel === 'pinned' ? ` ${version}` : ''}`);
    return this.snapshot();
  }

  /** update, rollback or self-update; the livetv actions go through startLivetv only (never an update) */
  start(action: 'update' | 'rollback' | 'self-update'): StartResult {
    if (!['update', 'rollback', 'self-update'].includes(action)) throw new Error('invalid action');
    if (this.current) return { ok: false, error: 'busy' };
    // a rollback restores the recorded digests under the channel's tag; a state from before digests: its sha tag, as before
    const digests = action === 'rollback' && this.state.previousDigests ? structuredClone(this.state.previousDigests) : null;
    const channel = channelTag(this.state.channel, this.state.version);
    const target = action !== 'rollback' || digests ? channel : this.state.previous;
    if (!target) return { ok: false, error: action === 'rollback' && !digests ? 'no_previous' : 'no_target' };
    if (action === 'rollback' && !digests && !SHA_TAG_RE.test(target)) return { ok: false, error: 'no_previous' };
    const job = newJob(action, this.state.current, target, this.o.now());
    this.state.lastJob = job;
    this.persist();
    this.log.add(`${action} to ${target}${digests ? ' (previous digests)' : ''} started`);
    const run = action === 'self-update' ? this.selfUpdate(job) : digests ? this.rollbackJob(job, digests) : this.deployJob(job, action === 'update');
    this.current = run.catch(() => undefined).finally(() => { this.current = null; });
    return { ok: true, job: structuredClone(job) };
  }

  /**
   * enable / disable / remove the livetv service. enable takes the channel's tag (the image its registry digest names, like
   * every update); disable and remove name the last installed tag (else the channel's). The state changes only when the job
   * gets that far.
   */
  startLivetv(op: LivetvOp): StartResult {
    if (this.current) return { ok: false, error: 'busy' };
    const channel = channelTag(this.state.channel, this.state.version);
    const target = op.op === 'enable' ? channel : this.state.current ?? channel;
    if (!target) return { ok: false, error: 'no_target' };
    const action: JobAction = `livetv-${op.op}`;
    const job = newJob(action, null, target, this.o.now());
    if (op.op !== 'enable') { job.steps.pull = 'skipped'; job.steps.verify = 'skipped'; job.steps.health = 'skipped'; }
    this.state.lastJob = job;
    this.persist();
    this.log.add(`${action} (${target}) started`);
    const run = op.op === 'enable' ? this.livetvEnable(job) : this.livetvDisable(job, op.op === 'remove' ? { data: op.data } : null);
    this.current = run.catch(() => undefined).finally(() => { this.current = null; });
    return { ok: true, job: structuredClone(job) };
  }

  private persist(): void {
    try { this.store.save(this.state); } catch { this.log.add('state file could not be written'); }
  }

  /** writes the state file now (a media job calls it after it changed its own job's steps) */
  persistNow(): void { this.persist(); }

  /** a copy of the managed media server's state */
  mediaState(): MediaState { return structuredClone(this.state.media); }

  /** changes the media state in place and writes it; `fn` must be synchronous */
  updateMedia(fn: (m: MediaState) => void): void {
    fn(this.state.media);
    this.persist();
  }

  /**
   * a media job (no core step runs: pull, verify, restart, health and rollback are skipped, every media step starts pending).
   * `to` is what the stack last ran (else the channel's tag). Same lock as every other job; `run` does the work on the live job
   * and ends it with finishJob. A `run` that throws instead ends the job `failed` with a fixed code.
   */
  startMediaJob(action: MediaJobAction, run: (job: Job) => Promise<void>): StartResult {
    if (this.current) return { ok: false, error: 'busy' };
    const job = newJob(action, null, this.state.current ?? channelTag(this.state.channel, this.state.version) ?? 'latest', this.o.now());
    for (const k of Object.keys(job.steps) as StepName[]) job.steps[k] = 'skipped';
    job.media = { step: null, steps: Object.fromEntries(MEDIA_STEPS.map((k) => [k, 'pending'])) as NonNullable<Job['media']>['steps'] };
    const copy = structuredClone(job);
    this.state.lastJob = job;
    this.persist();
    this.log.add(`${action} started`);
    this.current = run(job)
      .catch((e: unknown) => {
        const code = e instanceof StepError && (MEDIA_ERRORS as readonly string[]).includes(e.code) ? e.code : 'helper_failed';
        if (job.state === 'running') this.finishJob(job, 'failed', code);
      })
      .finally(() => { this.current = null; });
    return { ok: true, job: copy };
  }

  private async step<T>(job: Job, name: StepName, fn: () => Promise<T>): Promise<T> {
    job.step = name; job.steps[name] = 'running'; this.persist();
    this.log.add(`step ${name}`);
    try {
      const v = await fn();
      job.steps[name] = 'ok'; this.persist();
      return v;
    } catch (e) {
      job.steps[name] = 'failed'; this.persist();
      if (e instanceof StepError && e.detail) this.log.add(`step ${name}: ${e.code} (${e.detail})`);
      throw e instanceof StepError ? e : new StepError(`${name}_failed`);
    }
  }

  /** ends a job: what never ran is skipped, the state and the fixed error code are kept, the file is written and one log line added */
  finishJob(job: Job, state: JobState, error: string | null): void {
    job.state = state; job.error = error; job.finishedAt = new Date(this.o.now()).toISOString();
    for (const k of Object.keys(job.steps) as StepName[]) if (job.steps[k] === 'pending') job.steps[k] = 'skipped';
    if (job.media) for (const k of MEDIA_STEPS) if (job.media.steps[k] === 'pending') job.media.steps[k] = 'skipped';
    if (state === 'succeeded') { job.step = null; if (job.media) job.media.step = null; }
    this.persist();
    this.log.add(`${job.action} ${state}${error ? ` (${error})` : ''}`);
  }

  /** the compose files images() settled on, in the log */
  private logFiles(): void {
    const files = this.ops.composeFiles?.();
    if (files?.length) this.log.add(`compose files: ${files.join(', ')}`);
  }

  /**
   * the registry digest of each service's image at `tag` (all of them first: a registry failure stops the job before any pull)
   * against the digests its running image carries; nothing is pulled here
   */
  private async compare(tag: string, images: Record<string, string>, services: readonly string[]): Promise<Targets> {
    const refs: Record<string, string> = {};
    for (const s of services) refs[s] = refOf(images[s]!, await this.ops.registryDigest(s, tag));
    const out: Targets = {};
    for (const s of services) {
      const before = await this.ops.running(s).catch(() => null);
      const ref = refs[s]!;
      out[s] = { service: s, image: images[s]!, ref, before, changed: !before?.repoDigests.includes(ref) };
      this.log.add(out[s].changed ? `${s} changed: ${ref}` : `${s} unchanged`);
    }
    return out;
  }

  /**
   * targets that bring the services back to recorded digest refs (`digests`; a service without one is left as it is), and the
   * pull of every one no longer on the host (pruned): those refs are returned in `pulled` and must be verified before use
   */
  private async restoreTargetsPullingPruned(images: Record<string, string>, digests: Record<string, string>, services: readonly string[]): Promise<{ targets: Targets; pulled: string[] }> {
    const wanted = services.filter((s) => digests[s]);
    // every recorded ref must name the very repository compose runs for its service (docker.ts checks it again), before any pull
    for (const s of wanted) {
      const ref = digests[s]!;
      if (!ref.startsWith(`${imageRepo(images[s]!)}@`) || !isDigest(ref.slice(ref.indexOf('@') + 1))) throw new StepError('unexpected_image');
    }
    const targets: Targets = {};
    const pulled: string[] = [];
    for (const s of wanted) {
      const ref = digests[s]!;
      const before = await this.ops.running(s).catch(() => null);
      targets[s] = { service: s, image: images[s]!, ref, before, changed: !before?.repoDigests.includes(ref) };
      if (!(await this.ops.imageInfo(ref).catch(() => null))) { await this.ops.pullDigest(ref); pulled.push(ref); }
    }
    return { targets, pulled };
  }

  /** cosign verify of each ref; the first failure throws verify_failed */
  private async verifyRefs(refs: readonly string[]): Promise<void> {
    for (const ref of new Set(refs)) {
      if (!(await this.ops.verify(ref).catch(() => false))) { this.log.add(`signature check failed for ${ref}`); throw new StepError('verify_failed'); }
      this.log.add(`signature ok: ${ref}`);
    }
  }

  /** the own-repository digest ref each target's service ran before the job (a service without one, e.g. a dev build, is left out) */
  private ownRefs(targets: readonly Target[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of targets) {
      const ref = t.before ? pinnedRef(t.image, t.before.repoDigests) : null;
      if (ref) out[t.service] = ref;
    }
    return out;
  }

  private async waitHealthy(ok: () => Promise<boolean>, timeoutMs = this.o.healthTimeoutMs): Promise<boolean> {
    const end = this.o.now() + timeoutMs;
    for (;;) {
      if (await ok().catch(() => false)) return true;
      if (this.o.now() >= end) return false;
      await this.o.sleep(this.o.healthIntervalMs);
    }
  }

  /**
   * restart + health: every target's local tag moved to its ref, `up` of the FriendFlix services (compose recreates only those
   * whose image or config changed), then healthy: when the backend moves, `/health` must answer with its image commit, and each
   * moved service must run its ref. Throws StepError for the FriendFlix services only. `livetv`: started after the core
   * services; when it fails to start or to get healthy it is stopped and disabled (dropLivetv) while the job goes on: livetv is
   * optional and never fails or rolls back a core update. Answers per service updated / unchanged (by container id).
   */
  private async bringUp(job: Job, tag: string, core: Targets, livetv: LivetvPlan, steps: boolean): Promise<Record<string, JobServiceResult>> {
    const backend = core.backend;
    const commit = backend?.changed ? (await this.ops.imageInfo(backend.ref).catch(() => null))?.commit ?? null : null;
    let lt = typeof livetv === 'object' ? livetv : null;
    const restart = async () => {
      for (const t of Object.values(core)) await this.ops.tag(t.ref, t.image);
      await this.ops.up(tag, FF_SERVICES);
      // only once the core services were recreated: a core failure that restarted nothing leaves livetv as it was
      if (livetv === 'off') return;
      if (typeof livetv === 'string') return this.dropLivetv(livetv, tag);
      try { await this.ops.tag(livetv.ref, livetv.image); await this.ops.up(tag, LIVETV); } catch { lt = null; await this.dropLivetv('restart_failed', tag); }
    };
    if (steps) await this.step(job, 'restart', restart); else await restart();
    const moved = Object.values(core).filter((t) => t.changed);
    const ok = async () => (await this.ops.healthy(commit ? commit.slice(0, 7) : null)) && (await this.runAll(moved));
    const health = async () => {
      if (!(await this.waitHealthy(ok))) throw new StepError('unhealthy');
      if (!lt) return;
      if (await this.waitLivetv()) await this.recordLivetvImage();
      else { lt = null; await this.dropLivetv('unhealthy', tag); }
    };
    if (steps) await this.step(job, 'health', health); else await health();
    return this.report([...Object.values(core), ...(lt ? [lt] : [])]);
  }

  /** whether each target's service runs its ref */
  private async runAll(targets: readonly Target[]): Promise<boolean> {
    for (const t of targets) if (!(await this.ops.running(t.service))?.repoDigests.includes(t.ref)) return false;
    return true;
  }

  /** updated: the service runs another container than before the job; unchanged: the same one */
  private async report(targets: readonly Target[]): Promise<Record<string, JobServiceResult>> {
    const out: Record<string, JobServiceResult> = {};
    for (const t of targets) {
      const after = await this.ops.running(t.service).catch(() => null);
      out[t.service] = t.before && after?.container === t.before.container ? 'unchanged' : 'updated';
    }
    return out;
  }

  /**
   * livetv at `tag`, on its own (its failure must not fail the core services' pull): compared like the others, pulled by digest
   * and verified when it changed. A fixed error code when its image is missing, does not resolve to this repository's or is not
   * verified; the target when it may start.
   */
  private async prepareLivetv(tag: string): Promise<Target | LivetvError> {
    let t: Target;
    try {
      const images = await this.ops.images(tag, LIVETV);
      t = (await this.compare(tag, images, LIVETV))[LIVETV_SERVICE]!;
      if (t.changed) await this.ops.pullDigest(t.ref);
    } catch (e) {
      // the real code (a changed config, an unexpected image, compose failing, the registry, the pull), with its fixed detail
      const code = livetvCode(e);
      const detail = e instanceof StepError ? e.detail ?? (e.code !== code ? e.code : null) : null;
      this.log.add(`livetv: ${code}${detail ? ` (${detail})` : ''}`);
      return code;
    }
    if (!t.changed) return t;
    try { await this.verifyRefs([t.ref]); } catch { return 'verify_failed'; }
    return t;
  }

  /** livetv back to its recorded ref (pulled and verified when it is no longer on the host); 'off' without one */
  private async restoreLivetv(tag: string, ref: string | undefined): Promise<LivetvPlan> {
    if (this.state.livetv !== 'enabled' || !ref) return 'off';
    try {
      const { targets, pulled } = await this.restoreTargetsPullingPruned(await this.ops.images(tag, LIVETV), { [LIVETV_SERVICE]: ref }, LIVETV);
      await this.verifyRefs(pulled);
      return targets[LIVETV_SERVICE]!;
    } catch (e) {
      const code = livetvCode(e);
      this.log.add(`livetv: ${code}`);
      return code;
    }
  }

  /**
   * Ruling (Task 9 review M5, spec §4.2 C3): livetv is optional. An update or rollback whose livetv image is missing or not
   * verified, or whose livetv does not start or get healthy, stops and removes livetv, persists `disabled` with a fixed error and
   * one fixed log line, and completes for the core services. An unverified livetv image is never started.
   */
  private async dropLivetv(code: LivetvError, tag: string): Promise<void> {
    // persisted before the stop (1b review M13): an updater that dies during it restarts with livetv disabled and the reason kept,
    // and `stop_failed` makes the next job stop the container again instead of adopting it as enabled
    this.state.livetvError = code;
    this.state.livetv = 'stop_failed';
    this.persist();
    this.state.livetv = (await this.stopLivetv()) ? 'disabled' : 'stop_failed';
    this.persist();
    this.log.add(`livetv disabled: ${code} at ${tag}`);
  }

  /** compose stop + rm -f livetv; false (logged) when it did not go through */
  private async stopLivetv(): Promise<boolean> {
    try { await this.ops.stop(LIVETV); await this.ops.rm(LIVETV); return true; } catch { this.log.add('livetv could not be stopped'); return false; }
  }

  /** remembers the image id livetv runs (remove deletes it later, also after a disable) */
  private async recordLivetvImage(): Promise<void> {
    const image = (await this.ops.livetvContainer().catch(() => null))?.image;
    if (image) { this.state.livetvImage = image; this.persist(); }
  }

  /**
   * Before every job: a livetv container that runs while the state is not `enabled` (a crash between its start and the state
   * write, or COMPOSE_PROFILES=livetv) is adopted as enabled, so updates keep it on the same build. It only ever started from a
   * verified image (enable) or by the admin's own compose command. `enabled` without a container is left as it is and logged.
   */
  private async reconcileLivetv(stackChecked = false): Promise<void> {
    let c: LivetvContainer | null;
    try {
      // never on a stack the updater does not manage (the job then fails with foreign_stack where it always did)
      if (!stackChecked) await this.ops.ownStack();
      c = await this.ops.livetvContainer();
    } catch { return; }
    if (this.state.livetv === 'stop_failed') {
      // a job disabled livetv but could not stop it: stop it again (never adopt it), keep the reason
      if (!c || (await this.stopLivetv())) { this.state.livetv = 'disabled'; this.persist(); this.log.add('livetv stopped'); }
      return;
    }
    if (c?.state === 'running' && this.state.livetv !== 'enabled') {
      this.state.livetv = 'enabled';
      this.state.livetvError = null;
      if (c.image) this.state.livetvImage = c.image;
      this.persist();
      this.log.add('livetv runs without being enabled: state set to enabled');
    } else if (!c && this.state.livetv === 'enabled') {
      this.log.add('livetv is enabled but has no container');
    }
  }

  /**
   * update (to the channel's tag, rolled back automatically) or the rollback to a legacy sha tag (never rolled back again).
   * 1 pull: compare every service's registry digest with what it runs, pull the changed ones by digest. Nothing changed: done.
   * 2 verify the changed ones. 3 record what runs now (previousDigests). 4 restart: move the local tags, `up`. 5 health.
   * 6 on a failure after the restart: back to the recorded digests (pruned images pulled and verified first).
   */
  private async deployJob(job: Job, autoRollback: boolean): Promise<void> {
    await this.reconcileLivetv();
    let core: Targets;
    let livetv: LivetvPlan;
    try {
      core = await this.step(job, 'pull', async () => {
        const images = await this.ops.images(job.to, FF_SERVICES);
        this.logFiles();
        const t = await this.compare(job.to, images, CORE);
        const from = shaTag(t.backend?.before?.commit);
        if (from) job.from = from;
        for (const x of Object.values(t)) if (x.changed) await this.ops.pullDigest(x.ref);
        return t;
      });
      const moved = Object.values(core).filter((t) => t.changed).map((t) => t.ref);
      if (moved.length) await this.step(job, 'verify', () => this.verifyRefs(moved));
      // livetv after the core services are verified, on its own (its failure never fails the core pull)
      livetv = this.state.livetv === 'enabled' ? await this.prepareLivetv(job.to) : 'off';
      if (!moved.length && !(typeof livetv === 'object' && livetv.changed)) return await this.unchanged(job, core, livetv);
      // only livetv changed: its image was verified on its own
      if (!moved.length) { job.steps.verify = 'ok'; this.persist(); }
    } catch (e) {
      // nothing was restarted
      return this.finishJob(job, 'failed', (e as StepError).code);
    }
    // what runs now is what a rollback goes back to; recorded before anything restarts (a crash there finds it). An update that
    // rolls back puts the earlier target back: the services run `prev` again, a rollback to it would change nothing.
    const earlier = { previousDigests: this.state.previousDigests, previous: this.state.previous };
    const prev = this.ownRefs([...Object.values(core), ...(typeof livetv === 'object' ? [livetv] : [])]);
    if (Object.keys(prev).length) { this.state.previousDigests = prev; this.state.previous = null; this.persist(); }
    try {
      job.services = await this.bringUp(job, job.to, core, livetv, true);
      this.state.current = job.to;
      this.persist();
    } catch (e) {
      const code = (e as StepError).code;
      // every service this job moved needs a digest to go back to (none for a dev build)
      if (!autoRollback || Object.values(core).some((t) => t.changed && !prev[t.service])) return this.finishJob(job, 'failed', code);
      this.log.add('rolling back to the previous digests');
      job.steps.rollback = 'pending';
      try {
        await this.step(job, 'rollback', async () => {
          const images = Object.fromEntries(Object.values(core).map((t) => [t.service, t.image]));
          const { targets, pulled } = await this.restoreTargetsPullingPruned(images, prev, CORE);
          await this.verifyRefs(pulled);
          await this.bringUp(job, job.to, targets, await this.restoreLivetv(job.to, prev.livetv), false);
        });
        // the services run the previous digests under the local tags of job.to; the rollback target is the one from before
        this.state.current = job.to;
        this.state.previousDigests = earlier.previousDigests;
        this.state.previous = earlier.previous;
        return this.finishJob(job, 'rolled_back', code);
      } catch {
        return this.finishJob(job, 'failed', 'rollback_failed');
      }
    }
    return this.afterCore(job);
  }

  /** nothing to pull, verify or restart: every service unchanged (a livetv that cannot follow is dropped as in any update) */
  private async unchanged(job: Job, core: Targets, livetv: LivetvPlan): Promise<void> {
    if (typeof livetv === 'string' && livetv !== 'off') await this.dropLivetv(livetv, job.to);
    job.steps.verify = 'skipped'; job.steps.restart = 'skipped'; job.steps.health = 'skipped';
    job.services = Object.fromEntries([...Object.values(core), ...(typeof livetv === 'object' ? [livetv] : [])].map((t) => [t.service, 'unchanged' as const]));
    this.persist();
    this.log.add('all services unchanged');
    return this.afterCore(job);
  }

  /** FriendFlix is healthy (or unchanged): the media server follows (its failure never rolls FriendFlix back); never in a rollback */
  private async afterCore(job: Job): Promise<void> {
    const media = job.action === 'update' ? await this.runMediaPhase(job) : null;
    return media ? this.finishJob(job, 'succeeded_mediaserver_failed', media) : this.finishJob(job, 'succeeded', null);
  }

  /**
   * rollback to the recorded digests under the channel's tag (`job.to`): pruned images pulled by digest and verified, the local
   * tags moved back, `up` recreates only the services that differ; on success the digests it left become the rollback target.
   * An unhealthy rollback is not rolled back again.
   */
  private async rollbackJob(job: Job, digests: Record<string, string>): Promise<void> {
    await this.reconcileLivetv();
    let core: Targets;
    let livetv: LivetvPlan;
    try {
      const pulled: string[] = [];
      core = await this.step(job, 'pull', async () => {
        const images = await this.ops.images(job.to, FF_SERVICES);
        this.logFiles();
        const r = await this.restoreTargetsPullingPruned(images, digests, CORE);
        pulled.push(...r.pulled);
        const from = shaTag(r.targets.backend?.before?.commit);
        if (from) job.from = from;
        return r.targets;
      });
      await this.step(job, 'verify', () => this.verifyRefs(pulled));
      livetv = await this.restoreLivetv(job.to, digests.livetv);
      if (!Object.values(core).some((t) => t.changed) && !(typeof livetv === 'object' && livetv.changed)) return await this.unchanged(job, core, livetv);
    } catch (e) {
      return this.finishJob(job, 'failed', (e as StepError).code);
    }
    const left = this.ownRefs([...Object.values(core), ...(typeof livetv === 'object' ? [livetv] : [])]);
    try {
      job.services = await this.bringUp(job, job.to, core, livetv, true);
    } catch (e) {
      return this.finishJob(job, 'failed', (e as StepError).code);
    }
    this.state.current = job.to;
    if (Object.keys(left).length) { this.state.previousDigests = left; this.state.previous = null; }
    this.persist();
    return this.finishJob(job, 'succeeded', null);
  }

  /** the media phase's code when it failed; null when it succeeded or had nothing to do */
  private async runMediaPhase(job: Job): Promise<MediaError | null> {
    if (!this.mediaPhase) return null;
    try {
      const r = await this.mediaPhase(job);
      return r === 'ok' ? null : r;
    } catch {
      return 'helper_failed';
    }
  }

  /** livetv running and healthy (where it has a check) within the livetv health timeout */
  private waitLivetv(): Promise<boolean> {
    return this.waitHealthy(async () => {
      const c = await this.ops.livetvContainer();
      return c !== null && c.state === 'running' && (c.health === '' || c.health === 'healthy');
    }, this.o.livetvHealthTimeoutMs);
  }

  /**
   * enable: the registry digest of livetv at the channel's tag -> pull by digest -> cosign verify -> its local tag moved ->
   * start (`up -d --no-deps --pull never livetv` with its profile) -> healthy within 2 min, then state enabled. A start that
   * fails or does not get healthy is stopped and removed again when livetv was not enabled before (the job ends rolled_back:
   * "start failed, removed again"); an enabled one (a repair) is left as it is.
   */
  private async livetvEnable(job: Job): Promise<void> {
    await this.reconcileLivetv();
    const wasEnabled = this.state.livetv === 'enabled';
    let t: Target;
    try {
      t = await this.step(job, 'pull', async () => {
        // compose files from before Live TV fail in images() (compose_outdated); files refreshed without `up -d` here (network_missing)
        const images = await this.ops.images(job.to, LIVETV);
        this.logFiles();
        await this.ops.livetvNetwork(job.to);
        const x = (await this.compare(job.to, images, LIVETV))[LIVETV_SERVICE]!;
        await this.ops.pullDigest(x.ref);
        return x;
      });
      await this.step(job, 'verify', () => this.verifyRefs([t.ref]));
    } catch (e) {
      return this.finishJob(job, 'failed', (e as StepError).code);
    }
    try {
      await this.step(job, 'restart', async () => { await this.ops.tag(t.ref, t.image); await this.ops.up(job.to, LIVETV); });
      await this.step(job, 'health', async () => { if (!(await this.waitLivetv())) throw new StepError('unhealthy'); });
    } catch (e) {
      const code = (e as StepError).code;
      if (wasEnabled) return this.finishJob(job, 'failed', code);
      job.steps.rollback = 'pending';
      try {
        await this.step(job, 'rollback', async () => { await this.ops.stop(LIVETV); await this.ops.rm(LIVETV); });
        return this.finishJob(job, 'rolled_back', code);
      } catch {
        return this.finishJob(job, 'failed', 'rollback_failed');
      }
    }
    this.state.livetv = 'enabled';
    this.state.livetvError = null;
    await this.recordLivetvImage();
    return this.finishJob(job, 'succeeded', null);
  }

  /**
   * disable: compose stop + rm -f livetv -> state disabled. Without a livetv container nothing runs (absent stays absent, also on
   * compose files from before livetv). remove: the same, then every local tag of the livetv repository, the image id recorded
   * when it ran and the container's, and with `data` the cache volume -> state absent. The recordings volume is never named.
   */
  private async livetvDisable(job: Job, remove: { data: boolean } | null): Promise<void> {
    try {
      await this.step(job, 'restart', async () => {
        await this.ops.ownStack();
        await this.reconcileLivetv(true);
        const c = await this.ops.livetvContainer();
        if (c) {
          await this.ops.stop(LIVETV);
          await this.ops.rm(LIVETV);
        } else {
          this.log.add('livetv has no container');
        }
        if (c || this.state.livetv === 'enabled') this.state.livetv = 'disabled';
        this.state.livetvError = null;
        this.persist();
        if (!remove) return;
        await this.ops.imageRm([...new Set([this.state.livetvImage, c?.image].filter((x): x is string => !!x))]);
        this.log.add('livetv images removed');
        if (remove.data) { await this.ops.volumeRm(); this.log.add('livetv cache volume removed'); }
        this.state.livetv = 'absent';
        this.state.livetvImage = null;
      });
      return this.finishJob(job, 'succeeded', null);
    } catch (e) {
      return this.finishJob(job, 'failed', (e as StepError).code);
    }
  }

  /**
   * self-update: the registry digest of the updater at the channel's tag against the image this updater runs. The same: nothing
   * to restart (compose would leave this container as it is and no new process would ever finish the job). Else pull by digest
   * -> cosign verify -> its local tag moved -> the helper recreates this container.
   */
  private async selfUpdate(job: Job): Promise<void> {
    job.steps.health = 'skipped';
    try {
      await this.reconcileLivetv();
      const t = await this.step(job, 'pull', async () => {
        const images = await this.ops.images(job.to, [SELF_SERVICE]);
        this.logFiles();
        const x = (await this.compare(job.to, images, [SELF_SERVICE]))[SELF_SERVICE]!;
        if (x.changed) await this.ops.pullDigest(x.ref);
        return x;
      });
      if (!t.changed) {
        job.steps.verify = 'skipped'; job.steps.restart = 'skipped';
        this.log.add('the updater already runs this image');
        return this.finishJob(job, 'succeeded', null);
      }
      await this.step(job, 'verify', () => this.verifyRefs([t.ref]));
      await this.step(job, 'restart', async () => { await this.ops.tag(t.ref, t.image); await this.ops.spawnSelfUpdate(job.to); });
      job.step = 'restart'; job.steps.restart = 'running'; this.persist();
      // the helper recreates this container: a new process finishes the job (recover()); still here after the timeout = it failed
      await this.o.sleep(this.o.selfUpdateTimeoutMs);
      job.steps.restart = 'failed';
      return this.finishJob(job, 'failed', 'self_update_timeout');
    } catch (e) {
      return this.finishJob(job, 'failed', (e as StepError).code);
    }
  }
}
