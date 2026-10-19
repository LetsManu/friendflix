// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/**
 * Device capability block the Android app sends with POST /api/playback/info (`caps`). Everything in it is a claim by the client: it can only
 * widen what the device may direct-play or narrow it further; role caps (height, bitrate, download rights), kids rules and max_streams always
 * win. Unknown values are dropped, oversized lists make the whole block invalid (null), and an invalid block behaves exactly like no block.
 */
export interface ClientVideoCap { codec: string; maxHeight?: number; profiles?: string[] }
export interface ClientCaps {
  client: 'android';
  /** strict x.y.z */
  appVersion: string;
  containers: string[];
  video: ClientVideoCap[];
  audio: string[];
  subtitles: string[];
}

export const MAX_CAP_ENTRIES = 16;
const MAX_HEIGHT = 8640;
export const CAP_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video']);
export const CAP_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3', 'dts', 'truehd', 'alac']);
export const CAP_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'ts']);
export const CAP_SUBTITLES: ReadonlySet<string> = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt']);
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

const videoEntry = z.object({ codec: z.unknown(), maxHeight: z.unknown().optional(), profiles: z.unknown().optional() });

const shape = z.object({
  client: z.literal('android'),
  appVersion: z.string().regex(SEMVER),
  containers: list, video: list, audio: list, subtitles: list,
});

/** Validates the capability block; null when absent, not an Android block, malformed or oversized, or when nothing valid is left in it. */
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
    video.push({
      codec,
      ...(typeof h === 'number' && Number.isInteger(h) && h >= 1 && h <= MAX_HEIGHT ? { maxHeight: h } : {}),
      ...(profiles.length ? { profiles } : {}),
    });
  }
  const caps: ClientCaps = {
    client: 'android', appVersion: r.data.appVersion,
    containers: allowed(r.data.containers, CAP_CONTAINERS), video, audio: allowed(r.data.audio, CAP_AUDIO_CODECS), subtitles: allowed(r.data.subtitles, CAP_SUBTITLES),
  };
  return caps.containers.length || caps.video.length || caps.audio.length ? caps : null;
}

/** true when the profile string names a 10-bit video profile (HEVC "main 10", H.264 "high 10", …) */
export const isTenBitProfile = (p: string) => /(^|[^0-9])10([^0-9]|$)/.test(p);
