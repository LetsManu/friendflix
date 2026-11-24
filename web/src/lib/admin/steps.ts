// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one animated step list of Admin -> Update (StepList.svelte) is driven only by what the server reports. These map its three
 * sources to rows plus an overall progress and a result note: an updater job (also Live TV's, through JobSteps.svelte), and a
 * Portainer redeploy record (backend redeploy.ts), followed by the updater card and, without an updater, by the page itself.
 *
 * The updater and the redeploy record have no per-step times (only the job's / redeploy's start and end), so rows carry no `took`:
 * the note gives the real total instead. Reconnecting (the backend restarts in the middle) never changes a row, only the label.
 */
import { fmtDateTime, fmtDuration, trDynamic } from '#lib/i18n';
import {
  MEDIA_STEPS, MEDIA_TAB, REDEPLOY_STEPS, failReason, isMediaJob, jobTone, mediaFailedText, redeployResult, redeploySteps, visibleMediaSteps, visibleSteps,
  type Redeploy, type StepName, type StepState, type UpdaterJob,
} from './updater';

export type RowState = 'waiting' | 'running' | 'ok' | 'failed' | 'skipped';
export interface StepRow { key: string; label: string; sub?: string; state: RowState; took?: string }
/** running; ok / neutral (nothing to do) / warn (FriendFlix updated, its media server not) / failed once it ended */
export type FlowOutcome = 'running' | 'ok' | 'neutral' | 'warn' | 'failed';
export interface FlowNote {
  tone: 'ok' | 'neutral' | 'warn' | 'bad';
  /** the outcome code (data-result): succeeded / rolled_back / failed / succeeded_mediaserver_failed, done / unchanged / failed / timeout */
  result: string;
  text: string;
  /** the real total duration and, for a failed job, its error code */
  detail: string;
  /** what to do (folded away under "What to do?" so the note keeps its height); '' = none */
  advice: string;
  /** a failure: the note offers to try again */
  retry: boolean;
  /** "try again" is elsewhere: the note links there instead (a media server failure: the media tab) */
  href?: string;
}
export interface StepFlow {
  rows: StepRow[];
  /** 0..1 */
  progress: number;
  outcome: FlowOutcome;
  /** left of the bar: elapsed time while it runs (or "reconnecting"), the end time once it ended */
  label: string;
  /** right of the bar: step n of m, finished, stopped at step n of m */
  count: string;
  reconnecting: boolean;
  note: FlowNote | null;
  /** invisible row slots kept under the list (an update's or a media job's rollback, shown only once it starts): nothing moves when it appears */
  reserve?: number;
}

const U = 'admin.update.updater';
export const rowState = (s: StepState): RowState => (s === 'pending' ? 'waiting' : s);
/** a rollback row (the update's own, a media job's): it only undoes the steps, never counts as one */
const isRollback = (key: string): boolean => key === 'rollback' || key === 'media-rollback';

/** done rows count whole, the running one by `partial` (0..1, default half); failed and skipped rows add nothing */
export function progressOf(rows: readonly StepRow[], partial = 0.5): number {
  if (!rows.length) return 0;
  const n = rows.reduce((a, r) => a + (r.state === 'ok' ? 1 : r.state === 'running' ? partial : 0), 0);
  return Math.max(0, Math.min(1, n / rows.length));
}

const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
/** "Took 29 sec" from the real start and end; '' when either is unknown */
function took(start: string, end: string | null): string {
  const a = ms(start), b = ms(end);
  return a !== null && b !== null && b >= a ? trDynamic(`${U}.flow.duration`, { d: fmtDuration((b - a) / 1000) }) : '';
}
const elapsed = (start: string, now: number) => { const a = ms(start); return a === null ? 0 : Math.max(0, Math.round((now - a) / 1000)); };

/** count and bar over the real steps (`rows` without a rollback: it only undoes them) */
function frame(rows: StepRow[], outcome: FlowOutcome, partial?: number): Pick<StepFlow, 'progress' | 'count'> {
  // the running or failed row; with none (just started, or failed before any step ran) the first step not done, else the last
  const found = rows.findIndex((r) => r.state === 'running' || r.state === 'failed');
  const open = rows.findIndex((r) => r.state !== 'ok');
  const at = found >= 0 ? found : open >= 0 ? open : rows.length - 1;
  const n = rows.length;
  if (outcome === 'running') return { progress: progressOf(rows, partial), count: trDynamic(`${U}.flow.stepOf`, { n: Math.max(1, at + 1), total: n }) };
  if (outcome === 'failed' || outcome === 'warn') return { progress: progressOf(rows), count: trDynamic(`${U}.flow.stopped`, { n: Math.max(1, at + 1), total: n }) };
  return { progress: 1, count: trDynamic(`${U}.flow.done`) };
}

export interface FlowOpts { reconnecting?: boolean; now?: number }

/**
 * The media server phase of an update before it started (`job.media` null): its steps waiting while the job runs, skipped once it
 * ended without one (nothing to move, the server stopped on purpose, or FriendFlix itself failed). The rollback is not listed: it
 * takes the update's reserved slot when it starts.
 */
function pendingPhase(job: UpdaterJob): NonNullable<UpdaterJob['media']> {
  const st: StepState = job.state === 'running' ? 'pending' : 'skipped';
  return { step: null, steps: Object.fromEntries(MEDIA_STEPS.map((k) => [k, k === 'rollback' ? 'skipped' : st])) as NonNullable<UpdaterJob['media']>['steps'] };
}

/**
 * an updater job; `steps`: which to list (Live TV passes its own, default the update's). A media job lists its media steps only; an
 * update with a media server phase adds that phase's steps after its own (keys `media-<step>`). `mediaPhase`: a managed media server
 * exists, so an update lists its phase's steps from the start (nothing jumps when the phase begins), skipped when it never ran.
 */
export function jobFlow(job: UpdaterJob, o: FlowOpts & { steps?: readonly StepName[] | null; mediaPhase?: boolean } = {}): StepFlow {
  const list = isMediaJob(job.action) ? [] : o.steps ?? visibleSteps(job);
  // only an update runs the phase (never a rollback or a self-update: updater/src/job.ts)
  const media = job.media ?? (o.mediaPhase && job.action === 'update' ? pendingPhase(job) : null);
  const core = list.map((st): StepRow => ({ key: st, label: trDynamic(`${U}.step.${st}`), state: rowState(job.steps[st]) }));
  const mediaRows = media ? visibleMediaSteps(media, job.action).map((st): StepRow => ({ key: `media-${st}`, label: trDynamic(`${U}.mediaStep.${st}`), state: rowState(media.steps[st]) })) : [];
  // FriendFlix's own rollback row goes last, into the slot reserved under the list: the media rows never move down when it starts
  const rows: StepRow[] = [...core.filter((r) => r.key !== 'rollback'), ...mediaRows, ...core.filter((r) => r.key === 'rollback')];
  const tone = jobTone(job.state);
  const outcome: FlowOutcome = tone === 'running' ? 'running' : tone === 'bad' ? 'failed' : tone;
  const running = outcome === 'running';
  const label = running
    ? (o.reconnecting ? trDynamic(`${U}.reconnecting`) : trDynamic(`${U}.running`, { s: elapsed(job.startedAt, o.now ?? Date.now()) }))
    : `${trDynamic(`${U}.lastJob`)} ${fmtDateTime(job.finishedAt ?? job.startedAt)}`;
  let note: FlowNote | null = null;
  if (outcome === 'warn') {
    // FriendFlix runs the new build; the media server phase failed and the old media server came back: tried again on its tab
    note = { tone: 'warn', result: job.state, text: mediaFailedText(job.error), advice: '', detail: took(job.startedAt, job.finishedAt), retry: false, href: MEDIA_TAB };
  } else if (!running) {
    // one sentence (the failed row by its label); the reason, often long, is the advice
    const failedRow = rows.find((r) => r.state === 'failed');
    const text = job.state === 'succeeded' ? trDynamic(`${U}.result.succeeded`, { to: job.to })
      : job.state === 'rolled_back' ? trDynamic(`${U}.result.rolled_back`, { from: job.from ?? trDynamic(`${U}.none`) })
        : failedRow ? trDynamic(`${U}.result.failedAt`, { row: failedRow.label }) : trDynamic(`${U}.result.failed`, { reason: failReason(job.error) });
    const code = job.error && /^[a-z_]{1,40}$/.test(job.error) ? trDynamic(`${U}.flow.code`, { code: job.error }) : '';
    const advice = outcome === 'failed' && (job.state === 'rolled_back' || failedRow) ? failReason(job.error) : '';
    note = { tone: outcome === 'ok' ? 'ok' : 'bad', result: job.state, text, advice, detail: [took(job.startedAt, job.finishedAt), code].filter(Boolean).join(' · '), retry: outcome === 'failed' };
  }
  const main = rows.filter((r) => !isRollback(r.key));
  // an update and a media job may roll back: the row's room is kept from the start, the row itself shows only once the rollback
  // started (it takes the slot: nothing moves)
  const reserve = (job.action === 'update' || isMediaJob(job.action)) && main.length === rows.length ? 1 : 0;
  return { rows, outcome, label, reconnecting: running && Boolean(o.reconnecting), note, reserve, ...frame(main, outcome) };
}

/** a Portainer redeploy record (with an updater: how many services already run the new build, as the recreate row's sub line) */
export function redeployFlow(r: Redeploy, o: FlowOpts = {}): StepFlow {
  const k = `${U}.redeploy`;
  const st = redeploySteps(r);
  const rows: StepRow[] = REDEPLOY_STEPS.map((s) => {
    const row: StepRow = { key: s, label: trDynamic(`${k}.step.${s}`), state: rowState(st[s]) };
    if (s === 'recreating' && r.services && (row.state === 'running' || row.state === 'ok' || row.state === 'failed')) {
      row.sub = trDynamic(`${k}.count`, { n: r.services.updated, total: r.services.total });
    }
    return row;
  });
  const outcome: FlowOutcome = r.running ? 'running' : r.phase === 'done' ? 'ok' : r.phase === 'unchanged' ? 'neutral' : 'failed';
  const running = outcome === 'running';
  const label = running
    ? (o.reconnecting ? trDynamic(`${U}.reconnecting`) : trDynamic(`${k}.running`, { s: elapsed(r.startedAt, o.now ?? Date.now()) }))
    : `${trDynamic(`${k}.last`)} ${fmtDateTime(r.finishedAt ?? r.startedAt)}`;
  // while containers are recreated, the bar follows the services on the new build
  const partial = r.phase === 'recreating' && r.services && r.services.total > 0 ? Math.min(0.9, Math.max(0.15, r.services.updated / r.services.total)) : undefined;
  const res = redeployResult(r);
  const note: FlowNote | null = running ? null : {
    tone: outcome === 'ok' ? 'ok' : outcome === 'neutral' ? 'neutral' : 'bad', result: r.phase, text: res.text, advice: res.advice,
    detail: outcome === 'failed' ? '' : took(r.startedAt, r.finishedAt), retry: outcome === 'failed',
  };
  return { rows, outcome, label, reconnecting: running && Boolean(o.reconnecting), note, ...frame(rows, outcome, partial) };
}

/** a state's badge text (the job states' words: waiting = pending) */
export const stateLabel = (s: RowState): string => trDynamic(`${U}.state.${s === 'waiting' ? 'pending' : s}`);

/**
 * How long a step the list catches up on stays "running" before it shows done. The page only samples the server (a poll every
 * 2 s, 3–10 s while the backend restarts) and the backend, the web container and on a self-update the updater are recreated in
 * the middle of a job: two polls in a row often differ by several steps (verify finished between two polls, restart and health
 * while the backend was away). The list then plays what happened in between, step by step, instead of flipping them together.
 */
export const STEP_DWELL_MS = 450;

const RANK: Record<RowState, number> = { waiting: 0, running: 1, ok: 2, failed: 2, skipped: 2 };
const ended = (s: RowState) => RANK[s] === 2;

/**
 * The frames (each row's state, in the order of `next`) from what the list shows to what the server reports now: every step that
 * went from waiting to done (or failed) between two polls shows running once, then its end, one after the other in list order;
 * the last frame is the server's state. Nothing shown yet (a page load), or a row that would go back (another job), is no replay.
 * A step still "waiting" before one that already ran (or runs) counts as done: a job runs its steps in order. The rollback row
 * comes after the four and never makes an earlier one done.
 */
export function catchUp(shown: readonly Pick<StepRow, 'key' | 'state'>[] | null, next: readonly Pick<StepRow, 'key' | 'state'>[]): RowState[][] {
  const target = next.map((r) => r.state);
  const reached = next.reduce((at, r, i) => (!isRollback(r.key) && r.state !== 'waiting' ? i : at), -1);
  for (let i = 0; i < reached; i++) if (target[i] === 'waiting' && !isRollback(next[i]!.key)) target[i] = 'ok';
  if (!shown) return [target];
  const before = new Map(shown.map((r) => [r.key, r.state]));
  const cur = next.map((r) => before.get(r.key) ?? 'waiting');
  if (cur.some((s, i) => RANK[target[i]!] < RANK[s] || (ended(s) && target[i] !== s))) return [target];
  const frames: RowState[][] = [];
  for (let i = 0; i < target.length; i++) {
    if (cur[i] === target[i]) continue;
    // done or failed without ever being seen running: it ran, show that first (together with the end of the step before it)
    if (cur[i] === 'waiting' && (target[i] === 'ok' || target[i] === 'failed')) { cur[i] = 'running'; frames.push([...cur]); }
    cur[i] = target[i]!;
  }
  frames.push(target);
  return frames;
}

/** a frame of a catch-up that has not reached the server's state yet: still running (no outcome, no note), bar and count from its rows */
export function heldFlow<F extends Pick<StepFlow, 'rows'> & Partial<StepFlow>>(flow: F, rows: StepRow[]): F {
  return { ...flow, rows, outcome: 'running', note: null, ...frame(rows.filter((r) => !isRollback(r.key)), 'running') };
}

export interface StepPlayerOpts {
  dwellMs?: number;
  /** true: show the server's state at once (reduced motion, calm mode) */
  instant?: () => boolean;
}

/**
 * Plays the flows the page pushes (one per poll) into what StepList shows: a step the server finished between two polls passes
 * through running → done, one step every `dwellMs`, and the outcome (note, bar colour, "Finished") lands only once every row
 * got there. A push with the same row states (the clock, a language switch, reconnecting) only refreshes the texts of what is
 * shown; a push with new states starts from what is on screen right now. stop() drops what is queued.
 */
export function stepPlayer<F extends Pick<StepFlow, 'rows'> & Partial<StepFlow>>(show: (flow: F) => void, o: StepPlayerOpts = {}) {
  const dwell = o.dwellMs ?? STEP_DWELL_MS;
  let on: StepRow[] | null = null;
  let latest: F | null = null;
  let target = '';
  let queue: RowState[][] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sig = (rows: readonly Pick<StepRow, 'key' | 'state'>[]) => rows.map((r) => `${r.key}:${r.state}`).join(' ');
  const stop = () => { clearTimeout(timer); timer = undefined; queue = []; };
  const render = (states: RowState[]) => {
    const f = latest!;
    on = f.rows.map((r, i) => (r.state === states[i] ? r : { ...r, state: states[i]! }));
    show(timer !== undefined || queue.length ? heldFlow(f, on) : { ...f, rows: on });
  };
  const next = () => {
    const states = queue.shift()!;
    timer = queue.length ? setTimeout(next, dwell) : undefined;
    render(states);
  };
  return {
    push(flow: F) {
      latest = flow;
      const s = sig(flow.rows);
      if (s === target && on) {
        // the same server state: keep the catch-up going, refresh the texts of the frame on screen
        render(on.map((r) => r.state));
        return;
      }
      target = s;
      stop();
      queue = o.instant?.() ? [catchUp(null, flow.rows).at(-1)!] : catchUp(on, flow.rows);
      next();
    },
    stop,
  };
}
