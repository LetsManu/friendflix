// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { ApiError } from '#lib/api';
import { TIME_RE, canRollback, failReason, foreignMode, foreignText, isRunning, nextPoll, portainerMissing, redeployResult, redeployRunning, redeploySteps, startError, statusOf, visibleSteps, type Redeploy, type UpdaterJob, type UpdaterStatus } from './updater';

const job = (over: Partial<UpdaterJob> = {}): UpdaterJob => ({
  id: '0123456789abcdef', action: 'update', state: 'running', step: 'pull', from: 'sha-aaaaaaa', to: 'latest', startedAt: '2026-10-18T04:00:00.000Z', finishedAt: null, error: null,
  steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' }, ...over,
});
const status = (over: Partial<UpdaterStatus> = {}): UpdaterStatus => ({
  updater: { version: '1.1.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: 'sha-aaaaaaa', busy: false, job: null, log: [], services: [], ...over,
});

afterEach(async () => { await setLocale('de'); });

describe('updater panel logic', () => {
  it('startError: a stale webhook has its own text in every locale', async () => {
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      const t = startError({ status: 502, body: { error: 'webhook_gone' } });
      expect(t).not.toBe(startError({ status: 502, body: { error: 'nope' } }));
      expect(t).toMatch(/webhook/i);
    }
  });

  it('steps: the four, rollback once it ran, no health step for a self-update', () => {
    expect(visibleSteps(job())).toEqual(['pull', 'verify', 'restart', 'health']);
    expect(visibleSteps(job({ steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'running' } }))).toEqual(['pull', 'verify', 'restart', 'health', 'rollback']);
    expect(visibleSteps(job({ action: 'self-update' }))).toEqual(['pull', 'verify', 'restart']);
  });

  it('status, running and rollback availability', () => {
    expect(statusOf(null)).toBeNull();
    expect(statusOf({ present: false })).toBeNull();
    expect(statusOf({ present: true, error: 'unauthorized' })).toBeNull();
    expect(statusOf({ present: true, status: status() })?.current).toBe('latest');
    expect(isRunning(job())).toBe(true);
    expect(isRunning(job({ state: 'failed' }))).toBe(false);
    expect(isRunning(null)).toBe(false);
    expect(canRollback(status())).toBe(true);
    expect(canRollback(status({ previous: null }))).toBe(false);
    expect(canRollback(status({ busy: true }))).toBe(false);
    expect(canRollback(status({ job: job() }))).toBe(false);
    expect(canRollback(null)).toBe(false);
    expect(nextPoll(false)).toBe(2000);
    expect(nextPoll(true)).toBe(3000);
    for (const ok of ['00:00', '04:00', '23:59']) expect(TIME_RE.test(ok)).toBe(true);
    for (const bad of ['4:00', '24:00', '12:60', '']) expect(TIME_RE.test(bad)).toBe(false);
  });

  it('a foreign (Portainer) stack: update through Portainer when it is set up, else the manual note; never a rollback', () => {
    const foreign = status({ stack: 'foreign' });
    expect(foreignMode({ present: true, status: foreign, portainer: { configured: true, mode: 'webhook' } })).toBe('portainer');
    expect(foreignMode({ present: true, status: foreign, portainer: { configured: false, mode: null } })).toBe('manual');
    expect(foreignMode({ present: true, status: foreign })).toBe('manual'); // an older backend without the portainer field
    expect(foreignMode({ present: true, status: status({ stack: 'own' }), portainer: { configured: true, mode: 'api' } })).toBeNull();
    expect(foreignMode({ present: true, status: status() })).toBeNull(); // an older updater: no stack field
    expect(foreignMode({ present: false })).toBeNull();
    expect(canRollback(foreign)).toBe(false);
    // an older updater (or one that cannot tell) with Portainer set up: the backend goes through Portainer, so does the page
    expect(foreignMode({ present: true, status: status(), portainer: { configured: true, mode: 'webhook' } })).toBe('portainer');
    // started from another directory (sudo, a GUI without PWD): not Portainer, the fix is UPDATER_PROJECT_DIR
    const wd = status({ stack: 'foreign', stackReason: 'working_dir', stackDir: '/volume1/docker/friendflix', projectDir: '/project' });
    expect(foreignMode({ present: true, status: wd, portainer: { configured: false, mode: null } })).toBe('workdir');
    expect(foreignMode({ present: true, status: { ...wd, stackDir: '/data/compose/4' } })).toBe('manual'); // Portainer's directory after all
    expect(foreignMode({ present: true, status: { ...wd, stackReason: 'portainer' } })).toBe('manual');
  });

  it('the notes name the directories and the fix', async () => {
    await setLocale('en');
    const wd = status({ stack: 'foreign', stackReason: 'working_dir', stackDir: '/volume1/docker/friendflix', projectDir: '/project' });
    const text = foreignText('workdir', wd);
    expect(text).toContain('/volume1/docker/friendflix');
    expect(text).toContain('/project');
    expect(text).toContain('UPDATER_PROJECT_DIR=/volume1/docker/friendflix');
    expect(foreignText('manual', wd)).toBe(tr('admin.update.updater.foreign.manual'));
    expect(foreignText('portainer', wd)).toBe(tr('admin.update.updater.foreign.portainer'));
  });

  it('error texts: known codes, rate limit, unknown codes never shown raw', async () => {
    await setLocale('en');
    expect(failReason('verify_failed')).toBe(tr('admin.update.updater.failReason.verify_failed'));
    expect(failReason('<b>x</b>')).toBe(tr('admin.update.updater.failReason.unknown'));
    expect(failReason(null)).toBe(tr('admin.update.updater.failReason.unknown'));
    expect(startError(new ApiError(429, {}))).toBe(tr('admin.update.updater.error.tooSoon'));
    expect(startError(new ApiError(409, { error: 'busy' }))).toBe(tr('admin.update.updater.error.busy'));
    expect(startError(new ApiError(409, { error: 'whatever' }))).toBe(tr('admin.update.updater.error.generic'));
    expect(startError(null)).toBe(tr('admin.update.updater.error.generic'));
    expect(startError(new ApiError(409, { error: 'foreign_stack' }))).toBe(tr('admin.update.updater.error.foreign_stack'));
    expect(startError(new ApiError(502, { error: 'portainer', status: 500, step: 'webhook' }))).toBe(tr('admin.update.updater.error.portainer'));
    expect(failReason('foreign_stack')).toBe(tr('admin.update.updater.failReason.foreign_stack'));
    expect(failReason('config_mismatch')).toBe(tr('admin.update.updater.failReason.config_mismatch'));
  });

  it('every updater string exists in all seven languages', async () => {
    const keys = ['title', 'intro', 'installed', 'previous', 'target', 'none', 'updateNow', 'rollback', 'selfUpdate', 'selfHint', 'advanced', 'confirm.update', 'confirm.rollback',
      'confirm.self-update', 'confirmGo', 'cancel', 'step.pull', 'step.verify', 'step.restart', 'step.health', 'step.rollback', 'state.pending', 'state.running', 'state.ok',
      'state.failed', 'state.skipped', 'running', 'reconnecting', 'watchTimeout', 'lastJob', 'result.succeeded', 'result.rolled_back', 'result.failed', 'error.busy', 'error.no_previous',
      'error.no_target', 'error.not_available', 'error.channel_sync_failed', 'error.tooSoon', 'error.generic', 'failReason.verify_failed', 'failReason.pull_failed',
      'failReason.unhealthy', 'failReason.restart_failed', 'failReason.rollback_failed', 'failReason.interrupted', 'failReason.self_update_timeout', 'failReason.unexpected_image', 'failReason.media_server_mismatch',
      'failReason.compose_config', 'failReason.unknown', 'unauthorized', 'invalid', 'log', 'auto.title', 'auto.label', 'auto.off', 'auto.window', 'auto.time',
      'auto.save', 'auto.saved', 'auto.locked', 'auto.hint', 'auto.timeInvalid', 'foreign.portainer', 'foreign.manual', 'foreign.started', 'foreign.workdir', 'confirm.updatePortainer', 'error.foreign_stack', 'error.portainer',
      'error.portainer_unreachable', 'failReason.foreign_stack', 'failReason.config_mismatch'];
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
      await setLocale(l);
      for (const k of keys) expect(hasKey(`admin.update.updater.${k}`), `${l} ${k}`).toBe(true);
    }
  });

  it('a Portainer redeploy: its phase as steps, the outcome line (status and step of a refusal only), polling while it runs', async () => {
    const rd = (over: Partial<Redeploy> = {}): Redeploy => ({ id: 'abcdef0123456789', mode: 'api', tag: 'latest', phase: 'pulling', running: true, startedAt: '2026-11-14T10:00:00.000Z', finishedAt: null,
      services: null, error: null, status: null, step: null, code: null, at: null, ...over });
    expect(redeploySteps(rd())).toEqual({ pulling: 'running', recreating: 'pending', health: 'pending' });
    expect(redeploySteps(rd({ phase: 'recreating' }))).toEqual({ pulling: 'ok', recreating: 'running', health: 'pending' });
    expect(redeploySteps(rd({ phase: 'health' }))).toEqual({ pulling: 'ok', recreating: 'ok', health: 'running' });
    expect(redeploySteps(rd({ phase: 'done' }))).toEqual({ pulling: 'ok', recreating: 'ok', health: 'ok' });
    expect(redeploySteps(rd({ phase: 'unchanged' }))).toEqual({ pulling: 'ok', recreating: 'skipped', health: 'skipped' });
    expect(redeploySteps(rd({ phase: 'failed' }))).toEqual({ pulling: 'failed', recreating: 'skipped', health: 'skipped' });
    expect(redeploySteps(rd({ phase: 'timeout', at: 'health' }))).toEqual({ pulling: 'ok', recreating: 'ok', health: 'failed' });
    expect(redeployRunning({ present: false, redeploy: rd() })).toBe(true);
    expect(redeployRunning({ present: false, redeploy: rd({ phase: 'done', running: false }) })).toBe(false);
    expect(redeployRunning({ present: false })).toBe(false);
    await setLocale('en');
    expect(redeployResult(rd())).toBe('');
    expect(redeployResult(rd({ phase: 'failed', running: false, error: 'portainer', status: 500, step: 'redeploy' }))).toBe('Portainer refused the redeploy (HTTP 500, step redeploy). Check the stack in Portainer and the Portainer settings in Admin → Settings → Updates.');
    expect(redeployResult(rd({ phase: 'unchanged', running: false, tag: 'nightly' }))).toContain('the images for nightly have nothing newer');
    expect(redeployResult(rd({ phase: 'timeout', running: false, at: 'recreating' }))).toBe('Nothing changed within 15 minutes (Recreate containers). Check the stack and its logs in Portainer.');
    // not reachable: its own text with the errno code and the hint; a fixed version without a number: its own text
    expect(redeployResult(rd({ phase: 'failed', running: false, error: 'portainer_unreachable', code: 'ENOTFOUND', step: 'stack' })))
      .toBe('Portainer was not reachable (ENOTFOUND: host name cannot be resolved, use the IP instead of nas.local). Check PORTAINER_URL in Admin → Settings → Updates: it must be an address the backend can reach.');
    expect(redeployResult(rd({ phase: 'failed', running: false, error: 'portainer_unreachable', code: null }))).toMatch(/^Portainer was not reachable\. /);
    // a webhook that Portainer answers with 404: the address is stale, the text says what to do (no status, no URL)
    expect(redeployResult(rd({ phase: 'failed', running: false, error: 'webhook_gone', status: 404, step: 'webhook' }))).toBe('The Portainer webhook address is no longer valid (Portainer issues a new one when the stack is recreated or its webhook is switched off and on). Create a new webhook in Portainer, or remove it in Admin → Settings → Updates and use the API settings instead.');
    expect(redeployResult(rd({ phase: 'failed', running: false, error: 'no_target' }))).toBe('Nothing was started: choose a version for the “Fixed version” channel first.');
  });

  it('the Portainer API set up only in part: the missing setting is named with where the stack ID is; such a stack counts as Portainer\'s', async () => {
    await setLocale('en');
    expect(portainerMissing({ missing: [] })).toBeNull();
    expect(portainerMissing(undefined)).toBeNull();
    const note = portainerMissing({ missing: ['PORTAINER_STACK_ID', '<b>'] })!;
    expect(note).toContain('PORTAINER_STACK_ID missing');
    expect(note).not.toContain('<b>');
    expect(note).toContain('?id=12');
    // an updater that cannot tell the stack (null) with the API half set up: the backend refuses the updater job, the page says why
    expect(foreignMode({ present: true, status: status({ stack: null }), portainer: { configured: false, mode: null, missing: ['PORTAINER_STACK_ID'] } })).toBe('manual');
    expect(foreignMode({ present: true, status: status({ stack: 'own' }), portainer: { configured: false, mode: null, missing: ['PORTAINER_STACK_ID'] } })).toBeNull();
    expect(foreignText('manual', null)).toContain('PORTAINER_STACK_ID');
    expect(failReason('compose_config')).toContain('Portainer');
  });
});
