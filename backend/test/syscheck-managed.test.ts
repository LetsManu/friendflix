// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { MemoryKV } from '../src/kv.js';
import type { MediaStatus } from '../src/mediaserver/client.js';
import type { MediaManaged } from '../src/mediaserver/store.js';
import type { MediaView } from '../src/routes/adminMediaserver.js';
import { managedLine, mediaCheck } from '../src/syscheck/checks/media.js';
import type { CheckEnv } from '../src/syscheck/engine.js';
import { CHECK_IDS } from '../src/syscheck/types.js';
import type { UpdaterJob, UpdaterStatus, UpdaterView } from '../src/updater.js';

// Task 15: the Systemcheck line media.managed (spec "Systemcheck"), one case per row of its table, first match wins.
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const DIGEST = `sha256:${'a'.repeat(64)}`;
const PIN = `docker.io/jellyfin/jellyfin@sha256:${'b'.repeat(64)}`;

const status = (): MediaStatus => ({
  available: true, reason: null, base: { set: true, path: '/srv/media', pending: false, expiresAt: null },
  desired: { kind: 'jellyfin', folders: [{ rel: 'Filme', target: '/media/filme' }], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true, run: true },
  container: { state: 'running', health: 'healthy', kind: 'jellyfin', image: { digest: DIGEST, upstream: '10.10.7' }, template: 'current', tampered: false, createdAt: ago(60) },
  pin: { image: `docker.io/jellyfin/jellyfin@${DIGEST}`, upstream: '10.10.7', changed: false },
  pins: { ferrofin: false, jellyfin: true }, engine: { api: '1.47', logs: true, arch: 'amd64', nvidia: false }, error: null,
  backups: [{ id: 'jellyfin-20261110-0300-10.10.7', kind: 'jellyfin', upstream: '10.10.7', at: ago(3), tag: 'auto', size: 1024 }], hdr: null,
});
const managed = (kind: MediaManaged['kind'] = 'jellyfin'): MediaManaged => ({
  kind, setup: kind ? 'done' : 'none', setupError: null, adminUser: kind ? 'friendflix-admin' : null, hasPassword: Boolean(kind), libraries: [],
  externalUrl: null, hasExternalKey: false, updatedAt: null,
});
const viewOf = (s: MediaStatus | null, kind: MediaManaged['kind'] = 'jellyfin'): MediaView => ({
  mode: kind ? 'managed' : 'external', offer: { managed: true, reason: null }, kinds: { ferrofin: false, jellyfin: true }, status: s, managed: managed(kind),
  external: { url: null, hasKey: false }, livetvLibraryPath: null,
});
const coreJob = (o: Partial<UpdaterJob>): UpdaterJob => ({
  id: '00000000000000a1', action: 'update', state: 'succeeded', step: null, steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' },
  from: 'latest', to: 'latest', startedAt: ago(1), finishedAt: ago(1), error: null, media: null, ...o,
});
const updater = (s: MediaStatus | null, job: UpdaterJob | null = null): UpdaterView => ({
  present: true,
  status: {
    updater: { version: '3.3.0', sha: null }, channel: 'stable', version: null, targetTag: 'latest', current: 'latest', previous: null, busy: false, job, log: [],
    services: [], stack: 'own', stackReason: 'own', stackDir: null, projectDir: null, livetv: null, mediaserver: s,
  } satisfies UpdaterStatus,
});

let kv: MemoryKV;
let env: CheckEnv;
beforeEach(() => {
  kv = new MemoryKV();
  env = { ctx: { kv } as unknown as Ctx, snapshot: async () => null, login: async () => { throw new Error('unused'); }, fresh: false, timeoutMs: 4_000 };
});
/** the line for a status changed by `edit` (managed jellyfin, updater present) */
const lineFor = async (edit: (s: MediaStatus) => void = () => undefined, o: { kind?: MediaManaged['kind']; job?: UpdaterJob | null; updater?: UpdaterView } = {}) => {
  const s = status();
  edit(s);
  return managedLine(env, viewOf(s, o.kind === undefined ? 'jellyfin' : o.kind), o.updater ?? updater(s, o.job ?? null));
};

