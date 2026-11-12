// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { markConvExempt } from './convexempt.js';
import type { Ctx } from './ctx.js';
import type { UserRow } from './types.js';

/**
 * The timed clip conversion shared by the HEVC probe (hevcenc.ts) and the conversion benchmark (convbench.ts). Leaf module: it imports
 * none of convbudget.ts, hevcenc.ts or convbench.ts, so they never form an import cycle. The caller owns the claim, the busy check and
 * the preview pause; this only converts, times and stops. No URL, path, title or play session leaves it: only a code or a speed.
 */

const TITLE_SCAN = 20;
const FETCH_TIMEOUT_MS = 30_000;
/** 1080p at 6 Mbit/s: what the conversions the budget admits look like */
const CLIP_VIDEO_BITRATE = 6_000_000;
const CLIP_AUDIO_BITRATE = 128_000;
const CLIP_MAX_WIDTH = 1920;
const CLIP_MAX_HEIGHT = 1080;
const CLIP_INFO_BITRATE = 8_000_000;

export type TimedClip = { ok: true; speed: number } | { ok: false; reason: 'http' | 'not_hevc' | 'no_title' };

const resolveUri = (base: string, uri: string) => { const u = new URL(uri, new URL(base, 'http://jf.invalid')); return u.pathname + u.search; };
const lines = (p: string) => p.split(/\r?\n/).map((l) => l.trim());
class HttpFail extends Error {}

/** The first of the first 20 library titles that is SDR and 720-1080p (a series by its first episode); the conversions the gates allow look like this. */
async function pickTitle(ctx: Ctx, user: UserRow): Promise<string | null> {
  const traits = ctx.jf.mediaTraits?.bind(ctx.jf);
  if (!traits) return null;
  const page = (await ctx.jf.items(user, { types: 'Movie,Series', limit: TITLE_SCAN, start: 0 })).items;
  for (const it of page) {
    let id = it.id;
    if (it.type === 'Series') {
      const ep = await ctx.jf.firstEpisode(user, it.id);
      if (!ep) continue;
      id = ep.id;
    }
    const t = await traits(user, id).catch(() => null);
    if (t && t.resolution === 'hd' && t.hdr === null && t.sdr === true) return id; // an unknown range is not SDR
  }
  return null;
}

/**
 * Converts the first SDR 720-1080p library title at 1080p / 6 Mbit/s (fMP4, `segmentSeconds` segments) in `videoCodec`: master,
 * variant, init (checked by `checkInit` when given; without an init that check fails as not_hevc), then the first `segments` segments
 * in order; speed = media seconds / wall seconds, two decimals. The play session is marked exempt from the budget as soon as it exists
 * and its conversion is always stopped. Any fetch or media server failure is `http`.
 */
export async function timedClip(
  ctx: Ctx, user: UserRow,
  o: { videoCodec: 'h264' | 'hevc'; segments: number; segmentSeconds: number; checkInit?: (init: Buffer) => boolean; now?: () => number },
): Promise<TimedClip> {
  const now = o.now ?? Date.now;
  let playSessionId: string | undefined;
  try {
    const videoId = await pickTitle(ctx, user);
    if (!videoId) return { ok: false, reason: 'no_title' };
    const info = await ctx.jf.playbackInfo(user, videoId, { maxBitrate: CLIP_INFO_BITRATE });
    const clip = await ctx.jf.clipTranscode(user, info, {
      videoCodec: o.videoCodec, fmp4: true, videoBitrate: CLIP_VIDEO_BITRATE, audioBitrate: CLIP_AUDIO_BITRATE, maxWidth: CLIP_MAX_WIDTH, maxHeight: CLIP_MAX_HEIGHT, segmentLength: o.segmentSeconds,
    });
    playSessionId = clip.playSessionId;
    await markConvExempt(ctx, playSessionId); // never throws; a measurement is not a conversion of the budget (ruling 8)
    const get = async (path: string): Promise<Response> => {
      const res = await ctx.jf.mediaFetch(user, path, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new HttpFail();
      return res;
    };
    const master = lines(await (await get(clip.path)).text()).find((l) => l && !l.startsWith('#'));
    if (!master) throw new HttpFail();
    const variantPath = resolveUri(clip.path, master);
    const variant = lines(await (await get(variantPath)).text());
    const mapUri = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(variant.find((l) => l.startsWith('#EXT-X-MAP')) ?? '')?.[1];
    if (o.checkInit && !mapUri) return { ok: false, reason: 'not_hevc' };
    if (mapUri) {
      const init = Buffer.from(await (await get(resolveUri(variantPath, mapUri))).arrayBuffer());
      if (o.checkInit && !o.checkInit(init)) return { ok: false, reason: 'not_hevc' };
    }
    const segs: Array<{ uri: string; dur: number }> = [];
    variant.forEach((l, i) => {
      if (!l || l.startsWith('#')) return;
      const dur = Number(/^#EXTINF:([\d.]+)/.exec(variant[i - 1] ?? '')?.[1]);
      segs.push({ uri: l, dur: Number.isFinite(dur) && dur > 0 ? dur : o.segmentSeconds });
    });
    const run = segs.slice(0, o.segments);
    if (!run.length) throw new HttpFail();
    const t0 = now();
    for (const s of run) {
      const body = Buffer.from(await (await get(resolveUri(variantPath, s.uri))).arrayBuffer());
      if (!body.length) throw new HttpFail();
    }
    const seconds = Math.max((now() - t0) / 1000, 0.001);
    return { ok: true, speed: Math.round((run.reduce((a, s) => a + s.dur, 0) / seconds) * 100) / 100 };
  } catch {
    return { ok: false, reason: 'http' };
  } finally {
    if (playSessionId) await ctx.jf.stopEncoding(user, playSessionId).catch(() => undefined);
  }
}
