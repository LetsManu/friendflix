// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertHelper, TemplateViolation } from '../src/mediaserver/guard.js';
import {
  canonical, containerSpec, FERROFIN_ADMIN_NAME, FFMPEG_DIR, HDR_INNER, HDR_TEST1_ARGS, hdrSpec, helperSpec, names, needsSeed, SEED_DIR, seedSpec,
  specHash, uidSupported, volumeSpec, type TemplateFacts,
} from '../src/mediaserver/template.js';
import type { DesiredSpec } from '../src/mediaserver/types.js';

const IMG = 'ghcr.io/letsmanu/friendflix-mediaserver@sha256:' + 'a'.repeat(64);
const JIMG = 'docker.io/jellyfin/jellyfin@sha256:' + 'b'.repeat(64);
const BASE = 'friendflix_mediaserver-base-' + createHash('sha256').update('/srv/media').digest('hex').slice(0, 8);
const D: DesiredSpec = {
  kind: 'ferrofin', folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien', target: '/media/serien' }],
  uid: 1000, gid: 1000, gpu: 'dri', mediaGid: 2000, egress: true, tz: 'Europe/Berlin',
};
const F: TemplateFacts = { project: 'friendflix', image: IMG, renderGids: [993], baseVolume: BASE };
const pw = 'A'.repeat(43);

type Body = Record<string, any>;
const body = (d: Partial<DesiredSpec> = {}, f: Partial<TemplateFacts> = {}, o?: { password?: string }): Body => containerSpec({ ...D, ...d }, { ...F, ...f }, o).body as Body;
const labels = (b: Body): Record<string, string> => b.Labels;

