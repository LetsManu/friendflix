// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Update with the updater container (backend/src/updater.ts, GET/POST /api/admin/updater): the job steps
 * (pull → verify → restart → health, rollback when it ran), the result of the last job, and the polling while a job runs
 * (the backend restarts in the middle: failed polls mean "reconnecting", not an error).
 */
import { hasKey, trDynamic } from '#lib/i18n';

export type StepName = 'pull' | 'verify' | 'restart' | 'health' | 'rollback';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type UpdaterAction = 'update' | 'rollback' | 'self-update';
/** the updater's last job can be one of Live TV's too (backend updater.ts UpdaterJobAction) */
export type UpdaterJobAction = UpdaterAction | 'livetv-enable' | 'livetv-disable' | 'livetv-remove';
export interface UpdaterJob {
  id: string; action: UpdaterJobAction; state: 'running' | 'succeeded' | 'failed' | 'rolled_back'; step: StepName | null;
  steps: Record<StepName, StepState>; from: string | null; to: string; startedAt: string; finishedAt: string | null; error: string | null;
}
export interface UpdaterStatus {
  updater: { version: string | null; sha: string | null };
  channel: 'stable' | 'nightly' | 'pinned'; version: string | null; targetTag: string | null;
  current: string | null; previous: string | null; busy: boolean; job: UpdaterJob | null; log: string[];
  services: Array<{ service: string; state: string; health: string; sha: string | null; version: string | null }>;
  /** own = started from the updater's directory; foreign = Portainer (or another tool) runs it, the updater never recreates it; absent/null = unknown */
  stack?: 'own' | 'foreign' | null;
  /** why foreign: working_dir = started from another directory (stackDir) than the updater sees (projectDir); portainer; no_labels */
  stackReason?: 'own' | 'working_dir' | 'portainer' | 'no_labels' | null;
  stackDir?: string | null;
  projectDir?: string | null;
}
export interface AutoUpdate { mode: 'off' | 'nightly-window'; time: string; locked: string[] }
/**
 * whether Admin → Settings has the Portainer webhook / API: a foreign stack is then updated through Portainer. missing: the API
 * settings still missing when it is set up only in part (names only; older backends send none)
 */
export interface PortainerSetup { configured: boolean; mode: 'webhook' | 'api' | null; missing?: string[] }
/**
 * The last update handed to Portainer (backend redeploy.ts) and its phase, judged from what runs: Portainer reports no progress
 * and recreates the backend halfway through, so the page polls this like an updater job.
 */
export type RedeployPhase = 'pulling' | 'recreating' | 'health' | 'done' | 'unchanged' | 'failed' | 'timeout';
export interface Redeploy {
  id: string; mode: 'webhook' | 'api'; tag: string; phase: RedeployPhase; running: boolean; startedAt: string; finishedAt: string | null;
  services: { updated: number; total: number } | null;
  error: string | null; status: number | null; step: string | null; code: string | null;
  /** timeout: the phase it hung in; failed: the phase it failed in (null: refused before anything ran; older backends: always null) */
  at: RedeployPhase | null;
}
export type UpdaterView = { autoUpdate?: AutoUpdate; portainer?: PortainerSetup; redeploy?: Redeploy | null } & ({ present: false } | { present: true; error: 'unauthorized' | 'invalid_answer' } | { present: true; status: UpdaterStatus });

/** HH:MM like the backend (config.ts AUTO_UPDATE_TIME) */
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const MAIN_STEPS: readonly StepName[] = ['pull', 'verify', 'restart', 'health'];

export const statusOf = (v: UpdaterView | null): UpdaterStatus | null => (v && v.present && 'status' in v ? v.status : null);
export const isRunning = (j: UpdaterJob | null | undefined): boolean => j?.state === 'running';
/** a Portainer redeploy that is still going (the page keeps polling) */
export const redeployRunning = (v: UpdaterView | null): boolean => Boolean(v?.redeploy?.running);

/** request: the redeploy handed to Portainer (it answered, or is at work); then what can be seen of it */
export type RedeployStep = 'request' | 'pulling' | 'recreating' | 'health';
export const REDEPLOY_STEPS: readonly RedeployStep[] = ['request', 'pulling', 'recreating', 'health'];
/**
 * each step's state for a phase (job step states): the running one, the ones before it done. unchanged: Portainer pulled but
 * recreated nothing; failed: the step it failed in (`at`; none = refused before anything ran: the request); timeout: the step it hung in.
 */
export function redeploySteps(r: Pick<Redeploy, 'phase' | 'at'>): Record<RedeployStep, StepState> {
  const upTo = (i: number, cur: StepState): Record<RedeployStep, StepState> =>
    Object.fromEntries(REDEPLOY_STEPS.map((s, k) => [s, k < i ? 'ok' : k === i ? cur : cur === 'running' ? 'pending' : 'skipped'])) as Record<RedeployStep, StepState>;
  const at = (fallback: number) => { const i = REDEPLOY_STEPS.indexOf(r.at as RedeployStep); return i > 0 ? i : fallback; };
  switch (r.phase) {
    case 'pulling': return upTo(1, 'running');
    case 'recreating': return upTo(2, 'running');
    case 'health': return upTo(3, 'running');
    case 'done': return upTo(4, 'ok');
    case 'unchanged': return { request: 'ok', pulling: 'ok', recreating: 'skipped', health: 'skipped' };
    case 'failed': return upTo(at(0), 'failed');
    case 'timeout': return upTo(at(1), 'failed');
  }
}

