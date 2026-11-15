// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { jobFlow, progressOf, redeployFlow, type StepRow } from './steps';
import { installedOf, mergeView, shownActivity, tagText, type Redeploy, type UpdaterJob, type UpdaterStatus, type UpdaterView } from './updater';

// The one step list of Admin -> Update (StepList.svelte) is driven by these mappings only: an updater job, a Portainer redeploy
// followed in the updater card, and the same redeploy record followed by the page without an updater.
const T = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms: number) => new Date(T + ms).toISOString();
const job = (over: Partial<UpdaterJob> = {}): UpdaterJob => ({
  id: '0123456789abcdef', action: 'update', state: 'running', step: 'pull', from: 'sha-aaaaaaa', to: 'latest', startedAt: iso(0), finishedAt: null, error: null,
  steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' }, ...over,
});
const rd = (over: Partial<Redeploy> = {}): Redeploy => ({
  id: 'abcdef0123456789', mode: 'api', tag: 'latest', phase: 'pulling', running: true, startedAt: iso(0), finishedAt: null,
  services: null, error: null, status: null, step: null, code: null, at: null, ...over,
});
const status = (over: Partial<UpdaterStatus> = {}): UpdaterStatus => ({
  updater: { version: '1.1.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: 'sha-aaaaaaa', busy: false, job: null, log: [], services: [], ...over,
});
const states = (rows: StepRow[]) => Object.fromEntries(rows.map((r) => [r.key, r.state]));

beforeEach(async () => { await setLocale('en'); });
afterEach(async () => { await setLocale('de'); });

describe('updater job -> rows', () => {
  it('running: pending is "waiting", the running row is marked, the label counts the seconds from the job\'s own start (it survives a reload)', () => {
    const f = jobFlow(job({ step: 'verify', steps: { pull: 'ok', verify: 'running', restart: 'pending', health: 'pending', rollback: 'skipped' } }), { now: T + 12_000 });
    expect(f.rows.map((r) => r.key)).toEqual(['pull', 'verify', 'restart', 'health']);
    expect(states(f.rows)).toEqual({ pull: 'ok', verify: 'running', restart: 'waiting', health: 'waiting' });
    // an update keeps one row's room for a rollback that may come (no row shown, no "skipped")
    expect(f.reserve).toBe(1);
    expect(f.rows[0]!.label).toBe('Download images');
    expect(f).toMatchObject({ outcome: 'running', reconnecting: false, note: null, count: 'Step 2 of 4' });
    expect(f.label).toContain('12');
    expect(f.progress).toBeCloseTo(1.5 / 4);
    // no per-step times from the updater: nothing invented
    expect(f.rows.every((r) => r.took === undefined)).toBe(true);
  });

  it('just started (every step still pending): "step 1 of 4", not the last step', () => {
    const f = jobFlow(job({ step: null, steps: { pull: 'pending', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' } }), { now: T });
    expect(f).toMatchObject({ outcome: 'running', count: 'Step 1 of 4' });
    expect(f.progress).toBe(0);
  });

  it('failed before any step ran (all skipped): "stopped at step 1 of 4"', () => {
    const f = jobFlow(job({ state: 'failed', step: null, finishedAt: iso(2_000), error: 'pull_failed', steps: { pull: 'skipped', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' } }));
    expect(f.outcome).toBe('failed');
    expect(f.count).toBe('Stopped at step 1 of 4');
  });

  it('reconnecting (the backend restarts in the middle): the rows stay as they were, only the label says so, never a failure', () => {
    const running = job({ step: 'restart', steps: { pull: 'ok', verify: 'ok', restart: 'running', health: 'pending', rollback: 'skipped' } });
    const f = jobFlow(running, { now: T + 30_000, reconnecting: true });
    expect(f).toMatchObject({ outcome: 'running', reconnecting: true, note: null });
    expect(states(f.rows)).toEqual(states(jobFlow(running).rows));
    expect(f.label).toMatch(/restarting/i);
  });

  it('succeeded: all done, full bar, an ok note with the real duration (from startedAt / finishedAt)', () => {
    const f = jobFlow(job({ state: 'succeeded', step: null, finishedAt: iso(29_000), steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } }));
    expect(f).toMatchObject({ outcome: 'ok', progress: 1, count: 'Finished' });
    expect(f.note).toMatchObject({ tone: 'ok', result: 'succeeded', retry: false });
    expect(f.note!.text).toBe('Update to latest finished.');
    expect(f.note!.detail).toBe('Took 29 sec');
  });

  it('rolled back: the health row failed, the rollback row shows, the note has the error code and a retry', () => {
    const f = jobFlow(job({ state: 'rolled_back', step: 'rollback', error: 'unhealthy', finishedAt: iso(80_000), steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'ok' } }));
    expect(states(f.rows)).toEqual({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'ok' });
    // the count and the bar over the four real steps; the rollback row sits in the reserved slot
    expect(f).toMatchObject({ outcome: 'failed', count: 'Stopped at step 4 of 4', reserve: 0 });
    expect(f.progress).toBeCloseTo(3 / 4);
    expect(f.note).toMatchObject({ tone: 'bad', result: 'rolled_back', retry: true });
    expect(f.note!.detail).toContain('Error code: unhealthy');
    expect(f.note!.advice).toBe('not healthy in time');
  });

  it('failed early: later steps are "skipped", the bar stops where it failed', () => {
    const f = jobFlow(job({ state: 'failed', error: 'verify_failed', finishedAt: iso(5_000), steps: { pull: 'ok', verify: 'failed', restart: 'skipped', health: 'skipped', rollback: 'skipped' } }));
    expect(states(f.rows)).toEqual({ pull: 'ok', verify: 'failed', restart: 'skipped', health: 'skipped' });
    expect(f.progress).toBeCloseTo(1 / 4);
    expect(f.note).toMatchObject({ tone: 'bad', result: 'failed', retry: true });
    // one sentence naming the row; the long reason is the advice
    expect(f.note!.text).toBe('Job failed at “Check signatures”.');
    expect(f.note!.advice).toContain('signature check failed');
  });

  it('a rollback running: "step 4 of 4" (the failed health check), the bar over the four; a self-update and Live TV reserve nothing', () => {
    const rb = jobFlow(job({ step: 'rollback', steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'running' } }));
    expect(rb.rows.map((r) => r.key)).toEqual(['pull', 'verify', 'restart', 'health', 'rollback']);
    expect(rb).toMatchObject({ outcome: 'running', count: 'Step 4 of 4', reserve: 0 });
    expect(rb.progress).toBeCloseTo(3 / 4);
    expect(jobFlow(job({ action: 'self-update' })).reserve).toBe(0);
    expect(jobFlow(job({ state: 'succeeded', steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } }))).toMatchObject({ reserve: 1, progress: 1 });
  });

  it('Live TV passes its own steps (a disable has only the restart)', () => {
    const lt = job({ action: 'livetv-disable', step: 'restart', steps: { pull: 'skipped', verify: 'skipped', restart: 'running', health: 'skipped', rollback: 'skipped' } });
    expect(jobFlow(lt, { steps: ['restart'] }).rows.map((r) => [r.key, r.state])).toEqual([['restart', 'running']]);
  });
});

describe('Portainer redeploy -> rows (updater card)', () => {
  it('pulling -> recreating (n of 3 as the row\'s sub line, the bar follows it) -> health -> done', () => {
    const p = redeployFlow(rd(), { now: T + 4_000 });
    expect(states(p.rows)).toEqual({ request: 'ok', pulling: 'running', recreating: 'waiting', health: 'waiting' });
    expect(p).toMatchObject({ outcome: 'running', count: 'Step 2 of 4' });
    const r1 = redeployFlow(rd({ phase: 'recreating', services: { updated: 1, total: 3 } }));
    expect(r1.rows.find((r) => r.key === 'recreating')).toMatchObject({ state: 'running', sub: '1 of 3 services on the new build' });
    const r2 = redeployFlow(rd({ phase: 'recreating', services: { updated: 2, total: 3 } }));
    expect(r2.progress).toBeGreaterThan(r1.progress);
    expect(states(redeployFlow(rd({ phase: 'health' })).rows)).toMatchObject({ recreating: 'ok', health: 'running' });
    const done = redeployFlow(rd({ phase: 'done', running: false, finishedAt: iso(95_000), services: { updated: 3, total: 3 } }));
    expect(states(done.rows)).toEqual({ request: 'ok', pulling: 'ok', recreating: 'ok', health: 'ok' });
    expect(done).toMatchObject({ outcome: 'ok', progress: 1 });
    expect(done.note).toMatchObject({ tone: 'ok', result: 'done', retry: false, detail: 'Took 2 min' });
  });

  it('failed at once (refused before anything ran): the request row failed, the rest skipped, the note has a retry', () => {
    const f = redeployFlow(rd({ phase: 'failed', running: false, finishedAt: iso(1_000), error: 'portainer', status: 401, step: 'stack' }));
    expect(states(f.rows)).toEqual({ request: 'failed', pulling: 'skipped', recreating: 'skipped', health: 'skipped' });
    expect(f).toMatchObject({ outcome: 'failed', count: 'Stopped at step 1 of 4' });
    expect(f.note).toMatchObject({ tone: 'bad', result: 'failed', retry: true });
    expect(f.note!.text).toBe('Portainer refused the update (HTTP 401, step stack lookup).');
  });

  it('a refusal after "started" fails the step Portainer was in', () => {
    const f = redeployFlow(rd({ phase: 'failed', running: false, finishedAt: iso(60_000), error: 'portainer', status: 500, step: 'redeploy', at: 'pulling' }));
    expect(states(f.rows)).toEqual({ request: 'ok', pulling: 'failed', recreating: 'skipped', health: 'skipped' });
    // the request went through: the note says so, names the failed row, and never "refused"
    expect(f.note!.text).toBe('Portainer started the update, but it stopped at “Portainer pulls the images” (HTTP 500).');
    expect(f.count).toBe('Stopped at step 2 of 4');
  });

  it('unchanged: a neutral note, no retry, nothing failed', () => {
    const f = redeployFlow(rd({ phase: 'unchanged', running: false, finishedAt: iso(20_000) }));
    expect(f).toMatchObject({ outcome: 'neutral', progress: 1 });
    expect(f.note).toMatchObject({ tone: 'neutral', result: 'unchanged', retry: false });
    expect(f.rows.some((r) => r.state === 'failed')).toBe(false);
  });

  it('timeout: the step it hung in failed, a retry', () => {
    const f = redeployFlow(rd({ phase: 'timeout', running: false, finishedAt: iso(900_001), at: 'health' }));
    expect(states(f.rows)).toEqual({ request: 'ok', pulling: 'ok', recreating: 'ok', health: 'failed' });
    expect(f.note).toMatchObject({ tone: 'bad', result: 'timeout', retry: true });
    expect(f.note!.text).toContain('15 minutes');
    expect(f.note!.text).toContain('Health check');
  });
});

describe('the page without an updater: the same redeploy record (no services listing)', () => {
  it('running from the record (a reload resumes it), reconnecting while the backend is recreated, then done', () => {
    const run = redeployFlow(rd({ mode: 'webhook', services: null }), { now: T + 40_000 });
    expect(run.rows.find((r) => r.key === 'recreating')!.sub).toBeUndefined();
    expect(run.label).toContain('40');
    const away = redeployFlow(rd({ mode: 'webhook', services: null }), { now: T + 70_000, reconnecting: true });
    expect(away).toMatchObject({ outcome: 'running', reconnecting: true, note: null });
    expect(states(away.rows)).toEqual(states(run.rows));
    expect(redeployFlow(rd({ mode: 'webhook', phase: 'done', running: false, finishedAt: iso(75_000) }))).toMatchObject({ outcome: 'ok', note: { result: 'done' } });
  });

  it('progressOf: 0 before anything, 1 when every row is done, failed rows do not count', () => {
    const row = (state: StepRow['state']): StepRow => ({ key: state, label: state, state });
    expect(progressOf([row('waiting'), row('waiting')])).toBe(0);
    expect(progressOf([row('ok'), row('ok')])).toBe(1);
    expect(progressOf([row('ok'), row('failed'), row('skipped')])).toBeCloseTo(1 / 3);
  });
});

describe('what the updater card shows', () => {
  const old = job({ state: 'succeeded', step: null, startedAt: '2026-10-21T04:03:00.000Z', finishedAt: '2026-10-21T04:04:00.000Z', steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } });
  it('a finished updater job on a Portainer stack is old news: only the redeploy (or nothing) is shown', () => {
    expect(shownActivity(status({ job: old }), null, true)).toBeNull();
    expect(shownActivity(status({ job: old }), rd({ phase: 'failed', running: false, finishedAt: iso(1_000) }), true)).toBe('redeploy');
    expect(shownActivity(status({ job: old }), null, false)).toBe('job');
  });
  it('the newer of a finished job and a finished redeploy; whatever runs wins', () => {
    const later = job({ ...old, startedAt: iso(500_000), finishedAt: iso(560_000) });
    expect(shownActivity(status({ job: later }), rd({ phase: 'done', running: false, finishedAt: iso(100_000) }), false)).toBe('job');
    expect(shownActivity(status({ job: old }), rd({ phase: 'done', running: false, finishedAt: iso(100_000) }), false)).toBe('redeploy');
    expect(shownActivity(status({ job: job() }), rd({ phase: 'done', running: false, finishedAt: iso(100_000) }), false)).toBe('job');
    expect(shownActivity(status({ job: old }), rd(), false)).toBe('redeploy');
  });
  it('a Live TV job is not an update: never shown as "Update to … finished"', () => {
    const lt = job({ action: 'livetv-enable', state: 'succeeded', finishedAt: iso(9_000) });
    expect(shownActivity(status({ job: lt }), null, false)).toBeNull();
  });

  it('labels: installed is what the backend runs (version · sha tag), not the updater\'s record of a moving tag; tags carry the channel name', () => {
    const svc = [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-c0be6c5', version: '1.0.0' }];
    expect(installedOf(status({ current: 'latest', services: svc }))).toEqual({ version: '1.0.0', tag: 'sha-c0be6c5' });
    expect(installedOf(status({ current: 'latest', services: [] }))).toEqual({ version: null, tag: 'latest' });
    expect(installedOf(status({ current: null, services: [] }))).toBeNull();
    expect(tagText('latest')).toBe('Stable');
    expect(tagText('nightly')).toBe('Nightly');
    expect(tagText('1.2.3')).toBe('Fixed version');
    expect(tagText('sha-c0be6c5')).toBeNull();
  });

  it('the updater away while Portainer recreates it: the last status stays (reconnecting), the redeploy record still updates', () => {
    const prev: UpdaterView = { present: true, status: status(), redeploy: rd() };
    const next: UpdaterView = { present: false, redeploy: rd({ phase: 'recreating' }) };
    const m = mergeView(prev, next);
    expect(m.away).toBe(true);
    expect(m.view).toMatchObject({ present: true, status: { current: 'latest' }, redeploy: { phase: 'recreating' } });
    // nothing running: an updater that is gone is gone
    expect(mergeView({ present: true, status: status() }, { present: false }).view).toEqual({ present: false });
    // a fresh status replaces the old one
    expect(mergeView(prev, { present: true, status: status({ current: 'nightly' }) })).toMatchObject({ away: false, view: { status: { current: 'nightly' } } });
  });
});