describe('media server container template', () => {
  it('golden: ferrofin with Intel/AMD', () => {
    const req = containerSpec(D, F);
    expect(req.name).toBe('friendflix-mediaserver');
    const { Labels, ...rest } = req.body as { Labels: Record<string, string> };
    expect(rest).toEqual({
      Hostname: 'mediaserver', User: '1000:1000', Image: IMG, Env: ['TZ=Europe/Berlin'], StopTimeout: 30,
      HostConfig: {
        NetworkMode: 'friendflix_media',
        Mounts: [
          { Type: 'volume', Source: 'friendflix_mediaserver-ferrofin-data', Target: '/data', ReadOnly: false },
          { Type: 'volume', Source: 'friendflix_mediaserver-ferrofin-cache', Target: '/cache', ReadOnly: false },
          { Type: 'volume', Source: BASE, Target: '/media/filme', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'Filme' } },
          { Type: 'volume', Source: BASE, Target: '/media/serien', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'Serien' } },
        ],
        Tmpfs: { '/tmp': 'size=512m,mode=1777' }, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }], GroupAdd: ['993', '2000'],
        RestartPolicy: { Name: 'unless-stopped' }, Init: true, PidsLimit: 4096,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
      NetworkingConfig: { EndpointsConfig: { friendflix_media: { Aliases: ['mediaserver'] } } },
    });
    expect(Labels).toEqual({
      'friendflix.managed': 'mediaserver', 'friendflix.project': 'friendflix', 'friendflix.kind': 'ferrofin',
      'friendflix.template': '1', 'com.centurylinklabs.watchtower.enable': 'false', 'friendflix.spec': specHash(req.body),
    });
    expect(Labels['friendflix.spec']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('golden: jellyfin with NVIDIA, no egress, no media group', () => {
    const req = containerSpec({ ...D, kind: 'jellyfin', gpu: 'nvidia', egress: false, mediaGid: null }, { ...F, image: JIMG });
    expect(req.name).toBe('friendflix-mediaserver');
    const { Labels, ...rest } = req.body as { Labels: Record<string, string> };
    expect(rest).toEqual({
      Hostname: 'mediaserver', User: '1000:1000', Image: JIMG,
      Env: ['TZ=Europe/Berlin', 'XDG_CACHE_HOME=/cache/xdg', 'NVIDIA_DRIVER_CAPABILITIES=compute,video,utility'], StopTimeout: 30,
      HostConfig: {
        NetworkMode: 'friendflix_media',
        Mounts: [
          { Type: 'volume', Source: 'friendflix_mediaserver-jellyfin-config', Target: '/config', ReadOnly: false },
          { Type: 'volume', Source: 'friendflix_mediaserver-jellyfin-cache', Target: '/cache', ReadOnly: false },
          { Type: 'volume', Source: BASE, Target: '/media/filme', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'Filme' } },
          { Type: 'volume', Source: BASE, Target: '/media/serien', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'Serien' } },
        ],
        Tmpfs: { '/tmp': 'size=512m,mode=1777' }, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        DeviceRequests: [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }],
        RestartPolicy: { Name: 'unless-stopped' }, Init: true, PidsLimit: 4096,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
      NetworkingConfig: { EndpointsConfig: { friendflix_media: { Aliases: ['mediaserver'] } } },
    });
    expect(Labels).toEqual({
      'friendflix.managed': 'mediaserver', 'friendflix.project': 'friendflix', 'friendflix.kind': 'jellyfin',
      'friendflix.template': '1', 'com.centurylinklabs.watchtower.enable': 'false', 'friendflix.spec': specHash(req.body),
    });
  });

  it('gpu off: no Devices, DeviceRequests or GroupAdd', () => {
    const h = body({ gpu: 'off', mediaGid: null }).HostConfig;
    expect(h).not.toHaveProperty('Devices');
    expect(h).not.toHaveProperty('DeviceRequests');
    expect(h).not.toHaveProperty('GroupAdd');
    expect(body({ gpu: 'off' }).HostConfig.GroupAdd).toEqual(['2000']);
    expect(body({ gpu: 'off' }).Env).toEqual(['TZ=Europe/Berlin']);
  });

  it('first run adds the administrator after TZ only when given', () => {
    expect(FERROFIN_ADMIN_NAME).toBe('FERROFIN_ADMIN_USER');
    expect(body({}, {}, { password: pw }).Env).toEqual(['TZ=Europe/Berlin', 'FERROFIN_ADMIN_USER=friendflix-admin', 'FERROFIN_ADMIN_PASSWORD=' + pw]);
    expect(body({ gpu: 'nvidia' }, {}, { password: pw }).Env).toEqual([
      'TZ=Europe/Berlin', 'FERROFIN_ADMIN_USER=friendflix-admin', 'FERROFIN_ADMIN_PASSWORD=' + pw, 'NVIDIA_DRIVER_CAPABILITIES=compute,video,utility',
    ]);
    expect(body({}, {}, {}).Env).toEqual(['TZ=Europe/Berlin']);
    expect(() => body({ kind: 'jellyfin' }, { image: JIMG }, { password: pw })).toThrow(TemplateViolation);
    expect(() => body({}, {}, { password: 'x\nLD_PRELOAD=/x' })).toThrow(TemplateViolation);
  });

  it('render gids sorted, deduplicated with mediaGid, at most 4 render gids', () => {
    expect(body({}, { renderGids: [993, 44, 993, 2000] }).HostConfig.GroupAdd).toEqual(['44', '993', '2000']);
    expect(body({ mediaGid: 44 }, { renderGids: [107, 44] }).HostConfig.GroupAdd).toEqual(['44', '107']);
    expect(body({ mediaGid: null }, { renderGids: [] }).HostConfig).not.toHaveProperty('GroupAdd');
    expect(body({}, { renderGids: [44, 993, 105, 106] }).HostConfig.GroupAdd).toEqual(['44', '105', '106', '993', '2000']);
    let err: unknown;
    try { body({}, { renderGids: [44, 993, 44, 105, 106, 107] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TemplateViolation);
    expect((err as TemplateViolation).field).toBe('GroupAdd');
    expect(() => body({}, { renderGids: [0] })).toThrow(TemplateViolation);
    // render gids only count with the Intel/AMD choice
    expect(body({ gpu: 'nvidia', mediaGid: null }, { renderGids: [44, 993, 105, 106, 107] }).HostConfig).not.toHaveProperty('GroupAdd');
  });

  it('refuses what the parser should have stopped', () => {
    expect(() => body({ uid: 0 })).toThrow(TemplateViolation);
    expect(() => body({ folders: [{ rel: 'Filme', target: '/data/x' }] })).toThrow(TemplateViolation);
    expect(() => body({ folders: [{ rel: '../etc', target: '/media/x' }] })).toThrow(TemplateViolation);
  });

  it('the spec hash is stable and changes with every field', () => {
    const h = (d: Partial<DesiredSpec> = {}, f: Partial<TemplateFacts> = {}) => labels(body(d, f))['friendflix.spec'];
    const base = h();
    expect(h()).toBe(base);
    expect(h({ egress: false })).toBe(base);
    const variants = [
      h({ uid: 1001 }), h({ gid: 1001 }), h({ folders: [{ rel: 'Filme', target: '/media/filme' }] }), h({ folders: [{ rel: 'Filme2', target: '/media/filme' }, D.folders[1]!] }),
      h({ gpu: 'off' }), h({ gpu: 'nvidia' }), h({ tz: 'UTC' }), h({}, { renderGids: [994] }), h({ mediaGid: null }), h({}, { image: IMG.replace(/a{64}$/, 'd'.repeat(64)) }),
      h({}, { baseVolume: 'friendflix_mediaserver-base-00000000' }), h({}, { project: 'other' }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
    expect(labels(body({}, {}, { password: pw }))['friendflix.spec']).not.toBe(base);
  });

  it('canonical JSON sorts keys recursively and keeps array order', () => {
    expect(canonical({ b: 1, a: { d: [2, 1], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(specHash({ Labels: { 'friendflix.spec': 'x', a: '1' }, B: 2 })).toBe(specHash({ B: 2, Labels: { a: '1' } }));
  });

  it('names', () => {
    const n = names('friendflix');
    expect([n.container, n.old, n.data('ferrofin'), n.cache('ferrofin'), n.data('jellyfin'), n.cache('jellyfin'), n.base('/srv/media'), n.backup]).toEqual([
      'friendflix-mediaserver', 'friendflix-mediaserver-old', 'friendflix_mediaserver-ferrofin-data', 'friendflix_mediaserver-ferrofin-cache',
      'friendflix_mediaserver-jellyfin-config', 'friendflix_mediaserver-jellyfin-cache', BASE, 'friendflix_mediaserver-backup',
    ]);
    expect(n.helper()).toMatch(/^friendflix-mediahelper-[0-9a-f]{8}$/);
    expect(n.helper()).not.toBe(n.helper());
    expect([n.media, n.egress]).toEqual(['friendflix_media', 'friendflix_egress']);
  });
});

describe('seed containers', () => {
  it('seed only where the uid differs from the image owner', () => {
    expect(needsSeed('ferrofin', 1000, 1000)).toBe(false);
    expect(needsSeed('ferrofin', 1000, 2000)).toBe(true);
    expect(needsSeed('jellyfin', 1000, 1000)).toBe(true);
    const req = seedSpec('jellyfin', 'data', { ...D, kind: 'jellyfin' }, { ...F, image: JIMG });
    expect(req.name).toMatch(/^friendflix-mediahelper-[0-9a-f]{8}$/);
    expect(req.body).toEqual({
      Image: JIMG, User: '1000:1000', Cmd: ['true'], Labels: { 'friendflix.managed': 'helper', 'friendflix.project': 'friendflix' },
      HostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], AutoRemove: false,
        Mounts: [{ Type: 'volume', Source: 'friendflix_mediaserver-jellyfin-config', Target: SEED_DIR.jellyfin, ReadOnly: false }],
      },
    });
    expect(() => assertHelper(req.body, { project: 'friendflix', uid: 1000, gid: 1000, image: JIMG, verb: 'seed', kind: 'jellyfin' })).not.toThrow();
    const cache = seedSpec('jellyfin', 'cache', { ...D, kind: 'jellyfin' }, { ...F, image: JIMG });
    expect((cache.body as Body).HostConfig.Mounts[0].Source).toBe('friendflix_mediaserver-jellyfin-cache');
    expect(() => assertHelper(cache.body, { project: 'friendflix', uid: 1000, gid: 1000, image: JIMG, verb: 'seed', kind: 'jellyfin' })).not.toThrow();
  });

  it('a uid is supported when no seed is needed or the kind has a seed directory', () => {
    expect(uidSupported('jellyfin', 1000, 1000)).toBe(true);
    expect(uidSupported('jellyfin', 1000, 1000, { ...SEED_DIR, jellyfin: null })).toBe(false);
    expect(uidSupported('ferrofin', 1000, 1000)).toBe(true);
    // the pinned Ferrofin image's /data is 1000:1000 0755 and is copied up again at the real create: a seed cannot help (report)
    expect(SEED_DIR.ferrofin).toBeNull();
    expect(uidSupported('ferrofin', 1001, 1001)).toBe(false);
    expect(() => seedSpec('ferrofin', 'data', { ...D, uid: 1001 }, F)).toThrow(TemplateViolation);
  });
});

describe('volumes', () => {
  it('base, data and cache volumes', () => {
    expect(volumeSpec('friendflix', 'base', { path: '/srv/media' })).toEqual({
      Name: BASE, Driver: 'local', DriverOpts: { type: 'none', o: 'bind,ro', device: '/srv/media' },
      Labels: { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': 'friendflix' },
    });
    expect(volumeSpec('friendflix', 'data', { kind: 'jellyfin' })).toEqual({
      Name: 'friendflix_mediaserver-jellyfin-config', Driver: 'local', DriverOpts: {},
      Labels: { 'friendflix.managed': 'mediaserver-data', 'friendflix.project': 'friendflix' },
    });
    expect(volumeSpec('friendflix', 'cache', { kind: 'ferrofin' })).toEqual({
      Name: 'friendflix_mediaserver-ferrofin-cache', Driver: 'local', DriverOpts: {},
      Labels: { 'friendflix.managed': 'mediaserver-cache', 'friendflix.project': 'friendflix' },
    });
    expect(() => volumeSpec('friendflix', 'base', {})).toThrow(TemplateViolation);
    expect(() => volumeSpec('friendflix', 'base', { path: 'srv/media' })).toThrow(TemplateViolation);
    expect(() => volumeSpec('friendflix', 'data', {})).toThrow(TemplateViolation);
  });
});

describe('helper containers', () => {
  const H = { project: 'friendflix', image: 'sha256:' + 'c'.repeat(64) };

  it('helpers', () => {
    const req = helperSpec({ verb: 'browse', args: ['Filme'], uid: 1000, gid: 1000, groups: [2000], mounts: [{ kind: 'base', volume: BASE }] }, H);
    expect(req.name).toMatch(/^friendflix-mediahelper-[0-9a-f]{8}$/);
    expect(req.body).toEqual({
      Image: H.image, User: '1000:1000', Cmd: ['node', 'updater/dist/mediaHelper.js', 'browse', 'Filme'],
      Labels: { 'friendflix.managed': 'helper', 'friendflix.project': 'friendflix' },
      HostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], AutoRemove: false,
        Tmpfs: { '/tmp': 'size=64m' }, GroupAdd: ['2000'],
        Mounts: [{ Type: 'volume', Source: BASE, Target: '/base', ReadOnly: true, VolumeOptions: { NoCopy: true } }],
      },
    });
  });

  it('every helper mount kind', () => {
    const req = helperSpec({
      verb: 'restore', args: [], uid: 1000, gid: 1000, groups: [],
      mounts: [{ kind: 'request', path: '/srv/media' }, { kind: 'dri' }, { kind: 'drm' }, { kind: 'data', volume: 'friendflix_mediaserver-ferrofin-data', rw: true }, { kind: 'backup', rw: false }],
    }, H);
    expect((req.body as Body).HostConfig).not.toHaveProperty('GroupAdd');
    expect((req.body as Body).HostConfig.Mounts).toEqual([
      { Type: 'bind', Source: '/srv/media', Target: '/base', ReadOnly: true },
      { Type: 'bind', Source: '/dev/dri', Target: '/dev/dri', ReadOnly: true },
      { Type: 'bind', Source: '/sys/class/drm', Target: '/sys-drm', ReadOnly: true },
      { Type: 'volume', Source: 'friendflix_mediaserver-ferrofin-data', Target: '/data', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: 'friendflix_mediaserver-backup', Target: '/backups', ReadOnly: true },
    ]);
  });
});

describe('HDR test', () => {
  const script = readFileSync(new URL('../../mediaserver/probe.sh', import.meta.url), 'utf8');
  const joined = script.replace(/\s*\\\n\s*/g, ' ');

  it('HDR tests match probe.sh', () => {
    expect(FFMPEG_DIR).toEqual({ ferrofin: '/usr/local/bin', jellyfin: '/usr/lib/jellyfin-ffmpeg' });
    const test1 = HDR_TEST1_ARGS.map((a) => a.replace('/dev/dri/<node>', '$RENDER_NODE')).join(' ');
    expect(joined.replace(/"/g, '')).toContain(`--entrypoint ${FFMPEG_DIR.ferrofin}/ffmpeg $IMAGE ${test1} 2>&1`);
    const inner = /\nINNER='([^']*)'\n/.exec(script)?.[1];
    expect(inner).toBeDefined();
    const dir = FFMPEG_DIR.ferrofin;
    expect(inner!.replace(/^FF=\S+ FP=\S+ /m, `FF=${dir}/ffmpeg FP=${dir}/ffprobe `)).toBe(HDR_INNER);
    expect(joined).toContain('-c "$INNER" probe "$RENDER_NODE"');
  });

  it('hdr containers', () => {
    const o = { project: 'friendflix', kind: 'jellyfin' as const, image: JIMG, uid: 1000, gid: 1000, renderGids: [993, 44], node: 'renderD128' };
    const common = {
      Image: JIMG, User: '1000:1000', Labels: { 'friendflix.managed': 'helper', 'friendflix.project': 'friendflix' },
      HostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], AutoRemove: false,
        Tmpfs: { '/tmp': 'size=256m' }, Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }], GroupAdd: ['44', '993'],
      },
    };
    const t1 = hdrSpec(1, o);
    expect(t1.name).toMatch(/^friendflix-mediahelper-[0-9a-f]{8}$/);
    expect(t1.body).toEqual({
      ...common, Entrypoint: ['/usr/lib/jellyfin-ffmpeg/ffmpeg'],
      Cmd: ['-hide_banner', '-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-init_hw_device', 'opencl=ocl@va', '-f', 'lavfi', '-i', 'nullsrc', '-frames', '1', '-f', 'null', '-'],
    });
    const t2 = hdrSpec(2, o).body as Body;
    expect(t2.Entrypoint).toEqual(['/bin/sh']);
    expect(t2.Cmd.slice(2)).toEqual(['probe', '/dev/dri/renderD128']);
    expect(t2.Cmd[0]).toBe('-c');
    expect(t2.Cmd[1]).toBe(HDR_INNER.replace('FF=/usr/local/bin/ffmpeg FP=/usr/local/bin/ffprobe', 'FF=/usr/lib/jellyfin-ffmpeg/ffmpeg FP=/usr/lib/jellyfin-ffmpeg/ffprobe'));
    expect((hdrSpec(2, { ...o, kind: 'ferrofin', image: IMG }).body as Body).Cmd[1]).toBe(HDR_INNER);
    const g = { project: 'friendflix', uid: 1000, gid: 1000, image: JIMG, verb: 'hdr' as const };
    expect(() => assertHelper(t1.body, g)).not.toThrow();
    expect(() => assertHelper(t2, g)).not.toThrow();
    expect(() => hdrSpec(1, { ...o, node: '../sda' })).toThrow(TemplateViolation);
    expect(() => hdrSpec(1, { ...o, renderGids: [1, 2, 3, 4, 5] })).toThrow(TemplateViolation);
  });
});
