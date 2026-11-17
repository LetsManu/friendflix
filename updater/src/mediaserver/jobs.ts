// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { StepError } from '../docker.js';
import type { StartResult } from '../job.js';
import type { Job, MediaState } from '../state.js';
import { EngineError } from './engine.js';
import type { EngineFacts } from './facts.js';
import { TemplateViolation, assertHelper, assertManaged, assertManagedInspect } from './guard.js';
import { runHdr } from './helpers.js';
import type { Pin, PinRead } from './pins.js';
import type { MediaDeps } from './service.js';
import { containerSpec, helperSpec, names, needsSeed, seedSpec, uidSupported, volumeSpec, type CreateRequest, type HelperMount, type HelperVerb, type TemplateFacts } from './template.js';
import { BACKUP_ID_RE, KINDS, MEDIA_ERRORS, MEDIA_STEPS, type BackupMeta, type Desired, type DesiredSpec, type Gpu, type Kind, type MediaError, type MediaJobAction, type MediaOp, type MediaStep } from './types.js';

/**
 * The media server jobs (spec "Lifecycle"): apply / update / finish as one deploy (check → pull → verify → snapshot → create →
 * start → health, a recreate with rollback when a container exists), start / stop / restart, the HDR test and remove. They share
 * the Updater's one-job lock. Job log lines are fixed messages and codes: never a path, a folder name, a digest or server output.
 */

export interface JobDeps extends MediaDeps {
  pins(): Promise<PinRead>;
  verify(ref: string): Promise<boolean>;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  sleep?(ms: number): Promise<void>;
}

export type MediaJobOp = Extract<MediaOp, { op: 'apply' | 'finish-setup' | 'start' | 'stop' | 'restart' | 'update' | 'hdr-test' | 'remove' }>;
type Reason = 'apply' | 'update' | 'recover' | 'finish';

/** helper limits (spec "Times"): 2 min, backup and restore 2 h */
export const HELPER_MS = 2 * 60_000;
export const BACKUP_HELPER_MS = 2 * 3600_000;
const HEALTH_MS = 3 * 60_000;
/** an image without a healthcheck counts as healthy once it ran this long */
const RUNNING_MS = 60_000;
const INTERVAL_MS = 5_000;
const MAX_FOLDERS = 20;
const FERROFIN_UPSTREAM_LABEL = 'io.github.letsmanu.friendflix.mediaserver.ferrofin';
const UPSTREAM_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const VERSION_RE = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/;
const RENDER_NODE_RE = /^renderD[0-9]{1,4}$/;
const JELLYFIN_REPO_RE = /^(docker\.io\/)?jellyfin\/jellyfin$/;
const FOLDER_CODES: readonly MediaError[] = ['folder_missing', 'folder_symlink', 'folder_unreadable'];
/** the container user before the admin chose one */
const DEFAULT_USER = { uid: 1000, gid: 1000 };
/** what a step that fails without a code of its own reports */
const STEP_CODE: Record<MediaStep, MediaError> = {
  check: 'helper_failed', pull: 'pull_failed', verify: 'verify_failed', snapshot: 'snapshot_failed', create: 'create_failed', start: 'start_failed', health: 'unhealthy', rollback: 'helper_failed',
};
const NO_TARGET: StartResult = { ok: false, error: 'no_target' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMediaError = (c: unknown): c is MediaError => typeof c === 'string' && (MEDIA_ERRORS as readonly string[]).includes(c);
const fail = (code: MediaError): never => { throw new StepError(code); };
/** a guard refusal is never turned into another code */
const guardFirst = (e: unknown): void => { if (e instanceof TemplateViolation) throw e; };

/** a fixed code for whatever was thrown: our codes and the engine's known ones pass, a guard refusal is template_violation */
function codeOf(e: unknown, fallback: MediaError): MediaError {
  if (e instanceof TemplateViolation) return 'template_violation';
  const c = e instanceof StepError || e instanceof EngineError ? e.code : '';
  return isMediaError(c) ? c : fallback;
}

/** a folder that is another chosen one or lies inside one */
function nested(rels: string[]): boolean {
  return rels.some((a, i) => rels.some((b, j) => i !== j && (a === b || b.startsWith(`${a}/`))));
}

/** `v?X.Y.Z` compared numerically; anything else is never "older" */
function older(a: string, b: string): boolean {
  const x = VERSION_RE.exec(a);
  const y = VERSION_RE.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]);
  return false;
}

