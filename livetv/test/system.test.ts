// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FsLike, Run } from '../src/run.js';
import { CACHE_USAGE_TTL_MS, cacheUsage, cpuInfo, encoders, gpuInfo, parseSrtPorts, systemView } from '../src/system.js';

/** a fake file system: directory listings, link targets and file contents by path; anything else is ENOENT */
function fakeFs(o: { dirs?: Record<string, string[]>; links?: Record<string, string>; files?: Record<string, string>; rw?: (p: string) => boolean }): FsLike & { accessed: Array<[string, number]> } {
  const accessed: Array<[string, number]> = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  const fake = {
    accessed,
    readdirSync: (p: string) => { const d = o.dirs?.[p]; if (!d) throw enoent(p); return d; },
    readlinkSync: (p: string) => { const l = o.links?.[p]; if (!l) throw enoent(p); return l; },
    readFileSync: (p: string) => { const f = o.files?.[p]; if (f === undefined) throw enoent(p); return f; },
    accessSync: (p: string, mode: number) => { accessed.push([p, mode]); if (o.rw && !o.rw(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
  };
  return fake as unknown as FsLike & { accessed: Array<[string, number]> };
}

/** the shape of `ffmpeg -hide_banner -encoders` (jellyfin-ffmpeg 7, shortened) */
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V....D hevc_vaapi           H.265/HEVC (VAAPI) (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D h264_nvenc_fake      not a video encoder line
`;

const runOf = (stdout: string, code = 0): Run & { calls: Array<[string, string[]]> } => {
  const calls: Array<[string, string[]]> = [];
  const run: Run = async (cmd, args) => { calls.push([cmd, args]); return { code, stdout: Buffer.from(stdout), stderr: '' }; };
  return Object.assign(run, { calls });
};

describe('parseSrtPorts', () => {
  it('a range, one port, the default', () => {
    expect(parseSrtPorts('9000-9009')).toEqual([9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009]);
    expect(parseSrtPorts('9005')).toEqual([9005]);
    expect(parseSrtPorts(undefined)).toHaveLength(10);
    expect(parseSrtPorts('')).toEqual(parseSrtPorts('9000-9009'));
    expect(parseSrtPorts(' 9000-9099 ')).toHaveLength(100);
  });

  it('refuses more than 100 ports, reversed ranges, port 0 or > 65535 and anything else', () => {
    for (const bad of ['9000-9200', '9000-9100', '9009-9000', '0', '65536', '70000-70001', 'abc', '9000-', '-9000', '9000,9001', '9000 - 9001', '09000']) {
      expect(() => parseSrtPorts(bad), bad).toThrow(/LIVETV_SRT_PORTS/);
    }
    expect(parseSrtPorts('65535')).toEqual([65535]);
    expect(parseSrtPorts('1')).toEqual([1]);
  });
});

describe('gpuInfo', () => {
  it('Intel (i915): the render node, its driver, readable, no busy percentage', () => {
    const fs = fakeFs({ dirs: { '/dev/dri': ['card0', 'renderD128', 'by-path'] }, links: { '/sys/class/drm/renderD128/device/driver': '../../../bus/pci/drivers/i915' } });
    expect(gpuInfo(fs)).toEqual({ devices: ['/dev/dri/renderD128'], driver: 'i915', readable: true, busyPct: null });
    expect(fs.accessed).toEqual([['/dev/dri/renderD128', constants.R_OK | constants.W_OK]]);
  });

  it('AMD (amdgpu): gpu_busy_percent is reported', () => {
    const fs = fakeFs({
      dirs: { '/dev/dri': ['renderD129', 'renderD128', 'card1'] },
      links: { '/sys/class/drm/renderD128/device/driver': '../../../../bus/pci/drivers/amdgpu' },
      files: { '/sys/class/drm/renderD128/device/gpu_busy_percent': '37\n' },
    });
    expect(gpuInfo(fs)).toEqual({ devices: ['/dev/dri/renderD128', '/dev/dri/renderD129'], driver: 'amdgpu', readable: true, busyPct: 37 });
  });

  it('AMD with an unreadable or odd busy file: null', () => {
    const base = { dirs: { '/dev/dri': ['renderD128'] }, links: { '/sys/class/drm/renderD128/device/driver': 'drivers/amdgpu' } };
    expect(gpuInfo(fakeFs(base)).busyPct).toBeNull();
    expect(gpuInfo(fakeFs({ ...base, files: { '/sys/class/drm/renderD128/device/gpu_busy_percent': 'n/a' } })).busyPct).toBeNull();
    expect(gpuInfo(fakeFs({ ...base, files: { '/sys/class/drm/renderD128/device/gpu_busy_percent': '140' } })).busyPct).toBeNull();
  });

  it('a render node without read and write access: readable false (RENDER_GID not set)', () => {
    const fs = fakeFs({ dirs: { '/dev/dri': ['renderD128'] }, links: { '/sys/class/drm/renderD128/device/driver': 'i915' }, rw: () => false });
    expect(gpuInfo(fs)).toEqual({ devices: ['/dev/dri/renderD128'], driver: 'i915', readable: false, busyPct: null });
  });

  it('two render nodes: driver, readable and busy percentage all describe the first one livetv may open', () => {
    const fs = fakeFs({
      dirs: { '/dev/dri': ['renderD129', 'renderD128'] },
      links: { '/sys/class/drm/renderD128/device/driver': 'drivers/i915', '/sys/class/drm/renderD129/device/driver': 'drivers/amdgpu' },
      files: { '/sys/class/drm/renderD129/device/gpu_busy_percent': '12' },
      rw: (p) => p === '/dev/dri/renderD129',
    });
    expect(gpuInfo(fs)).toEqual({ devices: ['/dev/dri/renderD128', '/dev/dri/renderD129'], driver: 'amdgpu', readable: true, busyPct: 12 });
    // none usable: the first node in numeric order speaks
    const none = fakeFs({ dirs: { '/dev/dri': ['renderD130', 'renderD129'] }, links: { '/sys/class/drm/renderD129/device/driver': 'drivers/i915', '/sys/class/drm/renderD130/device/driver': 'drivers/amdgpu' }, rw: () => false });
    expect(gpuInfo(none)).toEqual({ devices: ['/dev/dri/renderD129', '/dev/dri/renderD130'], driver: 'i915', readable: false, busyPct: null });
  });

  it('NVIDIA without /dev/dri: driver nvidia from /proc', () => {
    const fs = fakeFs({ files: { '/proc/driver/nvidia/version': 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54\n' } });
    expect(gpuInfo(fs)).toEqual({ devices: [], driver: 'nvidia', readable: false, busyPct: null });
  });

  it('no GPU at all', () => {
    expect(gpuInfo(fakeFs({}))).toEqual({ devices: [], driver: null, readable: false, busyPct: null });
    expect(gpuInfo(fakeFs({ dirs: { '/dev/dri': ['card0'] } }))).toEqual({ devices: [], driver: null, readable: false, busyPct: null });
  });
});

describe('encoders', () => {
  it('parses the encoder list once into the known H.264 encoders, in a fixed order', async () => {
    const run = runOf(ENCODERS);
    expect(await encoders(run)).toEqual(['h264_qsv', 'h264_vaapi', 'libx264']);
    expect(run.calls).toEqual([['ffmpeg', ['-hide_banner', '-encoders']]]);
  });

  it('a failing ffmpeg gives an empty list', async () => {
    expect(await encoders(runOf('', 1))).toEqual([]);
    expect(await encoders((async () => { throw new Error('spawn'); }) as Run)).toEqual([]);
  });
});

describe('cpuInfo', () => {
  it('model, cores and the 1-minute load as a percentage of the cores (0-100)', () => {
    const os = (load: number) => ({ cpus: () => [{ model: ' Fictional CPU 9000 ' }, { model: 'x' }, { model: 'x' }, { model: 'x' }], availableParallelism: () => 4, loadavg: () => [load, 0, 0] });
    expect(cpuInfo(os(1))).toEqual({ model: 'Fictional CPU 9000', cores: 4, loadPct: 25 });
    expect(cpuInfo(os(9)).loadPct).toBe(100);
    expect(cpuInfo({ cpus: () => [], availableParallelism: () => 1, loadavg: () => [0.333, 0, 0] })).toEqual({ model: 'unknown', cores: 1, loadPct: 33 });
  });

  it('the real host answers plausible values', () => {
    const c = cpuInfo();
    expect(c.cores).toBeGreaterThan(0);
    expect(c.loadPct).toBeGreaterThanOrEqual(0);
    expect(c.loadPct).toBeLessThanOrEqual(100);
  });
});

describe('cacheUsage and systemView', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-livetv-cache-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('sums the files below the cache directory; a missing one is empty', async () => {
    mkdirSync(join(dir, 'abc'), { recursive: true });
    writeFileSync(join(dir, 'abc', '1.ts'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'top.bin'), Buffer.alloc(24));
    expect(await cacheUsage(dir)).toBe(1024);
    expect(await cacheUsage(join(dir, 'missing'))).toBe(0);
  });

  it('the /v1/system answer: spec shape + srt ports, recordings null; encoders are asked once per process', async () => {
    const run = runOf(ENCODERS);
    const fs = fakeFs({ dirs: { '/dev/dri': ['renderD128'] }, links: { '/sys/class/drm/renderD128/device/driver': 'i915' } });
    const view = systemView({ fs, run, cacheDir: dir, cacheMaxBytes: 6 * 1024 ** 3, srtPorts: [9000, 9001] });
    const a = await view();
    expect(a).toMatchObject({
      gpu: { devices: ['/dev/dri/renderD128'], driver: 'i915', readable: true, busyPct: null },
      encoders: ['h264_qsv', 'h264_vaapi', 'libx264'],
      cache: { usedBytes: 1024, maxBytes: 6 * 1024 ** 3 },
      recordings: null,
      srt: { ports: [9000, 9001] },
    });
    expect(Object.keys(a).sort()).toEqual(['cache', 'cpu', 'encoders', 'gpu', 'recordings', 'srt']);
    expect(Object.keys(a.cpu).sort()).toEqual(['cores', 'loadPct', 'model']);
    await view();
    expect(run.calls).toHaveLength(1);
  });

  it('the cache size is measured at most every 30 s', async () => {
    let t = 1_000_000;
    const sub = mkdtempSync(join(dir, 'memo-'));
    writeFileSync(join(sub, 'a.ts'), Buffer.alloc(100));
    const view = systemView({ fs: fakeFs({}), run: runOf(ENCODERS), cacheDir: sub, cacheMaxBytes: 1, srtPorts: [9000], now: () => t });
    expect((await view()).cache.usedBytes).toBe(100);
    writeFileSync(join(sub, 'b.ts'), Buffer.alloc(50));
    t += CACHE_USAGE_TTL_MS - 1;
    expect((await view()).cache.usedBytes).toBe(100);
    t += 1;
    expect((await view()).cache.usedBytes).toBe(150);
    expect(CACHE_USAGE_TTL_MS).toBe(30_000);
  });

  it('a failed encoder probe is asked again next time', async () => {
    let n = 0;
    const run = (async () => { n++; return { code: n === 1 ? 1 : 0, stdout: Buffer.from(ENCODERS), stderr: '' }; }) as Run;
    const view = systemView({ fs: fakeFs({}), run, cacheDir: dir, cacheMaxBytes: 1, srtPorts: [9000] });
    expect((await view()).encoders).toEqual([]);
    expect((await view()).encoders).toEqual(['h264_qsv', 'h264_vaapi', 'libx264']);
    expect((await view()).encoders).toHaveLength(3);
    expect(n).toBe(2);
  });
});
