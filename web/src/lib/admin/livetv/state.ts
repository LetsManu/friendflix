// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV, the enable card and the off dialog (spec §4): the answer of GET /api/admin/livetv/state (backend/src/livetv/
 * adminRoutes.ts) and the pure decisions the page makes from it.
 */
import type { UpdaterJob } from '../updater';
import type { AdminSummary } from '../summary';

/** the updater's own state of the optional service; `stop_failed` = a job turned it off but could not stop the container */
export type LivetvUpdaterState = 'absent' | 'disabled' | 'enabled' | 'stop_failed';
/** how the speed measurement started on enabling went (null: none) */
export type EnableBenchmark = 'started' | 'busy' | 'running' | 'no_user' | 'unsupported' | 'error';
export interface GpuAdvice { level: 'warn' | 'info' | 'ok'; key: 'needsOverlay' | 'needsRenderGid' | 'needsNvidia' | 'cpuOnly' | 'both'; driver?: string }
/** an updater job: the livetv ones carry action livetv-enable / livetv-disable / livetv-remove */
export type LivetvJob = Omit<UpdaterJob, 'action'> & { action: string };

export interface LivetvAdminState {
  installed: boolean; reachable: boolean; version: string | null;
  /** what the admin asked for (a refused request leaves it as it was) */
  wanted: boolean;
  /** LIVETV_OFFER_HIDDEN: true hides the optional entry */
  offerHidden: boolean;
  updater: {
    available: boolean; stack: 'own' | 'foreign' | null; job: LivetvJob | null;
    /** null = an updater from before livetv */
    livetv: { state: LivetvUpdaterState; container: 'running' | 'exited' | null; error: string | null } | null;
  };
  envLine: string;
  benchmark: EnableBenchmark | null;
  gpu: { jellyfin: string | null; livetv: { driver: string | null; devices: number } | null; /** null = no advice */ advice: GpuAdvice | null };
}

export type EnableMode = 'updater' | 'env' | 'portainer';
/** how this install can turn Live TV on: the updater (own stack), by hand in Portainer, or by the .env line */
export function enableMode(s: LivetvAdminState): EnableMode {
  if (s.updater.available && s.updater.stack === 'own') return 'updater';
  if (s.updater.stack === 'foreign') return 'portainer';
  return 'env';
}

/** the admin nav shows the entry while installed, or while the optional offer is not hidden (no summary yet: not yet) */
export function navShown(s: AdminSummary | null): boolean {
  return s ? s.livetv.installed || !s.livetv.offerHidden : false;
}

export const jobRunning = (s: LivetvAdminState): boolean => s.updater.job?.state === 'running';
/** the last job when it is one of livetv's (an update's job says nothing about Live TV) */
export const livetvJob = (s: LivetvAdminState): LivetvJob | null => (s.updater.job?.action.startsWith('livetv-') ? s.updater.job : null);

export type Phase = 'area' | 'working' | 'settling' | 'wantedDown' | 'offer';
/**
 * What the page shows: the area while installed; the job's steps while one runs; "checking" for a moment after a job
 * ended and detection has not caught up (`settling`); "turned on but not running" (wanted, nothing detected); else the offer.
 */
export function phase(s: LivetvAdminState, settling: boolean): Phase {
  if (s.installed) return 'area';
  if (jobRunning(s)) return 'working';
  if (settling) return 'settling';
  // the backend keeps `wanted` once it accepted an enable, even when the job then failed or was rolled back: that is not "turned on"
  const j = livetvJob(s);
  const failedEnable = j?.action === 'livetv-enable' && (j.state === 'failed' || j.state === 'rolled_back');
  if (s.wanted && !failedEnable) return 'wantedDown';
  return 'offer';
}

const ERRORS = ['pull_failed', 'verify_failed', 'restart_failed', 'unhealthy', 'unexpected_image', 'config_mismatch', 'compose_config', 'remove_failed', 'rollback_failed', 'no_updater', 'foreign_stack', 'busy'] as const;
export type ErrorKey = (typeof ERRORS)[number] | 'generic';
/** the message key (adminLive.err.<key>) of an updater / route code; an unknown code is "generic", never shown raw */
export function errorKey(code: string | null | undefined): ErrorKey {
  return (ERRORS as readonly string[]).includes(code ?? '') ? (code as ErrorKey) : 'generic';
}

/** adminLive.gpu.<key> of an advice; null = no advice (nothing is shown) */
export function gpuKey(a: GpuAdvice | null): 'needsOverlay' | 'needsRenderGid' | 'needsNvidia' | 'cpuOnly' | 'both' | 'bothPlain' | null {
  if (!a) return null;
  return a.key === 'both' && !a.driver ? 'bothPlain' : a.key;
}

/** the steps worth listing for a livetv job: the ones that ran or will (an enable has no skipped rows, a disable only "restart") */
export function livetvSteps(j: LivetvJob): Array<keyof LivetvJob['steps']> {
  const order = ['pull', 'verify', 'restart', 'health', 'rollback'] as const;
  return order.filter((k) => j.steps[k] !== 'skipped' && (k !== 'rollback' || j.steps[k] !== 'pending'));
}

/** polling every 3 s while a job runs (spec §4.5) */
export const POLL_MS = 3_000;
/** how long after a job ended the page keeps asking before it says "turned on but not running" */
export const SETTLE_MS = 30_000;