const specOf = (d: Desired): DesiredSpec => ({ kind: d.kind, folders: d.folders, uid: d.uid, gid: d.gid, gpu: d.gpu, mediaGid: d.mediaGid, egress: d.egress, tz: d.tz });
const userOf = (d: { uid: number; gid: number; mediaGid: number | null } | null) =>
  ({ uid: d?.uid ?? DEFAULT_USER.uid, gid: d?.gid ?? DEFAULT_USER.gid, groups: d?.mediaGid ? [d.mediaGid] : [] });
const labelsOf = (i: Obj): Record<string, unknown> => (isObj(i.Config) && isObj(i.Config.Labels) ? i.Config.Labels : {});
const two = (n: number): string => String(n).padStart(2, '0');
/** `<kind>-<YYYYMMDD-HHMM UTC>-<upstream>` (Controller's call 14) */
const snapshotId = (kind: Kind, upstream: string, at: Date): string =>
  `${kind}-${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(at.getUTCHours())}${two(at.getUTCMinutes())}-${upstream}`;

/** the render nodes a `gpu` helper reported (a gid 0 is kept: the template refuses it) */
function renderNodes(a: Obj): Array<{ node: string; gid: number; vendor: string }> {
  if (!Array.isArray(a.nodes)) return [];
  return a.nodes.filter((n): n is { node: string; gid: number; vendor: string } =>
    isObj(n) && typeof n.node === 'string' && RENDER_NODE_RE.test(n.node) && typeof n.gid === 'number' && Number.isInteger(n.gid) && n.gid >= 0 && n.gid <= 65535)
    .map((n) => ({ node: n.node, gid: n.gid, vendor: typeof n.vendor === 'string' ? n.vendor : 'other' }));
}

interface Runner { project: string; image: string }
/** a managed container found under the real name */
interface Existing { id: string; kind: Kind | null; running: boolean }
interface Ctx { project: string; facts: EngineFacts; runner: Runner; base: NonNullable<MediaState['base']>; pin: Pin; old: Existing | null; dataExists: boolean }
/** what a deploy changed so far (for the rollback) */
interface Changes { stopped: boolean; renamed: boolean; newId: string | null; started: boolean; snapshot: { id: string; kind: Kind } | null }

