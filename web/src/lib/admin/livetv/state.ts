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
    /** an updater that answers but refuses the backend's signature (unauthorized) or answers garbage; null = none of that */
    error: 'unauthorized' | 'invalid_answer' | null;
    /** null = an updater from before livetv */
    livetv: { state: LivetvUpdaterState; container: 'running' | 'exited' | null; error: string | null } | null;
  };
  envLine: string;
  benchmark: EnableBenchmark | null;
  gpu: { jellyfin: string | null; livetv: { driver: string | null; devices: number } | null; /** null = no advice */ advice: GpuAdvice | null };
}

export type EnableMode = 'updater' | 'updaterOld' | 'updaterError' | 'env' | 'portainer';
/**
 * how this install can turn Live TV on: the updater (own stack), by hand in Portainer, or by the .env line; `updaterOld`: an own
 * stack whose updater is from before livetv (its status has no livetv), so the admin updates the updater first; `updaterError`:
 * an updater that refuses the signature or answers garbage (1b review M7)
 */
export function enableMode(s: LivetvAdminState): EnableMode {
  if (s.updater.available && s.updater.stack === 'own') return s.updater.livetv === null ? 'updaterOld' : 'updater';
  if (s.updater.stack === 'foreign') return 'portainer';
  // an updater is there but refuses or garbles: say that (Admin → Update fixes it), not the steps for an install without one
  if (s.updater.error) return 'updaterError';
  return 'env';
}

/** the admin nav shows the entry while installed, or while the optional offer is not hidden (no summary yet: not yet) */
export function navShown(s: AdminSummary | null): boolean {
  return s ? s.livetv.installed || !s.livetv.offerHidden : false;
}

export const jobRunning = (s: LivetvAdminState): boolean => s.updater.job?.state === 'running';
/** the last job when it is one of livetv's (an update's job says nothing about Live TV) */
export const livetvJob = (s: LivetvAdminState): LivetvJob | null => (s.updater.job?.action.startsWith('livetv-') ? s.updater.job : null);

/** a livetv job of the updater is running */
export const livetvRunning = (s: LivetvAdminState): boolean => livetvJob(s)?.state === 'running';
/**
 * the "could not be stopped" note: only while no job runs. A job that drops livetv stores stop_failed before it stops the
 * container (so a crash in between is recovered), and for those seconds the note would be untrue (1b re-review concern 4).
 */
export const stopFailedShown = (s: LivetvAdminState): boolean => s.updater.livetv?.state === 'stop_failed' && !jobRunning(s);
/** another updater job (an app update, a rollback) is running: livetv cannot be started or stopped meanwhile */
export const otherJobRunning = (s: LivetvAdminState): boolean => jobRunning(s) && !livetvRunning(s);

export type Phase = 'area' | 'stopping' | 'working' | 'settling' | 'wantedDown' | 'offer';
/**
 * What the page waits for after a livetv job succeeded (detection is cached up to 10 s and the page stops polling with the job):
 * 'on' after an enable, 'off' after a disable / remove; null = nothing to wait for (another job, a failure, or detection already
 * agrees). 1b review I4: a disable used to leave "Live-TV läuft." on the page until the next reload.
 */
export type Settle = 'on' | 'off' | null;
export function settleAfter(j: LivetvJob | null, installed: boolean): Settle {
  if (!j || j.state !== 'succeeded' || !j.action.startsWith('livetv-')) return null;
  if (j.action === 'livetv-enable') return installed ? null : 'on';
  return installed ? 'off' : null;
}
/** the wait is over once detection agrees with the job */
export const settled = (target: Settle, installed: boolean): boolean => target === null || (target === 'on') === installed;

/**
 * What the page shows: the area while installed; "being turned off" while a finished disable waits for detection (`stopping`,
 * never "läuft"); the job's steps while one runs; "checking" for a moment after an enable ended and detection has not caught up
 * (`settling`); "turned on but not running" (wanted, nothing detected); else the offer. `settle`: the wait that is still open.
 */
export function phase(s: LivetvAdminState, settle: Settle): Phase {
  if (s.installed) return settle === 'off' && !jobRunning(s) ? 'stopping' : 'area';
  if (livetvRunning(s)) return 'working';
  if (settle === 'on') return 'settling';
  // the backend keeps `wanted` once it accepted an enable, even when the job then failed or was rolled back: that is not "turned on"
  const j = livetvJob(s);
  const failedEnable = j?.action === 'livetv-enable' && (j.state === 'failed' || j.state === 'rolled_back');
  if (s.wanted && !failedEnable) return 'wantedDown';
  return 'offer';
}

const ERRORS = ['pull_failed', 'verify_failed', 'restart_failed', 'unhealthy', 'unexpected_image', 'config_mismatch', 'compose_config', 'updater_outdated', 'compose_outdated', 'network_missing', 'stop_failed', 'interrupted', 'no_target', 'updater_error', 'not_found', 'unauthorized', 'remove_failed', 'rollback_failed', 'no_updater', 'foreign_stack', 'busy'] as const;
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

const NAV_KEY = 'ff-admin-livetv-nav';
/**
 * Whether the Live-TV nav row was shown the last time (the admin summary decides, but it arrives after the first paint). The shell
 * reserves a row of the same height by this guess while the summary loads, so the group below never shifts for a returning admin;
 * the first visit guesses "shown" (the default is an offer that is not hidden).
 */
export function navGuess(): boolean {
  try { return localStorage.getItem(NAV_KEY) !== '0'; } catch { return true; }
}
export function rememberNav(shown: boolean): void {
  try { localStorage.setItem(NAV_KEY, shown ? '1' : '0'); } catch { /* private mode: no memory */ }
}

/** polling every 3 s while a job runs (spec §4.5) */
export const POLL_MS = 3_000;
/** how long after a job ended the page keeps asking before it believes detection ("turned on but not running", or still running) */
export const SETTLE_MS = 30_000;
