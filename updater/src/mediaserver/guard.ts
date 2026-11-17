// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HelperVerb } from './template.js';
import type { Gpu, Kind } from './types.js';

/**
 * The independent check of every create body (spec "The guard"): a second implementation that never calls the template and keeps its
 * own literals. An allowlist: the known keys must hold exactly the template's values, every other key must be unset. A refusal is
 * `template_violation` and is never retried; on inspect it is `managed_tampered`.
 */
export class TemplateViolation extends Error {
  constructor(readonly field: string) {
    super(`template_violation: ${field}`);
    this.name = 'TemplateViolation';
  }
}

export interface ManagedExpect { project: string; kind: Kind; uid: number; gid: number; repo: string }
interface ImageFacts { env: string[]; entrypoint: string[] | null; cmd: string[] | null; volumes: string[] }

type Obj = Record<string, unknown>;
const fail = (field: string): never => { throw new TemplateViolation(field); };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown, field: string): Obj => (isObj(v) ? v : fail(field));
/** the values Docker treats as "not set" */
const unset = (v: unknown): boolean =>
  v === undefined || v === null || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const need = (ok: boolean, field: string): void => { if (!ok) fail(field); };
/** every key outside `known` must be unset */
function onlyKeys(o: Obj, known: readonly string[], path: string): void {
  for (const [k, v] of Object.entries(o)) if (!known.includes(k) && !unset(v)) fail(path + k);
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
/**
 * Docker fills in its default masked and read-only paths only when these are nil: an empty list is kept and unmasks /proc and /sys
 * (`systempaths=unconfined`), so on a create body they must be absent, not merely "unset"
 */
function defaultSystemPaths(h: Obj): void {
  for (const k of ['MaskedPaths', 'ReadonlyPaths']) need(h[k] === undefined || h[k] === null, `HostConfig.${k}`);
}

// --- the guard's own literals ---
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DIGEST = '@sha256:';
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SOCKET_RE = /docker\.sock|containerd/;
const MEDIA_TARGET_RE = /^\/media(\/[a-z0-9-]{1,40}){1,3}$/;
const COMPONENT_RE = /^[\p{L}\p{N} ._\-+()&']+$/u;
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const PASSWORD_RE = /^[A-Za-z0-9_-]{43}$/;
const GID_RE = /^[1-9][0-9]{0,4}$/;
const STATE: Record<Kind, { data: [string, string]; cache: [string, string] }> = {
  ferrofin: { data: ['ferrofin-data', '/data'], cache: ['ferrofin-cache', '/cache'] },
  jellyfin: { data: ['jellyfin-config', '/config'], cache: ['jellyfin-cache', '/cache'] },
};
const NVIDIA_CAPS = 'compute,video,utility';
const ENV: Record<Kind, Record<string, (v: string) => boolean>> = {
  ferrofin: {
    TZ: (v) => TZ_RE.test(v) && v.length <= 64, FERROFIN_CACHE_DIR: (v) => v === '/cache', FERROFIN_ADMIN_USER: (v) => v === 'friendflix-admin',
    FERROFIN_ADMIN_PASSWORD: (v) => PASSWORD_RE.test(v), NVIDIA_DRIVER_CAPABILITIES: (v) => v === NVIDIA_CAPS,
  },
  jellyfin: { TZ: (v) => TZ_RE.test(v) && v.length <= 64, XDG_CACHE_HOME: (v) => v === '/cache/xdg', NVIDIA_DRIVER_CAPABILITIES: (v) => v === NVIDIA_CAPS },
};
const DRI_DEVICE = { PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' };
const HARDENING: [string, unknown][] = [['ReadonlyRootfs', true], ['CapDrop', ['ALL']], ['SecurityOpt', ['no-new-privileges:true']]];
/** labels an image may bring along (seen on inspect only): the OCI annotations and our own image labels */
const IMAGE_LABEL_PREFIXES = ['org.opencontainers.', 'io.github.letsmanu.friendflix.mediaserver.'];
const FFMPEG_DIRS = ['/usr/local/bin', '/usr/lib/jellyfin-ffmpeg'];
const HDR_TEST1 = ['-hide_banner', '-init_hw_device', null, '-init_hw_device', 'opencl=ocl@va', '-f', 'lavfi', '-i', 'nullsrc', '-frames', '1', '-f', 'null', '-'];
const RENDER_NODE_RE = /^\/dev\/dri\/renderD[0-9]{1,4}$/;
const SEED_TARGET: Record<Kind, string | null> = { ferrofin: '/tmp', jellyfin: '/tmp' };
/** the media images a seed or HDR run may use: one of the two allowed repositories, pinned by digest */
const MEDIA_IMAGE_RE: Record<Kind, RegExp> = {
  ferrofin: /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+-mediaserver@sha256:[0-9a-f]{64}$/,
  jellyfin: /^docker\.io\/jellyfin\/jellyfin@sha256:[0-9a-f]{64}$/,
};

const repository = (kind: Kind, repo: string): string => {
  need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), 'repo');
  return kind === 'ferrofin' ? `ghcr.io/${repo.toLowerCase()}-mediaserver` : 'docker.io/jellyfin/jellyfin';
};
/** `<repository>@sha256:<64 hex>`, nothing else (no tag) */
const pinnedBy = (image: unknown, repo: string): boolean =>
  typeof image === 'string' && image.startsWith(repo + DIGEST) && DIGEST_RE.test(image.slice(repo.length + DIGEST.length));
const validId = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
function checkUser(v: unknown, uid: number, gid: number): void {
  need(validId(uid) && validId(gid) && v === `${uid}:${gid}`, 'User');
}
function checkGroups(v: unknown, max: number): void {
  if (unset(v)) return;
  need(strings(v) && v.length <= max && new Set(v).size === v.length && v.every((g) => GID_RE.test(g) && Number(g) <= 65535), 'HostConfig.GroupAdd');
}
const noSocket = (...s: unknown[]): void => need(!s.some((x) => typeof x === 'string' && SOCKET_RE.test(x)), 'HostConfig.Mounts');
function isRel(rel: unknown): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 200) return false;
  const p = rel.split('/');
  return p.length <= 3 && p.every((c) => COMPONENT_RE.test(c) && !c.startsWith('.'));
}
const checkProject = (project: string): void => need(PROJECT_RE.test(project), 'project');