/**
 * The outcome of a finished redeploy as a one-sentence headline and the advice apart (StepList puts it under "What to do?"); both
 * '' while it runs. Refused on the request row (`at` null): "refused", with the HTTP status and the step by name. Accepted, then
 * failed in a later row (`at`): "started, but stopped at <row label>", never "refused" and never the API step code.
 */
export function redeployResult(r: Redeploy): { text: string; advice: string } {
  const k = 'admin.update.updater.redeploy';
  const row = (p: RedeployPhase | null, fallback: RedeployStep) => trDynamic(`${k}.step.${p && REDEPLOY_STEPS.includes(p as RedeployStep) ? p : fallback}`);
  const out = (key: string, vars: Record<string, string> = {}) => ({ text: trDynamic(`${k}.head.${key}`, vars), advice: trDynamic(`${k}.advice.${key}`, vars) });
  if (r.phase === 'failed') {
    if (r.error === 'no_target') return out('noTarget');
    if (r.error === 'webhook_gone') return out('webhookGone'); // the stored webhook address is stale (404)
    if (r.error === 'portainer_unreachable') {
      // the errno code (never the URL), with the same hint as the Portainer card ("host name cannot be resolved", …)
      const c = r.code && /^[A-Z_]{2,40}$/.test(r.code) ? r.code : null;
      const hint = c && hasKey(`admin.update.hint.${c}`) ? `: ${trDynamic(`admin.update.hint.${c}`)}` : '';
      return out('unreachable', { code: c ? ` (${c}${hint})` : '' });
    }
    if (r.at && r.at !== 'pulling' && r.at !== 'recreating' && r.at !== 'health') return out('failed', { detail: '' });
    if (r.at) return out('failedAt', { row: row(r.at, 'pulling'), status: r.status !== null ? trDynamic(`${k}.httpStatus`, { status: String(r.status) }) : '' });
    // the step by its name (an unknown code as it is); without an HTTP status only the step
    const step = r.step && /^[a-z_]{1,20}$/.test(r.step) && hasKey(`${k}.stepName.${r.step}`) ? trDynamic(`${k}.stepName.${r.step}`) : r.step;
    return out('failed', { detail: r.status !== null ? trDynamic(`${k}.detail`, { status: String(r.status), step: step ?? '?' }) : step ? trDynamic(`${k}.detailStep`, { step }) : '' });
  }
  if (r.phase === 'timeout') return out('timeout', { row: row(r.at, 'pulling') });
  if (r.phase === 'unchanged') return out('unchanged', { tag: r.tag });
  if (r.phase === 'done') return { text: trDynamic(`${k}.result.done`), advice: '' };
  return { text: '', advice: '' };
}

/** the note when the Portainer API is set up only in part (null when nothing is missing) */
export function portainerMissing(p: Pick<PortainerSetup, 'missing'> | null | undefined): string | null {
  const m = (p?.missing ?? []).filter((f) => /^PORTAINER_[A-Z_]{1,30}$/.test(f));
  return m.length ? trDynamic('admin.update.updater.portainerMissing', { fields: m.join(', ') }) : null;
}

/** the four steps, plus the rollback once it started (self-update: no health step); StepList keeps an update's slot for it */
export function visibleSteps(j: UpdaterJob): StepName[] {
  const base = MAIN_STEPS.filter((s) => !(j.action === 'self-update' && s === 'health'));
  return j.steps.rollback !== 'skipped' && j.steps.rollback !== 'pending' ? [...base, 'rollback'] : base;
}

/** a readable reason for a job's error code (unknown codes: "unknown error"; the code itself is never shown raw) */
export function failReason(code: string | null): string {
  const k = code && /^[a-z_]+$/.test(code) && hasKey(`admin.update.updater.failReason.${code}`) ? code : 'unknown';
  return trDynamic(`admin.update.updater.failReason.${k}`);
}

/** the error toast of a refused start (backend codes from routes/updater.ts) */
export function startError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  const code = (e as { body?: { error?: unknown } } | null)?.body?.error;
  if (status === 429) return trDynamic('admin.update.updater.error.tooSoon');
  if (typeof code === 'string' && /^[a-z_]+$/.test(code) && hasKey(`admin.update.updater.error.${code}`)) return trDynamic(`admin.update.updater.error.${code}`);
  return trDynamic('admin.update.updater.error.generic');
}

