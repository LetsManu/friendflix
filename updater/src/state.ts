// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMediaBody } from './mediaserver/parse.js';
import { checkBasePath } from './mediaserver/paths.js';
import { BACKUP_ID_RE, KINDS, MEDIA_ERRORS, MEDIA_JOB_ACTIONS, MEDIA_STEPS, type BackupMeta, type BackupTag, type Desired, type HdrResult, type Kind, type MediaError, type MediaJobAction, type MediaStep } from './mediaserver/types.js';
import { CHANNELS, SHA_TAG_RE, VERSION_RE, isTag, type Channel } from './policy.js';

export type StepName = 'pull' | 'verify' | 'restart' | 'health' | 'rollback';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type JobAction = 'update' | 'rollback' | 'self-update' | 'livetv-enable' | 'livetv-disable' | 'livetv-remove' | MediaJobAction;
const JOB_ACTIONS: readonly JobAction[] = ['update', 'rollback', 'self-update', 'livetv-enable', 'livetv-disable', 'livetv-remove', ...MEDIA_JOB_ACTIONS];
/**
 * the optional livetv service: enabled (the updater started it; it follows every update), disabled (container removed), absent
 * (never enabled or removed with its image), stop_failed (a job disabled it but could not stop its container: the next job
 * stops it again, it is never adopted as enabled meanwhile)
 */
export type LivetvState = 'enabled' | 'disabled' | 'absent' | 'stop_failed';
const LIVETV_STATES: readonly LivetvState[] = ['enabled', 'disabled', 'absent', 'stop_failed'];
/**
 * why an update or rollback disabled livetv on its own (livetv never holds back or rolls back the core services): its image
 * missing or not resolving as expected (pull_failed, unexpected_image, config_mismatch, compose_config), not verified, not
 * started, not healthy
 */
export const LIVETV_ERRORS = ['pull_failed', 'unexpected_image', 'config_mismatch', 'compose_config', 'compose_outdated', 'verify_failed', 'restart_failed', 'unhealthy'] as const;
export type LivetvError = (typeof LIVETV_ERRORS)[number];
/** succeeded_mediaserver_failed: the FriendFlix services are updated, the managed media server phase of the same job failed */
export type JobState = 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'succeeded_mediaserver_failed';
const JOB_STATES: readonly JobState[] = ['running', 'succeeded', 'failed', 'rolled_back', 'succeeded_mediaserver_failed'];

export interface Job {
  id: string;
  action: JobAction;
  state: JobState;
  /** where the job is (or stopped) */
  step: StepName | null;
  steps: Record<StepName, StepState>;
  /** tags: what ran before (sha-<7> when known) and the target */
  from: string | null;
  to: string;
  startedAt: string;
  finishedAt: string | null;
  /** a fixed error code (never command output) */
  error: string | null;
  /** the media server phase: null for a core job that did none */
  media: { step: MediaStep | null; steps: Record<MediaStep, StepState> } | null;
}

/**
 * Everything the updater keeps about the managed media server. `pending` carries only the sha256 of the base code (the code itself
 * is printed once to stdout and never stored).
 */
export interface MediaState {
  base: { path: string; volume: string; confirmedAt: string; previousVolume: string | null } | null;
  pending: { path: string; codeHash: string; expiresAt: string; failures: number } | null;
  desired: Desired | null;
  container: { id: string; kind: Kind; digest: string; upstream: string; specHash: string } | null;
  pinSource: string | null;
  backups: BackupMeta[];
  hdr: HdrResult | null;
  lastError: MediaError | null;
  tampered: boolean;
  /**
   * per kind, the upstream version its data volume was last brought to (a successful deploy or restore); kept while the container
   * goes (`remove` without data, a kind switch) and forgotten only with that kind's data volume. The never-down rule and the
   * deploy's snapshot read it, not the container.
   */
  dataUpstream: Partial<Record<Kind, string>>;
}

export const DEFAULT_MEDIA: MediaState = { base: null, pending: null, desired: null, container: null, pinSource: null, backups: [], hdr: null, lastError: null, tampered: false, dataUpstream: {} };

/** What survives a restart (state volume): the channel, what is installed and the previous build to roll back to. */
export interface State {
  channel: Channel;
  version: string | null;
  /** the tag the FriendFlix services were last brought up with by the updater */
  current: string | null;
  /** sha-<7> of the build that ran before the last successful update (the rollback target) */
  previous: string | null;
  /** the optional livetv service (spec §4.2) */
  livetv: LivetvState;
  /** set when a job disabled livetv by itself (its image missing or unverified for the target build, or it did not get healthy) */
  livetvError: LivetvError | null;
  /** the image id the livetv container last ran (recorded when it got healthy): `remove` deletes it even after a disable */
  livetvImage: string | null;
  lastJob: Job | null;
  /** the managed media server (spec "Lifecycle") */
  media: MediaState;
}

