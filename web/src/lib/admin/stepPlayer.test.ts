// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '#lib/i18n';
import { STEP_DWELL_MS, catchUp, jobFlow, redeployFlow, stepPlayer, type StepFlow, type StepRow } from './steps';
import type { Redeploy, StepName, StepState, UpdaterJob } from './updater';

// What the owner saw: "the updater's progress doesn't go through all steps". The page only samples the server (every 2 s, 3-10 s
// while the backend restarts), and the backend, the web container and on a self-update the updater itself are recreated in the
// middle. So the polls of a real update see "pull running", then "restart running", then (after the reconnect) "succeeded": the
// step list used to flip verify, health and the rest in the same frame, the running highlight never visited them and the
// outcome landed on top. These tests feed exactly those snapshots and record every frame the list shows.
const T = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms: number) => new Date(T + ms).toISOString();
const steps = (s: Partial<Record<StepName, StepState>>): Record<StepName, StepState> => ({ pull: 'pending', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped', ...s });
const job = (over: Partial<UpdaterJob> = {}): UpdaterJob => ({
  id: '0123456789abcdef', action: 'update', state: 'running', step: null, from: 'sha-aaaaaaa', to: 'latest', startedAt: iso(0), finishedAt: null, error: null,
  steps: steps({}), ...over,
});
const rd = (over: Partial<Redeploy> = {}): Redeploy => ({
  id: 'abcdef0123456789', mode: 'api', tag: 'latest', phase: 'pulling', running: true, startedAt: iso(0), finishedAt: null,
  services: null, error: null, status: null, step: null, code: null, at: null, ...over,
});
const sig = (rows: readonly Pick<StepRow, 'key' | 'state'>[]) => rows.map((r) => `${r.key}:${r.state}`).join(' ');

/** a player on fake timers that records every flow it shows */
function recorder() {
  const shown: StepFlow[] = [];
  const p = stepPlayer<StepFlow>((f) => { shown.push(f); });
  return { p, shown, rows: () => shown.map((f) => sig(f.rows)) };
}
/** for each key, the index of the first frame it is shown `state` in (-1: never) */
const firstSeen = (frames: StepFlow[], key: string, state: string) => frames.findIndex((f) => f.rows.find((r) => r.key === key)?.state === state);

beforeEach(async () => { await setLocale('en'); vi.useFakeTimers(); });
afterEach(async () => { vi.useRealTimers(); await setLocale('de'); });

describe('the step list catches up with what the server did between two polls', () => {
  it('a real update as the polls see it: every step shows running and then done, in order, before the outcome lands', () => {
    const { p, shown } = recorder();
    // the 202 answer, then the polls: pull running; restart running (verify finished between two polls); backend away
    // (reconnecting: same rows); the answer once it is back: succeeded
    p.push(jobFlow(job(), { now: T }));
    p.push(jobFlow(job({ step: 'pull', steps: steps({ pull: 'running' }) }), { now: T + 2_000 }));
    p.push(jobFlow(job({ step: 'restart', steps: steps({ pull: 'ok', verify: 'ok', restart: 'running' }) }), { now: T + 40_000 }));
    p.push(jobFlow(job({ step: 'restart', steps: steps({ pull: 'ok', verify: 'ok', restart: 'running' }) }), { now: T + 46_000, reconnecting: true }));
    p.push(jobFlow(job({ state: 'succeeded', finishedAt: iso(70_000), steps: steps({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' }) }), { now: T + 75_000 }));
    vi.advanceTimersByTime(10 * STEP_DWELL_MS);

    const keys = ['pull', 'verify', 'restart', 'health'];
    for (const k of keys) {
      expect(firstSeen(shown, k, 'running'), `${k} shown running`).toBeGreaterThanOrEqual(0);
      expect(firstSeen(shown, k, 'ok'), `${k} done after running`).toBeGreaterThan(firstSeen(shown, k, 'running'));
    }
    // in order: a step is done before the next one is (pull and verify were both done in the poll that saw restart running)
    expect(firstSeen(shown, 'pull', 'ok')).toBeLessThan(firstSeen(shown, 'verify', 'ok'));
    expect(firstSeen(shown, 'verify', 'ok')).toBeLessThan(firstSeen(shown, 'restart', 'ok'));
    expect(firstSeen(shown, 'restart', 'ok')).toBeLessThan(firstSeen(shown, 'health', 'ok'));
    // never more than one step running, never a step done while one before it still waits
    for (const f of shown) {
      expect(f.rows.filter((r) => r.state === 'running').length).toBeLessThanOrEqual(1);
      const firstOpen = f.rows.findIndex((r) => r.state === 'waiting');
      if (firstOpen >= 0) expect(f.rows.slice(firstOpen).every((r) => r.state === 'waiting')).toBe(true);
    }
    // the outcome (note, green bar, "Finished") only once every row is done; the end is exactly the server's state
    const end = shown[shown.length - 1]!;
    expect(sig(end.rows)).toBe('pull:ok verify:ok restart:ok health:ok');
    expect(end).toMatchObject({ outcome: 'ok', progress: 1, count: 'Finished' });
    expect(end.note).toMatchObject({ result: 'succeeded' });
    for (const f of shown.filter((x) => x.rows.some((r) => r.state !== 'ok'))) expect(f).toMatchObject({ outcome: 'running', note: null });
  });

  it('each caught-up step stays on screen for a moment (no frame faster than the dwell time)', () => {
    const { p, shown } = recorder();
    p.push(jobFlow(job({ step: 'pull', steps: steps({ pull: 'running' }) })));
    const at = shown.length;
    p.push(jobFlow(job({ state: 'succeeded', finishedAt: iso(70_000), steps: steps({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' }) })));
    // the first catch-up frame at once (pull done, verify running), the next ones one dwell apart
    expect(shown.length).toBe(at + 1);
    expect(sig(shown[at]!.rows)).toBe('pull:ok verify:running restart:waiting health:waiting');
    vi.advanceTimersByTime(STEP_DWELL_MS - 1);
    expect(shown.length).toBe(at + 1);
    vi.advanceTimersByTime(1);
    expect(sig(shown[shown.length - 1]!.rows)).toBe('pull:ok verify:ok restart:running health:waiting');
    vi.advanceTimersByTime(2 * STEP_DWELL_MS);
    expect(shown[shown.length - 1]!.outcome).toBe('ok');
  });

  it('a Portainer redeploy seen only at "pulling" and then "done" (no updater listing) passes recreate and health too', () => {
    const { p, shown } = recorder();
    p.push(redeployFlow(rd(), { now: T + 4_000 }));
    p.push(redeployFlow(rd({ phase: 'done', running: false, finishedAt: iso(90_000) })));
    vi.advanceTimersByTime(10 * STEP_DWELL_MS);
    for (const k of ['recreating', 'health']) {
      expect(firstSeen(shown, k, 'running'), k).toBeGreaterThanOrEqual(0);
      expect(firstSeen(shown, k, 'ok'), k).toBeGreaterThan(firstSeen(shown, k, 'running'));
    }
    expect(shown[shown.length - 1]).toMatchObject({ outcome: 'ok', note: { result: 'done' } });
  });

  it('a failure is played up to the failed step: the steps before it pass, the failed one turns red last, later ones are skipped', () => {
    const { p, shown } = recorder();
    p.push(jobFlow(job({ step: 'pull', steps: steps({ pull: 'running' }) })));
    p.push(jobFlow(job({ state: 'failed', step: 'restart', finishedAt: iso(50_000), error: 'restart_failed', steps: steps({ pull: 'ok', verify: 'ok', restart: 'failed', health: 'skipped' }) })));
    vi.advanceTimersByTime(10 * STEP_DWELL_MS);
    expect(firstSeen(shown, 'verify', 'running')).toBeGreaterThanOrEqual(0);
    expect(firstSeen(shown, 'restart', 'running')).toBeGreaterThan(firstSeen(shown, 'verify', 'ok') - 1);
    expect(firstSeen(shown, 'health', 'running')).toBe(-1);
    const end = shown[shown.length - 1]!;
    expect(sig(end.rows)).toBe('pull:ok verify:ok restart:failed health:skipped');
    expect(end).toMatchObject({ outcome: 'failed', note: { result: 'failed' } });
  });

  it('the first state (a page load, a finished job) and reduced motion show the server\'s state at once, nothing replayed', () => {
    const { p, shown } = recorder();
    p.push(jobFlow(job({ state: 'succeeded', finishedAt: iso(70_000), steps: steps({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' }) })));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.outcome).toBe('ok');

    const still: StepFlow[] = [];
    const q = stepPlayer<StepFlow>((f) => { still.push(f); }, { instant: () => true });
    q.push(jobFlow(job({ step: 'pull', steps: steps({ pull: 'running' }) })));
    q.push(jobFlow(job({ state: 'succeeded', finishedAt: iso(70_000), steps: steps({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' }) })));
    expect(still).toHaveLength(2);
    expect(still[1]!.outcome).toBe('ok');
  });

  it('a poll with the same steps (the clock, a language switch, reconnecting) does not restart a catch-up, only refreshes the texts', () => {
    const { p, shown } = recorder();
    p.push(jobFlow(job({ step: 'pull', steps: steps({ pull: 'running' }) })));
    const done = job({ state: 'succeeded', finishedAt: iso(70_000), steps: steps({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' }) });
    p.push(jobFlow(done));
    vi.advanceTimersByTime(STEP_DWELL_MS);
    const mid = sig(shown[shown.length - 1]!.rows);
    p.push(jobFlow(done, { now: T + 80_000 }));
    expect(sig(shown[shown.length - 1]!.rows)).toBe(mid);
    vi.advanceTimersByTime(10 * STEP_DWELL_MS);
    expect(sig(shown[shown.length - 1]!.rows)).toBe('pull:ok verify:ok restart:ok health:ok');
  });

  it('stop() drops what is still queued (a card destroyed mid catch-up keeps no timer)', () => {
    const { p, shown } = recorder();
    p.push(jobFlow(job({ step: 'pull', steps: steps({ pull: 'running' }) })));
    p.push(jobFlow(job({ state: 'succeeded', finishedAt: iso(70_000), steps: steps({ pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' }) })));
    const n = shown.length;
    p.stop();
    vi.advanceTimersByTime(10 * STEP_DWELL_MS);
    expect(shown).toHaveLength(n);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('catchUp (the frames between two states)', () => {
  const rows = (s: string): StepRow[] => s.split(' ').map((x) => { const [key, state] = x.split(':'); return { key: key!, label: key!, state: state as StepRow['state'] }; });
  it('nothing shown yet: the state itself', () => {
    expect(catchUp(null, rows('a:ok b:running')).map((f) => f.join())).toEqual(['ok,running']);
  });
  it('a row that goes back (another job, a retry): no replay', () => {
    expect(catchUp(rows('a:ok b:ok'), rows('a:running b:waiting')).map((f) => f.join())).toEqual(['running,waiting']);
  });
  it('a skipped step is set at once (it never ran), a rollback row that appears takes its state', () => {
    expect(catchUp(rows('a:running b:waiting c:waiting'), rows('a:ok b:skipped c:skipped')).map((f) => f.join())).toEqual(['ok,skipped,skipped']);
    expect(catchUp(rows('a:ok b:running'), rows('a:ok b:failed rollback:running')).map((f) => f.join())).toEqual(['ok,failed,running']);
  });
  it('a step still "waiting" before one that already ran is done (the job runs its steps in order)', () => {
    expect(catchUp(null, rows('a:ok b:waiting c:running d:waiting')).at(-1)!.join()).toBe('ok,ok,running,waiting');
  });
});
