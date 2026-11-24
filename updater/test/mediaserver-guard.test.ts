// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertHelper, assertManaged, assertManagedInspect, isMigratedTarget, TemplateViolation, type ManagedExpect } from '../src/mediaserver/guard.js';
import { isMigratedTarget as pathsMigratedTarget, isTarget } from '../src/mediaserver/paths.js';
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
    ['DeviceRequests next to Devices', (b) => { H(b).DeviceRequests = [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]; }],
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
    ['Env FERROFIN_CACHE_DIR elsewhere', (b) => { b.Env[1] = 'FERROFIN_CACHE_DIR=/media/filme'; }],
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

  // each refused for its own reason: [row, mutation, field]
  const fields: [string, (b: Body) => void, string][] = [
    ['HostConfig.MaskedPaths=[] (systempaths=unconfined)', (b) => { H(b).MaskedPaths = []; }, 'HostConfig.MaskedPaths'],
    ['HostConfig.ReadonlyPaths=[] (systempaths=unconfined)', (b) => { H(b).ReadonlyPaths = []; }, 'HostConfig.ReadonlyPaths'],
    ['HostConfig.MaskedPaths shortened', (b) => { H(b).MaskedPaths = ['/proc/acpi']; }, 'HostConfig.MaskedPaths'],
    ['DeviceRequests next to Devices', (b) => { H(b).DeviceRequests = [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]; }, 'HostConfig.Devices'],
  ];
  it.each(fields)('widening field %s is refused for its own reason', (_name, mutate, field) => {
    const b = ok();
    mutate(b);
    expect(() => assertManaged(b, E)).toThrow(expect.objectContaining({ field }));
  });

  // on the NVIDIA body (no Devices), so each row reaches the check it is named for
  const J = { ...E, kind: 'jellyfin' as const };
  const nvidia = (): Body => clone(containerSpec({ ...D, kind: 'jellyfin', gpu: 'nvidia', mediaGid: null }, { ...F, image: JIMG }).body) as Body;
  const R = (b: Body): Body => H(b).DeviceRequests[0];
  const deviceRequests: [string, (b: Body) => void, string][] = [
    ['a second DeviceRequests entry', (b) => { H(b).DeviceRequests.push({ ...R(b) }); }, 'HostConfig.DeviceRequests'],
    ['DeviceRequests not a list', (b) => { H(b).DeviceRequests = R(b); }, 'HostConfig.DeviceRequests'],
    ['DeviceRequests Count -1 (all GPUs)', (b) => { R(b).Count = -1; }, 'HostConfig.DeviceRequests.Count'],
    ['DeviceRequests Count 2', (b) => { R(b).Count = 2; }, 'HostConfig.DeviceRequests.Count'],
    ['DeviceRequests other driver', (b) => { R(b).Driver = 'cdi'; }, 'HostConfig.DeviceRequests.Driver'],
    ['DeviceRequests DeviceIDs all', (b) => { R(b).DeviceIDs = ['all']; }, 'HostConfig.DeviceRequests.DeviceIDs'],
    ['DeviceRequests Options', (b) => { R(b).Options = { x: 'y' }; }, 'HostConfig.DeviceRequests.Options'],
    ['DeviceRequests widened Capabilities', (b) => { R(b).Capabilities = [['gpu', 'compute', 'utility', 'video', 'display']]; }, 'HostConfig.DeviceRequests.Capabilities'],
    ['DeviceRequests a second capability set', (b) => { R(b).Capabilities = [['gpu'], ['display']]; }, 'HostConfig.DeviceRequests.Capabilities'],
  ];
  it.each(deviceRequests)('widening field %s is refused for its own reason', (_name, mutate, field) => {
    expect(() => assertManaged(nvidia(), J)).not.toThrow();
    const b = nvidia();
    mutate(b);
    expect(() => assertManaged(b, J)).toThrow(expect.objectContaining({ field }));
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
    env: (fixture.Config.Env as string[]).filter((e) => !e.startsWith('TZ=') && !e.startsWith('FERROFIN_CACHE_DIR=')),
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
      ['CgroupnsMode other', (i) => { i.HostConfig.CgroupnsMode = 'shared'; }],
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

  it('inspect accepts the cgroup v1 default and the nvidia runtime only with the NVIDIA choice', () => {
    const v1 = inspect();
    v1.HostConfig.CgroupnsMode = 'host';
    expect(() => assertManagedInspect(v1, X)).not.toThrow();
    for (const r of ['', 'runc']) {
      const i = inspect();
      i.HostConfig.Runtime = r;
      expect(() => assertManagedInspect(i, X)).not.toThrow();
    }
    const nv = inspect();
    delete nv.HostConfig.Devices;
    nv.HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: 1, DeviceIDs: null, Capabilities: [['gpu']], Options: null }];
    nv.HostConfig.GroupAdd = ['2000'];
    nv.HostConfig.Runtime = 'nvidia';
    nv.Config.Env.push('NVIDIA_DRIVER_CAPABILITIES=compute,video,utility');
    expect(() => assertManagedInspect(nv, { ...X, gpu: 'nvidia' })).not.toThrow();
    for (const gpu of [undefined, 'dri', 'off'] as const) {
      expect(() => assertManagedInspect(nv, { ...X, gpu })).toThrow(expect.objectContaining({ field: 'HostConfig.Runtime' }));
    }
    const dri = inspect();
    dri.HostConfig.Runtime = 'nvidia';
    expect(() => assertManagedInspect(dri, { ...X, gpu: 'dri' })).toThrow(expect.objectContaining({ field: 'HostConfig.Runtime' }));
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
      ['MaskedPaths=[]', (b) => { b.HostConfig.MaskedPaths = []; }],
      ['ReadonlyPaths=[]', (b) => { b.HostConfig.ReadonlyPaths = []; }],
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
    const fseed = clone(seedSpec('ferrofin', 'data', { ...D, uid: 1001 }, F).body) as Body;
    expect(() => assertHelper(fseed, { ...g, uid: 1001, image: IMG, kind: 'ferrofin' })).not.toThrow();
    refuses(() => assertHelper(fseed, { ...g, uid: 1001, image: JIMG, kind: 'ferrofin' }));
    refuses(() => assertHelper(seed(), { ...g, kind: undefined }));
    refuses(() => assertHelper(seed(), { ...g, image: 'docker.io/jellyfin/jellyfin:latest' }));
  });
});

