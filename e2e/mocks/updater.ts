// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsMock } from './settings.js';

/**
 * A fake opt-in updater behind GET/POST /api/admin/updater (backend/src/routes/updater.ts). Not installed by default
 * (`present: false`, Admin → Update keeps the manual steps). A started job advances one step per poll: pull → verify → restart,
 * then `downPolls` polls answered 502 (the backend restarting), then health → done, or (outcome rolled_back) health failed →
 * rollback → rolled back.
 */
export interface UpdaterMock {
  present: boolean | 'unauthorized';
  current: string | null;
  previous: string | null;
  job: any;
  log: string[];
  /** POSTed actions */
  posts: string[];
  outcome: 'succeeded' | 'rolled_back';
  downPolls: number;
  tick: number;
  /** the updater's stack field (foreign = Portainer's stack); undefined = an updater from before it */
  stack?: 'own' | 'foreign';
  /** why foreign and the two directories (status fields stackReason / stackDir / projectDir) */
  stackReason?: 'working_dir' | 'portainer' | 'no_labels';
  stackDir?: string;
  projectDir?: string;
  /** the Portainer webhook / API is set up in Admin → Settings (GET answers portainer.configured) */
  portainer?: boolean;
}
type Reply = (b: unknown, status?: number) => Promise<void>;

export function updaterState(present: UpdaterMock['present'] = false): UpdaterMock {
  return { present, current: 'latest', previous: 'sha-a1b2c3d', job: null, log: ['2026-10-17T04:00:00.000Z update succeeded'], posts: [], outcome: 'succeeded', downPolls: 2, tick: 0 };
}

const value = (s: SettingsMock, key: string) => s.groups.flatMap((g) => g.items).find((i) => i.key === key);

function advance(u: UpdaterMock): boolean {
  const j = u.job;
  if (!j || j.state !== 'running') return true;
  const n = u.tick++;
  const set = (step: string, steps: Record<string, string>) => { j.step = step; Object.assign(j.steps, steps); };
  if (n === 0) set('verify', { pull: 'ok', verify: 'running' });
  else if (n === 1) set('restart', { verify: 'ok', restart: 'running' });
  else if (n < 2 + u.downPolls) return false; // the backend is restarting
  else if (n === 2 + u.downPolls) set('health', { restart: 'ok', health: 'running' });
  else if (u.outcome === 'rolled_back' && j.steps.rollback !== 'running') set('rollback', { health: 'failed', rollback: 'running' });
  else {
    const rolled = u.outcome === 'rolled_back';
    Object.assign(j.steps, rolled ? { rollback: 'ok' } : { health: 'ok' });
    j.state = rolled ? 'rolled_back' : 'succeeded';
    j.error = rolled ? 'unhealthy' : null;
    j.step = rolled ? 'rollback' : null;
    j.finishedAt = new Date().toISOString();
    if (!rolled) { u.previous = j.from; u.current = j.to; }
    u.log.push(`${j.finishedAt} ${j.action} ${j.state}`);
  }
  return true;
}

