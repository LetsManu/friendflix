// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { livetvSystem } from './detect.js';
import type { Encoder } from './wire.js';

/**
 * Which H.264 encoder livetv uses for a transcode and for its benchmark (spec §5.4, setting LIVETV_ENCODER). `auto` = the media server's
 * hardware acceleration when livetv can use that device, else VA-API when /dev/dri is usable, else NVENC when present, else software
 * (`libx264`). An explicit choice livetv cannot use falls back to `libx264`, never to another GPU.
 */
export type EncoderSetting = 'auto' | 'qsv' | 'vaapi' | 'nvenc' | 'software';

const BY_SETTING: Record<'qsv' | 'vaapi' | 'nvenc', Encoder> = { qsv: 'h264_qsv', vaapi: 'h264_vaapi', nvenc: 'h264_nvenc' };
/** the encoders that need a readable /dev/dri render node in the livetv container */
const DRI: readonly Encoder[] = ['h264_qsv', 'h264_vaapi'];

export function resolveEncoder(setting: EncoderSetting, jfHwAccel: string | null, sys: { encoders: Encoder[]; gpu: { readable: boolean } }): Encoder {
  const usable = (e: Encoder) => sys.encoders.includes(e) && (!DRI.includes(e) || sys.gpu.readable);
  if (setting === 'software') return 'libx264';
  if (setting !== 'auto') return usable(BY_SETTING[setting]) ? BY_SETTING[setting] : 'libx264';
  const hw = jfHwAccel?.toLowerCase() ?? '';
  const jf = hw === 'qsv' || hw === 'vaapi' || hw === 'nvenc' ? BY_SETTING[hw] : null;
  if (jf && usable(jf)) return jf;
  if (usable('h264_vaapi')) return 'h264_vaapi';
  if (usable('h264_nvenc')) return 'h264_nvenc';
  return 'libx264';
}

const HW_MEMO_MS = 60_000;
const HW_WAIT_MS = 800;
const hwMemo = new WeakMap<object, { at: number; p: Promise<string | null> }>();

/**
 * The media server's hardware acceleration, read at most once a minute (a failed or late read is null: the rule then goes on with what
 * livetv itself has). A start waits at most 800 ms for it.
 */
async function mediaHwAccel(ctx: Ctx): Promise<string | null> {
  const read = ctx.jf.admin.encoderSettings?.bind(ctx.jf.admin);
  if (!read) return null;
  let hit = hwMemo.get(ctx.jf);
  if (!hit || Date.now() - hit.at >= HW_MEMO_MS) {
    hit = { at: Date.now(), p: read().then((s) => s?.hwAccel ?? null, () => null) };
    hwMemo.set(ctx.jf, hit);
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), HW_WAIT_MS); timer.unref?.(); });
  try { return await Promise.race([hit.p, late]); } finally { clearTimeout(timer); }
}

/**
 * The encoder for the next stream start or livetv benchmark: LIVETV_ENCODER against what livetv reports (`GET /v1/system`, cached 10 s).
 * `jfHwAccel` when the caller already read it (the benchmark); a livetv that does not answer its system view gets `libx264`.
 */
export async function liveEncoder(ctx: Ctx, jfHwAccel?: string | null): Promise<Encoder> {
  const [sys, hw] = await Promise.all([livetvSystem(ctx), jfHwAccel !== undefined ? Promise.resolve(jfHwAccel) : mediaHwAccel(ctx)]);
  return resolveEncoder(ctx.cfg.LIVETV_ENCODER, hw, sys ?? { encoders: [], gpu: { readable: false } });
}
