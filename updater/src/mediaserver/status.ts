// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Updater } from '../job.js';
import type { Engine } from './engine.js';
import type { EngineFacts } from './facts.js';
import type { MediaJobs } from './jobs.js';
import type { PinRead } from './pins.js';
import { names } from './template.js';
import { KINDS, type BackupMeta, type Desired, type Gpu, type HdrResult, type Kind, type MediaError } from './types.js';

/**
 * The `mediaserver` part of `GET /v1/status` (spec "Updater API", Controller's call 3). What Docker says (engine facts, the pins,
 * the container under the real name, the template state) is cached 10 s and read again once a job ended; what the updater keeps
 * (base, desired, error, backups, HDR result) is read on every call. Never a code, its hash, a password or a path below the base.
 */

export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | '';
export interface MediaContainerView {
  state: string; health: ContainerHealth; kind: Kind; image: { digest: string; upstream: string };
  template: 'current' | 'update_pending'; tampered: boolean; createdAt: string;
}
export interface MediaStatusView {
  available: boolean;
  reason: EngineFacts['reason'];
  base: { set: boolean; path: string | null; pending: boolean; expiresAt: string | null };
  desired: Omit<Desired, 'tz'> | null;
  container: MediaContainerView | null;
  pin: { image: string | null; upstream: string | null; changed: boolean } | null;
  pins: { ferrofin: boolean; jellyfin: boolean };
  engine: { api: string | null; logs: boolean; arch: string | null; nvidia: boolean };
  error: MediaError | null;
  backups: BackupMeta[];
  hdr: HdrResult | null;
}

export interface MediaStatusDeps {
  updater: Updater;
  engine: Pick<Engine, 'inspectContainer'>;
  jobs: Pick<MediaJobs, 'labelled' | 'guardInspect'>;
  facts(): Promise<EngineFacts>;
  pins(): Promise<PinRead>;
  /** Supervisor.templateState(): with the dri GPU it runs a helper, so it is cached longer (templateTtlMs) */
  templateState(): Promise<'current' | 'update_pending' | null>;
  now?(): number;
  ttlMs?: number;
  templateTtlMs?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Obj => (isObj(v) ? v : {});
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const HEALTH: readonly ContainerHealth[] = ['healthy', 'unhealthy', 'starting'];
/** an adopted container's upstream when nothing tells it (supervise.ts) */
const UNKNOWN_UPSTREAM = 'unknown';

/** the container under the real name as Docker shows it (one inspect, the guard only for one the state does not record) */
interface Seen { id: string; kind: Kind | null; state: string; health: ContainerHealth; createdAt: string; digest: string; clean: boolean | null }
interface Live { facts: EngineFacts | null; read: PinRead | null; seen: Seen | null; template: 'current' | 'update_pending' | null }

/** the GPU choice a container was built with (as supervise.ts reads it), for the guard of a container the state does not record */
function gpuOf(i: Obj): Gpu {
  const h = objOf(i.HostConfig);
  if (Array.isArray(h.DeviceRequests) && h.DeviceRequests.some((r) => isObj(r) && r.Driver === 'nvidia')) return 'nvidia';
  if (Array.isArray(h.Devices) && h.Devices.some((d) => isObj(d) && d.PathOnHost === '/dev/dri')) return 'dri';
  return 'off';
}

/** the desired spec in the status shape (spec "Updater API": without the time zone) */
const withoutTz = ({ tz: _tz, ...rest }: Desired): Omit<Desired, 'tz'> => rest;

function iso(v: unknown): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  // Docker always sets Created; a missing one reads as the epoch (the oldest possible)
  return new Date(Number.isNaN(t) ? 0 : t).toISOString();
}

