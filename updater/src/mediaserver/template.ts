// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { TemplateViolation } from './guard.js';
import { isRel, isTarget } from './paths.js';
import type { DesiredSpec, Kind } from './types.js';

/**
 * The only builder of Docker create bodies for the managed media server and its helper containers (spec "The container template",
 * "Helper containers"). Every body is checked again by guard.ts, a second implementation, before it is sent.
 */

export interface CreateRequest { name: string; body: Record<string, unknown> }
/** what the updater read from Docker itself: the compose project, the pinned image (`repo@sha256:…`), render node gids, base volume */
export interface TemplateFacts { project: string; image: string; renderGids: number[]; baseVolume: string }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const names = (project: string) => ({
  container: `${project}-mediaserver`,
  old: `${project}-mediaserver-old`,
  data: (k: Kind): string => `${project}_mediaserver-${k === 'ferrofin' ? 'ferrofin-data' : 'jellyfin-config'}`,
  cache: (k: Kind): string => `${project}_mediaserver-${k}-cache`,
  base: (path: string): string => `${project}_mediaserver-base-${sha256(path).slice(0, 8)}`,
  backup: `${project}_mediaserver-backup`,
  helper: (): string => `${project}-mediahelper-${randomBytes(4).toString('hex')}`,
  media: `${project}_media`,
  egress: `${project}_egress`,
});

/** where each kind keeps its state: the image's own directories */
export const STATE_TARGETS: Record<Kind, { data: string; cache: string }> = {
  ferrofin: { data: '/data', cache: '/cache' },
  jellyfin: { data: '/config', cache: '/cache' },
};

/**
 * Ferrofin v1.5.1's first-run administrator name variable (its docs/CONFIG.md: `FERROFIN_ADMIN_USER`, default `admin`, next to
 * `FERROFIN_ADMIN_PASSWORD`; both only act when the database is created. Without the password the admin is seeded passwordless).
 */
export const FERROFIN_ADMIN_NAME = 'FERROFIN_ADMIN_USER';
export const ADMIN_USER = 'friendflix-admin';
const NVIDIA_ENV = 'NVIDIA_DRIVER_CAPABILITIES=compute,video,utility';
const PASSWORD_RE = /^[A-Za-z0-9_-]{43}$/;

export const ENV_KEYS: Record<Kind, readonly string[]> = {
  ferrofin: ['TZ', 'FERROFIN_CACHE_DIR', FERROFIN_ADMIN_NAME, 'FERROFIN_ADMIN_PASSWORD', 'NVIDIA_DRIVER_CAPABILITIES'],
  jellyfin: ['TZ', 'XDG_CACHE_HOME', 'NVIDIA_DRIVER_CAPABILITIES'],
};

/**
 * the owner of the state directories in the pinned images (Ferrofin: user `ferrofin`; Jellyfin: root). Both make them mode 0777
 * (Jellyfin upstream; our Ferrofin image by its own fork change, mediaserver/Dockerfile), so Docker's copy-up alone leaves a fresh
 * volume writable for any non-root uid.
 */
export const IMAGE_OWNER: Record<Kind, string> = { ferrofin: '1000:1000', jellyfin: '0:0' };

/**
 * Where a never-started seed container mounts a fresh state volume so Docker's copy-up gives it an owner and mode the uid can write
 * (Controller's call 15). `/tmp` is root 1777 in both images (checked on the pinned layers). Docker copies the owner and mode of the
 * image directory into a still-empty volume again at every create that mounts it without NoCopy, so the real create then gives the
 * volume its state directory's mode 0777: the seed is redundant for both kinds, harmless, and keeps the rule uniform. null would
 * mean `uid_unsupported` for a uid that is not the owner.
 */
export const SEED_DIR: Record<Kind, string | null> = { ferrofin: '/tmp', jellyfin: '/tmp' };

/** a fresh state volume needs a seed when the container user is not the owner of the image's state directories */
export function needsSeed(kind: Kind, uid: number, gid: number): boolean {
  return `${uid}:${gid}` !== IMAGE_OWNER[kind];
}

/** false = `uid_unsupported` (`seedDirs` is for tests) */
export function uidSupported(kind: Kind, uid: number, gid: number, seedDirs: Record<Kind, string | null> = SEED_DIR): boolean {
  return validId(uid) && validId(gid) && (!needsSeed(kind, uid, gid) || seedDirs[kind] !== null);
}

const validId = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;
const user = (uid: number, gid: number): string => {
  if (!validId(uid) || !validId(gid)) throw new TemplateViolation('User');
  return `${uid}:${gid}`;
};

/** distinct numeric group ids, sorted; never 0; at most `max` */
function groups(ids: readonly number[], max: number): string[] {
  const set = [...new Set(ids)].sort((a, b) => a - b);
  if (set.length > max || !set.every(validId)) throw new TemplateViolation('GroupAdd');
  return set.map(String);
}

