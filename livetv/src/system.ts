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
export interface GpuInfo { devices: string[]; driver: string | null; readable: boolean; busyPct: number | null }
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

/**
 * GPU facts for the setup check (spec §4.4): the render nodes in /dev/dri, the kernel driver of the first one (sysfs link) or
 * `nvidia` when the NVIDIA driver is visible, whether livetv may open a node (read + write: the render group, RENDER_GID), and
 * the AMD busy percentage (amdgpu only; Intel and NVIDIA expose none there).
 */
export function gpuInfo(fs: FsLike): GpuInfo {
  const nodes = tryOr(() => fs.readdir('/dev/dri'), [] as string[])
    .filter((n) => /^renderD[0-9]{1,4}$/.test(n))
    .sort((x, y) => Number(x.slice(7)) - Number(y.slice(7)));
  const devices = nodes.map((n) => `/dev/dri/${n}`);
  const sys = nodes[0] ? `/sys/class/drm/${nodes[0]}/device` : null;
  let driver = sys ? tryOr(() => basename(fs.readlink(`${sys}/driver`)) || null, null) : null;
  if (!driver && tryOr(() => fs.readFile('/proc/driver/nvidia/version').length > 0, false)) driver = 'nvidia';
  const readable = devices.some((d) => fs.canAccess(d, constants.R_OK | constants.W_OK));
  let busyPct: number | null = null;
  if (sys && driver === 'amdgpu') {
    const raw = tryOr(() => fs.readFile(`${sys}/gpu_busy_percent`).trim(), '');
    busyPct = /^[0-9]{1,3}$/.test(raw) && Number(raw) <= 100 ? Number(raw) : null;
  }
  return { devices, driver, readable, busyPct };
}

const ENCODER_LINE = /^\s*V[A-Z.]{5}\s+([A-Za-z0-9_]+)\s/;

/** The usable H.264 encoders from `ffmpeg -hide_banner -encoders` (compiled in; whether the hardware works shows in the benchmark). */
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

export interface SystemDeps { fs: FsLike; run: Run; cacheDir: string; cacheMaxBytes: number; srtPorts: number[] }

/** `GET /v1/system`; the encoder list is asked once per process (a failed probe is asked again next time). */
export function systemView(d: SystemDeps): () => Promise<SystemView> {
  let enc: Encoder[] | null = null;
  return async () => {
    if (!enc) {
      const list = await encoders(d.run);
      if (list.length) enc = list;
    }
    return {
      cpu: cpuInfo(),
      gpu: gpuInfo(d.fs),
      encoders: enc ?? [],
      cache: { usedBytes: await cacheUsage(d.cacheDir), maxBytes: d.cacheMaxBytes },
      recordings: null,
      srt: { ports: d.srtPorts },
    };
  };
}