export const DEFAULT_STATE: State = { channel: 'stable', version: null, current: null, previous: null, livetv: 'absent', livetvError: null, livetvImage: null, lastJob: null, media: DEFAULT_MEDIA };

const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SYNTAX_ONLY = { dockerRoot: null, stackDir: null };
const BASE_VOLUME_RE = /^[a-z0-9][a-z0-9_-]{0,62}_mediaserver-base-([0-9a-f]{8})$/;
const UPSTREAM_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const BACKUP_TAGS: readonly BackupTag[] = ['manual', 'auto', 'upload'];
const PASS_FAIL = ['pass', 'fail'] as const;
const kindOf = (v: unknown): Kind | null => KINDS.find((k) => k === v) ?? null;

function sanitizeBase(raw: unknown): MediaState['base'] {
  if (!isObj(raw)) return null;
  const { path, volume, previousVolume } = raw;
  const confirmedAt = iso(raw.confirmedAt);
  if (typeof path !== 'string' || checkBasePath(path, SYNTAX_ONLY) !== null || typeof volume !== 'string' || !confirmedAt) return null;
  // the volume name is the one the template derives from the path
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  if (BASE_VOLUME_RE.exec(volume)?.[1] !== hash) return null;
  const prev = typeof previousVolume === 'string' && BASE_VOLUME_RE.test(previousVolume) ? previousVolume : null;
  return { path, volume, confirmedAt, previousVolume: prev };
}

function sanitizePending(raw: unknown): MediaState['pending'] {
  if (!isObj(raw)) return null;
  const { path, codeHash, failures } = raw;
  const expiresAt = iso(raw.expiresAt);
  if (typeof path !== 'string' || checkBasePath(path, SYNTAX_ONLY) !== null || typeof codeHash !== 'string' || !HEX64.test(codeHash) || !expiresAt) return null;
  if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0 || failures > 5) return null;
  return { path, codeHash, expiresAt, failures };
}

/** the same checks as a request body's spec (parseMediaBody), plus the run flag */
function sanitizeDesired(raw: unknown): Desired | null {
  if (!isObj(raw) || typeof raw.run !== 'boolean') return null;
  const { run, ...spec } = raw;
  const op = parseMediaBody({ op: 'apply', spec });
  return op?.op === 'apply' ? { ...op.spec, run } : null;
}

function sanitizeContainer(raw: unknown): MediaState['container'] {
  if (!isObj(raw)) return null;
  const kind = kindOf(raw.kind);
  const { id, digest, upstream, specHash } = raw;
  if (!kind || typeof id !== 'string' || !HEX64.test(id) || typeof digest !== 'string' || !DIGEST.test(digest)) return null;
  if (typeof upstream !== 'string' || !UPSTREAM_RE.test(upstream) || typeof specHash !== 'string' || !HEX64.test(specHash)) return null;
  return { id, kind, digest, upstream, specHash };
}

function sanitizeBackups(raw: unknown): BackupMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupMeta[] = [];
  for (const b of raw.slice(0, 50)) {
    if (!isObj(b)) continue;
    const kind = kindOf(b.kind);
    const at = iso(b.at);
    const tag = BACKUP_TAGS.find((t) => t === b.tag);
    if (typeof b.id !== 'string' || !BACKUP_ID_RE.test(b.id) || !kind || !at || !tag) continue;
    if (typeof b.upstream !== 'string' || !UPSTREAM_RE.test(b.upstream) || typeof b.size !== 'number' || !Number.isSafeInteger(b.size) || b.size < 0) continue;
    out.push({ id: b.id, kind, upstream: b.upstream, at, tag, size: b.size });
  }
  return out;
}

function sanitizeHdr(raw: unknown): HdrResult | null {
  if (!isObj(raw)) return null;
  const kind = kindOf(raw.kind);
  const at = iso(raw.at);
  const opencl = PASS_FAIL.find((v) => v === raw.opencl);
  const qsv = PASS_FAIL.find((v) => v === raw.qsv);
  return kind && at && opencl && qsv ? { kind, at, opencl, qsv } : null;
}