// --- the managed media server ---

const TOP_KEYS = ['Hostname', 'User', 'Image', 'Env', 'Labels', 'StopTimeout', 'HostConfig', 'NetworkingConfig'];
const HOST_KEYS = ['NetworkMode', 'Mounts', 'Tmpfs', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Devices', 'DeviceRequests', 'GroupAdd', 'RestartPolicy', 'Init', 'PidsLimit', 'LogConfig', 'AutoRemove'];
const MOUNT_KEYS = ['Type', 'Source', 'Target', 'ReadOnly', 'VolumeOptions'];

function checkEnv(env: unknown, kind: Kind): void {
  need(strings(env), 'Env');
  const seen = new Set<string>();
  for (const entry of env as string[]) {
    const i = entry.indexOf('=');
    const key = i < 0 ? entry : entry.slice(0, i);
    const check = Object.prototype.hasOwnProperty.call(ENV[kind], key) ? ENV[kind][key] : undefined;
    need(i > 0 && check !== undefined && !seen.has(key) && check(entry.slice(i + 1)), `Env.${key}`);
    seen.add(key);
  }
}

function checkLabels(labels: unknown, e: ManagedExpect): void {
  const l = obj(labels, 'Labels');
  const want: Obj = {
    'friendflix.managed': 'mediaserver', 'friendflix.project': e.project, 'friendflix.kind': e.kind, 'friendflix.template': '1',
    'com.centurylinklabs.watchtower.enable': 'false',
  };
  for (const [k, v] of Object.entries(want)) need(l[k] === v, `Labels.${k}`);
  need(typeof l['friendflix.spec'] === 'string' && DIGEST_RE.test(l['friendflix.spec']), 'Labels.friendflix.spec');
  for (const k of Object.keys(l)) need(Object.prototype.hasOwnProperty.call(want, k) || k === 'friendflix.spec', `Labels.${k}`);
}

function checkMounts(mounts: unknown, e: ManagedExpect): void {
  need(Array.isArray(mounts), 'HostConfig.Mounts');
  const prefix = `${e.project}_mediaserver-`;
  const state = STATE[e.kind];
  const targets = new Set<string>();
  let data = 0, cache = 0;
  let base: string | null = null;
  for (const raw of mounts as unknown[]) {
    const m = obj(raw, 'HostConfig.Mounts');
    onlyKeys(m, MOUNT_KEYS, 'HostConfig.Mounts.');
    const { Type, Source, Target, ReadOnly, VolumeOptions } = m;
    need(Type === 'volume' && typeof Source === 'string' && typeof Target === 'string' && !targets.has(Target), 'HostConfig.Mounts');
    targets.add(Target as string);
    noSocket(Source, Target, isObj(VolumeOptions) ? VolumeOptions.Subpath : undefined);
    if (Source === prefix + state.data[0] || Source === prefix + state.cache[0]) {
      const [, target] = Source === prefix + state.data[0] ? state.data : state.cache;
      need(Target === target && unset(ReadOnly) && unset(VolumeOptions), 'HostConfig.Mounts');
      if (target === state.data[1]) data++; else cache++;
      continue;
    }
    // a media folder: the one base volume, read-only, without copy-up, below /media
    need((Source as string).startsWith(prefix + 'base-') && /^[0-9a-f]{8}$/.test((Source as string).slice((prefix + 'base-').length)), 'HostConfig.Mounts.Source');
    need(base === null || base === Source, 'HostConfig.Mounts.Source');
    base = Source as string;
    need(MEDIA_TARGET_RE.test(Target as string), 'HostConfig.Mounts.Target');
    need(ReadOnly === true, 'HostConfig.Mounts.ReadOnly');
    const vo = obj(VolumeOptions, 'HostConfig.Mounts.VolumeOptions');
    onlyKeys(vo, ['NoCopy', 'Subpath'], 'HostConfig.Mounts.VolumeOptions.');
    need(vo.NoCopy === true && isRel(vo.Subpath), 'HostConfig.Mounts.VolumeOptions');
  }
  need(data === 1 && cache === 1, 'HostConfig.Mounts');
}

function checkHostConfig(hc: unknown, e: ManagedExpect): void {
  const h = obj(hc, 'HostConfig');
  onlyKeys(h, HOST_KEYS, 'HostConfig.');
  defaultSystemPaths(h);
  need(h.NetworkMode === `${e.project}_media`, 'HostConfig.NetworkMode');
  for (const [k, v] of HARDENING) need(eq(h[k], v), `HostConfig.${k}`);
  need(eq(h.Tmpfs, { '/tmp': 'size=512m,mode=1777' }), 'HostConfig.Tmpfs');
  checkMounts(h.Mounts, e);
  need(unset(h.Devices) || eq(h.Devices, [DRI_DEVICE]), 'HostConfig.Devices');
  if (!unset(h.DeviceRequests)) {
    need(unset(h.Devices), 'HostConfig.Devices');
    need(Array.isArray(h.DeviceRequests) && h.DeviceRequests.length === 1, 'HostConfig.DeviceRequests');
    const r = obj((h.DeviceRequests as unknown[])[0], 'HostConfig.DeviceRequests');
    onlyKeys(r, ['Driver', 'Count', 'Capabilities'], 'HostConfig.DeviceRequests.');
    need(r.Driver === 'nvidia', 'HostConfig.DeviceRequests.Driver');
    need(r.Count === 1, 'HostConfig.DeviceRequests.Count');
    need(eq(r.Capabilities, [['gpu']]), 'HostConfig.DeviceRequests.Capabilities');
  }
  checkGroups(h.GroupAdd, 5);
  const rp = obj(h.RestartPolicy, 'HostConfig.RestartPolicy');
  onlyKeys(rp, ['Name'], 'HostConfig.RestartPolicy.');
  need(rp.Name === 'unless-stopped', 'HostConfig.RestartPolicy');
  need(h.Init === true, 'HostConfig.Init');
  need(h.PidsLimit === 4096, 'HostConfig.PidsLimit');
  need(eq(h.LogConfig, { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }), 'HostConfig.LogConfig');
  need(unset(h.AutoRemove), 'HostConfig.AutoRemove');
}

/** the shared checks of a create body; `networking: false` when the networks are checked from an inspect instead */
function checkManaged(body: unknown, e: ManagedExpect, networking: boolean): void {
  const b = obj(body, 'body');
  checkProject(e.project);
  onlyKeys(b, TOP_KEYS, '');
  need(b.Hostname === 'mediaserver', 'Hostname');
  checkUser(b.User, e.uid, e.gid);
  need(pinnedBy(b.Image, repository(e.kind, e.repo)), 'Image');
  checkEnv(b.Env, e.kind);
  checkLabels(b.Labels, e);
  need(b.StopTimeout === 30, 'StopTimeout');
  checkHostConfig(b.HostConfig, e);
  if (!networking) return;
  const nc = obj(b.NetworkingConfig, 'NetworkingConfig');
  onlyKeys(nc, ['EndpointsConfig'], 'NetworkingConfig.');
  const ep = obj(nc.EndpointsConfig, 'NetworkingConfig.EndpointsConfig');
  const media = `${e.project}_media`;
  need(Object.keys(ep).length === 1 && isObj(ep[media]), 'NetworkingConfig.EndpointsConfig');
  const m = ep[media] as Obj;
  onlyKeys(m, ['Aliases'], 'NetworkingConfig.EndpointsConfig.');
  need(eq(m.Aliases, ['mediaserver']), 'NetworkingConfig.EndpointsConfig.Aliases');
}

/** a create body for the managed media server */
export function assertManaged(body: unknown, e: ManagedExpect): void {
  checkManaged(body, e, true);
}

// Config keys of an inspect: what the template sets, what the image brings (checked below), what the engine reports as defaults.
const INSPECT_CONFIG_KEYS = [
  'Hostname', 'User', 'Image', 'Env', 'Labels', 'StopTimeout', 'Entrypoint', 'Cmd', 'Volumes', 'ExposedPorts', 'Healthcheck', 'WorkingDir', 'StopSignal',
  'AttachStdin', 'AttachStdout', 'AttachStderr',
];
// HostConfig keys of an inspect that hold engine defaults, each checked on its own
const ENGINE_DEFAULTS = ['CgroupnsMode', 'IpcMode', 'ShmSize', 'ConsoleSize', 'Runtime', 'MaskedPaths', 'ReadonlyPaths', 'PortBindings'];

/**
 * An existing container with our labels, before the updater adopts or acts on it: the same checks on `Config`, `HostConfig` and the
 * top-level `Mounts`, tolerating what the image brings (its environment entries, entrypoint, command, volumes, labels, exposed ports,
 * healthcheck) and the engine's defaults; the default masked and read-only paths must still be there. `gpu` is the expected spec's
 * choice: a host whose default runtime is `nvidia` reports it on every container, so it is accepted only with the NVIDIA choice.
 */
export function assertManagedInspect(inspect: unknown, e: ManagedExpect & { gpu?: Gpu; image: ImageFacts }): void {
  const i = obj(inspect, 'inspect');
  const c = obj(i.Config, 'Config');
  const h = obj(i.HostConfig, 'HostConfig');
  onlyKeys(c, INSPECT_CONFIG_KEYS, 'Config.');
  for (const k of ['AttachStdin', 'AttachStdout', 'AttachStderr']) need(c[k] === undefined || typeof c[k] === 'boolean', `Config.${k}`);
  for (const k of ['Entrypoint', 'Cmd'] as const) need(unset(c[k]) || eq(c[k], e.image[k === 'Entrypoint' ? 'entrypoint' : 'cmd']), `Config.${k}`);
  need(unset(c.Volumes) || (isObj(c.Volumes) && Object.keys(c.Volumes).every((v) => e.image.volumes.includes(v))), 'Config.Volumes');
  need(unset(c.ExposedPorts) || isObj(c.ExposedPorts), 'Config.ExposedPorts'); // inert without bindings, which are checked below
  need(unset(c.Healthcheck) || (isObj(c.Healthcheck) && strings(c.Healthcheck.Test) && c.Healthcheck.Test[0] !== 'NONE'), 'Config.Healthcheck');
  need(c.WorkingDir === undefined || typeof c.WorkingDir === 'string', 'Config.WorkingDir');
  need(c.StopSignal === undefined || typeof c.StopSignal === 'string', 'Config.StopSignal');

  const env = strings(c.Env) ? c.Env.filter((x) => !e.image.env.includes(x)) : c.Env;
  const labels = isObj(c.Labels) ? Object.fromEntries(Object.entries(c.Labels).filter(([k]) => !IMAGE_LABEL_PREFIXES.some((p) => k.startsWith(p)))) : c.Labels;
  const host = Object.fromEntries(Object.entries(h).filter(([k]) => !ENGINE_DEFAULTS.includes(k)));
  checkManaged({ Hostname: c.Hostname, User: c.User, Image: c.Image, Env: env, Labels: labels, StopTimeout: c.StopTimeout, HostConfig: host }, e, false);

  // 'host' is the engine default on cgroup v1 hosts
  need(h.CgroupnsMode === undefined || ['', 'private', 'host'].includes(h.CgroupnsMode as string), 'HostConfig.CgroupnsMode');
  need(h.IpcMode === undefined || ['', 'private', 'shareable'].includes(h.IpcMode as string), 'HostConfig.IpcMode');
  need(h.Runtime === undefined || h.Runtime === '' || h.Runtime === 'runc' || (h.Runtime === 'nvidia' && e.gpu === 'nvidia'), 'HostConfig.Runtime');
  need(h.ShmSize === undefined || (typeof h.ShmSize === 'number' && h.ShmSize >= 0), 'HostConfig.ShmSize');
  need(h.ConsoleSize === undefined || h.ConsoleSize === null || (Array.isArray(h.ConsoleSize) && h.ConsoleSize.every((n) => typeof n === 'number')), 'HostConfig.ConsoleSize');
  need(strings(h.MaskedPaths) && h.MaskedPaths.length > 0, 'HostConfig.MaskedPaths');
  need(strings(h.ReadonlyPaths) && h.ReadonlyPaths.length > 0, 'HostConfig.ReadonlyPaths');
  need(unset(h.PortBindings) || (isObj(h.PortBindings) && Object.values(h.PortBindings).every(unset)), 'HostConfig.PortBindings');

  // the mounts as the engine made them: each named one as specified, anonymous ones only at the image's own volumes
  const spec = h.Mounts as Obj[];
  for (const raw of Array.isArray(i.Mounts) ? i.Mounts : unset(i.Mounts) ? [] : fail('Mounts')) {
    const m = obj(raw, 'Mounts');
    need(m.Type === 'volume' && typeof m.Destination === 'string', 'Mounts');
    noSocket(m.Name, m.Source, m.Destination);
    const s = spec.find((x) => x.Target === m.Destination);
    if (s) need(m.Name === s.Source && m.RW === (s.ReadOnly !== true), 'Mounts');
    else need(typeof m.Name === 'string' && DIGEST_RE.test(m.Name) && e.image.volumes.includes(m.Destination as string), 'Mounts');
  }

  // networks: the media network, and the egress network when metadata download is on; no published port
  const ns = obj(i.NetworkSettings, 'NetworkSettings');
  const nets = obj(ns.Networks, 'NetworkSettings.Networks');
  need(isObj(nets[`${e.project}_media`]) && Object.keys(nets).every((n) => n === `${e.project}_media` || n === `${e.project}_egress`), 'NetworkSettings.Networks');
  need(unset(ns.Ports) || (isObj(ns.Ports) && Object.values(ns.Ports).every(unset)), 'NetworkSettings.Ports');
}

// --- helpers, HDR runs and seeds ---

const HELPER_HOST_KEYS = ['NetworkMode', 'Mounts', 'Tmpfs', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Devices', 'GroupAdd', 'AutoRemove'];

function checkHelperMounts(mounts: unknown[], e: { project: string; verb: HelperVerb; bind?: string }): void {
  const p = `${e.project}_mediaserver-`;
  const targets = new Set<string>();
  for (const raw of mounts) {
    const m = obj(raw, 'HostConfig.Mounts');
    onlyKeys(m, MOUNT_KEYS, 'HostConfig.Mounts.');
    const { Type, Source, Target, ReadOnly, VolumeOptions } = m;
    need(typeof Source === 'string' && typeof Target === 'string' && !targets.has(Target), 'HostConfig.Mounts');
    targets.add(Target as string);
    noSocket(Source, Target);
    /** a named volume: `ro` = must be read-only (else either), `noCopy` = must not be copied up into */
    const vol = (src: boolean, ro: boolean, noCopy: boolean): void =>
      need(Type === 'volume' && src && (ro ? ReadOnly === true : ReadOnly === undefined || typeof ReadOnly === 'boolean')
        && (noCopy ? eq(VolumeOptions, { NoCopy: true }) : unset(VolumeOptions)), `HostConfig.Mounts.${Target as string}`);
    const bind = (src: string | undefined, verb: HelperVerb): void =>
      need(Type === 'bind' && e.verb === verb && src !== undefined && Source === src && ReadOnly === true && unset(VolumeOptions), `HostConfig.Mounts.${Target as string}`);
    switch (Target) {
      case '/base':
        if (Type === 'bind') bind(e.bind !== undefined && /^(\/[^/]+)+$/.test(e.bind) && !e.bind.split('/').some((c) => c === '.' || c === '..') ? e.bind : undefined, 'check');
        else vol((Source as string).startsWith(p + 'base-') && /^[0-9a-f]{8}$/.test((Source as string).slice((p + 'base-').length)), true, true);
        break;
      case '/dev/dri': bind('/dev/dri', 'gpu'); break;
      case '/sys-drm': bind('/sys/class/drm', 'gpu'); break;
      case '/data': vol(Source === p + 'ferrofin-data' || Source === p + 'jellyfin-config', e.verb !== 'restore', true); break;
      case '/backups': vol(Source === p + 'backup', e.verb !== 'backup' && e.verb !== 'restore', false); break;
      default: fail('HostConfig.Mounts.Target');
    }
  }
}

function checkHdrRun(b: Obj): void {
  need(strings(b.Entrypoint) && b.Entrypoint.length === 1 && strings(b.Cmd), 'Entrypoint');
  const [entry] = b.Entrypoint as string[];
  const cmd = b.Cmd as string[];
  if (entry === '/bin/sh') {
    need(cmd.length === 4 && cmd[0] === '-c' && cmd[2] === 'probe' && RENDER_NODE_RE.test(cmd[3]!), 'Cmd');
    return;
  }
  need(FFMPEG_DIRS.some((d) => entry === `${d}/ffmpeg`), 'Entrypoint');
  need(cmd.length === HDR_TEST1.length && HDR_TEST1.every((a, k) => (a === null ? cmd[k]!.startsWith('vaapi=va:') && RENDER_NODE_RE.test(cmd[k]!.slice(9)) : cmd[k] === a)), 'Cmd');
}

function checkSeed(h: Obj, b: Obj, e: { project: string; image: string; kind?: Kind }): void {
  const kind = e.kind ?? fail('kind');
  const target = SEED_TARGET[kind] ?? fail('kind');
  need(MEDIA_IMAGE_RE[kind].test(e.image), 'Image');
  need(unset(b.Entrypoint) && eq(b.Cmd, ['true']), 'Cmd');
  need(unset(h.Tmpfs), 'HostConfig.Tmpfs');
  need(Array.isArray(h.Mounts) && h.Mounts.length === 1, 'HostConfig.Mounts');
  const m = obj((h.Mounts as unknown[])[0], 'HostConfig.Mounts');
  onlyKeys(m, ['Type', 'Source', 'Target', 'ReadOnly'], 'HostConfig.Mounts.');
  const p = `${e.project}_mediaserver-`;
  need(m.Type === 'volume' && (m.Source === p + STATE[kind].data[0] || m.Source === p + STATE[kind].cache[0]) && m.Target === target && unset(m.ReadOnly), 'HostConfig.Mounts');
}

/**
 * A helper, HDR run or seed body: the updater's image (`e.image`) with a fixed verb, or the media image for `hdr`/`seed`; no network,
 * read-only root, no capabilities, never auto-removed; mounts only from the fixed list (binds: the requested path for `check`,
 * /dev/dri and /sys/class/drm for `gpu`; data read-write only for `restore`; backups read-write only for `backup`/`restore`).
 */
export function assertHelper(body: unknown, e: { project: string; uid: number; gid: number; image: string; verb: HelperVerb | 'hdr' | 'seed'; bind?: string; kind?: Kind }): void {
  const b = obj(body, 'body');
  checkProject(e.project);
  need(/^sha256:[0-9a-f]{64}$/.test(e.image) || /^[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(e.image), 'Image');
  onlyKeys(b, ['Image', 'User', 'Cmd', 'Entrypoint', 'Labels', 'HostConfig'], '');
  need(b.Image === e.image, 'Image');
  checkUser(b.User, e.uid, e.gid);
  need(eq(b.Labels, { 'friendflix.managed': 'helper', 'friendflix.project': e.project }), 'Labels');

  const h = obj(b.HostConfig, 'HostConfig');
  onlyKeys(h, HELPER_HOST_KEYS, 'HostConfig.');
  defaultSystemPaths(h);
  need(h.NetworkMode === 'none', 'HostConfig.NetworkMode');
  for (const [k, v] of HARDENING) need(eq(h[k], v), `HostConfig.${k}`);
  need(unset(h.AutoRemove), 'HostConfig.AutoRemove');
  checkGroups(h.GroupAdd, 8);
  need(e.verb === 'hdr' ? eq(h.Devices, [DRI_DEVICE]) : unset(h.Devices), 'HostConfig.Devices');

  if (e.verb === 'seed') return checkSeed(h, b, e);
  if (e.verb === 'hdr') {
    need(MEDIA_IMAGE_RE.ferrofin.test(e.image) || MEDIA_IMAGE_RE.jellyfin.test(e.image), 'Image');
    need(eq(h.Tmpfs, { '/tmp': 'size=256m' }), 'HostConfig.Tmpfs');
    need(unset(h.Mounts), 'HostConfig.Mounts');
    return checkHdrRun(b);
  }
  need(eq(h.Tmpfs, { '/tmp': 'size=64m' }), 'HostConfig.Tmpfs');
  need(unset(b.Entrypoint), 'Entrypoint');
  need(strings(b.Cmd) && b.Cmd.length >= 3 && b.Cmd[0] === 'node' && b.Cmd[1] === 'updater/dist/mediaHelper.js' && b.Cmd[2] === e.verb, 'Cmd');
  need(unset(h.Mounts) || Array.isArray(h.Mounts), 'HostConfig.Mounts');
  checkHelperMounts(unset(h.Mounts) ? [] : (h.Mounts as unknown[]), { project: e.project, verb: e.verb, bind: e.bind });
}