describe('media.managed', () => {
  it('sits right after media.server, in the media group', () => {
    expect(CHECK_IDS.indexOf('media.managed')).toBe(CHECK_IDS.indexOf('media.server') + 1);
    expect(mediaCheck.ids.indexOf('media.managed')).toBe(mediaCheck.ids.indexOf('media.server') + 1);
  });

  it('external server in use, no managed container → not_set_up / managed_off', async () => {
    const l = await lineFor((s) => { s.container = null; s.desired = null; }, { kind: null });
    expect(l).toMatchObject({ id: 'media.managed', group: 'media', status: 'not_set_up', cause: 'managed_off', runs: 'server', href: '/admin/settings?tab=media', docs: 'mediaserver.md' });
  });

  it('updater missing → warning managed_no_updater with a managed kind, else not_set_up managed_off', async () => {
    const s = status();
    for (const u of [{ present: false } as const, { present: true, error: 'unauthorized' } as const, updater(null)]) {
      expect(await managedLine(env, viewOf(null), u)).toMatchObject({ status: 'warning', cause: 'managed_no_updater' });
      expect(await managedLine(env, viewOf(null, null), u)).toMatchObject({ status: 'not_set_up', cause: 'managed_off' });
    }
    expect(s.available).toBe(true);
  });

  it('starting (no media status read yet since the updater started) → not_set_up managed_starting, never a warning', async () => {
    const starting = (s: MediaStatus) => { s.available = false; s.reason = 'starting'; s.container = null; s.desired = null; s.backups = []; s.error = null; };
    expect(await lineFor(starting)).toMatchObject({ status: 'not_set_up', cause: 'managed_starting', href: '/admin/settings?tab=media' });
    // even with the last media job failed: the status is not read yet
    expect(await lineFor(starting, { job: coreJob({ action: 'mediaserver-start', state: 'failed', error: 'start_failed' }) })).toMatchObject({ status: 'not_set_up', cause: 'managed_starting' });
    // an external server in use and no container seen: still neutral
    expect(await lineFor(starting, { kind: null })).toMatchObject({ status: 'not_set_up', cause: 'managed_off' });
  });

  it('engine_old → problem with a container, else not_set_up', async () => {
    expect(await lineFor((s) => { s.available = false; s.reason = 'engine_old'; })).toMatchObject({ status: 'problem', cause: 'managed_engine_old' });
    expect(await lineFor((s) => { s.available = false; s.reason = 'engine_old'; s.container = null; })).toMatchObject({ status: 'not_set_up', cause: 'managed_engine_old' });
  });

  it('no_logs → warning managed_proxy_outdated with the compose docs', async () => {
    expect(await lineFor((s) => { s.available = false; s.reason = 'no_logs'; }))
      .toMatchObject({ status: 'warning', cause: 'managed_proxy_outdated', docs: 'mediaserver.md#update-the-compose-files' });
  });

  it('any other reason the updater cannot run it (no project, no media network, engine unreachable) → never ok', async () => {
    for (const reason of ['no_project', 'no_network', null] as const) {
      const off = (s: MediaStatus) => { s.available = false; s.reason = reason; s.container = null; s.desired = null; s.backups = []; };
      expect(await lineFor(off), String(reason)).toMatchObject({ status: 'warning', cause: 'managed_no_updater' });
      expect(await lineFor((s) => { s.available = false; s.reason = reason; }), String(reason)).toMatchObject({ status: 'warning', cause: 'managed_no_updater' });
    }
  });

  it('tampered → problem managed_tampered', async () => {
    expect(await lineFor((s) => { s.container!.tampered = true; s.container!.state = 'exited'; })).toMatchObject({ status: 'problem', cause: 'managed_tampered' });
  });

  it('desired running and the container missing or not running → problem managed_down', async () => {
    expect(await lineFor((s) => { s.container = null; })).toMatchObject({ status: 'problem', cause: 'managed_down' });
    expect(await lineFor((s) => { s.container!.state = 'exited'; s.container!.health = 'unhealthy'; })).toMatchObject({ status: 'problem', cause: 'managed_down' });
    // stopped on purpose: not down
    expect((await lineFor((s) => { s.container!.state = 'exited'; s.desired!.run = false; })).status).toBe('ok');
  });

  it('unhealthy → problem managed_unhealthy', async () => {
    expect(await lineFor((s) => { s.container!.health = 'unhealthy'; s.error = 'base_missing'; })).toMatchObject({ status: 'problem', cause: 'managed_unhealthy' });
  });

  it('base_missing → problem managed_base_missing', async () => {
    expect(await lineFor((s) => { s.error = 'base_missing'; })).toMatchObject({ status: 'problem', cause: 'managed_base_missing' });
  });

  it('folder_missing → warning managed_folder_missing', async () => {
    expect(await lineFor((s) => { s.error = 'folder_missing'; })).toMatchObject({ status: 'warning', cause: 'managed_folder_missing' });
  });

  it('gpu_missing or nvidia_missing → warning managed_gpu_missing', async () => {
    expect(await lineFor((s) => { s.error = 'gpu_missing'; })).toMatchObject({ status: 'warning', cause: 'managed_gpu_missing' });
    expect(await lineFor((s) => { s.error = 'nvidia_missing'; })).toMatchObject({ status: 'warning', cause: 'managed_gpu_missing' });
  });

  it('the last job a failed media action, or an update whose media phase failed → warning managed_job_failed with its code', async () => {
    const media = { step: null, steps: { check: 'ok', pull: 'failed', verify: 'skipped', snapshot: 'skipped', create: 'skipped', start: 'skipped', health: 'skipped', rollback: 'skipped' } } as UpdaterJob['media'];
    const failed = coreJob({ action: 'mediaserver-apply', state: 'failed', error: 'pull_failed', media });
    expect(await lineFor(undefined, { job: failed })).toMatchObject({ status: 'warning', cause: 'managed_job_failed', params: { code: 'pull_failed' } });
    const rolled = coreJob({ action: 'mediaserver-update', state: 'rolled_back', error: 'unhealthy', media });
    expect(await lineFor(undefined, { job: rolled })).toMatchObject({ status: 'warning', cause: 'managed_job_failed', params: { code: 'unhealthy' } });
    const update = coreJob({ state: 'succeeded_mediaserver_failed', error: 'verify_failed', media });
    expect(await lineFor(undefined, { job: update })).toMatchObject({ status: 'warning', cause: 'managed_job_failed', params: { code: 'verify_failed' } });
    // a failed FriendFlix update or a failed Live TV job is not the media server's
    expect((await lineFor(undefined, { job: coreJob({ state: 'failed', error: 'pull_failed' }) })).status).toBe('ok');
    expect((await lineFor(undefined, { job: coreJob({ action: 'livetv-enable', state: 'failed', error: 'unhealthy' }) })).status).toBe('ok');
    expect((await lineFor(undefined, { job: coreJob({ action: 'mediaserver-restart', state: 'running' }) })).status).toBe('ok');
  });

  it('a pin differing from the running image for more than 7 days → warning managed_update_pending', async () => {
    const differ = (s: MediaStatus) => { s.pin = { image: PIN, upstream: '10.11.0', changed: false }; };
    // never seen, or seen 6 days ago: not yet
    expect((await lineFor(differ)).status).toBe('ok');
    await kv.set(`media:pindiff:${PIN}`, ago(6), 30 * 86_400);
    expect((await lineFor(differ)).status).toBe('ok');
    await kv.set(`media:pindiff:${PIN}`, ago(8), 30 * 86_400);
    expect(await lineFor(differ)).toMatchObject({ status: 'warning', cause: 'managed_update_pending' });
    // the running image is the pin again: the old record says nothing
    expect((await lineFor()).status).toBe('ok');
  });

  it('the newest backup older than 30 days, or none and the container older than 30 days → warning managed_backup_old', async () => {
    expect(await lineFor((s) => { s.backups[0]!.at = ago(31); })).toMatchObject({ status: 'warning', cause: 'managed_backup_old' });
    expect(await lineFor((s) => { s.backups = []; })).toMatchObject({ status: 'warning', cause: 'managed_backup_old' });
    // a young container without a backup yet: fine
    expect((await lineFor((s) => { s.backups = []; s.container!.createdAt = ago(2); })).status).toBe('ok');
    // the newest of several counts
    expect((await lineFor((s) => { s.backups = [{ ...s.backups[0]!, at: ago(40) }, { ...s.backups[0]!, id: 'jellyfin-20261116-0300-10.10.7', at: ago(1) }]; })).status).toBe('ok');
  });

  it('else ok with kind and upstream', async () => {
    const l = await lineFor();
    expect(l).toEqual({ id: 'media.managed', group: 'media', status: 'ok', href: '/admin/settings?tab=media', docs: 'mediaserver.md', params: { kind: 'jellyfin', upstream: '10.10.7' }, runs: 'server' });
  });

  it('the line has no path, code or address in its params', async () => {
    const lines = [
      await lineFor((s) => { s.base.pending = true; s.base.expiresAt = ago(-0.01); }),
      await lineFor((s) => { s.error = 'folder_missing'; }),
      await lineFor(undefined, { job: coreJob({ action: 'mediaserver-apply', state: 'failed', error: 'folder_missing' }) }),
      await lineFor((s) => { s.container!.image.upstream = '192.0.2.10'; }),
      await lineFor((s) => { s.container!.image.upstream = '/srv/media'; }),
    ];
    for (const l of lines) {
      const text = JSON.stringify(l.params ?? {});
      expect(text).not.toMatch(/\/srv|\/media|sha256|192\.0\.2|example\.com|[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
    }
    // an upstream that is no version is dropped, the kind stays
    expect(lines[3]!.params).toEqual({ kind: 'jellyfin' });
  });
});
