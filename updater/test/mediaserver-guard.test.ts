// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertHelper, assertManaged, assertManagedInspect, TemplateViolation, type ManagedExpect } from '../src/mediaserver/guard.js';
import { containerSpec, hdrSpec, helperSpec, seedSpec, type HelperRequest, type TemplateFacts } from '../src/mediaserver/template.js';
import type { DesiredSpec } from '../src/mediaserver/types.js';

const IMG = 'ghcr.io/letsmanu/friendflix-mediaserver@sha256:' + 'a'.repeat(64);
const JIMG = 'docker.io/jellyfin/jellyfin@sha256:' + 'b'.repeat(64);
const BASE = 'friendflix_mediaserver-base-' + createHash('sha256').update('/srv/media').digest('hex').slice(0, 8);
const D: DesiredSpec = {
  kind: 'ferrofin', folders: [{ rel: 'Filme', target: '/media/filme' }, { rel: 'Serien', target: '/media/serien' }],
  uid: 1000, gid: 1000, gpu: 'dri', mediaGid: 2000, egress: true, tz: 'Europe/Berlin',
};
const F: TemplateFacts = { project: 'friendflix', image: IMG, renderGids: [993], baseVolume: BASE };
const E: ManagedExpect = { project: 'friendflix', kind: 'ferrofin', uid: 1000, gid: 1000, repo: 'LetsManu/friendflix' };

type Body = Record<string, any>;
const clone = <T>(v: T): T => structuredClone(v);
const ok = (): Body => clone(containerSpec(D, F).body) as Body;
const refuses = (fn: () => void): void => expect(fn).toThrow(TemplateViolation);