describe('migrated media server (stage 2)', () => {
  const REFUSED_TOPS = [
    'cache', 'config', 'tmp', 'proc', 'sys', 'dev', 'etc', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'lib32', 'libx32', 'var', 'run', 'root', 'home', 'boot', 'opt',
    'nonexistent', 'ferrofin-data', 'ffmedia',
  ];
  const accepted = ['/movies', '/data/tv', '/data/x', '/media', '/media/filme', '/srv', '/srv/a/b', '/mnt', '/mnt/nas/Filme', '/Filme ä', '/tv/Séries/日本', '/a/b/c', '/datax', '/cachex', '/optx', '/library'];
  const refused = [
    '/', '', '/data', 'relative', 'movies/x', '/movies/', '//movies', '/movies//x', '/a/b/c/d', '/a/../b', '/..', '/.', '/./movies', '/movies/.',
    '/movies/..', '/.hidden', '/a\nb', '/a\0b', '/' + 'x'.repeat(201), '/a/*', '/a:b',
    ...REFUSED_TOPS.flatMap((t) => [`/${t}`, `/${t}/x`, `/${t}/x/y`]),
  ];
  it('migrated target rules: the guard copy and the paths copy agree', () => {
    for (const t of accepted) {
      expect(isMigratedTarget(t), t).toBe(true);
      expect(pathsMigratedTarget(t), t).toBe(true);
    }
    for (const t of refused) {
      expect(isMigratedTarget(t), JSON.stringify(t)).toBe(false);
      expect(pathsMigratedTarget(t), JSON.stringify(t)).toBe(false);
    }
  });

  it('new folders after a move: /ffmedia/<slug> like /media/<slug>', () => {
    for (const t of ['/ffmedia/neu', '/ffmedia/a/b/c', '/media/filme']) expect(isTarget(t), t).toBe(true);
    for (const t of ['/ffmedia', '/ffmedia/', '/ffmedia/Neu', '/ffmedia/a/b/c/d', '/ffmedia/../etc', '/ffmediax/a']) expect(isTarget(t), t).toBe(false);
  });

  // a migrated Ferrofin: two folders at the paths the old Jellyfin used (one the whole base), one new folder after the move
  const DM: DesiredSpec = {
    ...D, migrated: true,
    folders: [{ rel: 'Filme', target: '/movies', migrated: true }, { rel: '', target: '/data/tv', migrated: true }, { rel: 'Neu', target: '/ffmedia/neu' }],
  };
  const EM: ManagedExpect = { ...E, migrated: { targets: ['/movies', '/data/tv'] } };
  const okM = (): Body => clone(containerSpec(DM, F).body) as Body;
  const M = (b: Body): Body[] => b.HostConfig.Mounts;
  const at = (b: Body, t: string): Body => M(b).find((m) => m.Target === t)!;

  it('the migrated template passes with the recorded targets only', () => {
    expect(() => assertManaged(okM(), EM)).not.toThrow();
    expect(() => assertManaged(containerSpec(DM, F, { password: 'A'.repeat(43) }).body, EM)).not.toThrow();
    // the same body without the migrated expectation: refused (stage 1 unchanged)
    refuses(() => assertManaged(okM(), E));
    // a listed target the rule refuses is still refused
    const etc = okM();
    at(etc, '/movies').Target = '/etc';
    refuses(() => assertManaged(etc, { ...E, migrated: { targets: ['/etc', '/data/tv'] } }));
  });

  it('a non-listed target outside /media is refused even when migrated', () => {
    for (const t of ['/srv/a', '/data/x', '/media', '/data', '/ferrofin-data/x', '/ffmedia', '/proc/x']) {
      const b = okM();
      at(b, '/movies').Target = t;
      refuses(() => assertManaged(b, EM));
    }
    // a listed target with the wrong case or a trailing slash is not the listed one
    for (const t of ['/Movies', '/movies/']) {
      const b = okM();
      at(b, '/movies').Target = t;
      refuses(() => assertManaged(b, EM));
    }
  });

  it('migrated media mounts stay read-only subpaths of the one base volume', () => {
    const mut: [string, (b: Body) => void][] = [
      ['read-write', (b) => { at(b, '/movies').ReadOnly = false; }],
      ['ReadOnly missing', (b) => { delete at(b, '/data/tv').ReadOnly; }],
      ['a bind', (b) => { Object.assign(at(b, '/movies'), { Type: 'bind', Source: '/srv/media/Filme' }); delete at(b, '/movies').VolumeOptions; }],
      ['a bind of the whole base', (b) => { Object.assign(at(b, '/data/tv'), { Type: 'bind', Source: '/srv/media' }); delete at(b, '/data/tv').VolumeOptions; }],
      ['another volume', (b) => { at(b, '/movies').Source = 'jellyfin_media'; }],
      ['a second base volume', (b) => { at(b, '/data/tv').Source = 'friendflix_mediaserver-base-00000000'; }],
      ['no NoCopy', (b) => { at(b, '/data/tv').VolumeOptions = {}; }],
      ['a subpath leaving the base', (b) => { at(b, '/movies').VolumeOptions.Subpath = '../x'; }],
      ['an empty string subpath', (b) => { at(b, '/data/tv').VolumeOptions.Subpath = ''; }],
      ['driver options', (b) => { at(b, '/data/tv').VolumeOptions.DriverConfig = { Name: 'local', Options: { device: '/' } }; }],
      ['a mount at a listed target twice', (b) => { M(b).push({ ...at(b, '/movies') }); }],
      ['the data volume at /data', (b) => { at(b, '/ferrofin-data').Target = '/data'; }],
      ['the data volume at a listed target', (b) => { at(b, '/ferrofin-data').Target = '/movies'; M(b).splice(M(b).indexOf(at(b, '/movies')), 1); }],
      ['a writable data volume elsewhere', (b) => { M(b).push({ ...at(b, '/ferrofin-data'), Target: '/data' }); }],
      ['no data volume', (b) => { M(b).splice(M(b).indexOf(at(b, '/ferrofin-data')), 1); }],
      ['FERROFIN_DATA_DIR elsewhere', (b) => { b.Env = b.Env.map((x: string) => (x.startsWith('FERROFIN_DATA_DIR=') ? 'FERROFIN_DATA_DIR=/data' : x)); }],
      ['FERROFIN_DATA_DIR missing', (b) => { b.Env = b.Env.filter((x: string) => !x.startsWith('FERROFIN_DATA_DIR=')); }],
      ['FERROFIN_DATA_DIR twice', (b) => { b.Env.push('FERROFIN_DATA_DIR=/ferrofin-data'); }],
    ];
    for (const [name, m] of mut) {
      const b = okM();
      m(b);
      expect(() => assertManaged(b, EM), name).toThrow(TemplateViolation);
    }
  });

  it('empty rel only for a migrated folder', () => {
    // a stage 1 folder without a subpath (the whole base) stays refused, also on a migrated server
    const b = okM();
    delete at(b, '/ffmedia/neu').VolumeOptions.Subpath;
    refuses(() => assertManaged(b, EM));
    const s1 = ok();
    delete M(s1).find((m) => m.Target === '/media/filme')!.VolumeOptions.Subpath;
    refuses(() => assertManaged(s1, E));
    // a listed folder with a subpath is fine as well
    const sub = okM();
    at(sub, '/data/tv').VolumeOptions.Subpath = 'Serien';
    expect(() => assertManaged(sub, EM)).not.toThrow();
  });

  it('FERROFIN_DATA_DIR only for a migrated ferrofin', () => {
    const b = ok();
    b.Env.push('FERROFIN_DATA_DIR=/ferrofin-data');
    refuses(() => assertManaged(b, E));
    // a migrated expectation for Jellyfin is refused outright
    const j = containerSpec({ ...D, kind: 'jellyfin', gpu: 'nvidia', mediaGid: null }, { ...F, image: JIMG }).body;
    refuses(() => assertManaged(j, { ...E, kind: 'jellyfin', migrated: { targets: [] } }));
    const jm = clone(j) as Body;
    jm.Env.push('FERROFIN_DATA_DIR=/ferrofin-data');
    refuses(() => assertManaged(jm, { ...E, kind: 'jellyfin', migrated: { targets: [] } }));
    // an expectation whose targets break the rule is refused even if the body does not use them
    refuses(() => assertManaged(okM(), { ...E, migrated: { targets: ['/movies', '/data/tv', '/proc'] } }));
  });

  it('/ferrofin-data only when migrated', () => {
    const b = ok();
    M(b)[0]!.Target = '/ferrofin-data';
    refuses(() => assertManaged(b, E));
    b.Env.push('FERROFIN_DATA_DIR=/ferrofin-data');
    refuses(() => assertManaged(b, E));
    // with the expectation (and the /data tmpfs) it passes: a migrated server whose recorded targets are below /media
    const below = { ...E, migrated: { targets: ['/media/filme', '/media/serien'] } };
    refuses(() => assertManaged(b, below));
    b.HostConfig.Tmpfs['/data'] = 'size=1m,mode=0755';
    expect(() => assertManaged(b, below)).not.toThrow();
    // the media volumes are never at /ferrofin-data
    const m = okM();
    at(m, '/movies').Target = '/ferrofin-data';
    refuses(() => assertManaged(m, { ...EM, migrated: { targets: ['/ferrofin-data', '/data/tv'] } }));
  });

  it('on a migrated server a new folder goes to /ffmedia, never to /media', () => {
    const b = okM();
    at(b, '/ffmedia/neu').Target = '/media/x';
    refuses(() => assertManaged(b, EM));
    // a recorded target below /media is still fine; only a folder not recorded must be at /ffmedia
    expect(() => assertManaged(b, { ...E, migrated: { targets: ['/movies', '/data/tv', '/media/x'] } })).not.toThrow();
    const ff = okM();
    at(ff, '/ffmedia/neu').Target = '/ffmedia/x';
    expect(() => assertManaged(ff, EM)).not.toThrow();
  });

  it('/ffmedia/<slug> only on a migrated server', () => {
    const b = ok();
    M(b).find((m) => m.Target === '/media/filme')!.Target = '/ffmedia/filme';
    refuses(() => assertManaged(b, E));
    const m = okM();
    for (const t of ['/ffmedia/Neu', '/ffmedia', '/ffmedia/a/b/c/d']) {
      const x = clone(m);
      at(x, '/ffmedia/neu').Target = t;
      refuses(() => assertManaged(x, EM));
    }
  });

  it('inspect: the same rules', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/mediaserver-inspect.json', import.meta.url), 'utf8')) as Body;
    const image = {
      env: (fixture.Config.Env as string[]).filter((e) => !e.startsWith('TZ=') && !e.startsWith('FERROFIN_CACHE_DIR=')),
      entrypoint: ['ferrofin-server'], cmd: null, volumes: ['/data'],
    };
    const i = clone(fixture);
    // the engine's view of the migrated create: data at /ferrofin-data, the image's FERROFIN_DATA_DIR overridden, the whole base at /movies
    i.HostConfig.Mounts[0].Target = i.Mounts[0].Destination = '/ferrofin-data';
    i.Config.Env = i.Config.Env.map((x: string) => (x === 'FERROFIN_DATA_DIR=/data' ? 'FERROFIN_DATA_DIR=/ferrofin-data' : x));
    i.HostConfig.Mounts[2].Target = i.Mounts[2].Destination = '/movies';
    delete i.HostConfig.Mounts[2].VolumeOptions.Subpath;
    // the other folder was added after the move: /ffmedia
    i.HostConfig.Mounts[3].Target = i.Mounts[3].Destination = '/ffmedia/serien';
    i.HostConfig.Tmpfs['/data'] = 'size=1m,mode=0755';
    expect(() => assertManagedInspect(i, { ...E, image, migrated: { targets: ['/movies'] } })).not.toThrow();
    refuses(() => assertManagedInspect(i, { ...E, image }));
    refuses(() => assertManagedInspect(i, { ...E, image, migrated: { targets: ['/tv'] } }));
    const rw = clone(i);
    rw.Mounts[2].RW = true;
    refuses(() => assertManagedInspect(rw, { ...E, image, migrated: { targets: ['/movies'] } }));
    // the fixed tmpfs over the image's /data is required on a migrated server, and no anonymous volume may sit at /data
    const notmp = clone(i);
    delete notmp.HostConfig.Tmpfs['/data'];
    refuses(() => assertManagedInspect(notmp, { ...E, image, migrated: { targets: ['/movies'] } }));
    const anon = clone(i);
    anon.Mounts.push({ Type: 'volume', Name: 'e'.repeat(64), Source: '/var/lib/docker/volumes/e/_data', Destination: '/data', Driver: 'local', Mode: '', RW: true, Propagation: '' });
    refuses(() => assertManagedInspect(anon, { ...E, image, migrated: { targets: ['/movies'] } }));
    const s1 = clone(fixture);
    s1.HostConfig.Tmpfs['/data'] = 'size=1m,mode=0755';
    refuses(() => assertManagedInspect(s1, { ...E, image }));
  });

  it('a migrated body covers the image /data with a fixed tmpfs, a stage 1 body may not', () => {
    expect(okM().HostConfig.Tmpfs).toEqual({ '/tmp': 'size=512m,mode=1777', '/data': 'size=1m,mode=0755' });
    const mut: [string, (b: Body) => void][] = [
      ['no /data tmpfs', (b) => { delete b.HostConfig.Tmpfs['/data']; }],
      ['a larger /data tmpfs', (b) => { b.HostConfig.Tmpfs['/data'] = 'size=10g,mode=0755'; }],
      ['a writable /data tmpfs', (b) => { b.HostConfig.Tmpfs['/data'] = 'size=1m,mode=1777'; }],
      ['an exec /data tmpfs', (b) => { b.HostConfig.Tmpfs['/data'] = 'size=1m,mode=0755,exec'; }],
      ['a tmpfs at a listed target', (b) => { b.HostConfig.Tmpfs['/movies'] = 'size=1m'; }],
    ];
    for (const [name, m] of mut) {
      const b = okM();
      m(b);
      expect(() => assertManaged(b, EM), name).toThrow(TemplateViolation);
    }
    const s1 = ok();
    s1.HostConfig.Tmpfs['/data'] = 'size=1m,mode=0755';
    refuses(() => assertManaged(s1, E));
  });

  it('a media target equal to or below another is refused, in both directions', () => {
    // the whole base at /media (as the bundled Jellyfin did): a folder below it could be moved by a symlink in the share
    const whole: DesiredSpec = { ...D, migrated: true, folders: [{ rel: '', target: '/media', migrated: true }, { rel: 'Neu', target: '/ffmedia/neu' }] };
    const b = clone(containerSpec(whole, F).body) as Body;
    const EW: ManagedExpect = { ...E, migrated: { targets: ['/media'] } };
    expect(() => assertManaged(b, EW)).not.toThrow();
    const below = clone(b);
    M(below).push({ ...at(below, '/ffmedia/neu'), Target: '/media/neu' });
    refuses(() => assertManaged(below, EW));
    const above = clone(b);
    M(above).splice(M(above).indexOf(at(above, '/media')), 1, { ...at(above, '/media'), Target: '/media/a' });
    M(above).push({ ...at(above, '/ffmedia/neu'), VolumeOptions: { NoCopy: true }, Target: '/media' });
    refuses(() => assertManaged(above, EW));
    // two listed targets, one inside the other, in either order
    for (const targets of [['/movies', '/movies/kids'], ['/movies/kids', '/movies']]) {
      const x = okM();
      at(x, '/movies').Target = targets[0];
      at(x, '/data/tv').Target = targets[1];
      refuses(() => assertManaged(x, { ...E, migrated: { targets } }));
    }
    // /ffmedia folders and stage 1 folders too
    const ff = okM();
    M(ff).push({ ...at(ff, '/ffmedia/neu'), Target: '/ffmedia/neu/a', VolumeOptions: { NoCopy: true, Subpath: 'Neu2' } });
    refuses(() => assertManaged(ff, EM));
    for (const order of [['/media/filme', '/media/filme/a'], ['/media/filme/a', '/media/filme']]) {
      const s1 = ok();
      M(s1).find((m) => m.Target === '/media/filme')!.Target = order[0];
      M(s1).find((m) => m.Target === '/media/serien')!.Target = order[1];
      refuses(() => assertManaged(s1, E));
    }
    // a common prefix that is not a parent is fine
    const sib = okM();
    at(sib, '/movies').Target = '/data/tvx';
    expect(() => assertManaged(sib, { ...E, migrated: { targets: ['/data/tvx', '/data/tv'] } })).not.toThrow();
  });
});

