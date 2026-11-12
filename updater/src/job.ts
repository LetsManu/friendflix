// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { StepError, type ImageInfo, type LivetvContainer } from './docker.js';
import { LIVETV_SERVICE, SELF_SERVICE, SHA_TAG_RE, channelTag, ffServices, healthServices, shaTag, type Channel, type LivetvOp } from './policy.js';
import type { Job, JobAction, LivetvState, State, StateStore, StepName } from './state.js';

/** What a job needs from Docker (docker.ts in production, a fake in the tests). */
export interface Ops {
  images(tag: string, services: readonly string[]): Promise<Record<string, string>>;
  pull(tag: string, services: readonly string[]): Promise<void>;
  verify(image: string): Promise<boolean>;
  up(tag: string, services: readonly string[]): Promise<void>;
  imageInfo(ref: string): Promise<ImageInfo | null>;
  running(service: string): Promise<ImageInfo | null>;
  spawnSelfUpdate(tag: string): Promise<void>;
  /**
   * one health round: every one of `services` (default: the FriendFlix services) up and healthy where it has a check, the
   * backend answering with `sha7`
   */
  healthy(sha7: string | null, services?: readonly string[]): Promise<boolean>;
  /** the compose files the last images() call settled on (file names only; for the job log) */
  composeFiles?(): readonly string[];
  /** compose stop / rm -f of the livetv service (stop refuses a foreign stack first) */
  stop(services: readonly string[]): Promise<void>;
  rm(services: readonly string[]): Promise<void>;
  /** removes this repository's livetv image with `tag`, then the image `id` the container ran (livetv's own only) */
  imageRm(tag: string, id: string | null): Promise<void>;
  /** removes this stack's livetv cache volume (<project>_livetv-cache); never another volume */
  volumeRm(): Promise<void>;
  /** the livetv container (any state) with its image id; null when there is none */
  livetvContainer(): Promise<LivetvContainer | null>;
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

  start(action: JobAction): StartResult {
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
   * enable / disable / remove the livetv service. The tag is the build the updater installed last (else the channel's), so
   * livetv runs the same build as the other services. The state changes only when the job gets that far.
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

  /** pull + verify (+ the commit the new backend image carries); nothing is restarted here */
  private async prepare(job: Job | null, tag: string, services: readonly string[], step = <T>(n: StepName, f: () => Promise<T>) => (job ? this.step(job, n, f) : f())) {
    const images = await step('pull', async () => {
      const imgs = await this.ops.images(tag, services);
      const files = this.ops.composeFiles?.();
      if (files?.length) this.log.add(`compose files: ${files.join(', ')}`);
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

  private async waitHealthy(sha7: string | null, services: readonly string[], ok = () => this.ops.healthy(sha7, services), timeoutMs = this.o.healthTimeoutMs): Promise<boolean> {
    const end = this.o.now() + timeoutMs;
    for (;;) {
      if (await ok().catch(() => false)) return true;
      if (this.o.now() >= end) return false;
      await this.o.sleep(this.o.healthIntervalMs);
    }
  }

  /** restart + health of an already verified tag; throws StepError */
  private async bringUp(job: Job, tag: string, images: Record<string, string>, steps: boolean, livetv: boolean): Promise<string | null> {
    const newSha = (await this.ops.imageInfo(images.backend!))?.gitSha ?? null;
    const restart = () => this.ops.up(tag, ffServices(livetv));
    if (steps) await this.step(job, 'restart', restart); else await restart();
    const health = async () => { if (!(await this.waitHealthy(newSha ? newSha.slice(0, 7) : null, healthServices(livetv)))) throw new StepError('unhealthy'); };
    if (steps) await this.step(job, 'health', health); else await health();
    return newSha;
  }

  private async deployJob(job: Job, autoRollback: boolean): Promise<void> {
    // livetv follows the channel like the other images while it is enabled (no livetv job can change that meanwhile: one job at a time)
    const livetv = this.state.livetv === 'enabled';
    const before = await this.ops.running('backend').catch(() => null);
    const prevTag = shaTag(before?.gitSha);
    if (prevTag) job.from = prevTag;
    let images: Record<string, string>;
    try {
      images = await this.prepare(job, job.to, ffServices(livetv));
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
          const imgs = await this.prepare(null, prevTag, ffServices(livetv));
          await this.bringUp(job, prevTag, imgs, false, livetv);
        });
        this.state.current = prevTag;
        return this.finish(job, 'rolled_back', code);
      } catch {
        return this.finish(job, 'failed', 'rollback_failed');
      }
    }
  }

  /** livetv running, and healthy where it has a check */
  private async livetvHealthy(): Promise<boolean> {
    const c = await this.ops.livetvContainer();
    return c !== null && c.state === 'running' && (c.health === '' || c.health === 'healthy');
  }

  /**
   * enable: pull -> cosign verify -> start (`up -d --no-deps --pull never livetv` with its profile) -> healthy within 2 min, then
   * state enabled. A start that fails or does not get healthy is stopped and removed again when livetv was not enabled before
   * (state and containers stay in step); an enabled one (a repair) is left as it is.
   */
  private async livetvEnable(job: Job): Promise<void> {
    const wasEnabled = this.state.livetv === 'enabled';
    try {
      await this.prepare(job, job.to, LIVETV);
    } catch (e) {
      return this.finish(job, 'failed', (e as StepError).code);
    }
    try {
      await this.step(job, 'restart', () => this.ops.up(job.to, LIVETV));
      await this.step(job, 'health', async () => {
        if (!(await this.waitHealthy(null, LIVETV, () => this.livetvHealthy(), this.o.livetvHealthTimeoutMs))) throw new StepError('health_timeout');
      });
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
    return this.finish(job, 'succeeded', null);
  }

  /**
   * disable: compose stop + rm -f livetv -> state disabled. remove: the same, then the livetv image (this tag, and the image the
   * container ran) and with `data` the cache volume -> state absent. The recordings volume is never named.
   */
  private async livetvDisable(job: Job, remove: { data: boolean } | null): Promise<void> {
    try {
      await this.step(job, 'restart', async () => {
        await this.ops.stop(LIVETV);
        const image = remove ? (await this.ops.livetvContainer().catch(() => null))?.image ?? null : null;
        await this.ops.rm(LIVETV);
        this.state.livetv = 'disabled';
        this.persist();
        if (!remove) return;
        await this.ops.imageRm(job.to, image);
        this.log.add('livetv image removed');
        if (remove.data) { await this.ops.volumeRm(); this.log.add('livetv cache volume removed'); }
        this.state.livetv = 'absent';
      });
      return this.finish(job, 'succeeded', null);
    } catch (e) {
      return this.finish(job, 'failed', (e as StepError).code);
    }
  }

  private async selfUpdate(job: Job): Promise<void> {
    job.steps.health = 'skipped';
    try {
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
