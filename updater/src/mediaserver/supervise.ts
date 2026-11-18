// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MediaState } from '../state.js';
import type { EngineFacts } from './facts.js';
import { cleanupHelpers } from './helpers.js';
import type { JobDeps, MediaJobs } from './jobs.js';
import { older } from './backup.js';
import { parseMediaBody } from './parse.js';
import { checkBasePath } from './paths.js';
import { names } from './template.js';
import { KINDS, type Folder, type Gpu, type Kind, type MediaError } from './types.js';

/**
 * Minimal supervision of the managed media server (spec "Lifecycle", Controller's call: never fighting the owner). Every 60 s while
 * no job runs: a recreate interrupted by a restart is settled, a labelled container of this project is adopted when the state lost
 * it (or flagged as tampered when it fails the guard), and a container that should run but is missing is recreated (after a failed
 * recover, again every 10 min; the recover checks the base, folders and GPU itself). No helper runs in normal operation: a
 * running server is only inspected. A container that stopped although it should run is left alone (Docker's restart policy handles
 * a crash) and its reason checked once per stop (base, folders, GPU), at most every 10 min (a crash loop); once it runs again those
 * host codes go. A server the admin
 * stopped (`desired.run = false`) is never checked. It acts only on containers with both of our labels, never removes a volume and
 * never starts or checks a container after a failed rollback (its data may be half restored).
 */

export type TickResult = 'busy' | 'idle' | 'recover' | 'aside' | 'tampered';

/** a server that should run but is missing is recreated again this long after a failed recover (spec "Times": 10 min) */
const RETRY_MS = 10 * 60_000;
/** the least time between two stop checks: a crash loop stops anew every round */
const STOP_CHECK_MS = 10 * 60_000;
/** what the stop check reports; only these go when the container runs again */
const HOST_CODES: readonly MediaError[] = ['base_missing', 'folder_missing', 'gpu_missing', 'nvidia_missing'];
/** Docker states of a container that stopped (`restarting`: the restart policy brings it back after a stop) */
const STOPPED = ['exited', 'dead', 'restarting'];
const FERROFIN_UPSTREAM_LABEL = 'io.github.letsmanu.friendflix.mediaserver.ferrofin';
const OCI_VERSION_LABEL = 'org.opencontainers.image.version';
const UPSTREAM_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const USER_RE = /^([0-9]{1,5}):([0-9]{1,5})$/;
const MEDIA_TARGET_RE = /^\/media\//;
/** what an adopted container's upstream is when nothing says it (never treated as older: no downgrade refusal, a snapshot on change) */
const UNKNOWN_UPSTREAM = 'unknown';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Obj => (isObj(v) ? v : {});
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const labelsOf = (i: Obj): Obj => objOf(objOf(i.Config).Labels);

/** the GPU choice a container was built with: an NVIDIA device request, the render devices, or none */
function gpuOf(i: Obj): Gpu {
  const h = objOf(i.HostConfig);
  if (listOf(h.DeviceRequests).some((r) => isObj(r) && r.Driver === 'nvidia')) return 'nvidia';
  if (listOf(h.Devices).some((d) => isObj(d) && d.PathOnHost === '/dev/dri')) return 'dri';
  return 'off';
}

/** Docker health `healthy`, or running without a healthcheck (no 60-s wait here: the next round looks again) */
function healthyNow(i: Obj): boolean {
  const st = objOf(i.State);
  const health = isObj(st.Health) ? st.Health.Status : undefined;
  return st.Running === true && (health === undefined || health === 'healthy');
}

type Owned = 'missing' | 'foreign' | 'tampered' | 'ok' | 'busy' | 'unknown';

export class Supervisor {
  /** when the last recover started (the first retry of a failed one is due one interval after the start) */
  private lastRecover: number;
  /** the stop the last stop check ran for (container id and State.FinishedAt) and when; in memory only */
  private checkedStop: { key: string; at: number } | null = null;

  constructor(private readonly d: JobDeps & { jobs: MediaJobs }) {
    this.lastRecover = d.now();
  }

  private get u() { return this.d.updater; }
  private get engine() { return this.d.engine; }
  private get jobs() { return this.d.jobs; }

  /** a round (or the startup) runs: another one meanwhile is skipped, never run on top of it */
  private running = false;

