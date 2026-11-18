// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StepError } from '../src/docker.js';
import { selfUpdate } from '../src/selfUpdate.js';
import { DEFAULT_MEDIA, DEFAULT_STATE, fileStore, sanitize } from '../src/state.js';

const SECRET = 'config-test-secret-0123456789';

describe('updater config', () => {
  it('defaults', () => {
    const c = loadConfig({ INTERNAL_SECRET: SECRET });
    expect(c).toMatchObject({ port: 7070, projectDir: '/project', composeFiles: ['compose.prod.yaml'], composeFilesAuto: true, repo: 'LetsManu/friendflix', dockerHost: 'tcp://docker-proxy:2375',
      stateDir: '/state', backendHealthUrl: 'http://backend:3000/health', version: null, gitSha: null });
    expect(c.secret).toBe(SECRET);
  });

  it('HOSTNAME (the own container, for telling a Portainer stack from its labels) only as a plain name', () => {
    expect(loadConfig({ INTERNAL_SECRET: SECRET, HOSTNAME: 'a1b2c3d4e5f6' }).self).toBe('a1b2c3d4e5f6');
    expect(loadConfig({ INTERNAL_SECRET: SECRET, HOSTNAME: '--format x' }).self).toBeUndefined();
    expect(loadConfig({ INTERNAL_SECRET: SECRET }).self).toBeUndefined();
  });

  it('an empty UPDATER_COMPOSE_FILES (compose passes "") means automatic', () => {
    expect(loadConfig({ INTERNAL_SECRET: SECRET, UPDATER_COMPOSE_FILES: '' })).toMatchObject({ composeFiles: ['compose.prod.yaml'], composeFilesAuto: true });
    expect(loadConfig({ INTERNAL_SECRET: SECRET, UPDATER_COMPOSE_FILES: ' ' })).toMatchObject({ composeFiles: ['compose.prod.yaml'], composeFilesAuto: true });
  });

  it('reads the secret from the bootstrap-gateway volume copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-upd-'));
    writeFileSync(join(dir, 'internal_secret'), `${SECRET}\n`);
    expect(loadConfig({ FF_BOOTSTRAP_DIR: dir }).secret).toBe(SECRET);
    writeFileSync(join(dir, 'f'), `${SECRET}\n`);
    expect(loadConfig({ INTERNAL_SECRET_FILE: join(dir, 'f') }).secret).toBe(SECRET);
    expect(() => loadConfig({ FF_BOOTSTRAP_DIR: join(dir, 'missing') })).toThrow('missing INTERNAL_SECRET');
  });

  it('refuses values that could smuggle arguments or paths', () => {
    const bad: Array<Record<string, string>> = [
      { UPDATER_COMPOSE_FILES: '../etc/passwd.yaml' }, { UPDATER_COMPOSE_FILES: '-f.yaml' }, { UPDATER_COMPOSE_FILES: 'a.yaml,--x' }, { UPDATER_COMPOSE_FILES: 'compose.json' },
      { UPDATER_PROJECT_DIR: 'relative' }, { UPDATER_PROJECT_DIR: '/a/../b' }, { UPDATER_PROJECT_DIR: '/a;b' },
      { COMPOSE_PROJECT_NAME: 'Bad Name' }, { UPDATE_REPO: 'x' }, { DOCKER_HOST: 'unix:///var/run/docker.sock' }, { DOCKER_HOST: 'tcp://-x:2375' },
      { PORT: '80' }, { UPDATER_BACKEND_HEALTH_URL: 'https://evil.example.com/x?y' },
    ];
    for (const b of bad) expect(() => loadConfig({ INTERNAL_SECRET: SECRET, ...b }), JSON.stringify(b)).toThrow();
    expect(loadConfig({ INTERNAL_SECRET: SECRET, UPDATER_COMPOSE_FILES: 'compose.prod.yaml, compose.secrets.yaml', UPDATER_PROJECT_DIR: '/srv/friend flix', COMPOSE_PROJECT_NAME: 'ff', GIT_SHA: 'a'.repeat(40), APP_VERSION: '1.1.0' }))
      .toMatchObject({ composeFiles: ['compose.prod.yaml', 'compose.secrets.yaml'], composeFilesAuto: false, projectDir: '/srv/friend flix', projectName: 'ff', gitSha: 'a'.repeat(40), version: null });
  });

  it('updater config: no version, sha from FF_IMAGE_COMMIT', () => {
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    expect(loadConfig({ INTERNAL_SECRET: SECRET, FF_IMAGE_COMMIT: A, GIT_SHA: B, APP_VERSION: '1.1.0' })).toMatchObject({ gitSha: A, version: null });
    expect(loadConfig({ INTERNAL_SECRET: SECRET, GIT_SHA: B })).toMatchObject({ gitSha: B, version: null });
    expect(loadConfig({ INTERNAL_SECRET: SECRET, FF_IMAGE_COMMIT: 'dev', GIT_SHA: B }).gitSha).toBe(B);
    expect(loadConfig({ INTERNAL_SECRET: SECRET, FF_IMAGE_COMMIT: 'dev' }).gitSha).toBeNull();
  });
});

