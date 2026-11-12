// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Spec §4.4: advice, never a blocker. The page words it (adminLive.gpu.<key>); `driver` fills the "both" line. */
export type GpuAdvice = { level: 'warn' | 'info' | 'ok'; key: 'needsOverlay' | 'needsRenderGid' | 'needsNvidia' | 'cpuOnly' | 'both'; driver?: string };

/**
 * Compares the media server's hardware acceleration with the devices livetv really has (1b review I5: never its compiled-in encoder
 * list, which names nvenc, qsv and vaapi on every host), rows in the order of the spec table: the media server uses the GPU (qsv /
 * vaapi) and livetv has no /dev/dri render node; a node livetv may not read; nvenc without /dev/nvidiactl (the NVIDIA overlay);
 * no GPU at all; otherwise both use it.
 */
export function gpuAdvice(jfHwAccel: string | null, sys: { gpu: { devices: string[]; readable: boolean; driver: string | null; nvidia: boolean } }): GpuAdvice {
  const hw = jfHwAccel?.toLowerCase() ?? null;
  const dri = hw === 'qsv' || hw === 'vaapi';
  if (dri && sys.gpu.devices.length === 0) return { level: 'warn', key: 'needsOverlay' };
  // a device the container may not read matters wherever the media server wants a GPU (not for none, and nvenc does not use /dev/dri)
  if (hw !== null && hw !== 'none' && hw !== 'nvenc' && sys.gpu.devices.length > 0 && !sys.gpu.readable) return { level: 'warn', key: 'needsRenderGid' };
  if (hw === 'nvenc' && !sys.gpu.nvidia) return { level: 'warn', key: 'needsNvidia' };
  if (hw === null || hw === 'none') return { level: 'info', key: 'cpuOnly' };
  // a GPU type livetv has no overlay for (amf, v4l2m2m, rkmpp, videotoolbox ...): with no device at all it runs on the processor,
  // which is what the info row says; claiming "both use the GPU" would be wrong
  if (!dri && hw !== 'nvenc' && sys.gpu.devices.length === 0 && !sys.gpu.nvidia) return { level: 'info', key: 'cpuOnly' };
  // the line names the GPU both use: for nvenc that is NVIDIA, even when livetv also has an Intel / AMD render node (whose driver,
  // e.g. i915, is what gpu.driver reports then)
  const driver = hw === 'nvenc' ? 'nvidia' : sys.gpu.driver;
  return { level: 'ok', key: 'both', ...(driver ? { driver } : {}) };
}
