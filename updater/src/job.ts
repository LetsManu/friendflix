// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { StepError, type ImageInfo, type LivetvContainer } from './docker.js';
import { FF_SERVICES, LIVETV_SERVICE, SELF_SERVICE, SHA_TAG_RE, channelTag, shaTag, type Channel, type LivetvOp } from './policy.js';
import { LIVETV_ERRORS, type Job, type JobAction, type LivetvError, type LivetvState, type State, type StateStore, type StepName } from './state.js';

/** what an update does with livetv at a tag: nothing (not enabled), start it (pulled and verified), or drop it for this reason */
type LivetvPlan = 'off' | 'up' | LivetvError;

/** What a job needs from Docker (docker.ts in production, a fake in the tests). */
export interface Ops {
  images(tag: string, services: readonly string[]): Promise<Record<string, string>>;
  pull(tag: string, services: readonly string[]): Promise<void>;
  verify(image: string): Promise<boolean>;
  up(tag: string, services: readonly string[]): Promise<void>;
  imageInfo(ref: string): Promise<ImageInfo | null>;
  running(service: string): Promise<ImageInfo | null>;
  spawnSelfUpdate(tag: string): Promise<void>;
  /** one health round: every FriendFlix service up (and healthy where it has a check), the backend answering with `sha7` */
  healthy(sha7: string | null): Promise<boolean>;
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

/** In-memory job log: our own fixed messages, tags and error codes only (never command output, never a secret). */
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
}

export type StartResult = { ok: true; job: Job } | { ok: false; error: 'busy' | 'no_target' | 'no_previous' };