const MAX_RENDER_GIDS = 4;
const DRI_DEVICE = { PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' };
const hardening = () => ({ ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] });
const HELPER_LABELS = (project: string) => ({ 'friendflix.managed': 'helper', 'friendflix.project': project });

/** JSON with object keys sorted recursively (array order kept, undefined members left out) */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** sha256 of the canonical body without its own `friendflix.spec` label */
export function specHash(body: Record<string, unknown>): string {
  const labels = body.Labels;
  const rest = typeof labels === 'object' && labels !== null
    ? { ...body, Labels: Object.fromEntries(Object.entries(labels).filter(([k]) => k !== 'friendflix.spec')) }
    : body;
  return sha256(canonical(rest));
}

/** the managed media server's create body (spec "The container template"); `password` only on Ferrofin's first-run create */
export function containerSpec(d: DesiredSpec, f: TemplateFacts, o: { password?: string } = {}): CreateRequest {
  const n = names(f.project);
  const t = STATE_TARGETS[d.kind];

  const env = [`TZ=${d.tz}`];
  if (d.kind === 'ferrofin') env.push('FERROFIN_CACHE_DIR=/cache'); // its default is /data/cache: keep the cache out of the data volume
  if (o.password !== undefined) {
    if (d.kind !== 'ferrofin' || !PASSWORD_RE.test(o.password)) throw new TemplateViolation('Env');
    env.push(`${FERROFIN_ADMIN_NAME}=${ADMIN_USER}`, `FERROFIN_ADMIN_PASSWORD=${o.password}`);
  }
  if (d.kind === 'jellyfin') env.push('XDG_CACHE_HOME=/cache/xdg');
  if (d.gpu === 'nvidia') env.push(NVIDIA_ENV);

  const media = d.folders.map((x) => {
    if (!isTarget(x.target) || !isRel(x.rel, 1, 3)) throw new TemplateViolation('HostConfig.Mounts');
    return { Type: 'volume', Source: f.baseVolume, Target: x.target, ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: x.rel } };
  });

  const render = d.gpu === 'dri' ? [...new Set(f.renderGids)] : [];
  if (render.length > MAX_RENDER_GIDS) throw new TemplateViolation('GroupAdd');
  const groupAdd = groups(d.mediaGid === null ? render : [...render, d.mediaGid], MAX_RENDER_GIDS + 1);

  const hostConfig: Record<string, unknown> = {
    NetworkMode: n.media,
    Mounts: [
      { Type: 'volume', Source: n.data(d.kind), Target: t.data, ReadOnly: false },
      { Type: 'volume', Source: n.cache(d.kind), Target: t.cache, ReadOnly: false },
      ...media,
    ],
    Tmpfs: { '/tmp': 'size=512m,mode=1777' },
    ...hardening(),
    ...(d.gpu === 'dri' ? { Devices: [{ ...DRI_DEVICE }] } : {}),
    ...(d.gpu === 'nvidia' ? { DeviceRequests: [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }] } : {}),
    ...(groupAdd.length ? { GroupAdd: groupAdd } : {}),
    RestartPolicy: { Name: 'unless-stopped' },
    Init: true,
    PidsLimit: 4096,
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
  };

  const body: Record<string, unknown> = {
    Hostname: 'mediaserver',
    User: user(d.uid, d.gid),
    Image: f.image,
    Env: env,
    Labels: {
      'friendflix.managed': 'mediaserver', 'friendflix.project': f.project, 'friendflix.kind': d.kind,
      'friendflix.template': '1', 'com.centurylinklabs.watchtower.enable': 'false',
    },
    StopTimeout: 30,
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [n.media]: { Aliases: ['mediaserver'] } } },
  };
  (body.Labels as Record<string, string>)['friendflix.spec'] = specHash(body);
  return { name: n.container, body };
}

/**
 * A never-started container from the kind's pinned image that mounts one fresh state volume at SEED_DIR[kind]: creating it makes
 * Docker copy that directory's owner and mode into the volume. Created, never started, removed with its anonymous volumes.
 */
export function seedSpec(kind: Kind, which: 'data' | 'cache', d: DesiredSpec, f: TemplateFacts): CreateRequest {
  const dir = SEED_DIR[kind];
  if (dir === null || d.kind !== kind) throw new TemplateViolation('HostConfig.Mounts');
  const n = names(f.project);
  return {
    name: n.helper(),
    body: {
      Image: f.image,
      User: user(d.uid, d.gid),
      Cmd: ['true'],
      Labels: HELPER_LABELS(f.project),
      HostConfig: {
        NetworkMode: 'none', ...hardening(), AutoRemove: false,
        Mounts: [{ Type: 'volume', Source: which === 'data' ? n.data(kind) : n.cache(kind), Target: dir, ReadOnly: false }],
      },
    },
  };
}