describe('updater state file', () => {
  it('round-trips atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-upd-'));
    const s = fileStore(dir);
    expect(s.load()).toEqual(DEFAULT_STATE);
    s.save({ ...DEFAULT_STATE, channel: 'pinned', version: '1.2.3', current: '1.2.3', previous: 'sha-abcdef1' });
    expect(s.load()).toMatchObject({ channel: 'pinned', version: '1.2.3', current: '1.2.3', previous: 'sha-abcdef1' });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).channel).toBe('pinned');
  });

  it('a tampered file cannot inject a tag, a channel or a job', () => {
    expect(sanitize({ channel: 'evil', version: '1.2.3; id', current: 'latest && id', previous: 'latest', lastJob: { id: 'x' } })).toEqual(DEFAULT_STATE);
    expect(sanitize({ channel: 'pinned' }).channel).toBe('stable'); // pinned without a version
    expect(sanitize(null)).toEqual(DEFAULT_STATE);
    const job = sanitize({ lastJob: { id: '0123456789abcdef', action: 'update', state: 'failed', to: 'latest', from: '$(id)', steps: { pull: 'ok', verify: 'weird' }, step: 'verify', error: 'Bad Error', startedAt: 'nope' } }).lastJob!;
    expect(job).toMatchObject({ from: null, error: null, step: 'verify', steps: { pull: 'ok', verify: 'pending' }, startedAt: new Date(0).toISOString() });
  });

  it('state: previousDigests survives a reload; a malformed entry is dropped', () => {
    const d = (c: string) => `sha256:${c.repeat(64)}`;
    const digests = { backend: `ghcr.io/letsmanu/friendflix-backend@${d('a')}`, gateway: `ghcr.io/letsmanu/friendflix-gateway@${d('b')}`,
      web: `ghcr.io/letsmanu/friendflix-web@${d('c')}`, livetv: `ghcr.io/letsmanu/friendflix-livetv@${d('d')}` };
    const dir = mkdtempSync(join(tmpdir(), 'ff-upd-'));
    const s = fileStore(dir);
    s.save({ ...DEFAULT_STATE, current: 'latest', previousDigests: digests });
    expect(s.load()).toMatchObject({ current: 'latest', previous: null, previousDigests: digests });
    // a bad entry is dropped, its siblings survive; nothing left = null
    expect(sanitize({ previousDigests: { ...digests,
      gateway: 'ghcr.io/letsmanu/friendflix-gateway:latest', web: `docker.io/evil/web@${d('c')}`, livetv: `ghcr.io/letsmanu/friendflix-livetv@${d('d')};id`,
      bootstrap: `ghcr.io/letsmanu/friendflix-backend@${d('a')}`, postgres: `ghcr.io/x/postgres@${d('a')}`, ['__proto__']: `ghcr.io/x/y@${d('a')}` } }).previousDigests)
      .toEqual({ backend: digests.backend });
    for (const bad of [{ backend: `ghcr.io/letsmanu/friendflix-backend@sha256:${'A'.repeat(64)}` }, { backend: 42 }, [digests.backend], 'x', null]) {
      expect(sanitize({ previousDigests: bad }).previousDigests, JSON.stringify(bad)).toBeNull();
    }
    // a file from before digests: null, the legacy sha tag kept
    expect(sanitize({ previous: 'sha-abcdef1' })).toMatchObject({ previous: 'sha-abcdef1', previousDigests: null });
  });

  it('a job\'s per-service report keeps known services with updated / unchanged only', () => {
    const job = (services: unknown) => sanitize({ lastJob: { id: '0123456789abcdef', action: 'update', state: 'succeeded', to: 'latest', services } }).lastJob!.services;
    expect(job({ backend: 'updated', gateway: 'unchanged', web: 'unchanged', livetv: 'updated' })).toEqual({ backend: 'updated', gateway: 'unchanged', web: 'unchanged', livetv: 'updated' });
    expect(job({ backend: 'updated', web: 'gone', bootstrap: 'updated', postgres: 'unchanged' })).toEqual({ backend: 'updated' });
    expect(job(undefined)).toBeNull();
    expect(job(['updated'])).toBeNull();
  });

  it('an old state file without media loads with the defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-upd-'));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ channel: 'nightly', version: null, current: 'nightly', previous: null, livetv: 'enabled', livetvError: null, livetvImage: null, lastJob: null }));
    const s = fileStore(dir).load();
    expect(s).toMatchObject({ channel: 'nightly', current: 'nightly', livetv: 'enabled' });
    expect(s.media).toEqual(DEFAULT_MEDIA);
    expect(DEFAULT_MEDIA).toEqual({ base: null, pending: null, desired: null, container: null, pinSource: null, backups: [], hdr: null, lastError: null, tampered: false, dataUpstream: {} });
    // a job from before the media server has no media phase
    expect(sanitize({ lastJob: { id: '0123456789abcdef', action: 'update', state: 'succeeded', to: 'latest' } }).lastJob!.media).toBeNull();
  });

  it('a valid media section survives, a media job and its new state are kept', () => {
    const path = '/srv/media';
    const volume = `friendflix_mediaserver-base-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`;
    const media = {
      base: { path, volume, confirmedAt: '2026-11-17T14:00:00.000Z', previousVolume: 'friendflix_mediaserver-base-0123abcd' },
      pending: { path: '/srv/other', codeHash: 'a'.repeat(64), expiresAt: '2026-11-17T14:30:00.000Z', failures: 2 },
      desired: { kind: 'jellyfin', folders: [{ rel: 'Filme', target: '/media/filme' }], uid: 1000, gid: 1000, gpu: 'dri', mediaGid: 44, egress: true, tz: 'Europe/Berlin', run: true },
      container: { id: 'b'.repeat(64), kind: 'jellyfin', digest: `sha256:${'c'.repeat(64)}`, upstream: '10.10.7', specHash: 'd'.repeat(64) },
      pinSource: `sha256:${'e'.repeat(64)}`,
      backups: [{ id: 'jellyfin-20261117-1400-manual', kind: 'jellyfin', upstream: '10.10.7', at: '2026-11-17T14:00:00.000Z', tag: 'manual', size: 1234 }],
      hdr: { kind: 'jellyfin', at: '2026-11-17T14:00:00.000Z', opencl: 'pass', qsv: 'fail' },
      lastError: 'unhealthy', tampered: true,
      dataUpstream: { jellyfin: '10.10.7', ferrofin: 'v1.5.1' },
    };
    expect(sanitize({ media }).media).toEqual(media);
    // a state file from before the per-kind data record takes it from the recorded container; a bad entry is dropped
    const { dataUpstream: _d, ...older } = media;
    expect(sanitize({ media: older }).media.dataUpstream).toEqual({ jellyfin: '10.10.7' });
    expect(sanitize({ media: { ...older, container: null } }).media.dataUpstream).toEqual({});
    expect(sanitize({ media: { ...media, dataUpstream: { jellyfin: '../x', ferrofin: 'v1.5.1', other: '1.0.0' } } }).media.dataUpstream).toEqual({ ferrofin: 'v1.5.1' });
    const steps = { check: 'ok', pull: 'ok', verify: 'ok', snapshot: 'ok', create: 'ok', start: 'ok', health: 'failed', rollback: 'skipped' };
    const job = sanitize({ lastJob: { id: '0123456789abcdef', action: 'mediaserver-apply', state: 'succeeded_mediaserver_failed', to: 'latest', media: { step: 'health', steps } } }).lastJob!;
    expect(job).toMatchObject({ action: 'mediaserver-apply', state: 'succeeded_mediaserver_failed', media: { step: 'health', steps } });
  });

  it('a tampered media section falls back field by field', () => {
    const good = { kind: 'ferrofin', folders: [], uid: 1000, gid: 1000, gpu: 'off', mediaGid: null, egress: false, tz: 'UTC', run: false };
    const hash = 'a'.repeat(64);
    const m = sanitize({
      media: {
        base: { path: '/etc', volume: 'friendflix_mediaserver-base-01234567', confirmedAt: '2026-11-17T14:00:00.000Z', previousVolume: null },
        pending: { path: '/srv/media', codeHash: hash, expiresAt: '2026-11-17T14:30:00.000Z', failures: 1 },
        desired: { ...good, uid: 0 },
        container: { id: '../x', kind: 'ferrofin', digest: `sha256:${hash}`, upstream: '1.5.1', specHash: hash },
        pinSource: `sha256:${hash}`,
        backups: [
          { id: '../x', kind: 'ferrofin', upstream: '1.5.1', at: '2026-11-17T14:00:00.000Z', tag: 'manual', size: 1 },
          { id: 'ferrofin-20261117-1400-manual', kind: 'ferrofin', upstream: '1.5.1', at: '2026-11-17T14:00:00.000Z', tag: 'manual', size: 1 },
        ],
        hdr: { kind: 'ferrofin', at: 'nope', opencl: 'pass', qsv: 'pass' },
        lastError: 'rm -rf', tampered: 'yes',
      },
    }).media;
    expect(m).toEqual({
      ...DEFAULT_MEDIA,
      // the valid siblings survive
      pending: { path: '/srv/media', codeHash: hash, expiresAt: '2026-11-17T14:30:00.000Z', failures: 1 },
      pinSource: `sha256:${hash}`,
      backups: [{ id: 'ferrofin-20261117-1400-manual', kind: 'ferrofin', upstream: '1.5.1', at: '2026-11-17T14:00:00.000Z', tag: 'manual', size: 1 }],
    });
    // a volume that is not the one derived from the path, a pending path that is refused, a bad hash or counter, an extra key in desired
    expect(sanitize({ media: { base: { path: '/srv/media', volume: 'other_x', confirmedAt: '2026-11-17T14:00:00.000Z', previousVolume: null } } }).media.base).toBeNull();
    expect(sanitize({ media: { base: { path: '/srv/media', volume: 'friendflix_mediaserver-base-00000000', confirmedAt: '2026-11-17T14:00:00.000Z', previousVolume: null } } }).media.base).toBeNull();
    for (const p of [{ path: '/etc', codeHash: hash }, { path: '/srv/media', codeHash: 'xyz' }, { path: '/srv/media', codeHash: hash, failures: 6 }]) {
      expect(sanitize({ media: { pending: { expiresAt: '2026-11-17T14:30:00.000Z', failures: 0, ...p } } }).media.pending).toBeNull();
    }
    expect(sanitize({ media: { desired: { ...good, extra: 1 } } }).media.desired).toBeNull();
    expect(sanitize({ media: { desired: { ...good, folders: [{ rel: '../x', target: '/media/x' }] } } }).media.desired).toBeNull();
    expect(sanitize({ media: { desired: { ...good, run: 'yes' } } }).media.desired).toBeNull();
    expect(sanitize({ media: { desired: { ...good, run: true } } }).media.desired).toEqual({ ...good, run: true });
    expect(sanitize({ media: 'x' }).media).toEqual(DEFAULT_MEDIA);
  });
});

