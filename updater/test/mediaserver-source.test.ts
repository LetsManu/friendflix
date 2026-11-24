// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MediaService, SCAN_HELPER_MS, SYNC_HELPER_MS } from '../src/mediaserver/service.js';
import { JELLYFIN_REPOS, SourceError, classifyMounts, findCandidates, rematch, scanSource, type SourceDeps } from '../src/mediaserver/source.js';
import type { RecordedSource } from '../src/mediaserver/types.js';
import { BASE, JSPEC, T0, jellyPin, world, type InspectMount } from './media-world.js';

/** FriendFlix's Jellyfin (its /System/Info/Public Id) and another server */
const OURS = '4f1c2a9b8e7d6c5b4a39281706f5e4d3';
const OTHER = '0123456789abcdef0123456789abcdef';
const CONF = '/srv/jellyfin/config';

const bind = (Source: string, Destination: string): InspectMount => ({ Type: 'bind', Source, Destination, RW: false });
const vol = (Name: string, Destination: string): InspectMount => ({ Type: 'volume', Name, Source: `/var/lib/docker/volumes/${Name}/_data`, Destination, Driver: 'local', RW: true });
const config = (src = CONF): InspectMount => bind(src, '/config');

function setup() {
  const w = world();
  const service = new MediaService(w.deps, w.jobs);
  /** the deps source.ts needs, wired like the service does (the real guard checks every helper body) */
  const deps = async (): Promise<SourceDeps> => (await service.sourceDeps())!;
  return { w, service, deps };
}

/** a source scan through the service's own wiring */
async function scan(s: ReturnType<typeof setup>, id: string, expect = OURS) {
  const r = await s.service.moveScan(expect, id);
  return r;
}

