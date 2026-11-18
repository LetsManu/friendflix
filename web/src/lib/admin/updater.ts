// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Update with the updater container (backend/src/updater.ts, GET/POST /api/admin/updater): the job steps
 * (pull → verify → restart → health, rollback when it ran), the result of the last job, and the polling while a job runs
 * (the backend restarts in the middle: failed polls mean "reconnecting", not an error).
 */
import { hasKey, trDynamic } from '#lib/i18n';
import { mediaErrorText } from './mediaserver/model';

export type StepName = 'pull' | 'verify' | 'restart' | 'health' | 'rollback';
export type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type UpdaterAction = 'update' | 'rollback' | 'self-update';
/** the managed media server's jobs (backend updater.ts MEDIA_JOB_ACTIONS) */
export const MEDIA_JOB_ACTIONS = ['mediaserver-apply', 'mediaserver-finish', 'mediaserver-start', 'mediaserver-stop', 'mediaserver-restart', 'mediaserver-update', 'mediaserver-hdr-test', 'mediaserver-backup', 'mediaserver-restore', 'mediaserver-remove', 'mediaserver-recover'] as const;
export type MediaJobAction = (typeof MEDIA_JOB_ACTIONS)[number];
/** the steps of a media job, also the media server phase of an update (backend updater.ts MEDIA_STEPS) */
export const MEDIA_STEPS = ['check', 'pull', 'verify', 'snapshot', 'create', 'start', 'health', 'rollback'] as const;
export type MediaStepName = (typeof MEDIA_STEPS)[number];
/** the updater's last job can be one of Live TV's or the media server's too (backend updater.ts UpdaterJobAction) */
export type UpdaterJobAction = UpdaterAction | 'livetv-enable' | 'livetv-disable' | 'livetv-remove' | MediaJobAction;
/** succeeded_mediaserver_failed: FriendFlix was updated, its media server phase failed (and the old media server came back) */
export type JobState = 'running' | 'succeeded' | 'failed' | 'rolled_back' | 'succeeded_mediaserver_failed';
export interface UpdaterJob {
  id: string; action: UpdaterJobAction; state: JobState; step: StepName | null;
  steps: Record<StepName, StepState>; from: string | null; to: string; startedAt: string; finishedAt: string | null; error: string | null;
  /** a media job's steps (and an update's media server phase); absent/null for every other job and older backends */
  media?: { step: MediaStepName | null; steps: Record<MediaStepName, StepState> } | null;
  /** per service what an update or rollback did; absent/null until it got that far, for other jobs and older backends */
  services?: Partial<Record<string, 'updated' | 'unchanged'>> | null;
}
/**
 * what a service runs: `sha` its image commit's sha-<7>, `commit` that commit, `changed` whether the registry's digest of the
 * channel's tag differs from its own (null: unknown); the newer fields are absent with older backends
 */
