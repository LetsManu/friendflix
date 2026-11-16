// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dayKey, diskAlerts, isoWeek, portainerFailedAlert, updateAlertTick, updateFailedAlert,
} from '../src/adminAlerts.js';
import type { Config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import type { DiskHealth, HealthSnapshot } from '../src/health.js';
import * as notify from '../src/notify.js';
import { line, registerChecks, resetChecksForTests, type GroupCheck } from '../src/syscheck/engine.js';
import type { CheckId, CheckLine, CheckStatus } from '../src/syscheck/types.js';
import { syscheckAlertTick } from '../src/syscheckAlerts.js';
import type { UpdaterJob } from '../src/updater.js';
import { updateInfo } from '../src/updates.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Mail stage C, Task 3: the four admin alerts (update available, update failed, Systemcheck problem, full storage). Each is an admin
// notice with a mail type; these tests drive the detection: once per version / job / day, no storms, no alert for a friend.
const MAIL_CFG: Partial<Config> = { MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com', PUBLIC_URL: 'https://friend.example.com' };
const CUR = 'c'.repeat(40);

let env: TestEnv;
let anna = '', carla = '', ben = '';

/** a fake GitHub: the newest release tag, the newest CI build on main (nightly) and whether it fails; counts its requests */
const gh = { release: 'v3.6.0' as string | null, mainSha: 'd'.repeat(40), fail: false, calls: 0 };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const ghFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const u = new URL(String(input));
  if (u.host !== 'api.github.com') return json({}, 404);
  gh.calls++;
  if (gh.fail) return json({}, 500);
  if (u.pathname.endsWith('/releases/latest')) return gh.release ? json({ tag_name: gh.release, name: gh.release, html_url: 'https://github.com/x/r', published_at: '2026-11-01T00:00:00Z', body: '' }) : json({}, 404);
  if (u.pathname.includes('/actions/workflows/')) return json({ workflow_runs: env.ctx.cfg.UPDATE_CHANNEL === 'nightly' ? [{ head_sha: gh.mainSha, updated_at: '2026-11-16T00:00:00Z', html_url: 'https://github.com/x/runs/1' }] : [] });
  if (u.pathname.includes(`/compare/${CUR}...`)) return json({ ahead_by: 2, commits: [] });
  return json({}, 404);
};

const at = (d: number, h = 10, min = 0) => new Date(2026, 10, d, h, min);
const notices = async (kind: string) => (await env.pool.query<{ user_id: string; title: string; body: string | null; link: string | null; dedupe: string }>(
  'select user_id, title, body, link, dedupe from notifications where kind = $1 order by id', [kind])).rows;
const mails = async (kind: string) => (await env.pool.query<{ user_id: string; dedupe: string }>('select user_id, dedupe from mail_outbox where kind = $1 order by created_at', [kind])).rows;
/** the 6-h lock ran out and the GitHub answer cache too (both live in kv with a TTL) */
const nextUpdateWindow = async () => { for (const p of ['alerts:update:', 'update:']) for (const k of await env.kv.keys(p)) await env.kv.del(k); };

async function addUser(sub: string, email: string, name: string, role: 'admin' | 'friend'): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    'insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, sub, email, name, role, sub.padEnd(32, '0'), sub, encrypt(env.ctx.encKey, 'pw')]);
  await env.pool.query('insert into profiles(id, user_id, name, is_owner) values ($1, $1, $2, true)', [id, name]);
  return id;
}

beforeAll(async () => {
  env = await makeEnv();
  env.ctx.fetchImpl = ghFetch as typeof fetch;
  anna = await addUser('sub-anna', 'anna@friend.example.com', 'Anna Beispiel', 'admin');
  carla = await addUser('sub-carla', 'carla@friend.example.com', 'Carla Muster', 'admin');
  ben = await addUser('sub-ben', 'ben@friend.example.com', 'Ben Muster', 'friend');
});
afterAll(() => env.close());
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  env.ctx.cfg = { ...cfg, ...MAIL_CFG, APP_VERSION: '3.5.0', GIT_SHA: 'dev', UPDATE_CHANNEL: 'stable' };
  Object.assign(gh, { release: 'v3.6.0', mainSha: 'd'.repeat(40), fail: false, calls: 0 });
  await env.pool.query('delete from notifications; delete from mail_outbox');
  for (const p of ['alerts:', 'update:', 'syscheck:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
});