describe('finding the source', () => {
  it('candidates by repository, any tag or digest, running or stopped', async () => {
    const { w } = setup();
    const want = [
      w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config()] }),
      w.foreign({ name: 'jf-digest', image: `docker.io/jellyfin/jellyfin@sha256:${'c'.repeat(64)}`, mounts: [config('/srv/a')] }),
      w.foreign({ name: 'jf-both', image: `docker.io/jellyfin/jellyfin:10.11.0@sha256:${'c'.repeat(64)}`, mounts: [config('/srv/b')] }),
      w.foreign({ name: 'lsio', image: 'lscr.io/linuxserver/jellyfin:latest', mounts: [config('/srv/c')], running: false }),
      w.foreign({ name: 'lsio-hub', image: 'linuxserver/jellyfin', mounts: [config('/srv/d')], running: false }),
    ];
    // look-alikes: another repository, another registry, a registry with a port, and our own managed containers
    w.foreign({ name: 'hotio', image: 'ghcr.io/hotio/jellyfin:release', mounts: [config('/srv/e')] });
    w.foreign({ name: 'vue', image: 'jellyfin/jellyfin-vue:latest', mounts: [] });
    w.foreign({ name: 'mirror', image: 'registry.example.com/jellyfin/jellyfin:10.10.3', mounts: [config('/srv/f')] });
    w.foreign({ name: 'local', image: 'localhost:5000/jellyfin/jellyfin:10.10.3', mounts: [config('/srv/g')] });
    w.foreign({ name: 'web', image: 'nginx:1.27', mounts: [] });
    w.foreign({ name: 'helper', image: 'jellyfin/jellyfin:10.10.3', mounts: [config('/srv/h')], labels: { 'friendflix.managed': 'helper' } });
    w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');

    expect(JELLYFIN_REPOS).toEqual(['jellyfin/jellyfin', 'docker.io/jellyfin/jellyfin', 'linuxserver/jellyfin', 'lscr.io/linuxserver/jellyfin']);
    const found = await findCandidates(w.deps.engine);
    expect(found.map((c) => c.id).sort()).toEqual(want.map((c) => c.id).sort());
    expect(found.find((c) => c.name === 'lsio')).toEqual({ id: want[3]!.id, name: 'lsio', image: 'lscr.io/linuxserver/jellyfin:latest', state: 'exited' });
  });

  it('the candidate list says which one is FriendFlix\'s server (a scan each, read-only), at most five scanned', async () => {
    const s = setup();
    const { w } = s;
    const ours = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config()] });
    const copy = w.foreign({ name: 'jellyfin-test', image: 'jellyfin/jellyfin:10.10.3', mounts: [vol('jf_config', '/config')], running: false });
    w.cfg.servers.set(CONF, OURS).set('jf_config', OTHER);
    const r = await s.service.moveScan(OURS);
    expect(r).toEqual({ candidates: [
      { id: ours.id, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', state: 'running', matches: true },
      { id: copy.id, name: 'jellyfin-test', image: 'jellyfin/jellyfin:10.10.3', state: 'exited', matches: false },
    ] });
    // each /config mounted read-only at /source, as Docker recorded it; the helper runs as the configured user, never root; only
    // the id-only scan (no sizes) within the short limit
    expect(w.helperCalls.map((c) => [c.verb, c.args, c.mounts, c.user, c.limit])).toEqual(expect.arrayContaining([
      ['migrate-scan', ['id'], [{ Type: 'bind', Source: CONF, Target: '/source', ReadOnly: true }], '1000:1000', SYNC_HELPER_MS],
      ['migrate-scan', ['id'], [{ Type: 'volume', Source: 'jf_config', Target: '/source', ReadOnly: true, VolumeOptions: { NoCopy: true } }], '1000:1000', SYNC_HELPER_MS],
    ]));
    expect(w.helperCalls).toHaveLength(2);
    // nothing was started, stopped or created besides the helpers
    expect(w.changes().filter((c) => !c.endsWith('helper'))).toEqual([]);

    for (let i = 0; i < 5; i++) w.foreign({ name: `jf-${i}`, image: 'jellyfin/jellyfin', mounts: [config(`/srv/more/${i}`)], running: false });
    w.helperCalls.length = 0;
    const many = await s.service.moveScan(OURS);
    expect('candidates' in many && many.candidates.length).toBe(7);
    expect(w.helperCalls).toHaveLength(5);
    // the running ones are scanned first; the rest is listed without an answer
    expect('candidates' in many && many.candidates.filter((c) => c.matches === null)).toHaveLength(2);
    expect('candidates' in many && many.candidates.find((c) => c.id === ours.id)?.matches).toBe(true);
  });

  it('source_mismatch for another server id', async () => {
    const s = setup();
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config(), bind(`${BASE}/Filme`, '/movies')] });
    s.w.cfg.servers.set(CONF, OTHER);
    expect(await scan(s, c.id)).toEqual({ error: 'source_mismatch' });
    await expect(scanSource(await s.deps(), c.id, OURS)).rejects.toMatchObject({ code: 'source_mismatch' });
    // with the right id it scans
    s.w.cfg.servers.set(CONF, OURS);
    expect(await scan(s, c.id)).toHaveProperty('scan');
    // the chosen source gets the sized scan, with its longer limit
    expect(s.w.helperCalls.map((x) => [x.args, x.limit]).at(-1)).toEqual([[], SCAN_HELPER_MS]);
    expect(SCAN_HELPER_MS).toBe(120_000);
  });

  it('only a Jellyfin candidate can be scanned: another image, our own containers and an unknown id are source_missing', async () => {
    const s = setup();
    const web = s.w.foreign({ name: 'web', image: 'nginx:1.27', mounts: [config()] });
    const helper = s.w.foreign({ name: 'h', image: 'jellyfin/jellyfin', mounts: [config()], labels: { 'friendflix.managed': 'helper' } });
    const managed = s.w.existing(JSPEC, jellyPin('10.11.3'), '10.11.3');
    s.w.cfg.servers.set(CONF, OURS);
    for (const id of [web.id, helper.id, managed.id, 'e'.repeat(64)]) expect(await scan(s, id), id).toEqual({ error: 'source_missing' });
    expect(s.w.helperCalls).toHaveLength(0);
  });

  it('a source without a /config mount is source_layout', async () => {
    const s = setup();
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin', mounts: [bind(`${BASE}/Filme`, '/movies')] });
    expect(await scan(s, c.id)).toEqual({ error: 'source_layout' });
  });
});