/** the named volumes: base = a read-only local bind volume of the confirmed base folder; data/cache = plain local volumes */
export function volumeSpec(project: string, which: 'base' | 'data' | 'cache', o: { kind?: Kind; path?: string }): { Name: string; Driver: 'local'; DriverOpts: Record<string, string>; Labels: Record<string, string> } {
  const n = names(project);
  const labels = (m: string) => ({ 'friendflix.managed': `mediaserver-${m}`, 'friendflix.project': project });
  if (which === 'base') {
    if (o.path === undefined || !o.path.startsWith('/')) throw new TemplateViolation('DriverOpts');
    return { Name: n.base(o.path), Driver: 'local', DriverOpts: { type: 'none', o: 'bind,ro', device: o.path }, Labels: labels('base') };
  }
  if (o.kind === undefined) throw new TemplateViolation('Name');
  return { Name: which === 'data' ? n.data(o.kind) : n.cache(o.kind), Driver: 'local', DriverOpts: {}, Labels: labels(which) };
}

export type HelperVerb = 'check' | 'browse' | 'gpu' | 'backup' | 'restore';
export type HelperMount =
  | { kind: 'base'; volume: string } | { kind: 'request'; path: string } | { kind: 'dri' } | { kind: 'drm' }
  | { kind: 'data'; volume: string; rw: boolean } | { kind: 'backup'; rw: boolean };
export interface HelperRequest { verb: HelperVerb; args: string[]; uid: number; gid: number; groups: number[]; mounts: HelperMount[] }

function helperMount(m: HelperMount, project: string): Record<string, unknown> {
  switch (m.kind) {
    case 'base': return { Type: 'volume', Source: m.volume, Target: '/base', ReadOnly: true, VolumeOptions: { NoCopy: true } };
    case 'request': return { Type: 'bind', Source: m.path, Target: '/base', ReadOnly: true };
    case 'dri': return { Type: 'bind', Source: '/dev/dri', Target: '/dev/dri', ReadOnly: true };
    case 'drm': return { Type: 'bind', Source: '/sys/class/drm', Target: '/sys-drm', ReadOnly: true };
    case 'data': return { Type: 'volume', Source: m.volume, Target: '/data', ReadOnly: !m.rw, VolumeOptions: { NoCopy: true } };
    case 'backup': return { Type: 'volume', Source: names(project).backup, Target: '/backups', ReadOnly: !m.rw };
  }
}

/** a short-lived helper from the updater's own image running `updater/dist/mediaHelper.js <verb>` (spec "Helper containers") */
export function helperSpec(h: HelperRequest, f: { project: string; image: string }): CreateRequest {
  const groupAdd = groups(h.groups, 8);
  return {
    name: names(f.project).helper(),
    body: {
      Image: f.image,
      User: user(h.uid, h.gid),
      Cmd: ['node', 'updater/dist/mediaHelper.js', h.verb, ...h.args],
      Labels: HELPER_LABELS(f.project),
      HostConfig: {
        NetworkMode: 'none', ...hardening(), AutoRemove: false, Tmpfs: { '/tmp': 'size=64m' },
        ...(groupAdd.length ? { GroupAdd: groupAdd } : {}),
        Mounts: h.mounts.map((m) => helperMount(m, f.project)),
      },
    },
  };
}

/** where each pinned image keeps ffmpeg and ffprobe (Ferrofin links them into /usr/local/bin; Jellyfin's JELLYFIN_FFMPEG) */
export const FFMPEG_DIR: Record<Kind, string> = { ferrofin: '/usr/local/bin', jellyfin: '/usr/lib/jellyfin-ffmpeg' };

const NODE_PLACEHOLDER = '/dev/dri/<node>';
/** mediaserver/probe.sh test 1 (OpenCL on VA-API), the arguments after the ffmpeg path; pass = exit 0 */
export const HDR_TEST1_ARGS: readonly string[] = [
  '-hide_banner', '-init_hw_device', `vaapi=va:${NODE_PLACEHOLDER}`, '-init_hw_device', 'opencl=ocl@va', '-f', 'lavfi', '-i', 'nullsrc', '-frames', '1', '-f', 'null', '-',
];