describe('day and week keys', () => {
  it('server-local day and ISO week', () => {
    expect(dayKey(at(16, 0, 5))).toBe('2026-11-16');
    expect(dayKey(new Date(2026, 0, 3, 23, 59))).toBe('2026-01-03');
    expect(isoWeek(at(16))).toBe('2026-W47');
    expect(isoWeek(at(22, 23, 59))).toBe('2026-W47');
    expect(isoWeek(at(23, 0, 0))).toBe('2026-W48');
    // the first days of January can belong to the last week of the year before
    expect(isoWeek(new Date(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(new Date(2026, 0, 1))).toBe('2026-W01');
  });
});

describe('update available', () => {
  it('update available notifies each admin once per version', async () => {
    expect(await updateAlertTick(env.ctx, at(16))).toBe(2);
    const n = await notices('update_available');
    expect(n.map((x) => x.user_id).sort()).toEqual([anna, carla].sort());
    expect(n[0]).toMatchObject({
      title: 'Neue Version verfügbar: 3.6.0', body: 'Unter Admin → Update siehst du, was neu ist, und installierst sie.', link: '/admin/update',
      dedupe: `update-avail-stable-3.6.0-${anna}`,
    });
    expect((await mails('update')).map((r) => r.dedupe).sort()).toEqual([`n:update-avail-stable-3.6.0-${anna}`, `n:update-avail-stable-3.6.0-${carla}`].sort());
    expect((await mails('update')).map((r) => r.user_id)).not.toContain(ben);
    // after the 6-h lock: the same version is not told again
    await nextUpdateWindow();
    expect(await updateAlertTick(env.ctx, at(16, 17))).toBe(0);
    expect(await notices('update_available')).toHaveLength(2);
    expect(await mails('update')).toHaveLength(2);
    // a newer release is
    gh.release = 'v3.6.1';
    await nextUpdateWindow();
    expect(await updateAlertTick(env.ctx, at(17))).toBe(2);
    expect((await notices('update_available')).slice(2).map((x) => x.title)).toEqual(['Neue Version verfügbar: 3.6.1', 'Neue Version verfügbar: 3.6.1']);
    expect(await mails('update')).toHaveLength(4);
  });

  it('the pinned channel alerts once for its version', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: '3.5.2' };
    expect(await updateAlertTick(env.ctx, at(16))).toBe(2);
    expect((await notices('update_available'))[0]).toMatchObject({ title: 'Neue Version verfügbar: 3.5.2', dedupe: `update-avail-pinned-3.5.2-${anna}` });
  });

  it('the update check runs at most every 6 hours', async () => {
    gh.release = 'v3.5.0'; // nothing new: the check ran, nothing to tell
    expect(await updateAlertTick(env.ctx, at(16, 10))).toBe(0);
    const calls = gh.calls;
    expect(calls).toBeGreaterThan(0);
    gh.release = 'v3.6.0';
    for (const k of await env.kv.keys('update:')) await env.kv.del(k); // no cached GitHub answer either
    expect(await updateAlertTick(env.ctx, at(16, 11))).toBe(0);
    expect(gh.calls).toBe(calls);
    expect(await notices('update_available')).toEqual([]);
  });

  it('nightly alerts at most once a week', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, UPDATE_CHANNEL: 'nightly', GIT_SHA: CUR };
    gh.mainSha = '1234567'.padEnd(40, 'a');
    expect(await updateAlertTick(env.ctx, at(16))).toBe(2);
    const first = await notices('update_available');
    expect(first[0]).toMatchObject({ title: 'Neue Version verfügbar: nightly · 1234567', dedupe: `update-avail-nightly-2026-W47-${anna}` });
    // another nightly build later in the same week: no second mail
    gh.mainSha = '89abcde'.padEnd(40, 'b');
    await nextUpdateWindow();
    expect(await updateAlertTick(env.ctx, at(19))).toBe(0);
    expect(await notices('update_available')).toHaveLength(2);
    // the next week
    await nextUpdateWindow();
    expect(await updateAlertTick(env.ctx, at(24))).toBe(2);
    expect((await notices('update_available')).at(-1)).toMatchObject({ title: 'Neue Version verfügbar: nightly · 89abcde' });
    expect(await mails('update')).toHaveLength(4);
  });

  it('no update alert while the nightly window installs updates', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, AUTO_UPDATE: 'nightly-window', UPDATER_URL: 'http://updater:7070' };
    expect(await updateAlertTick(env.ctx, at(16))).toBe(0);
    expect(gh.calls).toBe(0);
    // the window without an updater installs nothing: the admins are told
    env.ctx.cfg = { ...env.ctx.cfg, UPDATER_URL: undefined };
    expect(await updateAlertTick(env.ctx, at(16))).toBe(2);
  });

  it('none when updateAvailable is false or null', async () => {
    gh.release = 'v3.5.0';
    expect(await updateAlertTick(env.ctx, at(16))).toBe(0);
    await nextUpdateWindow();
    gh.fail = true; // GitHub down: updateAvailable null
    expect(await updateAlertTick(env.ctx, at(16, 17))).toBe(0);
    expect(await notices('update_available')).toEqual([]);
  });

  it('a failed notice gives the 6-h lock back', async () => {
    vi.spyOn(notify, 'notifyAdmins').mockRejectedValueOnce(new Error('database down'));
    await expect(updateAlertTick(env.ctx, at(16))).rejects.toThrow('database down');
    expect(await env.kv.get('alerts:update:tick')).toBeNull();
    expect(await updateAlertTick(env.ctx, at(16))).toBe(2);
  });
});