/** a state file from before `dataUpstream` knows it from the recorded container (the one running on that kind's data) */
function sanitizeDataUpstream(raw: unknown, container: MediaState['container']): MediaState['dataUpstream'] {
  if (!isObj(raw)) return container ? { [container.kind]: container.upstream } : {};
  const out: MediaState['dataUpstream'] = {};
  for (const k of KINDS) {
    const v = raw[k];
    if (typeof v === 'string' && UPSTREAM_RE.test(v)) out[k] = v;
  }
  return out;
}

/** every field of the media section is re-validated on its own; a wrong one falls back to its default, its siblings survive */
export function sanitizeMedia(raw: unknown): MediaState {
  const o = isObj(raw) ? raw : {};
  const container = sanitizeContainer(o.container);
  return {
    base: sanitizeBase(o.base),
    pending: sanitizePending(o.pending),
    desired: sanitizeDesired(o.desired),
    container,
    pinSource: typeof o.pinSource === 'string' && DIGEST.test(o.pinSource) ? o.pinSource : null,
    backups: sanitizeBackups(o.backups),
    hdr: sanitizeHdr(o.hdr),
    lastError: MEDIA_ERRORS.find((c) => c === o.lastError) ?? null,
    tampered: o.tampered === true,
    dataUpstream: sanitizeDataUpstream(o.dataUpstream, container),
  };
}


/** A malformed or tampered file falls back field by field to the defaults: nothing from it reaches compose unchecked. */
export function sanitize(raw: unknown): State {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const channel = typeof o.channel === 'string' && (CHANNELS as readonly string[]).includes(o.channel) ? (o.channel as Channel) : 'stable';
  const version = typeof o.version === 'string' && VERSION_RE.test(o.version) ? o.version : null;
  return {
    channel: channel === 'pinned' && !version ? 'stable' : channel,
    version,
    current: isTag(o.current) ? o.current : null,
    previous: typeof o.previous === 'string' && SHA_TAG_RE.test(o.previous) ? o.previous : null,
    livetv: LIVETV_STATES.find((v) => v === o.livetv) ?? 'absent',
    livetvError: LIVETV_ERRORS.find((v) => v === o.livetvError) ?? null,
    livetvImage: typeof o.livetvImage === 'string' && /^sha256:[0-9a-f]{64}$/.test(o.livetvImage) ? o.livetvImage : null,
    lastJob: sanitizeJob(o.lastJob),
    media: sanitizeMedia(o.media),
  };
}

function sanitizeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  if (typeof j.id !== 'string' || !/^[0-9a-f]{16}$/.test(j.id) || !isTag(j.to)) return null;
  if (!(JOB_ACTIONS as readonly string[]).includes(String(j.action)) || !(JOB_STATES as readonly string[]).includes(String(j.state))) return null;
  const steps = {} as Record<StepName, StepState>;
  for (const s of ['pull', 'verify', 'restart', 'health', 'rollback'] as const) {
    const v = (j.steps as Record<string, unknown> | undefined)?.[s];
    steps[s] = (['pending', 'running', 'ok', 'failed', 'skipped'] as const).find((x) => x === v) ?? 'pending';
  }
  return {
    id: j.id, action: j.action as JobAction, state: j.state as JobState,
    step: (['pull', 'verify', 'restart', 'health', 'rollback'] as const).find((x) => x === j.step) ?? null, steps,
    from: isTag(j.from) ? j.from : null, to: j.to, startedAt: iso(j.startedAt) ?? new Date(0).toISOString(), finishedAt: iso(j.finishedAt),
    error: typeof j.error === 'string' && /^[a-z_]{1,40}$/.test(j.error) ? j.error : null,
    media: sanitizeJobMedia(j.media),
  };
}

function sanitizeJobMedia(raw: unknown): Job['media'] {
  if (!isObj(raw)) return null;
  const steps = {} as Record<MediaStep, StepState>;
  for (const s of MEDIA_STEPS) steps[s] = (['pending', 'running', 'ok', 'failed', 'skipped'] as const).find((x) => x === (raw.steps as Record<string, unknown> | undefined)?.[s]) ?? 'pending';
  return { step: MEDIA_STEPS.find((x) => x === raw.step) ?? null, steps };
}

export interface StateStore { load(): State; save(s: State): void }

/** JSON file in the state volume, replaced atomically (write + rename). */
export function fileStore(dir: string): StateStore {
  const file = join(dir, 'state.json');
  return {
    load() {
      try { return sanitize(JSON.parse(readFileSync(file, 'utf8'))); } catch { return sanitize(null); }
    },
    save(s) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

export function memoryStore(init: State = DEFAULT_STATE): StateStore & { state: State } {
  const m = { state: structuredClone(init), load: () => structuredClone(m.state), save: (s: State) => { m.state = structuredClone(s); } };
  return m;
}