describe('reading the source', () => {
  it('media inside the base become migrated folders, the base itself with rel \'\'', async () => {
    const s = setup();
    const { w } = s;
    w.volumes.set('tv', { labels: {}, options: { type: 'none', o: 'bind', device: `${BASE}/Serien/HD` } });
    w.images.set(`sha256:${'6'.repeat(64)}`, { id: `sha256:${'6'.repeat(64)}`, repoDigests: [], labels: { 'org.opencontainers.image.version': '10.10.3' }, env: [], entrypoint: null, cmd: null, volumes: [], user: '' });
    const c = w.foreign({
      name: 'jellyfin', image: 'jellyfin/jellyfin:latest', imageId: `sha256:${'6'.repeat(64)}`,
      mounts: [
        config(), bind('/srv/jellyfin/cache', '/cache'), bind('/srv/jellyfin/transcodes', '/transcodes'), bind('/dev/dri', '/dev/dri'),
        bind('/var/run/docker.sock', '/var/run/docker.sock'), bind('/etc/localtime', '/etc/localtime'), vol('a'.repeat(64), '/cache/extra'),
        bind('/srv/jellyfin/tc', '/data/transcodes'), bind('/srv/jellyfin/tc2', '/Transcode'),
        bind(`${BASE}/Filme`, '/movies'), vol('tv', '/data/tv'), bind(`${BASE}/Umkodiert`, '/data/transcoded'),
      ],
    });
    w.cfg.servers.set(CONF, OURS);
    const r = await scanSource(await s.deps(), c.id, OURS);
    expect(r).toEqual({
      source: { id: c.id, name: 'jellyfin', image: 'jellyfin/jellyfin:latest', config: { type: 'bind', source: CONF }, serverId: OURS, version: '10.10.3', at: new Date(T0).toISOString() },
      // a container path that merely contains "transcode" is media; only a transcode(s) component is skipped
      folders: [{ rel: 'Filme', target: '/movies', migrated: true }, { rel: 'Serien/HD', target: '/data/tv', migrated: true }, { rel: 'Umkodiert', target: '/data/transcoded', migrated: true }],
      layout: 'official', bytes: 5_000_000, trickplayBytes: 1_000_000, plugins: ['Open Subtitles'], nfo: false,
    });

    // the whole base at one path; the version from the tag when the image has no version label
    const whole = w.foreign({ name: 'jf2', image: 'lscr.io/linuxserver/jellyfin:10.9.11', mounts: [config('/srv/jf2/config'), bind(BASE, '/media')] });
    w.cfg.servers.set('/srv/jf2/config', OURS);
    const r2 = await scanSource(await s.deps(), whole.id, OURS);
    expect(r2.folders).toEqual([{ rel: '', target: '/media', migrated: true }]);
    expect(r2.source.version).toBe('10.9.11');

    // the op answer: no host path and no server id, only what the page shows
    const a = await scan(s, c.id);
    expect(a).toEqual({
      candidates: expect.any(Array) as unknown,
      scan: { source: { id: c.id, name: 'jellyfin', image: 'jellyfin/jellyfin:latest', version: '10.10.3' }, folders: r.folders, layout: 'official', bytes: 5_000_000, trickplayBytes: 1_000_000, plugins: ['Open Subtitles'], nfo: false },
    });
    expect(JSON.stringify(a)).not.toContain(CONF);
    expect(JSON.stringify(a)).not.toContain(OURS);
  });

  it('a mount outside the base is source_outside_base with its container path only (never a host path)', async () => {
    const s = setup();
    const { w } = s;
    w.volumes.set('nfs', { labels: {}, options: { type: 'nfs', o: 'addr=192.0.2.10,ro', device: ':/export/media' } });
    w.volumes.set('outside', { labels: {}, options: { type: 'none', o: 'bind', device: '/mnt/elsewhere/tv' } });
    const c = w.foreign({
      name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3',
      mounts: [
        config(), bind(`${BASE}/Filme`, '/movies'), bind('/mnt/elsewhere/music', '/music'), vol('nfs', '/nfs'), vol('outside', '/tv'),
        // inside the base, but at a path a migrated Ferrofin cannot use (data itself, a system tree, too deep, nested in another)
        bind(`${BASE}/Serien`, '/data'), bind(`${BASE}/Doku`, '/usr/share/doku'), bind(`${BASE}/Kinder`, '/a/b/c/d'),
        // a base look-alike next to it is not inside it
        bind(`${BASE}-old/Filme`, '/old'),
      ],
    });
    w.cfg.servers.set(CONF, OURS);
    const a = await scan(s, c.id);
    expect(a).toEqual({
      error: 'source_outside_base',
      outside: ['/a/b/c/d', '/data', '/music', '/nfs', '/old', '/tv', '/usr/share/doku'],
      refused: ['/a/b/c/d', '/data', '/usr/share/doku'],
    });
    for (const host of ['/mnt', BASE, 'export', '192.0.2.10', CONF]) expect(JSON.stringify(a), host).not.toContain(host);
    const e = await scanSource(await s.deps(), c.id, OURS).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(String((e as Error).message)).toBe('source_outside_base');
  });

  it('a nested mount that shows the same files as its parent is dropped as redundant', async () => {
    const s = setup();
    s.w.cfg.servers.set(CONF, OURS);
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin', mounts: [config(), bind(`${BASE}/Filme`, '/movies'), bind(`${BASE}/Filme/4K`, '/movies/4K'), bind(`${BASE}/Serien`, '/tv')] });
    expect((await scanSource(await s.deps(), c.id, OURS)).folders).toEqual([{ rel: 'Filme', target: '/movies', migrated: true }, { rel: 'Serien', target: '/tv', migrated: true }]);
  });

  it('the whole base plus an inner folder at its matching path: the inner one is dropped', async () => {
    const s = setup();
    s.w.cfg.servers.set(CONF, OURS);
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin', mounts: [config(), bind(`${BASE}/Filme`, '/media/Filme'), bind(BASE, '/media'), bind(`${BASE}/Serien/HD`, '/media/Serien/HD')] });
    expect((await scanSource(await s.deps(), c.id, OURS)).folders).toEqual([{ rel: '', target: '/media', migrated: true }]);
  });

  it('inconsistent nesting refuses the move with source_nested (container paths only)', async () => {
    const s = setup();
    s.w.cfg.servers.set(CONF, OURS).set('/srv/b/config', OURS).set('/srv/c/config', OURS);
    // nested targets, but the inner one shows another folder than the outer one has there
    const a = s.w.foreign({ name: 'a', image: 'jellyfin/jellyfin', mounts: [config(), bind(`${BASE}/Filme`, '/movies'), bind(`${BASE}/Filme/4K`, '/movies/4k')] });
    expect(await scan(s, a.id)).toEqual({ error: 'source_nested', nested: ['/movies', '/movies/4k'] });
    // overlapping folders at unrelated paths (the base and a folder in it; one folder at two paths)
    const b = s.w.foreign({ name: 'b', image: 'jellyfin/jellyfin', mounts: [config('/srv/b/config'), bind(BASE, '/library'), bind(`${BASE}/Filme`, '/movies')] });
    expect(await scan(s, b.id)).toEqual({ error: 'source_nested', nested: ['/library', '/movies'] });
    const c = s.w.foreign({ name: 'c', image: 'jellyfin/jellyfin', mounts: [config('/srv/c/config'), bind(`${BASE}/Filme`, '/movies'), bind(`${BASE}/Filme`, '/films')] });
    expect(await scan(s, c.id)).toEqual({ error: 'source_nested', nested: ['/films', '/movies'] });
    await expect(scanSource(await s.deps(), c.id, OURS)).rejects.toMatchObject({ code: 'source_nested' });
    expect(JSON.stringify(await scan(s, c.id))).not.toContain(BASE);
  });

  it('more than 20 kept folders is too_many_folders', async () => {
    const s = setup();
    s.w.cfg.servers.set(CONF, OURS);
    const media = (n: number): InspectMount[] => Array.from({ length: n }, (_x, k) => bind(`${BASE}/F${k}`, `/m/f${k}`));
    const ok = s.w.foreign({ name: 'ok', image: 'jellyfin/jellyfin', mounts: [config(), ...media(20)] });
    expect((await scanSource(await s.deps(), ok.id, OURS)).folders).toHaveLength(20);
    s.w.containers.delete(ok.id);
    const many = s.w.foreign({ name: 'many', image: 'jellyfin/jellyfin', mounts: [config(), ...media(21)] });
    expect(await scan(s, many.id)).toEqual({ error: 'too_many_folders' });
  });

  it('classifyMounts keeps a volume as the config and never a host path in outside', () => {
    const r = classifyMounts({ Mounts: [vol('jf_config', '/config'), bind('/volume1/video', '/video')] }, { path: BASE });
    expect(r).toEqual({ config: { type: 'volume', source: 'jf_config' }, media: [], outside: ['/video'], refused: [], nested: [] });
    expect(classifyMounts({ Mounts: [config()] }, { path: BASE }, {}).config).toEqual({ type: 'bind', source: CONF });
    expect(classifyMounts({}, { path: BASE }).config).toBeNull();
  });

  it('a scan needs a confirmed base', async () => {
    const s = setup();
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin', mounts: [config()] });
    s.w.cfg.servers.set(CONF, OURS);
    s.w.updater.updateMedia((m) => { m.base = null; });
    expect(await scan(s, c.id)).toEqual({ error: 'no_base' });
  });

  it('a config bind the guard refuses never reaches a helper', async () => {
    const s = setup();
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin', mounts: [bind('/var/lib/docker/volumes/x/_data', '/config')] });
    s.w.cfg.servers.set('/var/lib/docker/volumes/x/_data', OURS);
    expect(await scan(s, c.id)).toEqual({ error: 'template_violation' });
    expect(s.w.helperCalls).toHaveLength(0);
  });

  it('a helper answer of the wrong shape is helper_failed', async () => {
    const s = setup();
    const c = s.w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin', mounts: [config()] });
    s.w.cfg.answer = () => ({ layout: 'official', serverId: OURS.toUpperCase(), bytes: -1, trickplayBytes: 0, plugins: [], nfo: false });
    expect(await scan(s, c.id)).toEqual({ error: 'helper_failed' });
  });
});