describe('self-update helper', () => {
  it('recreates only the updater service with a valid tag', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const d = { up: async (t: string, s: readonly string[]) => { calls.push([t, s]); } };
    expect(await selfUpdate({ FF_TAG: 'nightly' }, d)).toBe(0);
    expect(calls).toEqual([['nightly', ['updater']]]);
    expect(await selfUpdate({ FF_TAG: 'nightly;id' }, d)).toBe(2);
    expect(await selfUpdate({}, d)).toBe(2);
    expect(await selfUpdate({ FF_TAG: 'latest' }, { up: async () => { throw new Error('x'); } })).toBe(1);
    // the helper first runs the same checks as the running updater (the stack's compose files, own stack, unchanged ports and
    // networks, the expected image) and recreates nothing when one fails
    const order: string[] = [];
    const images = async (t: string, s: readonly string[]) => { order.push(`images ${t} ${s.join(',')}`); return {}; };
    expect(await selfUpdate({ FF_TAG: 'latest' }, { images, up: async () => { order.push('up'); } })).toBe(0);
    expect(order).toEqual(['images latest updater', 'up']);
    order.length = 0;
    expect(await selfUpdate({ FF_TAG: 'latest' }, { images: async () => { throw new StepError('foreign_stack'); }, up: async () => { order.push('up'); } })).toBe(1);
    expect(order).toEqual([]);
  });
});
