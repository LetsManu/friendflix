// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS, SHA_TAG_RE, VERSION_RE, isTag, type Channel } from './policy.js';

export type StepName = 'pull' | 'verify' | 'restart' | 'health' | 'rollback';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type JobAction = 'update' | 'rollback' | 'self-update' | 'livetv-enable' | 'livetv-disable' | 'livetv-remove';
const JOB_ACTIONS: readonly JobAction[] = ['update', 'rollback', 'self-update', 'livetv-enable', 'livetv-disable', 'livetv-remove'];
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
export const LIVETV_ERRORS = ['pull_failed', 'unexpected_image', 'config_mismatch', 'compose_config', 'verify_failed', 'restart_failed', 'unhealthy'] as const;
export type LivetvError = (typeof LIVETV_ERRORS)[number];
export type JobState = 'running' | 'succeeded' | 'failed' | 'rolled_back';

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
}

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
}

export const DEFAULT_STATE: State = { channel: 'stable', version: null, current: null, previous: null, livetv: 'absent', livetvError: null, livetvImage: null, lastJob: null };

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
  };
}

function sanitizeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  if (typeof j.id !== 'string' || !/^[0-9a-f]{16}$/.test(j.id) || !isTag(j.to)) return null;
  if (!(JOB_ACTIONS as readonly string[]).includes(String(j.action)) || !['running', 'succeeded', 'failed', 'rolled_back'].includes(String(j.state))) return null;
  const steps = {} as Record<StepName, StepState>;
  for (const s of ['pull', 'verify', 'restart', 'health', 'rollback'] as const) {
    const v = (j.steps as Record<string, unknown> | undefined)?.[s];
    steps[s] = (['pending', 'running', 'ok', 'failed', 'skipped'] as const).find((x) => x === v) ?? 'pending';
  }
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    id: j.id, action: j.action as JobAction, state: j.state as JobState,
    step: (['pull', 'verify', 'restart', 'health', 'rollback'] as const).find((x) => x === j.step) ?? null, steps,
    from: isTag(j.from) ? j.from : null, to: j.to, startedAt: iso(j.startedAt) ?? new Date(0).toISOString(), finishedAt: iso(j.finishedAt),
    error: typeof j.error === 'string' && /^[a-z_]{1,40}$/.test(j.error) ? j.error : null,
  };
}

export interface StateStore { load(): State; save(s: State): void }

/** JSON file in the state volume, replaced atomically (write + rename). */
export function fileStore(dir: string): StateStore {
  const file = join(dir, 'state.json');
  return {
    load() {
      try { return sanitize(JSON.parse(readFileSync(file, 'utf8'))); } catch { return { ...DEFAULT_STATE }; }
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
