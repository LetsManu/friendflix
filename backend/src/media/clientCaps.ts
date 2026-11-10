// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/**
 * Device capability block the Android, Windows, Samsung TV (Tizen), LG TV (webOS) or Fire TV app (or a browser that probed itself, `web`) sends with POST /api/playback/info (`caps`). Everything in it is a claim by the client: it can only
 * widen what the device may direct-play or narrow it further; role caps (height, bitrate, download rights), kids rules and max_streams always
 * win. The lists REPLACE the server's browser defaults, so the app must send complete lists, including mp4 / h264 / aac if it plays them. Unknown values are dropped, oversized lists make the whole block invalid (null), and an invalid block behaves exactly like no block.
 */
export interface ClientVideoCap {
  codec: string; maxHeight?: number; profiles?: string[];
  /** sample-entry tags the device plays (e.g. Safari: hvc1 but not hev1); absent = any */
  tags?: string[];
}
/** dynamic ranges the device shows correctly; absent = not stated (no range condition, as before) */
export type CapRange = 'sdr' | 'hdr10' | 'hlg' | 'hdr10plus' | 'dovi';
export interface ClientCaps {
  /** `web`: a browser that probed itself (web/src/lib/player/devicecaps.ts) */
  client: 'android' | 'windows' | 'tizen' | 'webos' | 'firetv' | 'web';
  /** strict x.y.z */
  appVersion: string;
  containers: string[];
  video: ClientVideoCap[];
  audio: string[];
  subtitles: string[];
  ranges?: CapRange[];
}

export const MAX_CAP_ENTRIES = 16;
const MAX_HEIGHT = 8640;
export const CAP_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video']);
export const CAP_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3', 'dts', 'truehd', 'alac']);
export const CAP_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'ts']);
export const CAP_SUBTITLES: ReadonlySet<string> = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt']);
export const CAP_TAGS: ReadonlySet<string> = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp09']);
export const CAP_RANGES: ReadonlySet<string> = new Set<CapRange>(['sdr', 'hdr10', 'hlg', 'hdr10plus', 'dovi']);
const PROFILE = /^[a-z0-9][a-z0-9 ._-]{0,31}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const list = z.array(z.unknown()).max(MAX_CAP_ENTRIES);

/** lowercased, de-duplicated members of `raw` that are on the allowlist (non-strings and unknown values are dropped) */
function allowed(raw: unknown[], allow: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (allow.has(s)) out.add(s);
  }
  return [...out];
}

const videoEntry = z.object({ codec: z.unknown(), maxHeight: z.unknown().optional(), profiles: z.unknown().optional(), tags: z.unknown().optional() });

const shape = z.object({
  client: z.enum(['android', 'windows', 'tizen', 'webos', 'firetv', 'web']),
  appVersion: z.string().max(32).regex(SEMVER),
  containers: list, video: list, audio: list, subtitles: list,
  ranges: list.optional(),
});

/** Validates the capability block; null when absent, not an app block, malformed or oversized, or when nothing valid is left in it. */
export function parseClientCaps(body: unknown): ClientCaps | null {
  const r = shape.safeParse(body);
  if (!r.success) return null;
  const video: ClientVideoCap[] = [];
  for (const raw of r.data.video) {
    const e = videoEntry.safeParse(raw);
    if (!e.success) continue;
    const codec = typeof e.data.codec === 'string' ? e.data.codec.trim().toLowerCase() : '';
    if (!CAP_VIDEO_CODECS.has(codec) || video.some((v) => v.codec === codec)) continue;
    const h = e.data.maxHeight;
    const profiles = Array.isArray(e.data.profiles)
      ? [...new Set(e.data.profiles.slice(0, MAX_CAP_ENTRIES).map((p) => (typeof p === 'string' ? p.trim().toLowerCase() : '')).filter((p) => PROFILE.test(p)))]
      : [];
    // a tag list that is present but has nothing valid left would read as "any tag": the codec is dropped instead (never widen a claim)
    const tags = Array.isArray(e.data.tags) ? allowed(e.data.tags.slice(0, MAX_CAP_ENTRIES), CAP_TAGS) : null;
    if (tags && !tags.length) continue;
    video.push({
      codec,
      ...(typeof h === 'number' && Number.isInteger(h) && h >= 1 && h <= MAX_HEIGHT ? { maxHeight: h } : {}),
      ...(profiles.length ? { profiles } : {}),
      ...(tags ? { tags } : {}),
    });
  }
  // ranges: present = the device states them; SDR is always playable (a block without it would refuse every SDR file)
  const ranges = r.data.ranges ? [...new Set<CapRange>(['sdr', ...(allowed(r.data.ranges, CAP_RANGES) as CapRange[])])] : null;
  const caps: ClientCaps = {
    client: r.data.client, appVersion: r.data.appVersion,
    containers: allowed(r.data.containers, CAP_CONTAINERS), video, audio: allowed(r.data.audio, CAP_AUDIO_CODECS), subtitles: allowed(r.data.subtitles, CAP_SUBTITLES),
    ...(ranges ? { ranges } : {}),
  };
  return caps.containers.length || caps.video.length || caps.audio.length ? caps : null;
}

/** true when the profile string names a 10-bit video profile (HEVC "main 10", H.264 "high 10", …) */
export const isTenBitProfile = (p: string) => /(^|[^0-9])10([^0-9]|$)/.test(p);