export function updaterRoute(u: UpdaterMock | null, settings: SettingsMock, m: string, p: string, J: Reply): Promise<void> | null {
  const auto = { mode: value(settings, 'AUTO_UPDATE')?.value ?? 'off', time: value(settings, 'AUTO_UPDATE_TIME')?.value ?? '04:00', locked: [] as string[] };
  const ch = value(settings, 'UPDATE_CHANNEL')?.value ?? 'stable';
  const ver = value(settings, 'UPDATE_VERSION')?.value ?? null;
  const target = ch === 'nightly' ? 'nightly' : ch === 'pinned' ? ver : 'latest';
  if (p === '/api/admin/updater' && m === 'GET') {
    const portainer = { configured: Boolean(u?.portainer), mode: u?.portainer ? 'webhook' : null };
    if (!u || !u.present) return J({ present: false, autoUpdate: auto, portainer });
    if (u.present === 'unauthorized') return J({ present: true, error: 'unauthorized', autoUpdate: auto, portainer });
    if (!advance(u)) return J({ error: 'bad_gateway' }, 502);
    const busy = u.job?.state === 'running';
    return J({ present: true, autoUpdate: auto, portainer, status: { ...(u.stack ? { stack: u.stack } : {}), ...(u.stackReason ? { stackReason: u.stackReason, stackDir: u.stackDir, projectDir: u.projectDir } : {}),
      updater: { version: '1.1.0', sha: null }, channel: ch, version: ch === 'pinned' ? ver : null, targetTag: target, current: u.current, previous: u.previous, busy,
      job: u.job, log: u.log.slice(-30), services: [{ service: 'backend', state: 'running', health: 'healthy', sha: 'sha-c0be6c5', version: '1.0.0' }],
    } });
  }
  const mm = p.match(/^\/api\/admin\/updater\/(update|rollback|self-update)$/);
  if (mm && m === 'POST') {
    if (!u || !u.present) return J({ error: 'not_available' }, 409);
    u.posts.push(mm[1]!);
    // Portainer's stack: the backend hands an update to Portainer, refuses everything else (backend/src/updater.ts startJob)
    if (u.stack === 'foreign' || (u.portainer && u.stack !== 'own')) return mm[1] === 'update' && u.portainer ? J({ portainer: { mode: 'webhook' } }, 202) : J({ error: 'foreign_stack' }, 409);
    if (u.job?.state === 'running') return J({ error: 'busy' }, 409);
    if (mm[1] === 'rollback' && !u.previous) return J({ error: 'no_previous' }, 409);
    const to = mm[1] === 'rollback' ? u.previous : target;
    u.tick = 0;
    u.job = { id: '0123456789abcdef', action: mm[1], state: 'running', step: 'pull', from: 'sha-c0be6c5', to, startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'running', verify: 'pending', restart: 'pending', health: mm[1] === 'self-update' ? 'skipped' : 'pending', rollback: 'skipped' } };
    return J({ job: u.job }, 202);
  }
  return null;
}

/**
 * The updater's job of the optional livetv service (backend UpdaterJob, action livetv-enable / livetv-disable / livetv-remove). An enable
 * walks pull -> verify -> restart -> health, a disable has only the restart step. `advanceLivetvJob` moves it one step per call and tells
 * when it ended; `outcome` is how (succeeded, failed with `error`, or rolled_back with the rollback step, a failed first enable cleaned up).
 */
export type LivetvJobOutcome = 'succeeded' | 'failed' | 'rolled_back';
export function livetvJob(action: 'livetv-enable' | 'livetv-disable' | 'livetv-remove'): any {
  const enable = action === 'livetv-enable';
  return {
    id: 'fedcba9876543210', action, state: 'running', step: enable ? 'pull' : 'restart', from: null, to: 'sha-c0be6c5', startedAt: new Date().toISOString(), finishedAt: null, error: null,
    steps: enable
      ? { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' }
      : { pull: 'skipped', verify: 'skipped', restart: 'running', health: 'skipped', rollback: 'skipped' },
  };
}
/** one step further; returns true when the job ended in this call */
export function advanceLivetvJob(j: any, tick: number, polls: number, outcome: LivetvJobOutcome, error: string | null): boolean {
  if (!j || j.state !== 'running') return false;
  const enable = j.action === 'livetv-enable';
  const set = (step: string, steps: Record<string, string>) => { j.step = step; Object.assign(j.steps, steps); };
  if (enable && tick < polls - 1) {
    const order = ['pull', 'verify', 'restart', 'health'];
    const i = Math.min(tick + 1, order.length - 1);
    set(order[i]!, { ...Object.fromEntries(order.slice(0, i).map((k) => [k, 'ok'])), [order[i]!]: 'running' });
    return false;
  }
  if (!enable && tick < polls - 1) return false;
  j.finishedAt = new Date().toISOString();
  if (outcome === 'succeeded') {
    Object.assign(j.steps, enable ? { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok' } : { restart: 'ok' });
    j.state = 'succeeded'; j.step = null;
  } else if (outcome === 'rolled_back') {
    Object.assign(j.steps, { pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'ok' });
    j.state = 'rolled_back'; j.step = 'rollback'; j.error = error ?? 'unhealthy';
  } else {
    Object.assign(j.steps, enable ? { pull: 'failed' } : { restart: 'failed' });
    j.state = 'failed'; j.step = null; j.error = error ?? 'pull_failed';
  }
  return true;
}