  private async alone<T>(skipped: T, fn: () => Promise<T>): Promise<T> {
    if (this.running) return skipped;
    this.running = true;
    try { return await fn(); } finally { this.running = false; }
  }

  /** once at start: leftover helpers go, an interrupted recreate is settled, a labelled container is adopted */
  startup(): Promise<void> {
    return this.alone(undefined, () => this.boot());
  }

  /** one supervision round (server.ts runs it every 60 s while no job runs); 'busy' while a job or another round runs */
  tick(): Promise<TickResult> {
    return this.alone<TickResult>('busy', () => this.round());
  }

  private async boot(): Promise<void> {
    const facts = await this.d.facts().catch(() => null);
    const project = facts?.project;
    if (!facts || !project) return;
    await cleanupHelpers(this.engine, project).catch(() => 0);
    if (this.u.busy) return;
    if ((await this.recoverAside(project)) !== 'none') return;
    await this.own(project, facts);
  }

  private async round(): Promise<TickResult> {
    if (this.u.busy) return 'busy';
    const facts = await this.d.facts().catch(() => null);
    const project = facts?.project;
    if (!facts || !project) return 'idle';
    const aside = await this.recoverAside(project);
    if (aside !== 'none') return aside;
    const { owned, i } = await this.own(project, facts);
    if (owned === 'tampered' || owned === 'busy' || owned === 'unknown') return owned === 'unknown' ? 'idle' : owned;
    if (owned === 'ok' && i) await this.watchStop(i);

    // a container that should run is missing: recreated, unless the last rollback failed (the data may be half restored: Admin
    // decides); after a failed recover (lastError set) again every 10 min, the recover's own check records what is still missing
    const m = this.u.mediaState();
    if (owned === 'missing' && m.desired?.run && !this.held()) {
      if (m.lastError !== null && this.d.now() - this.lastRecover < RETRY_MS) return 'idle';
      if (this.u.busy) return 'busy';
      const started = this.jobs.recover();
      if (!started.ok) return 'busy';
      this.lastRecover = this.d.now();
      return 'recover';
    }
    return 'idle';
  }

  /** for the status view: compared with the render gids the last deploy recorded, never through a helper */
  templateState(): Promise<'current' | 'update_pending' | null> {
    return this.jobs.templateState('recorded');
  }

  /**
   * our guard-clean container under the real name: running, the host codes of a stop check go (any other code stays); stopped
   * although it should run (no job, no failed rollback), the base, folders and GPU are checked once per stop (its id and
   * FinishedAt), at most every 10 min (a stop meanwhile is checked once that time passed), and a code found becomes lastError
   * (nothing found: lastError stays)
   */
  private async watchStop(i: Obj): Promise<void> {
    const st = objOf(i.State);
    const status = typeof st.Status === 'string' ? st.Status : '';
    const m = this.u.mediaState();
    if (status === 'running') {
      if (m.lastError !== null && HOST_CODES.includes(m.lastError)) this.setError(null);
      return;
    }
    if (!STOPPED.includes(status) || !m.desired?.run || this.held() || this.u.busy) return;
    const key = `${String(i.Id)}@${typeof st.FinishedAt === 'string' ? st.FinishedAt : ''}`;
    const last = this.checkedStop;
    if (last && (last.key === key || this.d.now() - last.at < STOP_CHECK_MS)) return;
    // once per stop, also when the check cannot run (no helper every round)
    this.checkedStop = { key, at: this.d.now() };
    let code: MediaError | null;
    try { code = await this.jobs.hostCheck(); } catch { return; }
    if (code !== null) this.setError(code);
  }

  /** the last job's rollback failed: nothing is started on its own */
  private held(): boolean {
    return this.u.snapshot().lastJob?.media?.steps.rollback === 'failed';
  }

