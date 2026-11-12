// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { basename, join } from 'node:path';
import type { FsLike, Run } from './run.js';

/** The H.264 encoders livetv can use (spec §3.2, §5.4), in the order `GET /v1/system` lists them. */
export const ENCODERS = ['h264_qsv', 'h264_vaapi', 'h264_nvenc', 'libx264'] as const;
export type Encoder = (typeof ENCODERS)[number];

export interface CpuInfo { model: string; cores: number; loadPct: number }
export interface GpuInfo { devices: string[]; driver: string | null; readable: boolean; busyPct: number | null; nvidia: boolean }
/** `GET /v1/system` (spec §3.2) + `srt.ports`; recordings arrive with Phase 3 */
export interface SystemView {
  cpu: CpuInfo;
  gpu: GpuInfo;
  encoders: Encoder[];
  cache: { usedBytes: number; maxBytes: number };
  recordings: { usedBytes: number; freeBytes: number } | null;
  srt: { ports: number[] };
}

export const DEFAULT_SRT_PORTS = '9000-9009';
const MAX_SRT_PORTS = 100;
const PORTS_RE = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/;

/** LIVETV_SRT_PORTS: `A-B` or one port, 1-100 ports in 1-65535; unset/empty = 9000-9009. Anything else throws (at start). */
export function parseSrtPorts(raw: string | undefined): number[] {
  const v = raw?.trim() || DEFAULT_SRT_PORTS;
  const m = PORTS_RE.exec(v);
  const a = m ? Number(m[1]) : NaN;
  const b = m?.[2] ? Number(m[2]) : a;
  if (!m || a > 65535 || b > 65535 || b < a || b - a + 1 > MAX_SRT_PORTS) {
    throw new Error(`LIVETV_SRT_PORTS must be a port or a range A-B of 1-${MAX_SRT_PORTS} ports (default ${DEFAULT_SRT_PORTS})`);
  }
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export interface OsLike { cpus(): Array<{ model: string }>; availableParallelism(): number; loadavg(): number[] }

/** CPU model, usable cores and the 1-minute load average as a share of them (0-100) */
export function cpuInfo(os: OsLike = nodeOs): CpuInfo {
  const cores = Math.max(1, os.availableParallelism());
  const model = os.cpus()[0]?.model.trim() || 'unknown';
  const loadPct = Math.min(100, Math.max(0, Math.round((os.loadavg()[0]! / cores) * 100)));
  return { model, cores, loadPct };
}

const tryOr = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

/** the device node only the NVIDIA container runtime puts into a container (compose.livetv-nvidia.yaml); the host's /proc is no sign */
export const NVIDIA_CTL = '/dev/nvidiactl';

/**
 * GPU facts for the setup check (spec §4.4), from the device nodes the container really has (1b review I5: `ffmpeg -encoders`
 * lists what is compiled in, and jellyfin-ffmpeg always has nvenc, qsv and vaapi): the render nodes in /dev/dri (numeric order)
 * and the facts of ONE chosen node: the first one livetv may open for reading and writing (the render group, RENDER_GID), else
 * the first one. Its kernel driver (sysfs link), else `nvidia` when /dev/nvidiactl is there; whether it is readable; its AMD busy
 * percentage (amdgpu only; Intel and NVIDIA expose none there); `nvidia`: /dev/nvidiactl is there (the NVIDIA overlay is on).
 */
export function gpuInfo(fs: FsLike): GpuInfo {
  const nodes = tryOr(() => fs.readdirSync('/dev/dri'), [] as string[])
    .filter((n) => /^renderD[0-9]{1,4}$/.test(n))
    .sort((x, y) => Number(x.slice(7)) - Number(y.slice(7)));
  const devices = nodes.map((n) => `/dev/dri/${n}`);
  const rw = (n: string) => tryOr(() => { fs.accessSync(`/dev/dri/${n}`, constants.R_OK | constants.W_OK); return true; }, false);
  const usable = nodes.find(rw);
  const chosen = usable ?? nodes[0];
  const sys = chosen ? `/sys/class/drm/${chosen}/device` : null;
  const nvidia = tryOr(() => { fs.accessSync(NVIDIA_CTL, constants.F_OK); return true; }, false);
  let driver = sys ? tryOr(() => basename(fs.readlinkSync(`${sys}/driver`)) || null, null) : null;
  if (!driver && nvidia) driver = 'nvidia';
  let busyPct: number | null = null;
  if (sys && driver === 'amdgpu') {
    const raw = tryOr(() => fs.readFileSync(`${sys}/gpu_busy_percent`, 'utf8').trim(), '');
    busyPct = /^[0-9]{1,3}$/.test(raw) && Number(raw) <= 100 ? Number(raw) : null;
  }
  return { devices, driver, readable: usable !== undefined, busyPct, nvidia };
}

const ENCODER_LINE = /^\s*V[A-Z.]{5}\s+([A-Za-z0-9_]+)\s/;

/**
 * The H.264 encoders compiled into ffmpeg (`ffmpeg -hide_banner -encoders`): what livetv could use, never a sign that the hardware is
 * there (jellyfin-ffmpeg lists nvenc, qsv and vaapi everywhere). Whether a GPU is usable is gpuInfo's device check; whether it works
 * shows in the benchmark.
 */
export async function encoders(run: Run): Promise<Encoder[]> {
  const r = await run('ffmpeg', ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  const listed = new Set<string>();
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const m = ENCODER_LINE.exec(line);
    if (m) listed.add(m[1]!);
  }
  return ENCODERS.filter((e) => listed.has(e));
}

/** Bytes of every file below `dir` (the DVR cache); a missing directory is empty. */
export async function cacheUsage(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    total += await lstat(join(e.parentPath, e.name)).then((s) => s.size, () => 0);
  }
  return total;
}

/** how long a measured cache size is reused (the walk lstats every DVR segment) */
export const CACHE_USAGE_TTL_MS = 30_000;

export interface SystemDeps { fs: FsLike; run: Run; cacheDir: string; cacheMaxBytes: number; srtPorts: number[]; now?: () => number }

/**
 * `GET /v1/system`. The encoder list is asked once per process (a failed probe is asked again next time); the cache size is
 * measured at most every 30 s.
 */
export function systemView(d: SystemDeps): () => Promise<SystemView> {
  const now = d.now ?? Date.now;
  let enc: Encoder[] | null = null;
  let used: { at: number; bytes: number } | null = null;
  return async () => {
    if (!enc) {
      const list = await encoders(d.run);
      if (list.length) enc = list;
    }
    if (!used || now() - used.at >= CACHE_USAGE_TTL_MS) used = { at: now(), bytes: await cacheUsage(d.cacheDir) };
    return {
      cpu: cpuInfo(),
      gpu: gpuInfo(d.fs),
      encoders: enc ?? [],
      cache: { usedBytes: used.bytes, maxBytes: d.cacheMaxBytes },
      recordings: null,
      srt: { ports: d.srtPorts },
    };
  };
}