describe('managed container guard', () => {
  it('the template passes', () => {
    expect(() => assertManaged(ok(), E)).not.toThrow();
    expect(() => assertManaged(containerSpec(D, F, { password: 'A'.repeat(43) }).body, E)).not.toThrow();
    expect(() => assertManaged(containerSpec({ ...D, gpu: 'off', mediaGid: null }, F).body, E)).not.toThrow();
    const j = containerSpec({ ...D, kind: 'jellyfin', gpu: 'nvidia', mediaGid: null }, { ...F, image: JIMG }).body;
    expect(() => assertManaged(j, { ...E, kind: 'jellyfin' })).not.toThrow();
    // a body for the other kind is not this kind's
    refuses(() => assertManaged(j, E));
    refuses(() => assertManaged(ok(), { ...E, kind: 'jellyfin' }));
  });

  const H = (b: Body): Body => b.HostConfig;
  const M = (b: Body): Body[] => b.HostConfig.Mounts;
  const media = (b: Body): Body => M(b).find((m) => m.Target === '/media/filme')!;
  const mutations: [string, (b: Body) => void][] = [
    ['HostConfig.Privileged=true', (b) => { H(b).Privileged = true; }],
    ['HostConfig.CapAdd', (b) => { H(b).CapAdd = ['NET_ADMIN']; }],
    ['HostConfig.CapDrop=[]', (b) => { H(b).CapDrop = []; }],
    ['HostConfig.CapDrop missing', (b) => { delete H(b).CapDrop; }],
    ['HostConfig.SecurityOpt seccomp', (b) => { H(b).SecurityOpt = ['seccomp=unconfined']; }],
    ['HostConfig.SecurityOpt extra apparmor', (b) => { H(b).SecurityOpt.push('apparmor=unconfined'); }],
    ['HostConfig.NetworkMode=host', (b) => { H(b).NetworkMode = 'host'; }],
    ['HostConfig.NetworkMode=container:x', (b) => { H(b).NetworkMode = 'container:x'; }],
    ['HostConfig.NetworkMode other network', (b) => { H(b).NetworkMode = 'other_media'; }],
    ['HostConfig.PidMode=host', (b) => { H(b).PidMode = 'host'; }],
    ['HostConfig.IpcMode=host', (b) => { H(b).IpcMode = 'host'; }],
    ['HostConfig.UsernsMode=host', (b) => { H(b).UsernsMode = 'host'; }],
    ['HostConfig.CgroupnsMode=host', (b) => { H(b).CgroupnsMode = 'host'; }],
    ['HostConfig.UTSMode=host', (b) => { H(b).UTSMode = 'host'; }],
    ['HostConfig.PortBindings', (b) => { H(b).PortBindings = { '8096/tcp': [{ HostPort: '8096' }] }; }],
    ['HostConfig.PublishAllPorts=true', (b) => { H(b).PublishAllPorts = true; }],
    ['ExposedPorts', (b) => { b.ExposedPorts = { '8096/tcp': {} }; }],
    ['HostConfig.Binds', (b) => { H(b).Binds = ['/:/host']; }],
    ['a bind mount', (b) => { M(b).push({ Type: 'bind', Source: '/', Target: '/media/root', ReadOnly: true }); }],
    ['a media mount turned into a bind', (b) => { Object.assign(media(b), { Type: 'bind', Source: '/srv/media/Filme' }); delete media(b).VolumeOptions; }],
    ['a mount of the docker socket', (b) => { M(b).push({ Type: 'volume', Source: 'friendflix_mediaserver-base-00000000', Target: '/media/docker.sock', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'x' } }); }],
    ['a mount of /var/run/docker.sock', (b) => { M(b).push({ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' }); }],
    ['a containerd path', (b) => { media(b).VolumeOptions.Subpath = 'containerd'; }],
    ['a tmpfs mount', (b) => { M(b).push({ Type: 'tmpfs', Target: '/media/x' }); }],
    ['a volume named other_x', (b) => { media(b).Source = 'other_x'; }],
    ['a data volume of another project', (b) => { M(b)[0]!.Source = 'other_mediaserver-ferrofin-data'; }],
    ['a data volume of the other kind', (b) => { M(b)[0]!.Source = 'friendflix_mediaserver-jellyfin-config'; }],
    ['the data volume at another target', (b) => { M(b)[0]!.Target = '/config'; }],
    ['the data volume twice', (b) => { M(b).push({ ...M(b)[0]!, Target: '/data2' }); }],
    ['no data volume', (b) => { M(b).shift(); }],
    ['two base volumes', (b) => { media(b).Source = 'friendflix_mediaserver-base-00000000'; }],
    ['a media mount at /data/x', (b) => { media(b).Target = '/data/x'; }],
    ['a media mount at /media', (b) => { media(b).Target = '/media'; }],
    ['a media mount at /media/../etc', (b) => { media(b).Target = '/media/../etc'; }],
    ['two media mounts at one target', (b) => { M(b)[3]!.Target = '/media/filme'; }],
    ['a media mount without ReadOnly', (b) => { delete media(b).ReadOnly; }],
    ['a media mount read-write', (b) => { media(b).ReadOnly = false; }],
    ['a base mount without NoCopy', (b) => { delete media(b).VolumeOptions.NoCopy; }],
    ['a base mount without a subpath', (b) => { delete media(b).VolumeOptions.Subpath; }],
    ['a subpath leaving the base', (b) => { media(b).VolumeOptions.Subpath = '../x'; }],
    ['an absolute subpath', (b) => { media(b).VolumeOptions.Subpath = '/etc'; }],
    ['a dot subpath', (b) => { media(b).VolumeOptions.Subpath = '.'; }],
    ['volume driver options on a mount', (b) => { media(b).VolumeOptions.DriverConfig = { Name: 'local', Options: { type: 'none', o: 'bind', device: '/' } }; }],
    ['volume options on the data mount', (b) => { M(b)[0]!.VolumeOptions = { DriverConfig: { Name: 'local', Options: { device: '/' } } }; }],
    ['bind options on a volume mount', (b) => { media(b).BindOptions = { Propagation: 'rshared' }; }],
    ['Mounts not an array', (b) => { H(b).Mounts = { 0: M(b)[0] }; }],
    ['Devices with /dev/sda', (b) => { H(b).Devices = [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }]; }],
    ['Devices /dev/dri/../sda', (b) => { H(b).Devices[0].PathOnHost = '/dev/dri/../sda'; }],
    ['a second device', (b) => { H(b).Devices.push({ PathOnHost: '/dev/mem', PathInContainer: '/dev/mem', CgroupPermissions: 'rwm' }); }],
    ['a second DeviceRequests entry', (b) => { H(b).DeviceRequests = [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }, { Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]; }],
    ['DeviceRequests Count -1', (b) => { H(b).DeviceRequests = [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }]; }],
    ['DeviceRequests other driver', (b) => { H(b).DeviceRequests = [{ Driver: 'cdi', Count: 1, Capabilities: [['gpu']] }]; }],
    ['HostConfig.ReadonlyRootfs=false', (b) => { H(b).ReadonlyRootfs = false; }],
    ['User=0:0', (b) => { b.User = '0:0'; }],
    ['User=1000:0', (b) => { b.User = '1000:0'; }],
    ['User=1001:1000 (spec 1000)', (b) => { b.User = '1001:1000'; }],
    ['User=root', (b) => { b.User = 'root'; }],
    ['User missing', (b) => { delete b.User; }],
    ['Image with a tag only', (b) => { b.Image = 'ghcr.io/letsmanu/friendflix-mediaserver:nightly'; }],
    ['Image with a tag and a digest', (b) => { b.Image = 'ghcr.io/letsmanu/friendflix-mediaserver:nightly@sha256:' + 'a'.repeat(64); }],
    ['Image of another repository', (b) => { b.Image = 'ghcr.io/evil/friendflix-mediaserver@sha256:' + 'a'.repeat(64); }],
    ['Image of the other kind', (b) => { b.Image = JIMG; }],
    ['Image a short digest', (b) => { b.Image = 'ghcr.io/letsmanu/friendflix-mediaserver@sha256:' + 'a'.repeat(63); }],
    ['Env LD_PRELOAD', (b) => { b.Env.push('LD_PRELOAD=x'); }],
    ['Env FERROFIN_DATA_DIR', (b) => { b.Env.push('FERROFIN_DATA_DIR=/x'); }],
    ['Env a key twice', (b) => { b.Env.push('TZ=UTC'); }],
    ['Env XDG_CACHE_HOME on ferrofin', (b) => { b.Env.push('XDG_CACHE_HOME=/cache/xdg'); }],
    ['Env a TZ with a newline', (b) => { b.Env[0] = 'TZ=UTC\nLD_PRELOAD=/x'; }],
    ['Env NVIDIA capabilities widened', (b) => { b.Env.push('NVIDIA_DRIVER_CAPABILITIES=all'); }],
    ['Env not an array', (b) => { b.Env = 'TZ=UTC'; }],
    ['a missing managed label', (b) => { delete b.Labels['friendflix.managed']; }],
    ['friendflix.project=other', (b) => { b.Labels['friendflix.project'] = 'other'; }],
    ['friendflix.kind=jellyfin', (b) => { b.Labels['friendflix.kind'] = 'jellyfin'; }],
    ['watchtower enabled', (b) => { b.Labels['com.centurylinklabs.watchtower.enable'] = 'true'; }],
    ['a spec label that is not a hash', (b) => { b.Labels['friendflix.spec'] = 'x'; }],
    ['an extra label', (b) => { b.Labels['traefik.enable'] = 'true'; }],
    ['a label named like an Object member', (b) => { b.Labels.toString = 'x'; }],
    ['HostConfig.Sysctls', (b) => { H(b).Sysctls = { 'net.ipv4.ip_unprivileged_port_start': '0' }; }],
    ['HostConfig.Dns', (b) => { H(b).Dns = ['192.0.2.1']; }],
    ['HostConfig.ExtraHosts', (b) => { H(b).ExtraHosts = ['host.docker.internal:host-gateway']; }],
    ['HostConfig.VolumesFrom', (b) => { H(b).VolumesFrom = ['friendflix-updater']; }],
    ['HostConfig.Links', (b) => { H(b).Links = ['x:y']; }],
    ['HostConfig.DeviceCgroupRules', (b) => { H(b).DeviceCgroupRules = ['c *:* rwm']; }],
    ['HostConfig.OomScoreAdj', (b) => { H(b).OomScoreAdj = -1000; }],
    ['HostConfig.Runtime=nvidia', (b) => { H(b).Runtime = 'nvidia'; }],
    ['HostConfig.Ulimits', (b) => { H(b).Ulimits = [{ Name: 'nofile', Soft: 1, Hard: 1 }]; }],
    ['HostConfig.Init=false', (b) => { H(b).Init = false; }],
    ['HostConfig.RestartPolicy always', (b) => { H(b).RestartPolicy = { Name: 'always' }; }],
    ['HostConfig.LogConfig syslog', (b) => { H(b).LogConfig = { Type: 'syslog', Config: { 'syslog-address': 'udp://192.0.2.1:514' } }; }],
    ['HostConfig.PidsLimit 0', (b) => { H(b).PidsLimit = 0; }],
    ['HostConfig.AutoRemove=true', (b) => { H(b).AutoRemove = true; }],
    ['HostConfig missing', (b) => { delete b.HostConfig; }],
    ['Entrypoint', (b) => { b.Entrypoint = ['/bin/sh']; }],
    ['Cmd', (b) => { b.Cmd = ['-c', 'id']; }],
    ['WorkingDir', (b) => { b.WorkingDir = '/media'; }],
    ['Healthcheck={Test:[NONE]}', (b) => { b.Healthcheck = { Test: ['NONE'] }; }],
    ['Volumes', (b) => { b.Volumes = { '/host': {} }; }],
    ['Hostname', (b) => { b.Hostname = 'other'; }],
    ['StopTimeout', (b) => { b.StopTimeout = 0; }],
    ['GroupAdd=[0]', (b) => { H(b).GroupAdd = ['0']; }],
    ['GroupAdd a name', (b) => { H(b).GroupAdd = ['docker']; }],
    ['GroupAdd too many', (b) => { H(b).GroupAdd = ['1', '2', '3', '4', '5', '6']; }],
    ['Tmpfs exec plus /data', (b) => { H(b).Tmpfs = { '/tmp': 'exec', '/data': '' }; }],
    ['Tmpfs a second path', (b) => { H(b).Tmpfs['/data'] = 'size=1m'; }],
    ['NetworkingConfig another network', (b) => { b.NetworkingConfig.EndpointsConfig.host = {}; }],
    ['NetworkingConfig a fixed address', (b) => { b.NetworkingConfig.EndpointsConfig.friendflix_media.IPAMConfig = { IPv4Address: '192.0.2.10' }; }],
    ['an unknown top-level key', (b) => { b.Zzz = 1; }],
  ];

  it.each(mutations)('widening field %s is refused', (_name, mutate) => {
    const b = ok();
    mutate(b);
    refuses(() => assertManaged(b, E));
  });

  it('unset values of other keys are tolerated', () => {
    const b = ok();
    Object.assign(H(b), { Privileged: false, CapAdd: null, Binds: [], PortBindings: {}, PublishAllPorts: false, Dns: [], OomScoreAdj: 0, Runtime: '' });
    Object.assign(b, { ExposedPorts: {}, Entrypoint: null, Cmd: null, WorkingDir: '' });
    expect(() => assertManaged(b, E)).not.toThrow();
  });

  it('refuses non-objects and reports the field', () => {
    for (const v of [null, [], 'x', 5]) refuses(() => assertManaged(v, E));
    const b = ok();
    H(b).Privileged = true;
    try { assertManaged(b, E); } catch (e) { expect((e as TemplateViolation).field).toBe('HostConfig.Privileged'); }
    refuses(() => assertManaged(ok(), { ...E, uid: 0 }));
  });
});

describe('managed container guard on inspect', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/mediaserver-inspect.json', import.meta.url), 'utf8')) as Body;
  const image = {
    env: (fixture.Config.Env as string[]).filter((e) => !e.startsWith('TZ=')),
    entrypoint: ['ferrofin-server'], cmd: null, volumes: ['/data'],
  };
  const X = { ...E, image };
  const inspect = (): Body => clone(fixture);

  it('inspect: engine defaults pass, tampering is caught', () => {
    expect(() => assertManagedInspect(inspect(), X)).not.toThrow();
    const tamper: [string, (i: Body) => void][] = [
      ['PortBindings', (i) => { i.HostConfig.PortBindings = { '8096/tcp': [{ HostIp: '', HostPort: '8096' }] }; }],
      ['a bound port in NetworkSettings', (i) => { i.NetworkSettings.Ports['8096/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '8096' }]; }],
      ['Privileged', (i) => { i.HostConfig.Privileged = true; }],
      ['MaskedPaths []', (i) => { i.HostConfig.MaskedPaths = []; }],
      ['ReadonlyPaths missing', (i) => { delete i.HostConfig.ReadonlyPaths; }],
      ['an extra bind in Mounts', (i) => { i.Mounts.push({ Type: 'bind', Source: '/', Destination: '/host', Mode: '', RW: true, Propagation: 'rprivate' }); }],
      ['an anonymous volume outside the image volumes', (i) => { i.Mounts.push({ Type: 'volume', Name: 'f'.repeat(64), Source: '/var/lib/docker/volumes/x/_data', Destination: '/x', Driver: 'local', Mode: '', RW: true, Propagation: '' }); }],
      ['a named volume not in HostConfig.Mounts', (i) => { i.Mounts.push({ Type: 'volume', Name: 'friendflix_mediaserver-backup', Source: '/x', Destination: '/backups', Driver: 'local', Mode: 'z', RW: true, Propagation: '' }); }],
      ['a media volume made writable', (i) => { i.Mounts[2].RW = true; }],
      ['an image env entry changed', (i) => { i.Config.Env.push('LD_PRELOAD=/x'); }],
      ['Entrypoint other than the image', (i) => { i.Config.Entrypoint = ['/bin/sh']; }],
      ['Cmd other than the image', (i) => { i.Config.Cmd = ['-c', 'id']; }],
      ['CgroupnsMode host', (i) => { i.HostConfig.CgroupnsMode = 'host'; }],
      ['IpcMode host', (i) => { i.HostConfig.IpcMode = 'host'; }],
      ['Runtime nvidia', (i) => { i.HostConfig.Runtime = 'nvidia'; }],
      ['host network', (i) => { i.NetworkSettings.Networks.host = {}; }],
      ['no media network', (i) => { delete i.NetworkSettings.Networks.friendflix_media; }],
      ['a label added in Portainer', (i) => { i.Config.Labels['traefik.enable'] = 'true'; }],
      ['a disabled healthcheck', (i) => { i.Config.Healthcheck = { Test: ['NONE'] }; }],
      ['Config.Volumes beyond the image', (i) => { i.Config.Volumes['/x'] = {}; }],
      ['Config missing', (i) => { delete i.Config; }],
    ];
    for (const [name, t] of tamper) {
      const i = inspect();
      t(i);
      expect(() => assertManagedInspect(i, X), name).toThrow(TemplateViolation);
    }
  });

  it('inspect tolerates an anonymous volume at an image volume and a jellyfin image env', () => {
    const i = inspect();
    i.Mounts.push({ Type: 'volume', Name: 'e'.repeat(64), Source: '/var/lib/docker/volumes/e/_data', Destination: '/state', Driver: 'local', Mode: '', RW: true, Propagation: '' });
    expect(() => assertManagedInspect(i, { ...X, image: { ...image, volumes: ['/data', '/state'] } })).not.toThrow();
    const j = inspect();
    j.Config.Image = JIMG;
    j.Config.Labels['friendflix.kind'] = 'jellyfin';
    j.Config.Env = ['TZ=Europe/Berlin', 'XDG_CACHE_HOME=/cache/xdg', 'LD_PRELOAD=/usr/lib/jellyfin/libjemalloc.so.2', 'JELLYFIN_DATA_DIR=/config'];
    j.Config.Entrypoint = ['/jellyfin/jellyfin'];
    j.Config.Volumes = { '/config': {}, '/cache': {} };
    j.HostConfig.Mounts[0].Source = j.Mounts[0].Name = 'friendflix_mediaserver-jellyfin-config';
    j.HostConfig.Mounts[0].Target = j.Mounts[0].Destination = '/config';
    j.HostConfig.Mounts[1].Source = j.Mounts[1].Name = 'friendflix_mediaserver-jellyfin-cache';
    const jimage = { env: ['XDG_CACHE_HOME=/cache', 'LD_PRELOAD=/usr/lib/jellyfin/libjemalloc.so.2', 'JELLYFIN_DATA_DIR=/config'], entrypoint: ['/jellyfin/jellyfin'], cmd: null, volumes: ['/config', '/cache'] };
    expect(() => assertManagedInspect(j, { ...X, kind: 'jellyfin', image: jimage })).not.toThrow();
  });
});

describe('helper guard', () => {
  const H = { project: 'friendflix', image: 'sha256:' + 'c'.repeat(64) };
  const G = { project: 'friendflix', uid: 1000, gid: 1000, image: H.image };
  const req = (r: Partial<HelperRequest>): Body => clone(helperSpec({ verb: 'browse', args: ['Filme'], uid: 1000, gid: 1000, groups: [2000], mounts: [{ kind: 'base', volume: BASE }], ...r }, H).body) as Body;
  const dataRw = { kind: 'data' as const, volume: 'friendflix_mediaserver-ferrofin-data', rw: true };
  const dataRo = { ...dataRw, rw: false };

  it('the helper templates pass', () => {
    expect(() => assertHelper(req({}), { ...G, verb: 'browse' })).not.toThrow();
    expect(() => assertHelper(req({ verb: 'check', args: ['base'], mounts: [{ kind: 'request', path: '/srv/media' }] }), { ...G, verb: 'check', bind: '/srv/media' })).not.toThrow();
    expect(() => assertHelper(req({ verb: 'gpu', args: [], groups: [], mounts: [{ kind: 'dri' }, { kind: 'drm' }] }), { ...G, verb: 'gpu' })).not.toThrow();
    expect(() => assertHelper(req({ verb: 'restore', args: ['x'], mounts: [dataRw, { kind: 'backup', rw: true }] }), { ...G, verb: 'restore' })).not.toThrow();
    expect(() => assertHelper(req({ verb: 'backup', args: ['x'], mounts: [dataRo, { kind: 'backup', rw: true }] }), { ...G, verb: 'backup' })).not.toThrow();
    expect(() => assertHelper(req({ verb: 'check', args: ['data'], mounts: [dataRo] }), { ...G, verb: 'check' })).not.toThrow();
  });

  it('refuses what a helper may not have', () => {
    const cases: [string, Body, Parameters<typeof assertHelper>[1]][] = [
      ['a bind for browse', req({ mounts: [{ kind: 'request', path: '/srv/media' }] }), { ...G, verb: 'browse', bind: '/srv/media' }],
      ['a bind for backup', req({ verb: 'backup', mounts: [{ kind: 'request', path: '/srv/media' }] }), { ...G, verb: 'backup', bind: '/srv/media' }],
      ['a bind for restore', req({ verb: 'restore', mounts: [{ kind: 'dri' }] }), { ...G, verb: 'restore' }],
      ['a check bind other than the requested path', req({ verb: 'check', mounts: [{ kind: 'request', path: '/srv' }] }), { ...G, verb: 'check', bind: '/srv/media' }],
      ['a check bind without a requested path', req({ verb: 'check', mounts: [{ kind: 'request', path: '/srv/media' }] }), { ...G, verb: 'check' }],
      ['a check bind of /', req({ verb: 'check', mounts: [{ kind: 'request', path: '/' }] }), { ...G, verb: 'check', bind: '/' }],
      ['a check bind with ..', req({ verb: 'check', mounts: [{ kind: 'request', path: '/srv/../etc' }] }), { ...G, verb: 'check', bind: '/srv/../etc' }],
      ['a check bind of the docker socket', req({ verb: 'check', mounts: [{ kind: 'request', path: '/var/run/docker.sock' }] }), { ...G, verb: 'check', bind: '/var/run/docker.sock' }],
      ['/dev/dri outside gpu', req({ verb: 'check', mounts: [{ kind: 'dri' }] }), { ...G, verb: 'check' }],
      ['/sys/class/drm outside gpu', req({ verb: 'browse', mounts: [{ kind: 'drm' }] }), { ...G, verb: 'browse' }],
      ['data read-write outside restore', req({ verb: 'backup', mounts: [dataRw] }), { ...G, verb: 'backup' }],
      ['data read-write for check', req({ verb: 'check', mounts: [dataRw] }), { ...G, verb: 'check' }],
      ['backup read-write outside backup/restore', req({ verb: 'browse', mounts: [{ kind: 'backup', rw: true }] }), { ...G, verb: 'browse' }],
      ['a data volume of another project', req({ verb: 'check', mounts: [{ ...dataRo, volume: 'other_mediaserver-ferrofin-data' }] }), { ...G, verb: 'check' }],
      ['a base volume of another name', req({ mounts: [{ kind: 'base', volume: 'other_x' }] }), { ...G, verb: 'browse' }],
      ['a Cmd for another verb', req({}), { ...G, verb: 'check' }],
      ['an image other than e.image', req({}), { ...G, verb: 'browse', image: 'sha256:' + 'd'.repeat(64) }],
    ];
    for (const [name, b, e] of cases) expect(() => assertHelper(b, e), name).toThrow(TemplateViolation);

    const browse = { ...G, verb: 'browse' as const };
    const mut: [string, (b: Body) => void][] = [
      ['NetworkMode bridge', (b) => { b.HostConfig.NetworkMode = 'bridge'; }],
      ['NetworkMode host', (b) => { b.HostConfig.NetworkMode = 'host'; }],
      ['AutoRemove=true', (b) => { b.HostConfig.AutoRemove = true; }],
      ['ReadonlyRootfs=false', (b) => { b.HostConfig.ReadonlyRootfs = false; }],
      ['Privileged', (b) => { b.HostConfig.Privileged = true; }],
      ['CapAdd', (b) => { b.HostConfig.CapAdd = ['SYS_ADMIN']; }],
      ['SecurityOpt', (b) => { b.HostConfig.SecurityOpt = []; }],
      ['Devices', (b) => { b.HostConfig.Devices = [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }]; }],
      ['Binds', (b) => { b.HostConfig.Binds = ['/:/host:ro']; }],
      ['Tmpfs other', (b) => { b.HostConfig.Tmpfs = { '/tmp': 'size=64m', '/x': '' }; }],
      ['GroupAdd 0', (b) => { b.HostConfig.GroupAdd = ['0']; }],
      ['User root', (b) => { b.User = '0:0'; }],
      ['User another uid', (b) => { b.User = '1001:1000'; }],
      ['Cmd not node', (b) => { b.Cmd = ['sh', '-c', 'id']; }],
      ['Cmd another script', (b) => { b.Cmd = ['node', 'updater/dist/server.js', 'browse']; }],
      ['Cmd a non-string arg', (b) => { b.Cmd.push(5); }],
      ['Entrypoint', (b) => { b.Entrypoint = ['/bin/sh', '-c']; }],
      ['Env', (b) => { b.Env = ['NODE_OPTIONS=--require=/base/x.js']; }],
      ['labels', (b) => { b.Labels['friendflix.managed'] = 'mediaserver'; }],
      ['an extra label', (b) => { b.Labels.x = 'y'; }],
      ['a mount at another target', (b) => { b.HostConfig.Mounts[0].Target = '/etc'; }],
      ['a base mount writable', (b) => { b.HostConfig.Mounts[0].ReadOnly = false; }],
      ['a base mount without NoCopy', (b) => { delete b.HostConfig.Mounts[0].VolumeOptions; }],
      ['a base mount with driver options', (b) => { b.HostConfig.Mounts[0].VolumeOptions.DriverConfig = { Name: 'local', Options: { device: '/' } }; }],
      ['two mounts at one target', (b) => { b.HostConfig.Mounts.push({ ...b.HostConfig.Mounts[0] }); }],
      ['Hostname', (b) => { b.Hostname = 'x'; }],
      ['ExposedPorts', (b) => { b.ExposedPorts = { '80/tcp': {} }; }],
    ];
    for (const [name, m] of mut) {
      const b = req({});
      m(b);
      expect(() => assertHelper(b, browse), name).toThrow(TemplateViolation);
    }
    refuses(() => assertHelper(null, browse));
    refuses(() => assertHelper(req({}), { ...browse, image: 'friendflix-updater:latest' }));
  });

  it('the HDR runs: no mounts, no network, the media image', () => {
    const o = { project: 'friendflix', kind: 'ferrofin' as const, image: IMG, uid: 1000, gid: 1000, renderGids: [993], node: 'renderD128' };
    const g = { ...G, image: IMG, verb: 'hdr' as const };
    const t1 = clone(hdrSpec(1, o).body) as Body;
    const t2 = clone(hdrSpec(2, o).body) as Body;
    expect(() => assertHelper(t1, g)).not.toThrow();
    expect(() => assertHelper(t2, g)).not.toThrow();
    const mut: [string, (b: Body) => void][] = [
      ['a mount', (b) => { b.HostConfig.Mounts = [{ Type: 'volume', Source: BASE, Target: '/base', ReadOnly: true, VolumeOptions: { NoCopy: true } }]; }],
      ['another device', (b) => { b.HostConfig.Devices = [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }]; }],
      ['a network', (b) => { b.HostConfig.NetworkMode = 'friendflix_media'; }],
      ['another entrypoint', (b) => { b.Entrypoint = ['/usr/bin/curl']; }],
      ['no entrypoint', (b) => { delete b.Entrypoint; }],
      ['another device node', (b) => { if (b.Entrypoint[0] === '/bin/sh') b.Cmd[3] = '/dev/sda'; else b.Cmd[2] = 'vaapi=va:/dev/sda'; }],
    ];
    for (const [name, m] of mut) {
      for (const t of [t1, t2]) {
        const b = clone(t);
        m(b);
        expect(() => assertHelper(b, g), name).toThrow(TemplateViolation);
      }
    }
    refuses(() => assertHelper(t1, { ...g, image: JIMG }));
  });

  it('seed: one fresh volume at the seed directory, never started', () => {
    const jd = { ...D, kind: 'jellyfin' as const };
    const jf = { ...F, image: JIMG };
    const g = { ...G, image: JIMG, verb: 'seed' as const, kind: 'jellyfin' as const };
    const seed = (): Body => clone(seedSpec('jellyfin', 'data', jd, jf).body) as Body;
    expect(() => assertHelper(seed(), g)).not.toThrow();
    const mut: [string, (b: Body) => void][] = [
      ['a second volume', (b) => { b.HostConfig.Mounts.push({ Type: 'volume', Source: 'friendflix_mediaserver-jellyfin-cache', Target: '/x', ReadOnly: false }); }],
      ['a non-true Cmd', (b) => { b.Cmd = ['sh', '-c', 'chown -R 0 /tmp']; }],
      ['an Entrypoint', (b) => { b.Entrypoint = ['/bin/sh']; }],
      ['a volume of another name', (b) => { b.HostConfig.Mounts[0].Source = 'friendflix_mediaserver-base-00000000'; }],
      ['a volume of the other kind', (b) => { b.HostConfig.Mounts[0].Source = 'friendflix_mediaserver-ferrofin-data'; }],
      ['a volume at another target', (b) => { b.HostConfig.Mounts[0].Target = '/config'; }],
      ['a read-only volume', (b) => { b.HostConfig.Mounts[0].ReadOnly = true; }],
      ['NoCopy (no copy-up, no seed)', (b) => { b.HostConfig.Mounts[0].VolumeOptions = { NoCopy: true }; }],
      ['a bind', (b) => { b.HostConfig.Mounts[0] = { Type: 'bind', Source: '/', Target: '/tmp' }; }],
      ['no mount', (b) => { b.HostConfig.Mounts = []; }],
      ['a tmpfs', (b) => { b.HostConfig.Tmpfs = { '/tmp': 'size=64m' }; }],
      ['a network', (b) => { b.HostConfig.NetworkMode = 'bridge'; }],
    ];
    for (const [name, m] of mut) {
      const b = seed();
      m(b);
      expect(() => assertHelper(b, g), name).toThrow(TemplateViolation);
    }
    refuses(() => assertHelper(seed(), { ...g, image: IMG }));
    refuses(() => assertHelper(seed(), { ...g, kind: 'ferrofin' }));
    refuses(() => assertHelper(seed(), { ...g, kind: undefined }));
    refuses(() => assertHelper(seed(), { ...g, image: 'docker.io/jellyfin/jellyfin:latest' }));
  });
});