  /** the inspect guard with the recorded GPU choice (else the container's own); false = tampered */
  private async clean(i: Obj, project: string, gpu: Gpu): Promise<boolean> {
    try {
      await this.jobs.guardInspect(i, project, gpu);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A crash between "rename aside" and "remove the old one" leaves `<project>-mediaserver-old` (ours by labels). With no container
   * under the real name it gets the name back (started when it should run and is guard-clean, never after a failed rollback); next
   * to a guard-clean, healthy container it is removed (without volumes) and the new one recorded; otherwise both stay and deploys
   * see `name_taken`. 'none' = no `-old` of ours.
   */
  private async recoverAside(project: string): Promise<'none' | 'aside' | 'busy'> {
    const n = names(project);
    const old = await this.engine.inspectContainer(n.old).catch(() => null);
    const aside = old ? this.jobs.labelled(old, project) : null;
    if (!old || !aside) return 'none';
    try {
      const main = await this.engine.inspectContainer(n.container);
      const m = this.u.mediaState();
      if (!main) {
        if (this.u.busy) return 'busy';
        await this.engine.rename(aside.id, n.container);
        const held = this.held();
        if (m.desired?.run && !held && (await this.clean(old, project, m.desired.gpu))) await this.engine.start(aside.id);
        // after a failed rollback the job's own code stays
        if (!held) this.u.updateMedia((s) => { s.lastError = 'interrupted'; });
        this.u.log.add('media server renamed back after an interrupted recreate');
        return 'aside';
      }
      const current = this.jobs.labelled(main, project);
      if (current && healthyNow(main) && (await this.clean(main, project, m.desired?.gpu ?? gpuOf(main)))) {
        if (this.u.busy) return 'busy';
        await this.engine.remove(aside.id, { force: true });
        this.u.log.add('media server: the container left aside was removed');
        if (m.container?.id !== current.id) await this.adopt(project, main, m.desired?.run ?? true);
        return 'aside';
      }
    } catch {
      // not answering or refused: reported below, the next round looks again
    }
    this.setError('name_taken');
    return 'aside';
  }

  /**
   * the container under the real name: 'missing'; 'foreign' (not ours: never touched); 'tampered' (ours, refused by the guard:
   * never started or adopted); 'ok' (guard-clean, adopted when the state has no container)
   */
  private async own(project: string, facts: EngineFacts): Promise<{ owned: Owned; i?: Obj }> {
    let i: Obj | null;
    try { i = await this.engine.inspectContainer(names(project).container); } catch { return { owned: 'unknown' }; }
    if (!i) return { owned: 'missing' };
    if (!this.jobs.labelled(i, project)) return { owned: 'foreign' };
    const m = this.u.mediaState();
    if (!(await this.clean(i, project, m.desired?.gpu ?? gpuOf(i)))) {
      if (!m.tampered) {
        this.u.updateMedia((s) => { s.tampered = true; });
        this.u.log.add('media server container changed outside FriendFlix');
      }
      return { owned: 'tampered' };
    }
    if (m.tampered) this.u.updateMedia((s) => { s.tampered = false; });
    if (!m.container) {
      if (this.u.busy) return { owned: 'busy' };
      await this.adopt(project, i, m.desired?.run ?? objOf(i.State).Running === true, facts);
    }
    return { owned: 'ok', i };
  }

  /**
   * records a guard-clean container of ours: `container` from its inspect, `desired` rebuilt from it (kind label, base mounts →
   * folders, `User`, devices → GPU, `GroupAdd` without the render gids → media group, egress network, `TZ`), the base from its
   * volume's `device` option when the state has none. Nothing is recorded when a value cannot be told.
   */
  private async adopt(project: string, i: Obj, run: boolean, facts?: EngineFacts): Promise<boolean> {
    const c = objOf(i.Config);
    const h = objOf(i.HostConfig);
    const kind = KINDS.find((k) => k === labelsOf(i)['friendflix.kind']);
    const user = USER_RE.exec(typeof c.User === 'string' ? c.User : '');
    if (!kind || !user) return false;
    const uid = Number(user[1]);
    const gid = Number(user[2]);

    const media = listOf(h.Mounts).filter((x): x is Obj => isObj(x) && typeof x.Target === 'string' && MEDIA_TARGET_RE.test(x.Target));
    const folders: Folder[] = media.map((x) => ({ rel: String(objOf(x.VolumeOptions).Subpath ?? ''), target: String(x.Target) }));
    const baseVolume = media.length ? String(media[0]!.Source ?? '') : null;
    if (media.some((x) => x.Source !== baseVolume)) return false;

    const gpu = gpuOf(i);
    let render: number[] = [];
    if (gpu === 'dri') {
      try { render = await this.jobs.hostRenderGids({ uid, gid }); } catch { return false; }
    }
    const groupAdd = listOf(h.GroupAdd).map(Number);
    const extra = groupAdd.filter((g) => !render.includes(g));
    const egressNet = facts?.egressNetwork ?? names(project).egress;
    const egress = Object.keys(objOf(objOf(i.NetworkSettings).Networks)).includes(egressNet);
    const tz = listOf(c.Env).find((e): e is string => typeof e === 'string' && e.startsWith('TZ='))?.slice(3) ?? '';
    const parsed = parseMediaBody({ op: 'apply', spec: { kind, folders, uid, gid, gpu, mediaGid: extra.length === 1 ? extra[0] : null, egress, tz } });
    if (parsed?.op !== 'apply') return false;

    const image = typeof c.Image === 'string' ? c.Image : '';
    const digest = image.slice(image.lastIndexOf('@') + 1);
    const specHash = labelsOf(i)['friendflix.spec'];
    const id = String(i.Id);
    if (!HEX64_RE.test(id) || !DIGEST_RE.test(digest) || typeof specHash !== 'string' || !HEX64_RE.test(specHash)) return false;
    const upstream = await this.upstreamOf(kind, typeof i.Image === 'string' ? i.Image : image, digest);
    const base = baseVolume ? await this.baseOf(project, baseVolume) : null;

    this.u.updateMedia((s) => {
      s.container = { id, kind, digest, upstream, specHash };
      // the adopted server ran on that kind's data: its version is the data's unless a newer one is recorded
      const known = s.dataUpstream[kind];
      if (upstream !== UNKNOWN_UPSTREAM && (known === undefined || older(known, upstream))) s.dataUpstream[kind] = upstream;
      s.desired = { ...parsed.spec, run };
      // the render gids it was built with, for the status view's template comparison
      s.renderGids = gpu === 'dri' ? [...new Set(groupAdd.filter((g) => render.includes(g)))] : [];
      s.tampered = false;
      if (base) adoptBase(s, base, new Date(this.d.now()).toISOString());
    });
    this.u.log.add('media server adopted');
    return true;
  }

  /** Ferrofin: its image's upstream label; Jellyfin: the pin's tag when the digests match, else the image's OCI version */
  private async upstreamOf(kind: Kind, imageRef: string, digest: string): Promise<string> {
    const img = await this.engine.inspectImage(imageRef).catch(() => null);
    let up: string | undefined = img?.labels[kind === 'ferrofin' ? FERROFIN_UPSTREAM_LABEL : OCI_VERSION_LABEL];
    if (kind === 'jellyfin') {
      const read = await this.d.pins().catch(() => null);
      const pin = read && !('error' in read) ? read.pins.jellyfin : undefined;
      if (pin?.digest === digest && pin.upstream) up = pin.upstream;
    }
    return typeof up === 'string' && UPSTREAM_RE.test(up) ? up : UNKNOWN_UPSTREAM;
  }

  /** the base folder behind a base volume of ours (its `device` option), when its name is the one the template derives from it */
  private async baseOf(project: string, volume: string): Promise<{ path: string; volume: string } | null> {
    const v = await this.engine.inspectVolume(volume).catch(() => null);
    const path = v?.options.device;
    if (!v || v.labels['friendflix.managed'] !== 'mediaserver-base' || v.labels['friendflix.project'] !== project || typeof path !== 'string') return null;
    if (checkBasePath(path, { dockerRoot: null, stackDir: null }) !== null || names(project).base(path) !== volume) return null;
    return { path, volume };
  }

  /** lastError, written only when it changes */
  private setError(code: MediaError | null): void {
    if (this.u.mediaState().lastError !== code) this.u.updateMedia((s) => { s.lastError = code; });
  }
}

/** the adopted container's base: the state's own when it has none; a different one becomes the volume the container still uses */
function adoptBase(s: MediaState, b: { path: string; volume: string }, at: string): void {
  if (!s.base) s.base = { path: b.path, volume: b.volume, confirmedAt: at, previousVolume: null };
  else if (s.base.volume !== b.volume) s.base.previousVolume = b.volume;
}