describe('update failed', () => {
  const job = (o: Partial<UpdaterJob> = {}): UpdaterJob => ({
    id: 'job-7', action: 'update', state: 'rolled_back', step: null,
    steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'failed', rollback: 'ok' }, from: '3.5.0', to: '3.6.0',
    startedAt: '2026-11-16T03:00:00.000Z', finishedAt: '2026-11-16T03:04:00.000Z', error: 'unhealthy', ...o,
  });

  it('failed and rolled-back update jobs alert once', async () => {
    expect(await updateFailedAlert(env.ctx, job())).toBe(2);
    const n = await notices('update_failed');
    expect(n[0]).toMatchObject({
      title: 'Update auf 3.6.0 fehlgeschlagen', body: 'Die bisherige Version läuft weiter. Was schiefging, steht unter Admin → Update.', link: '/admin/update',
      dedupe: `update-failed-job-7-${anna}`,
    });
    expect(await updateFailedAlert(env.ctx, job())).toBe(0);
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-8', state: 'succeeded' }))).toBe(0);
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-9', state: 'running' }))).toBe(0);
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-10', action: 'livetv-enable', state: 'failed' }))).toBe(0);
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-11', action: 'self-update', state: 'failed' }))).toBe(2);
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-12', action: 'rollback', state: 'failed', to: '3.4.0' }))).toBe(2);
    expect((await mails('updatefailed')).length).toBe(6);
    expect((await notices('update_failed')).map((x) => x.title)).toEqual([
      ...Array(4).fill('Update auf 3.6.0 fehlgeschlagen'), ...Array(2).fill('Zurück zur vorherigen Version fehlgeschlagen')]);
  });

  it('a tag that is no version names the cached release, else no version', async () => {
    // nothing cached: the stable tag says nothing an admin can use
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-20', to: 'latest' }))).toBe(2);
    expect(gh.calls).toBe(0); // no GitHub request for a title
    await updateInfo(env.ctx); // Admin -> Update was opened: the newest release (3.6.0) is cached
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-21', to: 'latest' }))).toBe(2);
    // a nightly or sha tag is not the release: no version
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-22', to: 'nightly' }))).toBe(2);
    expect(await updateFailedAlert(env.ctx, job({ id: 'job-23', to: 'sha-abcdef1' }))).toBe(2);
    expect((await notices('update_failed')).filter((x) => x.user_id === anna).map((x) => x.title)).toEqual([
      'Update fehlgeschlagen', 'Update auf 3.6.0 fehlgeschlagen', 'Update fehlgeschlagen', 'Update fehlgeschlagen']);
  });

  it('a failed Portainer redeploy alerts once per target and day', async () => {
    expect(await portainerFailedAlert(env.ctx, 'stable:3.6.0', at(16, 2))).toBe(2);
    expect((await notices('update_failed'))[0]).toMatchObject({
      title: 'Automatisches Update über Portainer fehlgeschlagen', link: '/admin/update', dedupe: `update-failed-portainer-stable:3.6.0-2026-11-16-${anna}`,
    });
    expect(await portainerFailedAlert(env.ctx, 'stable:3.6.0', at(16, 23))).toBe(0);
    expect(await portainerFailedAlert(env.ctx, 'stable:3.6.0', at(17, 2))).toBe(2);
    expect(await mails('updatefailed')).toHaveLength(4);
  });
});