export interface UpdaterService {
  service: string; state: string; health: string; sha: string | null; version: string | null;
  commit?: string | null; digest?: string | null; registry?: string | null; changed?: boolean | null;
}
export interface UpdaterStatus {
  updater: { version: string | null; sha: string | null };
  channel: 'stable' | 'nightly' | 'pinned'; version: string | null; targetTag: string | null;
  current: string | null; previous: string | null; busy: boolean; job: UpdaterJob | null; log: string[];
  services: UpdaterService[];
  /** whether a rollback has something to go back to (after an update by digests `previous` stays null); absent/null = an older backend */
  rollback?: { available: boolean } | null;
  /** own = started from the updater's directory; foreign = Portainer (or another tool) runs it, the updater never recreates it; absent/null = unknown */
  stack?: 'own' | 'foreign' | null;
  /** why foreign: working_dir = started from another directory (stackDir) than the updater sees (projectDir); portainer; no_labels */
  stackReason?: 'own' | 'working_dir' | 'portainer' | 'no_labels' | null;
  stackDir?: string | null;
  projectDir?: string | null;
  /** the managed media server as the updater sees it (only what this page reads); absent/null = none, or an older backend */
  mediaserver?: { container: object | null; desired: object | null } | null;
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

/** Admin → Einstellungen → Medienserver: where a media server failure is tried again */
export const MEDIA_TAB = '/admin/settings?tab=media';
export const isMediaJob = (action: string): action is MediaJobAction => (MEDIA_JOB_ACTIONS as readonly string[]).includes(action);

/** a media job's steps (check … health), plus the rollback once it started */
export function visibleMediaSteps(m: NonNullable<UpdaterJob['media']>): MediaStepName[] {
  return MEDIA_STEPS.filter((s) => s !== 'rollback' || (m.steps.rollback !== 'skipped' && m.steps.rollback !== 'pending'));
}

/**
 * a managed media server exists (a container, or one wanted): an update job then may end with a media server phase, so its steps
 * are listed from the start (steps.ts jobFlow `mediaPhase`)
 */
export const hasManagedMedia = (s: UpdaterStatus | null | undefined): boolean => Boolean(s?.mediaserver && (s.mediaserver.container || s.mediaserver.desired));

/**
 * Whether an update job lists its media server phase, decided once per job (StepList must not gain or lose rows between polls): a
 * job that carries its phase always; else at first sight, a running job when a managed media server exists. A job first seen
 * finished without a phase never gets the rows (it never had one we know of).
 */
export function mediaPhaseMemo(): (job: UpdaterJob | null | undefined, s: UpdaterStatus | null | undefined) => boolean {
  const seen = new Map<string, boolean>();
  return (job, s) => {
    if (!job) return false;
    if (job.media) { seen.set(job.id, true); return true; }
    let v = seen.get(job.id);
    if (v === undefined) { v = job.state === 'running' && hasManagedMedia(s); seen.set(job.id, v); }
    return v;
  };
}

/** a job state's tone: an update whose media server phase failed is a warning (FriendFlix runs the new build), never red */
export type JobTone = 'running' | 'ok' | 'warn' | 'bad';
export function jobTone(state: JobState): JobTone {
  if (state === 'running') return 'running';
  if (state === 'succeeded') return 'ok';
  return state === 'succeeded_mediaserver_failed' ? 'warn' : 'bad';
}

/** "FriendFlix aktualisiert, Medienserver nicht." with the media server's code as a sentence (mediaserver/model.ts mediaErrorText) */
export function mediaFailedText(code: string | null): string {
  return trDynamic('admin.update.updater.result.succeeded_mediaserver_failed', { reason: mediaErrorText(code) });
}

/** a media job's name (Einrichten, Starten, …) */
export function mediaActionLabel(action: MediaJobAction): string {
  const key = action.slice('mediaserver-'.length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return trDynamic(`admin.update.updater.mediaAction.${key}`);
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

/**
 * rollback is offered once the updater recorded something to go back to (the digests before the last update, or an older updater's
 * sha tag) and no job runs (never on a foreign stack: Portainer has no rollback)
 */
export const canRollback = (s: UpdaterStatus | null): boolean => Boolean((s?.previous || s?.rollback?.available) && !s.busy && !isRunning(s.job) && s.stack !== 'foreign');

/** "Vorherige Version": the sha tag, else (after an update by digests) the images before the last update, else none */
export function previousText(s: UpdaterStatus): { text: string; code: boolean } {
  if (s.previous) return { text: s.previous, code: true };
  return s.rollback?.available ? { text: trDynamic('admin.update.updater.previousImages'), code: false } : { text: trDynamic('admin.update.updater.none'), code: true };
}

/** the rollback's confirmation: back to the sha tag, or to the images before the last update */
export function rollbackConfirm(s: UpdaterStatus | null): string {
  return s?.previous ? trDynamic('admin.update.updater.confirm.rollback', { tag: s.previous }) : trDynamic('admin.update.updater.confirm.rollbackImages');
}

/** the rows under "Installiert", in this order (bootstrap runs the backend's image and is left out) */
const SERVICE_ORDER = ['backend', 'gateway', 'web', 'livetv', 'updater'] as const;
/** changed: the registry has another image; unchanged / updated: what the last job did (or unchanged: the registry has the same) */
export type ServiceMark = 'changed' | 'unchanged' | 'updated' | null;
export interface ServiceRow { service: string; commit: string | null; mark: ServiceMark; text: string }
const MARK_KEY: Record<Exclude<ServiceMark, null>, string> = { changed: 'svcChanged', unchanged: 'svcUnchanged', updated: 'svcUpdated' };

/**
 * One row per service: its name, commit7 and "Update verfügbar" / "unverändert" (unknown: no text, the row keeps its room). After
 * an update or rollback its report ("aktualisiert" / "unverändert"), until the registry has something newer again; when the report
 * found nothing changed, `all` ("alles unverändert") stands for its rows, the first `span` ones.
 */
export function serviceRows(s: UpdaterStatus | null): { rows: ServiceRow[]; all: string; span: number } {
  const listed = SERVICE_ORDER.flatMap((name) => s?.services.find((x) => x.service === name) ?? []);
  const j = s?.job;
  // the report holds until the registry has something newer for a service an update installs (the updater's own is its self-update)
  const newer = listed.some((x) => x.service !== 'updater' && x.changed === true);
  const report = j && !isRunning(j) && (j.action === 'update' || j.action === 'rollback') && s?.stack !== 'foreign' && !newer && j.services && Object.keys(j.services).length ? j.services : null;
  const rows = listed.map((x): ServiceRow => {
    const mark: ServiceMark = report?.[x.service] ?? (x.changed === true ? 'changed' : x.changed === false ? 'unchanged' : null);
    const commit = x.commit && /^[0-9a-f]{40}$/.test(x.commit) ? x.commit.slice(0, 7) : x.sha && /^sha-[0-9a-f]{7}$/.test(x.sha) ? x.sha.slice(4) : null;
    return { service: x.service, commit, mark, text: mark ? trDynamic(`admin.update.updater.${MARK_KEY[mark]}`) : '' };
  });
  const span = report && Object.values(report).every((v) => v === 'unchanged') ? rows.findIndex((r) => !report[r.service]) : 0;
  const n = span < 0 ? rows.length : span;
  return { rows, all: n > 0 ? trDynamic('admin.update.updater.allUnchanged') : '', span: n };
}

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

/** the updater's own image commit, short (its version is not baked in any more): null without a CI commit (a local build) */
export const updaterBuild = (s: Pick<UpdaterStatus, 'updater'> | null | undefined): string | null => {
  const sha = s?.updater?.sha;
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : null;
};

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