export class MediaJobs {
  private readonly healthMs: number;
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: JobDeps) {
    this.healthMs = d.healthTimeoutMs ?? HEALTH_MS;
    this.intervalMs = d.healthIntervalMs ?? INTERVAL_MS;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get u() { return this.d.updater; }
  private get engine() { return this.d.engine; }

  start(op: MediaJobOp): StartResult {
    if (this.u.busy) return { ok: false, error: 'busy' };
    const desired = this.u.mediaState().desired;
    switch (op.op) {
      case 'apply':
        return this.job('mediaserver-apply', (job) => this.deploy(job, op.spec, { reason: 'apply', ...(op.firstRun ? { password: op.firstRun.password } : {}) }));
      case 'finish-setup':
        if (desired?.kind !== 'ferrofin') return NO_TARGET;
        return this.job('mediaserver-finish', (job) => this.deploy(job, specOf(this.desired()), { reason: 'finish' }));
      case 'update':
        if (!desired) return NO_TARGET;
        return this.job('mediaserver-update', (job) => this.update(job));
      case 'start': case 'restart':
        if (!desired) return NO_TARGET;
        return this.job(`mediaserver-${op.op}`, (job) => this.run(job, op.op === 'restart'));
      case 'stop':
        return this.job('mediaserver-stop', (job) => this.stop(job));
      case 'hdr-test':
        return this.job('mediaserver-hdr-test', (job) => this.hdr(job, op.kind));
      case 'remove':
        return this.job('mediaserver-remove', (job) => this.remove(job, op.data));
    }
  }

  /**
   * base-confirm with a container: the same recreate as `apply` on the new base, but the owner's `run` choice is kept (a stopped
   * server is recreated stopped, like an update)
   */
  rebase(spec: DesiredSpec): StartResult {
    if (this.u.busy) return { ok: false, error: 'busy' };
    return this.job('mediaserver-apply', (job) => this.deploy(job, spec, { reason: 'update' }));
  }

  private desired(): Desired {
    return this.u.mediaState().desired ?? fail('no_base');
  }

  /** a media job: `body` throws a step error, the job ends rolled_back when the rollback step brought the old container back */
  private job(action: MediaJobAction, body: (job: Job) => Promise<void>): StartResult {
    return this.u.startMediaJob(action, async (job) => {
      try {
        await body(job);
        this.u.finishJob(job, 'succeeded', null);
      } catch (e) {
        const code = codeOf(e, 'helper_failed');
        const back = code !== 'template_violation' && job.media?.steps.rollback === 'ok';
        this.u.finishJob(job, back ? 'rolled_back' : 'failed', code);
      }
    });
  }

  private media(job: Job): NonNullable<Job['media']> {
    job.media ??= { step: null, steps: Object.fromEntries(MEDIA_STEPS.map((k) => [k, 'pending'])) as NonNullable<Job['media']>['steps'] };
    return job.media;
  }

  private async step<T>(job: Job, name: MediaStep, fn: () => Promise<T>): Promise<T> {
    const m = this.media(job);
    m.step = name; m.steps[name] = 'running'; this.u.persistNow();
    this.u.log.add(`media ${name}`);
    try {
      const v = await fn();
      m.steps[name] = 'ok'; this.u.persistNow();
      return v;
    } catch (e) {
      m.steps[name] = 'failed'; this.u.persistNow();
      const code = codeOf(e, STEP_CODE[name]);
      this.u.log.add(`media ${code}`);
      throw new StepError(code);
    }
  }

  /** one helper run as the given user: its JSON answer, or a StepError with the helper's own code */
  private async helper(r: Runner, u: { uid: number; gid: number; groups: number[] }, verb: HelperVerb, args: string[], mounts: HelperMount[], limitMs = HELPER_MS): Promise<Obj> {
    const req = helperSpec({ verb, args, uid: u.uid, gid: u.gid, groups: u.groups, mounts }, r);
    const a = await this.d.helper(this.engine, req, { project: r.project, uid: u.uid, gid: u.gid, image: r.image, verb }, limitMs);
    if ('error' in a) throw new StepError(isMediaError(a.error) ? a.error : 'helper_failed');
    return a;
  }

  /** facts with no reason against the managed media server, and the image the helpers run from */
  private async ready(): Promise<{ facts: EngineFacts; project: string; runner: Runner }> {
    const facts = await this.d.facts();
    if (facts.reason) fail(facts.reason);
    const project = facts.project ?? fail('no_project');
    const image = facts.selfImage ?? fail('no_project');
    return { facts, project, runner: { project, image } };
  }

  /**
   * check → pull → verify → snapshot → create → start → health; a recreate when a container exists. Throws StepError(code) after
   * undoing what it changed (the rollback step brings the old container back). `run` is the owner's choice: true for `apply`, the
   * recorded one otherwise; a server that should not run is created but not started.
   */
  async deploy(job: Job, d: DesiredSpec, o: { password?: string; reason: Reason }): Promise<void> {
    const before = this.u.mediaState();
    const run = o.reason === 'apply' ? true : before.desired?.run ?? true;
    const t: Changes = { stopped: false, renamed: false, newId: null, started: false, snapshot: null };
    let ctx: Ctx | null = null;
    try {
      const c = await this.step(job, 'check', () => this.check(d, o.password, before));
      ctx = c;
      await this.step(job, 'pull', () => this.engine.pull(c.pin.image));
      const upstream = await this.step(job, 'verify', async () => {
        const up = await this.verifyImage(c.pin);
        const prev = before.container;
        if (prev && prev.kind === d.kind && older(up, prev.upstream)) fail('downgrade_refused');
        return up;
      });

      const prev = before.container;
      if (prev && prev.kind === d.kind && prev.upstream !== upstream && c.dataExists) {
        await this.step(job, 'snapshot', async () => {
          if (c.old) { await this.engine.stop(c.old.id); t.stopped = true; }
          const meta = await this.snapshot(null, 'auto');
          t.snapshot = { id: meta.id, kind: meta.kind };
        });
      }

      const made = await this.step(job, 'create', () => this.create(c, d, o.password, t));
      if (run) {
        await this.step(job, 'start', async () => { await this.engine.start(made.id); t.started = true; });
        await this.step(job, 'health', async () => { if (!(await this.healthy(made.id))) fail('unhealthy'); });
      }

      // the new container runs: the old one and a base volume nothing uses any more go
      if (c.old) await this.engine.remove(c.old.id).catch(() => undefined);
      this.u.updateMedia((m) => {
        m.container = { id: made.id, kind: d.kind, digest: c.pin.digest, upstream, specHash: made.specHash };
        m.desired = { ...d, run };
        m.lastError = null;
        m.tampered = false;
      });
      await this.dropPreviousBase(c.project, c.base.volume);
    } catch (e) {
      const code = codeOf(e, 'helper_failed');
      if (ctx) await this.undo(job, ctx, t, before.desired?.run ?? ctx.old?.running ?? false);
      this.u.updateMedia((m) => { m.lastError = code; });
      throw new StepError(code);
    }
  }

  /** everything that can be known without changing anything; the template and the guard run once here as a dry run */
  private async check(d: DesiredSpec, password: string | undefined, before: MediaState): Promise<Ctx> {
    // the pins first: every deploy records where it read them (Controller's call 18), also one that fails below
    const read: PinRead = await this.d.pins().catch((): PinRead => ({ error: 'no_backend' }));
    if (!('error' in read)) this.u.updateMedia((m) => { m.pinSource = read.source; });

    const base = before.base ?? fail('no_base');
    const { facts, project, runner } = await this.ready();
    if (d.egress && !facts.egressNetwork) fail('no_network');
    const rels = d.folders.map((f) => f.rel);
    if (rels.length === 0) fail('folder_missing');
    if (rels.length > MAX_FOLDERS) fail('too_many_folders');
    if (nested(rels)) fail('folder_nested');
    // before any helper runs as that user
    if (!uidSupported(d.kind, d.uid, d.gid)) fail('uid_unsupported');
    if (!(await this.engine.inspectVolume(base.volume))) fail('base_missing');
    const user = userOf(d);
    await this.checkFolders(runner, user, base.volume, rels);
    const gids = await this.renderGids(runner, d);
    if (d.gpu === 'nvidia' && !facts.nvidia) fail('nvidia_missing');

    const old = await this.existing(project, before.desired?.gpu);
    if (d.kind === 'ferrofin' && facts.arch !== 'amd64') fail('arch_unsupported');
    if ('error' in read) return fail(read.error === 'verify_failed' ? 'verify_failed' : 'image_missing');
    const pin = read.pins[d.kind] ?? fail(read.invalid.includes(d.kind) ? 'pin_invalid' : 'image_missing');

    const data = names(project).data(d.kind);
    const dataExists = (await this.engine.inspectVolume(data)) !== null;
    if (dataExists) {
      const a = await this.helper(runner, user, 'check', ['data'], [{ kind: 'data', volume: data, rw: false }]);
      if (typeof a.owner === 'number' && a.owner !== d.uid) fail('uid_mismatch');
    }
    this.build(d, { project, image: pin.image, renderGids: gids, baseVolume: base.volume }, password);
    return { project, facts, runner, base, pin, old, dataExists };
  }

  /** every chosen folder exists below the base as a directory the container user can list (a helper that lstat's each component) */
  private async checkFolders(r: Runner, user: { uid: number; gid: number; groups: number[] }, volume: string, rels: string[]): Promise<void> {
    let a: Obj;
    try {
      a = await this.helper(r, user, 'check', ['folders', JSON.stringify(rels)], [{ kind: 'base', volume }]);
    } catch (e) {
      guardFirst(e);
      // a base that cannot be mounted or read at all (an unmounted share) is the base, not a folder
      const code = codeOf(e, 'base_missing');
      return fail(FOLDER_CODES.includes(code) ? code : 'base_missing');
    }
    const found = new Map<string, unknown>();
    if (Array.isArray(a.folders)) for (const x of a.folders) if (isObj(x) && typeof x.rel === 'string') found.set(x.rel, x.code);
    for (const rel of rels) {
      const code = found.get(rel);
      if (code !== 'ok') fail(isMediaError(code) && FOLDER_CODES.includes(code) ? code : 'folder_missing');
    }
  }

  /** GPU `dri`: the distinct gids of the host's render nodes, read through the helper each time (a host update can change them) */
  private async renderGids(r: Runner, d: DesiredSpec): Promise<number[]> {
    if (d.gpu !== 'dri') return [];
    let a: Obj;
    try { a = await this.helper(r, userOf(d), 'gpu', [], [{ kind: 'dri' }, { kind: 'drm' }]); } catch (e) { guardFirst(e); return fail('gpu_missing'); }
    const nodes = renderNodes(a);
    if (nodes.length === 0) fail('gpu_missing');
    return [...new Set(nodes.map((n) => n.gid))];
  }

  /**
   * the container under the real name: none, ours (labels of this project and guard-clean), else `name_taken` (never touched) or
   * `managed_tampered`. A leftover `-old` (an interrupted recreate, the supervisor's to settle) blocks a deploy as `name_taken`.
   */
  private async existing(project: string, gpu: Gpu | undefined): Promise<Existing | null> {
    const n = names(project);
    if (await this.engine.inspectContainer(n.old)) fail('name_taken');
    const i = await this.engine.inspectContainer(n.container);
    if (!i) return null;
    const found = this.labelled(i, project) ?? fail('name_taken');
    await this.guardInspect(i, project, gpu);
    return found;
  }

  /** a container with both of our labels (managed media server, this project); null for anything else */
  private labelled(i: Obj, project: string): Existing | null {
    const l = labelsOf(i);
    if (l['friendflix.managed'] !== 'mediaserver' || l['friendflix.project'] !== project) return null;
    return { id: String(i.Id), kind: KINDS.find((k) => k === l['friendflix.kind']) ?? null, running: isObj(i.State) && i.State.Running === true };
  }

  /** the inspect guard with the user the container runs as and the image's own facts; any refusal is `managed_tampered` */
  private async guardInspect(i: Obj, project: string, gpu: Gpu | undefined): Promise<void> {
    const user = /^([0-9]{1,5}):([0-9]{1,5})$/.exec(isObj(i.Config) && typeof i.Config.User === 'string' ? i.Config.User : '') ?? fail('managed_tampered');
    const img = typeof i.Image === 'string' ? await this.engine.inspectImage(i.Image).catch(() => null) : null;
    try {
      assertManagedInspect(i, {
        project, kind: KINDS.find((k) => k === labelsOf(i)['friendflix.kind']) ?? fail('managed_tampered'), uid: Number(user[1]), gid: Number(user[2]),
        repo: this.d.repo, ...(gpu ? { gpu } : {}), image: { env: img?.env ?? [], entrypoint: img?.entrypoint ?? null, cmd: img?.cmd ?? null, volumes: img?.volumes ?? [] },
      });
    } catch (e) {
      if (e instanceof TemplateViolation) fail('managed_tampered');
      throw e;
    }
  }

  /** the create body from the template, checked by the guard (a refusal throws TemplateViolation) */
  private build(d: DesiredSpec, f: TemplateFacts, password: string | undefined): CreateRequest {
    const req = containerSpec(d, f, password !== undefined ? { password } : {});
    assertManaged(req.body, { project: f.project, kind: d.kind, uid: d.uid, gid: d.gid, repo: this.d.repo });
    return req;
  }

  /**
   * Ferrofin: cosign on the pinned image and its upstream label; Jellyfin: the pulled image carries the pinned digest, the upstream
   * is the pin's tag. Returns the upstream version.
   */
  private async verifyImage(pin: Pin): Promise<string> {
    if (pin.kind === 'ferrofin' && !(await this.d.verify(pin.image))) fail('verify_failed');
    const img = (await this.engine.inspectImage(pin.image)) ?? fail('image_missing');
    if (pin.kind === 'ferrofin') {
      const up = img.labels[FERROFIN_UPSTREAM_LABEL];
      return typeof up === 'string' && UPSTREAM_RE.test(up) ? up : fail('verify_failed');
    }
    const ok = img.repoDigests.some((r) => {
      const at = r.lastIndexOf('@');
      return at > 0 && JELLYFIN_REPO_RE.test(r.slice(0, at)) && r.slice(at + 1) === pin.digest;
    });
    if (!ok || !pin.upstream || !UPSTREAM_RE.test(pin.upstream)) fail('verify_failed');
    return pin.upstream!;
  }

  /** render gids re-read, the body built and guarded, volumes ensured, the old container stopped and renamed aside, the new one created */
  private async create(c: Ctx, d: DesiredSpec, password: string | undefined, t: Changes): Promise<{ id: string; specHash: string }> {
    const gids = await this.renderGids(c.runner, d);
    const req = this.build(d, { project: c.project, image: c.pin.image, renderGids: gids, baseVolume: c.base.volume }, password);
    await this.ensureVolumes(c, d);
    const n = names(c.project);
    if (c.old) {
      if (!t.stopped) { await this.engine.stop(c.old.id); t.stopped = true; }
      await this.engine.rename(c.old.id, n.old);
      t.renamed = true;
    }
    const id = await this.engine.create(req);
    t.newId = id;
    if (d.egress) await this.engine.connect(c.facts.egressNetwork ?? fail('no_network'), id);
    this.u.log.add('media server created');
    return { id, specHash: String((req.body.Labels as Obj)['friendflix.spec']) };
  }

  /** the base volume, and the kind's data and cache volumes (a fresh one seeded when the user is not the image's owner) */
  private async ensureVolumes(c: Ctx, d: DesiredSpec): Promise<void> {
    if (!(await this.engine.inspectVolume(c.base.volume))) await this.engine.createVolume(volumeSpec(c.project, 'base', { path: c.base.path }));
    for (const which of ['data', 'cache'] as const) {
      const v = volumeSpec(c.project, which, { kind: d.kind });
      if (await this.engine.inspectVolume(v.Name)) continue;
      await this.engine.createVolume(v);
      if (!needsSeed(d.kind, d.uid, d.gid)) continue;
      // created, never started: the create alone copies the seed directory's owner and mode into the empty volume
      const seed = seedSpec(d.kind, which, d, { project: c.project, image: c.pin.image, renderGids: [], baseVolume: c.base.volume });
      assertHelper(seed.body, { project: c.project, uid: d.uid, gid: d.gid, image: c.pin.image, verb: 'seed', kind: d.kind });
      const id = await this.engine.create(seed);
      await this.engine.remove(id, { volumes: true }).catch(() => undefined);
    }
  }

  /** Docker health `healthy` within the limit, or (an image without a healthcheck) running for 60 s */
  private async healthy(id: string): Promise<boolean> {
    const end = this.d.now() + this.healthMs;
    let since: number | null = null;
    for (;;) {
      const i = await this.engine.inspectContainer(id).catch(() => null);
      const st = isObj(i?.State) ? i.State : {};
      const health = isObj(st.Health) ? st.Health.Status : undefined;
      if (health === 'healthy') return true;
      if (health === undefined && st.Running === true) {
        since ??= this.d.now();
        if (this.d.now() - since >= RUNNING_MS) return true;
      } else if (health === undefined) {
        since = null;
      }
      if (this.d.now() >= end) return false;
      await this.sleep(this.intervalMs);
    }
  }

  /**
   * After a failure: the new container goes; the snapshot is restored when the new one ran on the data; the old one is renamed back
   * and started when it should run. A first create without an old container is removed again (nothing is left half set up).
   */
  private async undo(job: Job, c: Ctx, t: Changes, wasRunning: boolean): Promise<void> {
    if (!t.newId && !t.stopped) return;
    const m = this.media(job);
    const withOld = c.old !== null;
    if (withOld) { m.step = 'rollback'; m.steps.rollback = 'running'; this.u.persistNow(); this.u.log.add('media rollback'); }
    try {
      if (t.newId) {
        await this.engine.stop(t.newId).catch(() => undefined);
        await this.engine.remove(t.newId, { force: true });
      }
      if (t.snapshot && t.started) await this.restoreSnapshot(t.snapshot.id, t.snapshot.kind);
      if (c.old && t.renamed) await this.engine.rename(c.old.id, names(c.project).container);
      if (c.old && t.stopped && wasRunning) await this.engine.start(c.old.id);
      if (withOld) { m.steps.rollback = 'ok'; this.u.log.add('media server restored to the previous container'); }
    } catch {
      if (withOld) { m.steps.rollback = 'failed'; this.u.log.add('media rollback failed'); }
    }
    this.u.persistNow();
  }

  /** after a successful deploy: the base volume the old container used (only ours) */
  private async dropPreviousBase(project: string, current: string): Promise<void> {
    const prev = this.u.mediaState().base?.previousVolume;
    if (!prev || prev === current) return;
    try {
      const v = await this.engine.inspectVolume(prev);
      if (v && v.labels['friendflix.managed'] === 'mediaserver-base' && v.labels['friendflix.project'] === project) await this.engine.removeVolume(prev);
    } catch {
      return; // still in use or not answering: the next successful deploy tries again
    }
    this.u.updateMedia((m) => { if (m.base?.previousVolume === prev) m.base.previousVolume = null; });
  }

  /**
   * a backup of the data volume as the recorded container has it (kind, upstream), tagged `auto`: helper `backup` with the data
   * volume read-only and the backup volume writable. With a job it runs as that job's `snapshot` step. Task 8 adds retention.
   */
  async snapshot(job: Job | null, tag: 'auto'): Promise<BackupMeta> {
    const run = async (): Promise<BackupMeta> => {
      const m = this.u.mediaState();
      const c = m.container ?? fail('snapshot_failed');
      const { project, runner } = await this.ready();
      const at = new Date(this.d.now());
      const id = snapshotId(c.kind, c.upstream, at);
      if (!BACKUP_ID_RE.test(id)) fail('snapshot_failed');
      let a: Obj;
      try {
        a = await this.helper(runner, userOf(m.desired), 'backup', [id, '0', c.kind, c.upstream],
          [{ kind: 'data', volume: names(project).data(c.kind), rw: false }, { kind: 'backup', rw: true }], BACKUP_HELPER_MS);
      } catch (e) {
        guardFirst(e);
        return fail('snapshot_failed');
      }
      const size = typeof a.size === 'number' && Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : fail('snapshot_failed');
      const meta: BackupMeta = { id, kind: c.kind, upstream: c.upstream, at: at.toISOString(), tag, size };
      // an id that exists already is replaced (Controller's call 14)
      this.u.updateMedia((s) => { s.backups = [...s.backups.filter((b) => b.id !== id), meta]; });
      return meta;
    };
    return job ? this.step(job, 'snapshot', run) : run();
  }

  /** helper `restore`: the data volume read-write, the backup volume read-only; any failure is `restore_failed` */
  async restoreSnapshot(id: string, kind: Kind): Promise<void> {
    if (!BACKUP_ID_RE.test(id)) fail('restore_failed');
    let a: Obj;
    try {
      const { project, runner } = await this.ready();
      a = await this.helper(runner, userOf(this.u.mediaState().desired), 'restore', [id, kind],
        [{ kind: 'data', volume: names(project).data(kind), rw: true }, { kind: 'backup', rw: false }], BACKUP_HELPER_MS);
    } catch (e) {
      guardFirst(e);
      return fail('restore_failed');
    }
    if (a.ok !== true) fail('restore_failed');
  }

  /** update: the current desired with the current pin; a server stopped on purpose stays as it is (Controller's call 17) */
  private async update(job: Job): Promise<void> {
    const d = this.desired();
    if (!d.run) { this.u.log.add('media server stopped: update skipped'); return; }
    await this.deploy(job, specOf(d), { reason: 'update' });
  }

  /** the container under the real name when it carries our labels (guard-clean when `guarded`); null when there is none */
  private async ours(guarded: boolean): Promise<{ project: string; c: Existing } | null> {
    const facts = await this.d.facts();
    const project = facts.project ?? fail('no_project');
    const i = await this.engine.inspectContainer(names(project).container);
    if (!i) return null;
    const c = this.labelled(i, project) ?? fail('name_taken');
    if (guarded) await this.guardInspect(i, project, this.u.mediaState().desired?.gpu);
    return { project, c };
  }

  /** start / restart: `desired.run = true`, then the engine; a missing container is recreated from the desired spec */
  private async run(job: Job, restart: boolean): Promise<void> {
    this.u.updateMedia((m) => { if (m.desired) m.desired.run = true; });
    const found = await this.step(job, 'check', () => this.ours(true));
    if (!found) return this.deploy(job, specOf(this.desired()), { reason: 'recover' });
    const id = found.c.id;
    await this.step(job, 'start', async () => {
      if (restart) await this.engine.stop(id);
      await this.engine.start(id);
    });
    await this.step(job, 'health', async () => { if (!(await this.healthy(id))) fail('unhealthy'); });
  }

  /** stop: `desired.run = false`, then the engine (only narrows: a container with our labels is stopped even when tampered) */
  private async stop(job: Job): Promise<void> {
    this.u.updateMedia((m) => { if (m.desired) m.desired.run = false; });
    const found = await this.step(job, 'check', () => this.ours(false));
    if (found) await this.step(job, 'start', () => this.engine.stop(found.c.id));
  }

  /**
   * remove: stops and removes the container (and a leftover `-old`) when it carries our labels, guard-clean or not (removing only
   * narrows); `data` also removes that kind's data and cache volumes (only ours). Base and backup volumes stay.
   */
  private async remove(job: Job, data: boolean): Promise<void> {
    const found = await this.step(job, 'check', async () => {
      const facts = await this.d.facts();
      const project = facts.project ?? fail('no_project');
      const n = names(project);
      const out: Existing[] = [];
      for (const name of [n.container, n.old]) {
        const i = await this.engine.inspectContainer(name);
        if (i) out.push(this.labelled(i, project) ?? fail('name_taken'));
      }
      return { project, containers: out };
    });
    const m = this.u.mediaState();
    const kinds = new Set<Kind>([...found.containers.flatMap((c) => (c.kind ? [c.kind] : [])), ...(m.desired ? [m.desired.kind] : []), ...(m.container ? [m.container.kind] : [])]);
    try {
      for (const c of found.containers) {
        await this.engine.stop(c.id);
        await this.engine.remove(c.id);
      }
      if (data) {
        const n = names(found.project);
        for (const k of kinds) {
          for (const [name, label] of [[n.data(k), 'mediaserver-data'], [n.cache(k), 'mediaserver-cache']] as const) {
            const v = await this.engine.inspectVolume(name);
            if (v?.labels['friendflix.managed'] === label && v.labels['friendflix.project'] === found.project) await this.engine.removeVolume(name);
          }
        }
      }
    } catch {
      fail('remove_failed');
    }
    this.u.updateMedia((s) => { s.desired = null; s.container = null; s.tampered = false; s.lastError = null; });
    this.u.log.add('media server removed');
  }

  /**
   * probe.sh tests 1 and 2 in throw-away containers of the kind's pinned image (pulled and verified first) with the GPU passed in,
   * no network; the result per test in `media.hdr`
   */
  private async hdr(job: Job, kind: Kind): Promise<void> {
    const c = await this.step(job, 'check', async () => {
      const { facts, project, runner } = await this.ready();
      if (kind === 'ferrofin' && facts.arch !== 'amd64') fail('arch_unsupported');
      const read = await this.d.pins();
      if ('error' in read) return fail(read.error === 'verify_failed' ? 'verify_failed' : 'image_missing');
      const pin = read.pins[kind] ?? fail(read.invalid.includes(kind) ? 'pin_invalid' : 'image_missing');
      const user = userOf(this.u.mediaState().desired);
      let a: Obj;
      try { a = await this.helper(runner, user, 'gpu', [], [{ kind: 'dri' }, { kind: 'drm' }]); } catch (e) { guardFirst(e); return fail('gpu_missing'); }
      const nodes = renderNodes(a);
      const node = nodes.find((x) => x.vendor === 'intel') ?? nodes[0] ?? fail('gpu_missing');
      return { project, pin, user, node: node.node, gids: [...new Set(nodes.map((x) => x.gid))] };
    });
    await this.step(job, 'pull', () => this.engine.pull(c.pin.image));
    await this.step(job, 'verify', () => this.verifyImage(c.pin));
    const result = await this.step(job, 'start', async () => {
      const o = { project: c.project, kind, image: c.pin.image, uid: c.user.uid, gid: c.user.gid, renderGids: c.gids, node: c.node };
      const opencl = await runHdr(this.engine, 1, o, HELPER_MS);
      const qsv = await runHdr(this.engine, 2, o, HELPER_MS);
      return { opencl, qsv };
    });
    this.u.updateMedia((m) => { m.hdr = { kind, at: new Date(this.d.now()).toISOString(), ...result }; });
  }
}