describe('Systemcheck problems', () => {
  const status = new Map<CheckId, CheckStatus>();
  const fake = (group: 'core' | 'signin', ids: readonly CheckId[]): GroupCheck => ({
    group, ids, timeoutMs: 1000, run: async () => ids.map((id) => line(id, status.get(id) ?? 'ok')),
  });
  const CORE = ['core.publicUrl', 'core.database', 'core.redis'] as const;
  const SIGNIN = ['signin.oidc', 'signin.authentik', 'signin.flows'] as const;
  const set = (ids: readonly CheckId[], s: CheckStatus) => { for (const id of ids) status.set(id, s); };
  /** the next 15-minute run: the tick lock ran out and the Systemcheck's cache too */
  const run = async (now = at(16)) => {
    for (const k of [...await env.kv.keys('syscheck:'), ...await env.kv.keys('alerts:syscheck:tick')]) await env.kv.del(k);
    return syscheckAlertTick(env.ctx, now);
  };

  beforeEach(() => {
    status.clear();
    resetChecksForTests();
    registerChecks([fake('core', CORE), fake('signin', SIGNIN)]);
  });

  it('several lines turning in one run make one notice', async () => {
    set(['signin.authentik', 'signin.flows', 'core.database'], 'problem');
    expect(await run()).toEqual(['core.database', 'signin.authentik', 'signin.flows']);
    const n = await notices('syscheck_problem');
    expect(n.map((x) => x.user_id).sort()).toEqual([anna, carla].sort());
    expect(n[0]).toMatchObject({
      title: 'Systemcheck: 3 neue Probleme', body: 'Betroffen: Grundlagen, Anmeldung. Ursache und Lösung stehen unter Admin → Status.', link: '/admin/status',
      dedupe: `syscheck-2026-11-16-core.database,signin.authentik,signin.flows-${anna}`,
    });
    expect(await mails('syscheck')).toHaveLength(2);
  });

  it('one line names its group once, in the singular', async () => {
    set(['signin.flows'], 'problem');
    expect(await run()).toEqual(['signin.flows']);
    expect((await notices('syscheck_problem'))[0]).toMatchObject({ title: 'Systemcheck: ein neues Problem', body: 'Betroffen: Anmeldung. Ursache und Lösung stehen unter Admin → Status.' });
  });

  it('a problem that stays alerts once', async () => {
    set(['signin.authentik', 'signin.flows', 'core.database'], 'problem');
    expect(await run()).toHaveLength(3);
    expect(await run(at(16, 10, 15))).toEqual([]);
    expect(await run(at(17, 10))).toEqual([]); // also the next day: it never went away
    expect(await notices('syscheck_problem')).toHaveLength(2);
  });

  it('a line that joins later alerts on its own', async () => {
    set(['core.database'], 'problem');
    expect(await run()).toEqual(['core.database']);
    set(['signin.flows'], 'problem');
    expect(await run(at(16, 10, 15))).toEqual(['signin.flows']);
    expect((await notices('syscheck_problem')).map((x) => x.title)).toEqual([
      'Systemcheck: ein neues Problem', 'Systemcheck: ein neues Problem', 'Systemcheck: ein neues Problem', 'Systemcheck: ein neues Problem']);
  });

  it('a flapping line alerts once a day', async () => {
    set(['core.database'], 'problem');
    expect(await run(at(16, 10))).toEqual(['core.database']);
    set(['core.database'], 'ok');
    expect(await run(at(16, 10, 15))).toEqual([]);
    set(['core.database'], 'problem');
    expect(await run(at(16, 10, 30))).toEqual([]);
    expect(await notices('syscheck_problem')).toHaveLength(2);
    // the next day it goes away and comes back: a second alert
    set(['core.database'], 'ok');
    expect(await run(at(17, 9))).toEqual([]);
    set(['core.database'], 'problem');
    expect(await run(at(17, 9, 15))).toEqual(['core.database']);
    expect(await notices('syscheck_problem')).toHaveLength(4);
    expect(await mails('syscheck')).toHaveLength(4);
  });

  it('two runs at once alert once', async () => {
    set(['core.database'], 'problem');
    const both = await Promise.all([syscheckAlertTick(env.ctx, at(16)), syscheckAlertTick(env.ctx, at(16))]);
    expect(both.filter((r) => r.length)).toEqual([['core.database']]);
    expect(await notices('syscheck_problem')).toHaveLength(2);
  });

  it('browser lines and warnings never alert', async () => {
    const lines: CheckLine[] = [
      { id: 'proxy.websocket', group: 'proxy', status: 'problem', runs: 'browser' },
      { id: 'core.redis', group: 'core', status: 'warning', runs: 'server' },
      { id: 'core.mail', group: 'core', status: 'unknown', runs: 'server' },
      { id: 'core.env', group: 'core', status: 'not_set_up', runs: 'server' },
    ];
    await env.kv.set('syscheck:result', JSON.stringify({ at: new Date().toISOString(), lines, counts: {} }), 300);
    expect(await syscheckAlertTick(env.ctx, at(16))).toEqual([]);
    expect(await notices('syscheck_problem')).toEqual([]);
  });

  it('the first run after the deploy alerts lines already in problem', async () => {
    expect(await env.kv.get('alerts:syscheck:prev')).toBeNull();
    set(['core.redis'], 'problem');
    expect(await run()).toEqual(['core.redis']);
    expect(JSON.parse((await env.kv.get('alerts:syscheck:prev'))!)).toEqual(['core.redis']);
  });

  it('the downloads and previews disk lines never alert here: the storage alert owns them', async () => {
    resetChecksForTests();
    const DISKS = ['core.disk.downloads', 'core.disk.previews', 'core.disk.database'] as const;
    registerChecks([fake('core', [...CORE, ...DISKS])]);
    set(['core.disk.downloads', 'core.disk.previews'], 'problem');
    expect(await run()).toEqual([]);
    expect(await notices('syscheck_problem')).toEqual([]);
    // the database disk has no storage alert: it stays a Systemcheck alert
    set(['core.disk.database'], 'problem');
    expect(await run(at(16, 10, 15))).toEqual(['core.disk.database']);
  });

  it('a problem whose check timed out in between does not alert again the next day', async () => {
    set(['signin.authentik'], 'problem');
    expect(await run()).toEqual(['signin.authentik']);
    // a run in which the sign-in check missed its limit: its lines are unknown
    const timedOut: CheckLine[] = SIGNIN.map((id) => ({ id, group: 'signin', status: 'unknown', runs: 'server', cause: 'check_timeout' }));
    for (const k of await env.kv.keys('alerts:syscheck:tick')) await env.kv.del(k);
    await env.kv.set('syscheck:result', JSON.stringify({ at: new Date().toISOString(), lines: timedOut, counts: {} }), 300);
    expect(await syscheckAlertTick(env.ctx, at(16, 10, 15))).toEqual([]);
    expect(JSON.parse((await env.kv.get('alerts:syscheck:prev'))!)).toEqual(['signin.authentik']);
    // still the same problem the next day: it never went away
    expect(await run(at(17, 10))).toEqual([]);
    expect(await notices('syscheck_problem')).toHaveLength(2);
  });

  it('a failed notice gives the run and its line days back', async () => {
    set(['core.database'], 'problem');
    vi.spyOn(notify, 'notifyAdmins').mockRejectedValueOnce(new Error('database down'));
    await expect(run()).rejects.toThrow('database down');
    expect(await env.kv.get('alerts:syscheck:tick')).toBeNull();
    expect(await env.kv.get('alerts:syscheck:core.database:2026-11-16')).toBeNull();
    expect(await env.kv.get('alerts:syscheck:prev')).toBeNull();
    expect(await run(at(16, 10, 15))).toEqual(['core.database']);
  });
});