/** mediaserver/probe.sh's INNER script verbatim (tests 2–4 in one `sh -c`), its FF=/FP= line built for one image */
const inner = (dir: string): string => String.raw`
set -u
FF=${dir}/ffmpeg FP=${dir}/ffprobe DEV=$1
TM="tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390:peak=100:desat=0"
cd /tmp || exit 1
if $FF -hide_banner -loglevel error -init_hw_device "vaapi=va:$DEV,driver=iHD" -filter_hw_device va \
    -f lavfi -i "color=c=black:s=1280x720:r=1:d=1,format=p010le" \
    -vf "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,hwupload,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709" \
    -frames:v 1 -f null - > vpp.log 2>&1; then
  echo "RESULT vpp PASS the VA driver has an HDR tone mapper (VPP tone mapping can work)"
elif grep -qE "support HDR|query HDR caps" vpp.log; then
  echo "RESULT vpp FAIL the VA driver has no HDR tone mapper: use OpenCL tone mapping, not VPP (change 0002)"
else
  echo "RESULT vpp FAIL ffmpeg exit, see below"; tail -n 5 vpp.log
fi
if ! $FF -hide_banner -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=24:duration=2 \
    -vf "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc" \
    -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p10le \
    -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -y hdr10.mkv > clip.log 2>&1; then
  echo "RESULT clip FAIL could not make the HDR10 test clip"; tail -n 5 clip.log; exit 0
fi
check() { # name, log, output file
  info=$($FP -v error -select_streams v:0 -count_packets \
    -show_entries stream=codec_name,pix_fmt,color_transfer,nb_read_packets -of default=nw=1:nk=0 "$3" 2>&1 | tr "\n" " ")
  case "$info" in
    *nb_read_packets=0*|"") echo "RESULT $1 FAIL no frames: $info" ;;
    *color_transfer=smpte2084*) echo "RESULT $1 FAIL still tagged PQ (no tone mapping): $info" ;;
    *) echo "RESULT $1 PASS $info" ;;
  esac
}
if $FF -hide_banner -loglevel error \
    -init_hw_device "vaapi=va:$DEV,driver=iHD" -init_hw_device qsv=qs@va -init_hw_device opencl=ocl@va -filter_hw_device qs \
    -hwaccel qsv -hwaccel_output_format qsv -i hdr10.mkv \
    -vf "scale_qsv=w=1280:h=720:format=p010,hwmap=derive_device=opencl:mode=read,$TM,hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv" \
    -c:v h264_qsv -preset veryfast -an -y sdr-qsv.mp4 > qsv.log 2>&1; then
  check qsv qsv.log sdr-qsv.mp4
else
  echo "RESULT qsv FAIL ffmpeg exit $?"; tail -n 8 qsv.log
fi
if $FF -hide_banner -loglevel error \
    -init_hw_device "vaapi=va:$DEV,driver=iHD" -init_hw_device opencl=ocl@va -filter_hw_device va \
    -hwaccel vaapi -hwaccel_output_format vaapi -i hdr10.mkv \
    -vf "scale_vaapi=w=1280:h=720:format=p010,hwmap=derive_device=opencl:mode=read,$TM,hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi" \
    -c:v h264_vaapi -an -y sdr-vaapi.mp4 > vaapi.log 2>&1; then
  check vaapi vaapi.log sdr-vaapi.mp4
else
  echo "RESULT vaapi FAIL ffmpeg exit $?"; tail -n 8 vaapi.log
fi
`;
/** probe.sh's INNER as in the script (Ferrofin's ffmpeg directory); run as `sh -c HDR_INNER probe /dev/dri/<node>`, pass = a line `RESULT qsv PASS` */
export const HDR_INNER = inner(FFMPEG_DIR.ferrofin);

/** a throw-away run of probe.sh test 1 or 2 in the chosen media server image with the GPU passed in, no network, no mounts */
export function hdrSpec(test: 1 | 2, o: { project: string; kind: Kind; image: string; uid: number; gid: number; renderGids: number[]; node: string }): CreateRequest {
  if (!/^renderD[0-9]{1,4}$/.test(o.node)) throw new TemplateViolation('Cmd');
  const dev = `/dev/dri/${o.node}`;
  const run = test === 1
    ? { Entrypoint: [`${FFMPEG_DIR[o.kind]}/ffmpeg`], Cmd: HDR_TEST1_ARGS.map((a) => a.replace(NODE_PLACEHOLDER, dev)) }
    : { Entrypoint: ['/bin/sh'], Cmd: ['-c', inner(FFMPEG_DIR[o.kind]), 'probe', dev] };
  const groupAdd = groups(o.renderGids, MAX_RENDER_GIDS);
  return {
    name: names(o.project).helper(),
    body: {
      Image: o.image,
      User: user(o.uid, o.gid),
      ...run,
      Labels: HELPER_LABELS(o.project),
      HostConfig: {
        NetworkMode: 'none', ...hardening(), AutoRemove: false, Tmpfs: { '/tmp': 'size=256m' },
        Devices: [{ ...DRI_DEVICE }],
        ...(groupAdd.length ? { GroupAdd: groupAdd } : {}),
      },
    },
  };
}