describe('the recorded source', () => {
  const recorded = (id: string, o: Partial<RecordedSource> = {}): RecordedSource => ({
    id, name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', config: { type: 'bind', source: CONF }, serverId: OURS, version: '10.10.3', at: new Date(T0).toISOString(), ...o,
  });

  it('rematch by config source and server id', async () => {
    const s = setup();
    const { w } = s;
    w.cfg.servers.set(CONF, OURS).set('/srv/copy/config', OURS);
    const now = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config()] });
    // the recorded container is still there: it is the source
    expect(await rematch(await s.deps(), recorded(now.id))).toBe(now.id);
    // recreated (Watchtower, compose up, Portainer): another id, the same /config and server id
    w.containers.delete(now.id);
    const again = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.11.0', mounts: [config()], running: false });
    // a copy with the same server id under another /config is not it
    w.foreign({ name: 'jellyfin-copy', image: 'jellyfin/jellyfin:10.11.0', mounts: [config('/srv/copy/config')] });
    expect(await rematch(await s.deps(), recorded(now.id))).toBe(again.id);
    // the same /config, but the server there is another one now
    w.cfg.servers.set(CONF, OTHER);
    expect(await rematch(await s.deps(), recorded(now.id))).toBeNull();
    // only the id-only scan runs (never the sized one)
    expect(w.helperCalls.every((c) => c.args[0] === 'id' && c.limit === SYNC_HELPER_MS)).toBe(true);
  });

  it('recorded + another running on the same /config → null (never two Jellyfins on one database)', async () => {
    const s = setup();
    const { w } = s;
    w.cfg.servers.set(CONF, OURS);
    const old = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config()], running: false });
    const sibling = w.foreign({ name: 'jellyfin-new', image: 'jellyfin/jellyfin:10.11.0', mounts: [config()] });
    expect(await rematch(await s.deps(), recorded(old.id))).toBeNull();
    // any image counts as a sibling (another Jellyfin build on the same /config)
    w.containers.delete(sibling.id);
    const hotio = w.foreign({ name: 'hotio', image: 'ghcr.io/hotio/jellyfin:release', mounts: [config()] });
    expect(await rematch(await s.deps(), recorded(old.id))).toBeNull();
    // stopped, it no longer blocks
    hotio.running = false;
    expect(await rematch(await s.deps(), recorded(old.id))).toBe(old.id);
  });

  it('two non-recorded containers on the recorded /config → null', async () => {
    const s = setup();
    const { w } = s;
    w.cfg.servers.set(CONF, OURS);
    w.foreign({ name: 'jellyfin-a', image: 'jellyfin/jellyfin:10.11.0', mounts: [config()], running: false });
    w.foreign({ name: 'jellyfin-b', image: 'jellyfin/jellyfin:10.11.0', mounts: [config()], running: false });
    expect(await rematch(await s.deps(), recorded('f'.repeat(64)))).toBeNull();
  });

  it('a container with the same name but another config source is not the source', async () => {
    const s = setup();
    const { w } = s;
    const old = w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config()] });
    w.containers.delete(old.id);
    w.foreign({ name: 'jellyfin', image: 'jellyfin/jellyfin:10.10.3', mounts: [config('/srv/new/config')] });
    w.cfg.servers.set(CONF, OURS).set('/srv/new/config', OURS);
    expect(await rematch(await s.deps(), recorded(old.id))).toBeNull();
    // and a non-Jellyfin container with the recorded /config is never matched
    w.foreign({ name: 'other', image: 'nginx:1.27', mounts: [config()] });
    expect(await rematch(await s.deps(), recorded(old.id))).toBeNull();
    // nor one of ours
    w.foreign({ name: 'ours', image: 'jellyfin/jellyfin', mounts: [config()], labels: { 'friendflix.managed': 'mediaserver' } });
    expect(await rematch(await s.deps(), recorded(old.id))).toBeNull();
  });
});