describe('disk and recordings storage', () => {
  const GB = 1_000_000_000;
  const snap = (disks: DiskHealth[]): HealthSnapshot => ({
    at: new Date().toISOString(), services: [], disks, errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 }, issues: [], worst: 'ok',
  });
  const dl = (level: DiskHealth['level'], usedPct: number, o: Partial<DiskHealth> = {}): DiskHealth =>
    ({ id: 'downloads', level, reason: 'full', totalBytes: 100 * GB, freeBytes: (100 - usedPct) * GB, usedPct, ownBytes: 0, ...o });

  it('a full disk alerts once a day and again on escalation', async () => {
    expect(await diskAlerts(env.ctx, snap([dl('warn', 87)]), at(16, 10))).toEqual(['downloads']);
    const n = await notices('disk_low');
    expect(n.map((x) => x.user_id).sort()).toEqual([anna, carla].sort());
    expect(n[0]).toMatchObject({
      title: 'Speicher fast voll: Offline-Downloads zu 87 % belegt', body: 'Noch 13 GB frei.', link: '/admin/status', dedupe: `disk-downloads-warn-2026-11-16-${anna}`,
    });
    // the next health tick a minute later: nothing
    expect(await diskAlerts(env.ctx, snap([dl('warn', 87)]), at(16, 10, 1))).toEqual([]);
    expect(await notices('disk_low')).toHaveLength(2);
    // worse the same day: once more
    expect(await diskAlerts(env.ctx, snap([dl('err', 96)]), at(16, 15))).toEqual(['downloads']);
    expect(await diskAlerts(env.ctx, snap([dl('err', 96)]), at(16, 16))).toEqual([]);
    expect((await notices('disk_low')).at(-1)).toMatchObject({ title: 'Speicher voll: Offline-Downloads zu 96 % belegt', body: 'Noch 4 GB frei.' });
    // still full the next day: once more
    expect(await diskAlerts(env.ctx, snap([dl('err', 96)]), at(17, 10))).toEqual(['downloads']);
    expect(await notices('disk_low')).toHaveLength(6);
    expect(await mails('storage')).toHaveLength(6);
  });

  it('an err alert also covers the almost-full level of that day', async () => {
    expect(await diskAlerts(env.ctx, snap([dl('err', 96)]), at(16, 10))).toEqual(['downloads']);
    // freed a little the same day: no "almost full" after "full"
    expect(await diskAlerts(env.ctx, snap([dl('warn', 88)]), at(16, 12))).toEqual([]);
    expect(await notices('disk_low')).toHaveLength(2);
    // the next day it is still almost full: told again
    expect(await diskAlerts(env.ctx, snap([dl('warn', 88)]), at(17, 10))).toEqual(['downloads']);
    expect(await notices('disk_low')).toHaveLength(4);
  });

  it('free space under 1 GB is told in MB', async () => {
    expect(await diskAlerts(env.ctx, snap([dl('err', 99, { totalBytes: 100 * GB, freeBytes: 0.4 * GB })]), at(16))).toEqual(['downloads']);
    expect((await notices('disk_low'))[0]).toMatchObject({ body: 'Noch 400 MB frei.' });
  });

  it('low free space alerts; the cap, the database and an unreadable disk do not', async () => {
    const pv: DiskHealth = { id: 'previews', level: 'err', reason: 'low_free', usedPct: 70, ownBytes: 0 };
    const quiet: DiskHealth[] = [
      dl('warn', 30, { reason: 'cap', capBytes: 10 * GB, ownBytes: 9.5 * GB }),
      { id: 'database', level: 'warn', reason: 'large', ownBytes: 30 * GB },
    ];
    expect(await diskAlerts(env.ctx, snap([...quiet, pv]), at(16))).toEqual(['previews']);
    const n = await notices('disk_low');
    expect(n).toHaveLength(2);
    // no free bytes known: no body
    expect(n[0]).toMatchObject({ title: 'Speicher voll: Vorschauen zu 70 % belegt', body: null, dedupe: `disk-previews-err-2026-11-16-${anna}` });
    expect(await diskAlerts(env.ctx, snap([{ id: 'downloads', level: 'off', reason: 'unavailable', ownBytes: 0 }]), at(16))).toEqual([]);
  });

  it('a kv failure while taking the almost-full claim gives the full claim back', async () => {
    const take = env.kv.setnx.bind(env.kv);
    vi.spyOn(env.kv, 'setnx').mockImplementation(async (k: string, v: string, ttl: number) => {
      if (k.includes(':warn:')) throw new Error('redis down');
      return take(k, v, ttl);
    });
    await expect(diskAlerts(env.ctx, snap([dl('err', 96)]), at(16))).rejects.toThrow('redis down');
    expect(await env.kv.get('alerts:disk:downloads:err:2026-11-16')).toBeNull();
    vi.restoreAllMocks();
    expect(await diskAlerts(env.ctx, snap([dl('err', 96)]), at(16))).toEqual(['downloads']);
  });

  it('a failed notice gives the disk day back', async () => {
    vi.spyOn(notify, 'notifyAdmins').mockRejectedValueOnce(new Error('database down'));
    await expect(diskAlerts(env.ctx, snap([dl('warn', 87)]), at(16))).rejects.toThrow('database down');
    expect(await env.kv.get('alerts:disk:downloads:warn:2026-11-16')).toBeNull();
    expect(await diskAlerts(env.ctx, snap([dl('warn', 87)]), at(16))).toEqual(['downloads']);
  });
});
