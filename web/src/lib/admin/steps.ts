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
import { REDEPLOY_STEPS, failReason, redeployResult, redeploySteps, visibleSteps, type Redeploy, type StepName, type StepState, type UpdaterJob } from './updater';

export type RowState = 'waiting' | 'running' | 'ok' | 'failed' | 'skipped';
export interface StepRow { key: string; label: string; sub?: string; state: RowState; took?: string }
/** running; ok / neutral (nothing to do) / failed once it ended */
export type FlowOutcome = 'running' | 'ok' | 'neutral' | 'failed';
export interface FlowNote {
  tone: 'ok' | 'neutral' | 'bad';
  /** the outcome code (data-result): succeeded / rolled_back / failed, done / unchanged / failed / timeout */
  result: string;
  text: string;
  /** the real total duration and, for a failed job, its error code */
  detail: string;
  /** what to do (folded away under "What to do?" so the note keeps its height); '' = none */
  advice: string;
  /** a failure: the note offers to try again */
  retry: boolean;
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
}

const U = 'admin.update.updater';
export const rowState = (s: StepState): RowState => (s === 'pending' ? 'waiting' : s);

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

function frame(rows: StepRow[], outcome: FlowOutcome, partial?: number): Pick<StepFlow, 'progress' | 'count'> {
  const at = rows.findIndex((r) => r.state === 'running' || r.state === 'failed');
  const n = rows.length;
  if (outcome === 'running') return { progress: progressOf(rows, partial), count: trDynamic(`${U}.flow.stepOf`, { n: Math.max(1, at + 1), total: n }) };
  if (outcome === 'failed') return { progress: progressOf(rows), count: trDynamic(`${U}.flow.stopped`, { n: Math.max(1, at + 1), total: n }) };
  return { progress: 1, count: trDynamic(`${U}.flow.done`) };
}

export interface FlowOpts { reconnecting?: boolean; now?: number }

/** an updater job; `steps`: which to list (Live TV passes its own, default the update's) */
export function jobFlow(job: UpdaterJob, o: FlowOpts & { steps?: readonly StepName[] | null } = {}): StepFlow {
  const list = o.steps ?? visibleSteps(job);
  const rows: StepRow[] = list.map((st) => ({ key: st, label: trDynamic(`${U}.step.${st}`), state: rowState(job.steps[st]) }));
  const outcome: FlowOutcome = job.state === 'running' ? 'running' : job.state === 'succeeded' ? 'ok' : 'failed';
  const running = outcome === 'running';
  const label = running
    ? (o.reconnecting ? trDynamic(`${U}.reconnecting`) : trDynamic(`${U}.running`, { s: elapsed(job.startedAt, o.now ?? Date.now()) }))
    : `${trDynamic(`${U}.lastJob`)} ${fmtDateTime(job.finishedAt ?? job.startedAt)}`;
  let note: FlowNote | null = null;
  if (!running) {
    // one sentence (the failed row by its label); the reason, often long, is the advice
    const failedRow = rows.find((r) => r.state === 'failed');
    const text = job.state === 'succeeded' ? trDynamic(`${U}.result.succeeded`, { to: job.to })
      : job.state === 'rolled_back' ? trDynamic(`${U}.result.rolled_back`, { from: job.from ?? trDynamic(`${U}.none`) })
        : failedRow ? trDynamic(`${U}.result.failedAt`, { row: failedRow.label }) : trDynamic(`${U}.result.failed`, { reason: failReason(job.error) });
    const code = job.error && /^[a-z_]{1,40}$/.test(job.error) ? trDynamic(`${U}.flow.code`, { code: job.error }) : '';
    const advice = outcome === 'failed' && (job.state === 'rolled_back' || failedRow) ? failReason(job.error) : '';
    note = { tone: outcome === 'ok' ? 'ok' : 'bad', result: job.state, text, advice, detail: [took(job.startedAt, job.finishedAt), code].filter(Boolean).join(' · '), retry: outcome === 'failed' };
  }
  return { rows, outcome, label, reconnecting: running && Boolean(o.reconnecting), note, ...frame(rows, outcome) };
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