/** poll every 2 s while a job runs, from 3 s while the backend is away (watch.ts backs off to 10 s); give up after 15 minutes */
export const POLL_MS = 2_000;
export const RECONNECT_MS = 3_000;
export const WATCH_MAX_MS = 15 * 60_000;
export const nextPoll = (reconnecting: boolean): number => (reconnecting ? RECONNECT_MS : POLL_MS);

export type ForeignMode = 'portainer' | 'manual' | 'workdir';

/**
 * The updater does not recreate this stack (backend updater.ts portainerStack): it says so, or Portainer is set up and the
 * updater does not confirm the stack as its own (an older updater). "portainer" = "Update now" redeploys through Portainer,
 * "workdir" = our own stack started from another directory than the updater sees (fix: UPDATER_PROJECT_DIR), "manual" =
 * Portainer or another tool runs it and nothing can be started here; null = our own stack.
 */
export function foreignMode(v: UpdaterView | null): ForeignMode | null {
  const s = statusOf(v);
  if (!s) return null;
  const portainer = Boolean(v?.portainer?.configured);
  // set up only in part: the backend treats a stack the updater cannot confirm as Portainer's too (and names what is missing)
  const partial = (v?.portainer?.missing ?? []).length > 0;
  if (s.stack !== 'foreign' && !((portainer || partial) && s.stack !== 'own')) return null;
  if (portainer) return 'portainer';
  if (s.stackReason === 'working_dir' && s.stackDir && s.projectDir && !/^\/data\/compose\//.test(s.stackDir)) return 'workdir';
  return 'manual';
}

/** the note for a foreign stack (workdir names both directories and the line for .env) */
export function foreignText(mode: ForeignMode, s: UpdaterStatus | null): string {
  if (mode === 'workdir') return trDynamic('admin.update.updater.foreign.workdir', { dir: s?.stackDir ?? '', projectDir: s?.projectDir ?? '' });
  return trDynamic(`admin.update.updater.foreign.${mode}`);
}

/** rollback is offered once the updater recorded a previous build and no job runs (never on a foreign stack: Portainer has no rollback) */
export const canRollback = (s: UpdaterStatus | null): boolean => Boolean(s?.previous && !s.busy && !isRunning(s.job) && s.stack !== 'foreign');

/** the jobs Admin -> Update starts (a Live TV job is the Live TV page's) */
const UPDATE_JOBS: readonly string[] = ['update', 'rollback', 'self-update'];
const at = (start: string, end: string | null) => { const t = Date.parse(end ?? start); return Number.isFinite(t) ? t : 0; };
/**
 * What the updater card shows of the last activity: whatever runs; else the newer of the last update job and the last Portainer
 * redeploy. On a Portainer stack (`foreign`) a finished updater job is from before Portainer ran it (the updater cannot run update
 * jobs there): not shown. A Live TV job is never shown as an update.
 */
export function shownActivity(s: UpdaterStatus | null, redeploy: Redeploy | null | undefined, foreign: boolean): 'job' | 'redeploy' | null {
  const job = s?.job && UPDATE_JOBS.includes(s.job.action) ? s.job : null;
  if (isRunning(job)) return 'job';
  if (redeploy?.running) return 'redeploy';
  const j = job && !foreign ? at(job.startedAt, job.finishedAt) : null;
  const r = redeploy ? at(redeploy.startedAt, redeploy.finishedAt) : null;
  if (j !== null && (r === null || j >= r)) return 'job';
  return r !== null ? 'redeploy' : null;
}

/**
 * A new answer of GET /api/admin/updater while something runs. Portainer recreates the updater too: for a while it does not answer
 * (`present: false`, the redeploy record still comes). The last status then stays (`away`: shown as reconnecting) instead of the
 * card losing its steps and buttons; nothing running: the answer as it is.
 */
export function mergeView(prev: UpdaterView, next: UpdaterView): { view: UpdaterView; away: boolean } {
  const ps = statusOf(prev);
  if (next.present || !ps) return { view: next, away: false };
  const busy = isRunning(ps.job) || Boolean(prev.redeploy?.running) || Boolean(next.redeploy?.running);
  return busy ? { view: { ...next, present: true, status: ps } as UpdaterView, away: true } : { view: next, away: false };
}

/** what is installed: the build the backend service runs (its version and sha tag); without a listing the updater's record */
export function installedOf(s: UpdaterStatus | null): { version: string | null; tag: string } | null {
  const b = s?.services.find((x) => x.service === 'backend' && x.sha);
  if (b?.sha) return { version: b.version, tag: b.sha };
  return s?.current ? { version: null, tag: s.current } : null;
}

/** the channel a tag stands for (latest = stable, nightly, a version = fixed); a build tag (sha-…) names no channel */
export function tagText(tag: string | null | undefined): string | null {
  if (tag === 'latest') return trDynamic('admin.update.channel.stable');
  if (tag === 'nightly') return trDynamic('admin.update.channel.nightly');
  if (tag && /^\d+\.\d+\.\d+$/.test(tag)) return trDynamic('admin.update.channel.pinned');
  return null;
}