describe('source helpers (stage 2)', () => {
  const H = { project: 'friendflix', image: 'sha256:' + 'c'.repeat(64) };
  const G = { project: 'friendflix', uid: 1000, gid: 1000, image: H.image, dockerRoot: '/var/lib/docker' };
  const bindSrc = { type: 'bind' as const, source: '/opt/jellyfin/config' };
  const volSrc = { type: 'volume' as const, source: 'jellyfin_config' };
  const source = (s: { type: 'bind' | 'volume'; source: string }) => ({ kind: 'source' as const, ...s });
  const data = (rw: boolean, volume = 'friendflix_mediaserver-ferrofin-data') => ({ kind: 'data' as const, volume, rw });
  const req = (r: Partial<HelperRequest>): Body => clone(helperSpec({ verb: 'migrate-scan', args: [], uid: 1000, gid: 1000, groups: [], mounts: [source(bindSrc)], ...r }, H).body) as Body;

  it('source mount: read-only, only for migrate verbs, only the expected source', () => {
    expect(() => assertHelper(req({}), { ...G, verb: 'migrate-scan', source: bindSrc })).not.toThrow();
    expect(() => assertHelper(req({ mounts: [source(volSrc)] }), { ...G, verb: 'migrate-scan', source: volSrc })).not.toThrow();
    expect(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(volSrc), data(true)] }), { ...G, verb: 'migrate-copy', source: volSrc })).not.toThrow();
    // no source mount at all is fine (the verbs decide what they need)
    expect(() => assertHelper(req({ mounts: [] }), { ...G, verb: 'migrate-scan' })).not.toThrow();

    const cases: [string, Body, Parameters<typeof assertHelper>[1]][] = [
      ['a source mount for browse', req({ verb: 'browse', mounts: [source(bindSrc)] }), { ...G, verb: 'browse', source: bindSrc }],
      ['a source mount for check', req({ verb: 'check', mounts: [source(bindSrc)] }), { ...G, verb: 'check', source: bindSrc }],
      ['a source mount for backup', req({ verb: 'backup', mounts: [source(volSrc)] }), { ...G, verb: 'backup', source: volSrc }],
      ['a source mount for restore', req({ verb: 'restore', mounts: [source(volSrc)] }), { ...G, verb: 'restore', source: volSrc }],
      ['a source mount without an expected source', req({}), { ...G, verb: 'migrate-scan' }],
      ['another bind path', req({ mounts: [source({ type: 'bind', source: '/opt/jellyfin' })] }), { ...G, verb: 'migrate-scan', source: bindSrc }],
      ['another volume', req({ mounts: [source({ type: 'volume', source: 'other_config' })] }), { ...G, verb: 'migrate-scan', source: volSrc }],
      ['a bind where a volume is expected', req({ mounts: [source({ type: 'bind', source: 'jellyfin_config' })] }), { ...G, verb: 'migrate-scan', source: volSrc }],
      ['a volume where a bind is expected', req({ mounts: [source({ type: 'volume', source: '/opt/jellyfin/config' })] }), { ...G, verb: 'migrate-scan', source: bindSrc }],
      ['a bind of /', req({ mounts: [source({ type: 'bind', source: '/' })] }), { ...G, verb: 'migrate-scan', source: { type: 'bind', source: '/' } }],
      ['a bind with ..', req({ mounts: [source({ type: 'bind', source: '/opt/../etc' })] }), { ...G, verb: 'migrate-scan', source: { type: 'bind', source: '/opt/../etc' } }],
      ['a relative bind', req({ mounts: [source({ type: 'bind', source: 'config' })] }), { ...G, verb: 'migrate-scan', source: { type: 'bind', source: 'config' } }],
      ['a bind of the docker socket', req({ mounts: [source({ type: 'bind', source: '/var/run/docker.sock' })] }), { ...G, verb: 'migrate-scan', source: { type: 'bind', source: '/var/run/docker.sock' } }],
      ['a volume with a bad name', req({ mounts: [source({ type: 'volume', source: '/x' })] }), { ...G, verb: 'migrate-scan', source: { type: 'volume', source: '/x' } }],
      ['the source twice', req({ mounts: [source(bindSrc), source(bindSrc)] }), { ...G, verb: 'migrate-scan', source: bindSrc }],
    ];
    for (const [name, b, e] of cases) expect(() => assertHelper(b, e), name).toThrow(TemplateViolation);

    const mut: [string, (b: Body) => void][] = [
      ['read-write', (b) => { b.HostConfig.Mounts[0].ReadOnly = false; }],
      ['ReadOnly missing', (b) => { delete b.HostConfig.Mounts[0].ReadOnly; }],
      ['bind options', (b) => { b.HostConfig.Mounts[0].BindOptions = { Propagation: 'rshared' }; }],
      ['volume options on a bind', (b) => { b.HostConfig.Mounts[0].VolumeOptions = { NoCopy: true }; }],
      ['another target', (b) => { b.HostConfig.Mounts[0].Target = '/config'; }],
    ];
    for (const [name, m] of mut) {
      const b = req({});
      m(b);
      expect(() => assertHelper(b, { ...G, verb: 'migrate-scan', source: bindSrc }), name).toThrow(TemplateViolation);
    }
    const vmut: [string, (b: Body) => void][] = [
      ['read-write', (b) => { b.HostConfig.Mounts[0].ReadOnly = false; }],
      ['copy-up into the source volume (no NoCopy)', (b) => { delete b.HostConfig.Mounts[0].VolumeOptions; }],
      ['a subpath', (b) => { b.HostConfig.Mounts[0].VolumeOptions.Subpath = 'x'; }],
      ['driver options', (b) => { b.HostConfig.Mounts[0].VolumeOptions.DriverConfig = { Name: 'local', Options: { device: '/' } }; }],
    ];
    for (const [name, m] of vmut) {
      const b = req({ verb: 'migrate-copy', mounts: [source(volSrc)] });
      m(b);
      expect(() => assertHelper(b, { ...G, verb: 'migrate-copy', source: volSrc }), name).toThrow(TemplateViolation);
    }
  });

  it('a source bind never comes from a system tree or the Docker runtime', () => {
    for (const p of [
      '/proc', '/proc/1/root', '/sys', '/sys/fs', '/dev', '/dev/sda', '/etc', '/etc/jellyfin', '/boot', '/boot/x', '/run', '/run/user/1000', '/var/run', '/var/run/x',
      '/var/lib/docker', '/var/lib/docker/volumes/x/_data', '/srv/docker.sock', '/srv/containerd/x', '/home/a/docker.sock.d', '/root', '/root/jellyfin/config',
    ]) {
      const s = { type: 'bind' as const, source: p };
      expect(() => assertHelper(req({ mounts: [source(s)] }), { ...G, verb: 'migrate-scan', source: s }), p).toThrow(TemplateViolation);
    }
    for (const p of ['/opt/jellyfin/config', '/srv/jellyfin', '/var/lib/jellyfin', '/home/a/jellyfin/config', '/mnt/docker-data/jellyfin', '/var/lib/dockerx/jf', '/runner/jf']) {
      const s = { type: 'bind' as const, source: p };
      expect(() => assertHelper(req({ mounts: [source(s)] }), { ...G, verb: 'migrate-scan', source: s }), p).not.toThrow();
    }
  });

  it("a source bind never lies at, below or above the engine's own Docker data root", () => {
    const scan = (p: string, dockerRoot: string | null | undefined) => {
      const s = { type: 'bind' as const, source: p };
      return () => assertHelper(req({ mounts: [source(s)] }), { ...G, verb: 'migrate-scan', source: s, dockerRoot });
    };
    for (const p of ['/srv/docker', '/srv/docker/volumes/x/_data', '/srv']) expect(scan(p, '/srv/docker'), p).toThrow(TemplateViolation);
    for (const p of ['/srv/dockerx/jf', '/srv/jellyfin/config']) expect(scan(p, '/srv/docker'), p).not.toThrow();
    // the root unknown or not a host path: no bind source at all (a volume source does not depend on it)
    for (const root of [null, undefined, 'relative', '/', '/srv/../x']) expect(scan('/opt/jellyfin/config', root), String(root)).toThrow(TemplateViolation);
    const v = { type: 'volume' as const, source: 'jellyfin_config' };
    expect(() => assertHelper(req({ mounts: [source(v)] }), { ...G, verb: 'migrate-scan', source: v, dockerRoot: null })).not.toThrow();
  });

  it('migrate-copy may write /data, migrate-scan may not', () => {
    const copy = { ...G, verb: 'migrate-copy' as const, source: bindSrc };
    const scan = { ...G, verb: 'migrate-scan' as const, source: bindSrc };
    expect(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), data(true)] }), copy)).not.toThrow();
    expect(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), data(false)] }), copy)).not.toThrow();
    // only the Ferrofin data volume of this project
    refuses(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), data(true, 'friendflix_mediaserver-jellyfin-config')] }), copy));
    refuses(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), data(true, 'other_mediaserver-ferrofin-data')] }), copy));
    refuses(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), data(true, 'jellyfin_config')] }), copy));
    // scan: never /data, read-only or not
    refuses(() => assertHelper(req({ mounts: [source(bindSrc), data(false)] }), scan));
    refuses(() => assertHelper(req({ mounts: [source(bindSrc), data(true)] }), scan));
    // the other verbs keep stage 1's rule: /data read-write only for restore
    refuses(() => assertHelper(req({ verb: 'backup', mounts: [data(true)] }), { ...G, verb: 'backup' }));
    // a copy never writes the backups or binds anything else
    refuses(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), { kind: 'backup', rw: true }] }), copy));
    refuses(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), { kind: 'request', path: '/srv/media' }] }), { ...copy, bind: '/srv/media' }));
    refuses(() => assertHelper(req({ verb: 'migrate-copy', mounts: [source(bindSrc), { kind: 'dri' }] }), copy));
  });
});