const newJob = (action: JobAction, from: string | null, to: string, now: number): Job => ({
  id: randomBytes(8).toString('hex'), action, state: 'running', step: null, from, to,
  steps: { pull: 'pending', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' },
  startedAt: new Date(now).toISOString(), finishedAt: null, error: null,
});

const LIVETV = [LIVETV_SERVICE] as const;

/**
 * One job at a time: update (pull -> cosign verify -> recreate -> health, automatic rollback to the previous build when the
 * new one does not get healthy), rollback (to the recorded previous sha tag), self-update (explicit only), and the livetv jobs
 * (enable: the same pull -> verify -> start -> health for the livetv service alone; disable; remove). A verify failure aborts
 * before anything is restarted. Every job, livetv ones included, runs alone: a second start answers busy.
 */
export class Updater {
  readonly log: JobLog;
  private state: State;
  private current: Promise<void> | null = null;
  private readonly o: Required<Omit<UpdaterOpts, 'log'>>;

  constructor(private readonly ops: Ops, private readonly store: StateStore, opts: UpdaterOpts = {}) {
    this.o = {
      healthTimeoutMs: opts.healthTimeoutMs ?? 180_000, livetvHealthTimeoutMs: opts.livetvHealthTimeoutMs ?? 120_000, healthIntervalMs: opts.healthIntervalMs ?? 5_000,
      selfUpdateTimeoutMs: opts.selfUpdateTimeoutMs ?? 180_000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: opts.now ?? Date.now,
    };
    this.log = opts.log ?? new JobLog(200, this.o.now);
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
    } else {
      if (j.step) j.steps[j.step] = 'failed';
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
    const target = action === 'rollback' ? this.state.previous : channelTag(this.state.channel, this.state.version);
    if (!target) return { ok: false, error: action === 'rollback' ? 'no_previous' : 'no_target' };
    if (action === 'rollback' && !SHA_TAG_RE.test(target)) return { ok: false, error: 'no_previous' };
    const job = newJob(action, this.state.current, target, this.o.now());
    this.state.lastJob = job;
    this.persist();
    this.log.add(`${action} to ${target} started`);
    const run = action === 'self-update' ? this.selfUpdate(job) : this.deployJob(job, action === 'update');
    this.current = run.catch(() => undefined).finally(() => { this.current = null; });
    return { ok: true, job: structuredClone(job) };
  }

  /**
   * enable / disable / remove the livetv service. `to` starts as the last installed tag (else the channel's); enable replaces it
   * inside the job with the running backend's sha-<7> tag when known (one Docker round trip, not done before the 202 answer), so
   * livetv runs exactly the build the other services run. The state changes only when the job gets that far.
   */
  startLivetv(op: LivetvOp): StartResult {
    if (this.current) return { ok: false, error: 'busy' };
    const target = this.state.current ?? channelTag(this.state.channel, this.state.version);
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

  private finish(job: Job, state: Job['state'], error: string | null): void {
    job.state = state; job.error = error; job.finishedAt = new Date(this.o.now()).toISOString();
    for (const k of Object.keys(job.steps) as StepName[]) if (job.steps[k] === 'pending') job.steps[k] = 'skipped';
    if (state === 'succeeded') job.step = null;
    this.persist();
    this.log.add(`${job.action} ${state}${error ? ` (${error})` : ''}`);
  }

  /** pull + verify (+ the commit the new backend image carries); nothing is restarted here. `check` runs before the pull. */
  private async prepare(job: Job | null, tag: string, services: readonly string[], check?: () => Promise<void>) {
    const step = <T>(n: StepName, f: () => Promise<T>) => (job ? this.step(job, n, f) : f());
    const images = await step('pull', async () => {
      const imgs = await this.ops.images(tag, services);
      const files = this.ops.composeFiles?.();
      if (files?.length) this.log.add(`compose files: ${files.join(', ')}`);
      await check?.();
      await this.ops.pull(tag, services);
      return imgs;
    });
    await step('verify', async () => {
      for (const img of [...new Set(Object.values(images))]) {
        if (!(await this.ops.verify(img))) { this.log.add(`signature check failed for ${img}`); throw new StepError('verify_failed'); }
        this.log.add(`signature ok: ${img}`);
      }
    });
    return images;
  }

  private async waitHealthy(sha7: string | null, ok = () => this.ops.healthy(sha7), timeoutMs = this.o.healthTimeoutMs): Promise<boolean> {
    const end = this.o.now() + timeoutMs;
    for (;;) {
      if (await ok().catch(() => false)) return true;
      if (this.o.now() >= end) return false;
      await this.o.sleep(this.o.healthIntervalMs);
    }
  }

  /**
   * restart + health of an already verified tag; throws StepError for the FriendFlix services only. `livetv`: its image at `tag`
   * is verified too; it is started after the core services and, when it fails to start or to get healthy, stopped and disabled
   * (dropLivetv) while the job goes on: livetv is optional and never fails or rolls back a core update.
   */
  private async bringUp(job: Job, tag: string, images: Record<string, string>, steps: boolean, livetv: LivetvPlan): Promise<string | null> {
    const newSha = (await this.ops.imageInfo(images.backend!))?.gitSha ?? null;
    let ltUp = livetv === 'up';
    const restart = async () => {
      await this.ops.up(tag, FF_SERVICES);
      // only once the core services were recreated: a core failure that restarted nothing leaves livetv as it was
      if (livetv === 'off') return;
      if (livetv !== 'up') return this.dropLivetv(livetv, tag);
      try { await this.ops.up(tag, LIVETV); } catch { ltUp = false; await this.dropLivetv('restart_failed', tag); }
    };
    if (steps) await this.step(job, 'restart', restart); else await restart();
    const health = async () => {
      if (!(await this.waitHealthy(newSha ? newSha.slice(0, 7) : null))) throw new StepError('unhealthy');
      if (!ltUp) return;
      if (await this.waitLivetv()) await this.recordLivetvImage();
      else await this.dropLivetv('unhealthy', tag);
    };
    if (steps) await this.step(job, 'health', health); else await health();
    return newSha;
  }

  /**
   * pull + cosign verify of livetv at `tag` on its own (a failure of its pull must not fail the core services' pull); a fixed
   * error code when its image is missing, does not resolve to this repository's or is not verified, null when it may start
   */
  private async prepareLivetv(tag: string): Promise<LivetvError | null> {
    let image: string;
    try {
      image = (await this.ops.images(tag, LIVETV))[LIVETV_SERVICE]!;
      await this.ops.pull(tag, LIVETV);
    } catch (e) {
      // the real code (a changed config, an unexpected image, compose failing, the pull), with its fixed detail
      const code = LIVETV_ERRORS.find((c) => e instanceof StepError && c === e.code) ?? 'pull_failed';
      this.log.add(`livetv: ${code}${e instanceof StepError && e.detail ? ` (${e.detail})` : ''}`);
      return code;
    }
    if (!(await this.ops.verify(image).catch(() => false))) { this.log.add(`signature check failed for ${image}`); return 'verify_failed'; }
    this.log.add(`signature ok: ${image}`);
    return null;
  }

  /**
   * Ruling (Task 9 review M5, spec §4.2 C3): livetv is optional. An update or rollback whose livetv image is missing or not
   * verified, or whose livetv does not start or get healthy, stops and removes livetv, persists `disabled` with a fixed error and
   * one fixed log line, and completes for the core services. An unverified livetv image is never started.
   */
  private async dropLivetv(code: LivetvError, tag: string): Promise<void> {
    this.state.livetvError = code;
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

  private async deployJob(job: Job, autoRollback: boolean): Promise<void> {
    await this.reconcileLivetv();
    const before = await this.ops.running('backend').catch(() => null);
    const prevTag = shaTag(before?.gitSha);
    if (prevTag) job.from = prevTag;
    let images: Record<string, string>;
    let livetv: LivetvPlan;
    try {
      images = await this.prepare(job, job.to, FF_SERVICES);
      livetv = await this.livetvFor(job.to);
    } catch (e) {
      // nothing was restarted
      return this.finish(job, 'failed', (e as StepError).code);
    }
    try {
      const newSha = await this.bringUp(job, job.to, images, true, livetv);
      this.state.current = job.to;
      const newTag = shaTag(newSha);
      if (prevTag && prevTag !== newTag) this.state.previous = prevTag;
      return this.finish(job, 'succeeded', null);
    } catch (e) {
      const code = (e as StepError).code;
      if (!autoRollback || !prevTag) return this.finish(job, 'failed', code);
      this.log.add(`rolling back to ${prevTag}`);
      job.steps.rollback = 'pending';
      try {
        await this.step(job, 'rollback', async () => {
          const imgs = await this.prepare(null, prevTag, FF_SERVICES);
          await this.bringUp(job, prevTag, imgs, false, await this.livetvFor(prevTag));
        });
        this.state.current = prevTag;
        return this.finish(job, 'rolled_back', code);
      } catch {
        return this.finish(job, 'failed', 'rollback_failed');
      }
    }
  }

  /** whether livetv goes along with `tag`: only while enabled, and only with its image pulled and verified (else it is dropped by bringUp) */
  private async livetvFor(tag: string): Promise<LivetvPlan> {
    if (this.state.livetv !== 'enabled') return 'off';
    return (await this.prepareLivetv(tag)) ?? 'up';
  }

  /** livetv running and healthy (where it has a check) within the livetv health timeout */
  private waitLivetv(): Promise<boolean> {
    return this.waitHealthy(null, async () => {
      const c = await this.ops.livetvContainer();
      return c !== null && c.state === 'running' && (c.health === '' || c.health === 'healthy');
    }, this.o.livetvHealthTimeoutMs);
  }

  /**
   * enable: the build the backend runs now (its sha-<7> tag; else the last installed tag, else the channel's) -> pull -> cosign
   * verify -> start (`up -d --no-deps --pull never livetv` with its profile) -> healthy within 2 min, then state enabled. A start
   * that fails or does not get healthy is stopped and removed again when livetv was not enabled before (the job ends
   * rolled_back: "start failed, removed again"); an enabled one (a repair) is left as it is.
   */
  private async livetvEnable(job: Job): Promise<void> {
    await this.reconcileLivetv();
    const running = shaTag((await this.ops.running('backend').catch(() => null))?.gitSha);
    if (running && running !== job.to) { job.to = running; this.persist(); this.log.add(`livetv follows the running build ${running}`); }
    const wasEnabled = this.state.livetv === 'enabled';
    try {
      // compose files from before Live TV fail in images() (compose_outdated); files refreshed without `up -d` here (network_missing)
      await this.prepare(job, job.to, LIVETV, () => this.ops.livetvNetwork(job.to));
    } catch (e) {
      return this.finish(job, 'failed', (e as StepError).code);
    }
    try {
      await this.step(job, 'restart', () => this.ops.up(job.to, LIVETV));
      await this.step(job, 'health', async () => { if (!(await this.waitLivetv())) throw new StepError('unhealthy'); });
    } catch (e) {
      const code = (e as StepError).code;
      if (wasEnabled) return this.finish(job, 'failed', code);
      job.steps.rollback = 'pending';
      try {
        await this.step(job, 'rollback', async () => { await this.ops.stop(LIVETV); await this.ops.rm(LIVETV); });
        return this.finish(job, 'rolled_back', code);
      } catch {
        return this.finish(job, 'failed', 'rollback_failed');
      }
    }
    this.state.livetv = 'enabled';
    this.state.livetvError = null;
    await this.recordLivetvImage();
    return this.finish(job, 'succeeded', null);
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
      return this.finish(job, 'succeeded', null);
    } catch (e) {
      return this.finish(job, 'failed', (e as StepError).code);
    }
  }

  private async selfUpdate(job: Job): Promise<void> {
    job.steps.health = 'skipped';
    try {
      await this.reconcileLivetv();
      const images = await this.prepare(job, job.to, [SELF_SERVICE]);
      // already on that image (same registry digest): compose would leave this container as it is and no new process would
      // ever finish the job, so there is nothing to restart
      const [now, next] = await Promise.all([this.ops.running(SELF_SERVICE).catch(() => null), this.ops.imageInfo(images[SELF_SERVICE]!).catch(() => null)]);
      if (now && next && now.repoDigests.some((d) => next.repoDigests.includes(d))) {
        job.steps.restart = 'skipped';
        this.log.add('the updater already runs this image');
        return this.finish(job, 'succeeded', null);
      }
      await this.step(job, 'restart', () => this.ops.spawnSelfUpdate(job.to));
      job.step = 'restart'; job.steps.restart = 'running'; this.persist();
      // the helper recreates this container: a new process finishes the job (recover()); still here after the timeout = it failed
      await this.o.sleep(this.o.selfUpdateTimeoutMs);
      job.steps.restart = 'failed';
      return this.finish(job, 'failed', 'self_update_timeout');
    } catch (e) {
      return this.finish(job, 'failed', (e as StepError).code);
    }
  }
}
