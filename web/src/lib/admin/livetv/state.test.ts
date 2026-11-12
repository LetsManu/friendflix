// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminSummary } from '../summary';
import { enableMode, errorKey, gpuKey, jobRunning, livetvJob, navGuess, navShown, otherJobRunning, phase, rememberNav, type LivetvAdminState } from './state';

const base = (): LivetvAdminState => ({
  installed: false, reachable: false, version: null, wanted: false, offerHidden: false,
  updater: { available: true, stack: 'own', job: null, livetv: { state: 'absent', container: null, error: null } },
  envLine: 'COMPOSE_PROFILES=livetv', benchmark: null, gpu: { jellyfin: null, livetv: null, advice: null },
});
const withUpdater = (s: LivetvAdminState, u: Partial<LivetvAdminState['updater']>): LivetvAdminState => ({ ...s, updater: { ...s.updater, ...u } });
const job = (o: Record<string, unknown> = {}) => ({
  id: 'j1', action: 'livetv-enable', state: 'running', step: 'pull', from: null, to: 'sha-abc1234', startedAt: '2026-11-12T10:00:00Z', finishedAt: null, error: null,
  steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' }, ...o,
}) as NonNullable<LivetvAdminState['updater']['job']>;
const summary = (livetv: AdminSummary['livetv']): AdminSummary => ({ livetv } as AdminSummary);

describe('enableMode', () => {
  it('own stack with an updater goes through the updater', () => {
    expect(enableMode(base())).toBe('updater');
  });
  it('a foreign stack (Portainer) shows the Portainer line, even with an updater', () => {
    expect(enableMode(withUpdater(base(), { stack: 'foreign' }))).toBe('portainer');
    expect(enableMode(withUpdater(base(), { available: false, stack: 'foreign' }))).toBe('portainer');
  });
  it('an own stack whose updater is from before livetv (no livetv in its status): update the updater first, no button', () => {
    expect(enableMode(withUpdater(base(), { livetv: null }))).toBe('updaterOld');
    // a foreign stack or no usable updater keep their own manual lines
    expect(enableMode(withUpdater(base(), { livetv: null, stack: 'foreign' }))).toBe('portainer');
    expect(enableMode(withUpdater(base(), { livetv: null, available: false, stack: null }))).toBe('env');
  });
  it('no updater, or one that does not know its stack, shows the .env line', () => {
    expect(enableMode(withUpdater(base(), { available: false, stack: null }))).toBe('env');
    expect(enableMode(withUpdater(base(), { stack: null }))).toBe('env');
  });
});

describe('navShown', () => {
  it('is hidden until the summary is there', () => { expect(navShown(null)).toBe(false); });
  it('shows the optional entry until it is hidden, and the area while installed', () => {
    expect(navShown(summary({ installed: false, offerHidden: false, failedSources: 0 }))).toBe(true);
    expect(navShown(summary({ installed: false, offerHidden: true, failedSources: 0 }))).toBe(false);
    expect(navShown(summary({ installed: true, offerHidden: true, failedSources: 0 }))).toBe(true);
  });
});

describe('jobRunning / livetvJob', () => {
  it('only a running job counts', () => {
    expect(jobRunning(base())).toBe(false);
    expect(jobRunning(withUpdater(base(), { job: job() }))).toBe(true);
    expect(jobRunning(withUpdater(base(), { job: job({ state: 'succeeded' }) }))).toBe(false);
  });
  it('livetvJob ignores the jobs of updates', () => {
    expect(livetvJob(withUpdater(base(), { job: job({ action: 'update' }) }))).toBeNull();
    expect(livetvJob(withUpdater(base(), { job: job() }))?.id).toBe('j1');
  });
});

describe('phase', () => {
  it('installed wins: the area', () => { expect(phase({ ...base(), installed: true, reachable: true }, false)).toBe('area'); });
  it('a running job is "working", also while installed is still false', () => {
    expect(phase(withUpdater(base(), { job: job() }), false)).toBe('working');
  });
  it('wanted but not reachable, no job: the service is down', () => {
    expect(phase({ ...base(), wanted: true }, false)).toBe('wantedDown');
  });
  it('right after a finished job the page waits for the detection instead of claiming the service is down', () => {
    expect(phase({ ...base(), wanted: true }, true)).toBe('settling');
  });
  it('a failed or rolled back enable is not "turned on", although the backend keeps wanted', () => {
    expect(phase(withUpdater({ ...base(), wanted: true }, { job: job({ state: 'rolled_back', error: 'unhealthy' }) }), false)).toBe('offer');
    expect(phase(withUpdater({ ...base(), wanted: true }, { job: job({ state: 'failed', error: 'pull_failed' }) }), false)).toBe('offer');
    // an older failed update job says nothing about it
    expect(phase(withUpdater({ ...base(), wanted: true }, { job: job({ action: 'update', state: 'failed' }) }), false)).toBe('wantedDown');
  });
  it('never enabled: the offer', () => { expect(phase(base(), false)).toBe('offer'); });
});

describe('errorKey', () => {
  it('maps the known codes and nothing else', () => {
    for (const c of ['pull_failed', 'verify_failed', 'restart_failed', 'unhealthy', 'unexpected_image', 'config_mismatch', 'compose_config', 'remove_failed', 'rollback_failed', 'no_updater', 'foreign_stack', 'busy']) expect(errorKey(c)).toBe(c);
    // installs from before Live TV (1b review I3): each its own advice, never the generic line or "unexpected image"
    for (const c of ['updater_outdated', 'compose_outdated', 'network_missing']) expect(errorKey(c)).toBe(c);
    expect(errorKey('rm -rf')).toBe('generic');
    expect(errorKey(null)).toBe('generic');
    expect(errorKey('weird_new_code')).toBe('generic');
  });
});

describe('gpuKey', () => {
  it('null advice is no advice, never "CPU only"', () => { expect(gpuKey(null)).toBeNull(); });
  it('words each advice, the both line with and without a driver', () => {
    expect(gpuKey({ level: 'info', key: 'cpuOnly' })).toBe('cpuOnly');
    expect(gpuKey({ level: 'ok', key: 'both', driver: 'iHD' })).toBe('both');
    expect(gpuKey({ level: 'ok', key: 'both' })).toBe('bothPlain');
    expect(gpuKey({ level: 'warn', key: 'needsOverlay' })).toBe('needsOverlay');
  });
});

describe('other jobs', () => {
  it('an app update running is not a livetv job: no "working", but it is named', () => {
    const s = withUpdater(base(), { job: job({ action: 'update' }) });
    expect(phase(s, false)).toBe('offer');
    expect(otherJobRunning(s)).toBe(true);
    expect(otherJobRunning(withUpdater(base(), { job: job() }))).toBe(false);
  });
});

describe('navGuess', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('remembers whether the row was shown; the first visit guesses shown', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    expect(navGuess()).toBe(true);
    rememberNav(false);
    expect(navGuess()).toBe(false);
    rememberNav(true);
    expect(navGuess()).toBe(true);
  });
  it('without storage it guesses shown', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(navGuess()).toBe(true);
    expect(() => rememberNav(false)).not.toThrow();
  });
});