export function mediaStatusView(d: MediaStatusDeps): () => Promise<MediaStatusView> {
  const now = d.now ?? Date.now;
  const ttl = d.ttlMs ?? 10_000;
  const templateTtl = d.templateTtlMs ?? 30_000;
  let live: { at: number; key: string; v: Live } | null = null;
  let template: { at: number; key: string; v: Live['template'] } | null = null;

  /** the last job and its state: a job that ended (any media job, an update with its media phase) invalidates both caches */
  const jobKey = (): string => {
    const j = d.updater.snapshot().lastJob;
    return j ? `${j.id}:${j.state}` : '';
  };

  async function templateState(key: string): Promise<Live['template']> {
    if (template && template.key === key && now() - template.at < templateTtl) return template.v;
    const v = await d.templateState().catch(() => null);
    template = { at: now(), key, v };
    return v;
  }

  async function seen(project: string): Promise<Seen | null> {
    const i = await d.engine.inspectContainer(names(project).container);
    if (!i) return null;
    const own = d.jobs.labelled(i, project);
    if (!own) return null;
    const st = objOf(i.State);
    const health = HEALTH.find((h) => h === objOf(st.Health).Status) ?? '';
    const ref = typeof objOf(i.Config).Image === 'string' ? String(objOf(i.Config).Image) : '';
    const tail = ref.slice(ref.lastIndexOf('@') + 1);
    const digest = DIGEST_RE.test(tail) ? tail : typeof i.Image === 'string' && DIGEST_RE.test(i.Image) ? i.Image : '';
    const m = d.updater.mediaState();
    let clean: boolean | null = null;
    if (m.container?.id !== own.id) {
      try { await d.jobs.guardInspect(i, project, m.desired?.gpu ?? gpuOf(i)); clean = true; } catch { clean = false; }
    }
    return { id: own.id, kind: own.kind, state: typeof st.Status === 'string' ? st.Status : '', health, createdAt: iso(i.Created), digest, clean };
  }

  /** one Docker read at a time: callers while it runs share it */
  let inflight: { key: string; p: Promise<Live> } | null = null;
  function read(key: string): Promise<Live> {
    if (live && live.key === key && now() - live.at < ttl) return Promise.resolve(live.v);
    if (inflight?.key === key) return inflight.p;
    const p = load(key).finally(() => { if (inflight?.p === p) inflight = null; });
    inflight = { key, p };
    return p;
  }

  async function load(key: string): Promise<Live> {
    const facts = await d.facts().catch(() => null);
    const project = facts?.project ?? null;
    const [r, s] = await Promise.all([
      d.pins().catch(() => null),
      project ? seen(project).catch(() => null) : Promise.resolve(null),
    ]);
    const m = d.updater.mediaState();
    const t = s && m.container?.id === s.id ? await templateState(key) : null;
    const v: Live = { facts, read: r, seen: s, template: t };
    live = { at: now(), key, v };
    return v;
  }

  return async () => {
    const v = await read(jobKey());
    const m = d.updater.mediaState();
    const f = v.facts;
    const pins = v.read && !('error' in v.read) ? v.read : null;

    let container: MediaContainerView | null = null;
    const s = v.seen;
    const adopted = s !== null && m.container?.id === s.id ? m.container : null;
    const kind = adopted?.kind ?? s?.kind ?? m.desired?.kind ?? null;
    if (s && kind) {
      container = {
        state: s.state, health: s.health, kind,
        image: adopted ? { digest: adopted.digest, upstream: adopted.upstream } : { digest: s.digest, upstream: UNKNOWN_UPSTREAM },
        template: v.template ?? 'current',
        // a container the state does not record: also tampered when it fails the guard (the supervisor never adopts it)
        tampered: m.tampered || (!adopted && s.clean === false),
        createdAt: s.createdAt,
      };
    }

    const pinKind = m.desired?.kind ?? m.container?.kind ?? null;
    const pin = pinKind ? pins?.pins[pinKind] : undefined;
    const pending = m.pending !== null && now() < Date.parse(m.pending.expiresAt);
    return {
      available: f !== null && f.reason === null,
      reason: f?.reason ?? null,
      base: { set: m.base !== null, path: m.base?.path ?? null, pending, expiresAt: pending ? m.pending!.expiresAt : null },
      desired: m.desired ? withoutTz(m.desired) : null,
      container,
      pin: pinKind ? {
        image: pin?.image ?? null, upstream: pin?.upstream ?? null,
        // the backend build changed since the pins were last read for a deploy (false while either is unknown)
        changed: pins !== null && m.pinSource !== null && pins.source !== m.pinSource,
      } : null,
      pins: Object.fromEntries(KINDS.map((k) => [k, pins?.pins[k] !== undefined])) as MediaStatusView['pins'],
      engine: { api: f?.api ?? null, logs: f?.logs ?? false, arch: f?.arch ?? null, nvidia: f?.nvidia ?? false },
      error: m.lastError,
      backups: m.backups,
      hdr: m.hdr,
    };
  };
}
