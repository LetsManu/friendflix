// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The capability block the LG (webOS) TV app sends with POST /api/playback/info: only what the TV itself confirms via
 * canPlayType / MediaSource.isTypeSupported ('maybe' and 'probably' both count), so the server direct-plays those formats.
 * Shape and allowlists: backend/src/media/clientCaps.ts. DTS and TrueHD are never claimed (the web player cannot decode them).
 */
import { APP_VERSION } from '#lib/version/codenames';
import { isLgApp } from './detect';

export interface MediaProbe { canPlayType(t: string): string; isTypeSupported?: (t: string) => boolean }

export interface ClientCapsBody {
  client: 'webos';
  appVersion: string;
  containers: string[];
  video: Array<{ codec: string; maxHeight?: number; profiles?: string[] }>;
  audio: string[];
  subtitles: string[];
}

interface Variant { profile: string; mime: string }
export const CANDIDATES = {
  video: {
    h264: [
      { profile: 'main', mime: 'video/mp4; codecs="avc1.4D4033"' },
      { profile: 'high', mime: 'video/mp4; codecs="avc1.640033"' },
      { profile: 'high 10', mime: 'video/mp4; codecs="avc1.6E0033"' },
    ],
    hevc: [
      { profile: 'main', mime: 'video/mp4; codecs="hvc1.1.6.L153.B0"' },
      { profile: 'main 10', mime: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
    ],
    av1: [
      { profile: 'main', mime: 'video/mp4; codecs="av01.0.12M.08"' },
      { profile: 'main 10', mime: 'video/mp4; codecs="av01.0.12M.10"' },
    ],
    vp9: [{ profile: 'profile 0', mime: 'video/webm; codecs="vp09.00.51.08"' }],
    mpeg2video: [{ profile: 'main', mime: 'video/mpeg' }],
  } as Record<string, Variant[]>,
  audio: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    opus: 'audio/webm; codecs="opus"',
    vorbis: 'audio/webm; codecs="vorbis"',
  } as Record<string, string>,
  containers: {
    mkv: 'video/x-matroska',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    ts: 'video/mp2t',
    webm: 'video/webm',
  } as Record<string, string>,
  subtitles: ['srt', 'ass', 'ssa', 'vtt'],
} as const;

/** true when the TV confirms this MIME type; a throwing probe counts as "no" */
function confirms(m: MediaProbe, mime: string): boolean {
  try { if (m.canPlayType(mime)) return true; } catch { /* unsupported string */ }
  try { return m.isTypeSupported?.(mime) === true; } catch { return false; }
}

/** the video codec profiles, audio codecs and containers the TV confirms (reused by the probe page) */
export function confirmedTypes(m: MediaProbe | null): { video: string[]; audio: string[]; containers: string[] } {
  if (!m) return { video: [], audio: [], containers: [] };
  const ok = (mime: string) => confirms(m, mime);
  return {
    video: Object.entries(CANDIDATES.video).flatMap(([codec, vs]) => vs.filter((v) => ok(v.mime)).map((v) => `${codec}:${v.profile}`)),
    audio: Object.entries(CANDIDATES.audio).filter(([, mime]) => ok(mime)).map(([k]) => k),
    containers: Object.entries(CANDIDATES.containers).filter(([, mime]) => ok(mime)).map(([k]) => k),
  };
}

export function buildLgCaps(m: MediaProbe | null, appVersion: string): ClientCapsBody | null {
  const t = confirmedTypes(m);
  const video: ClientCapsBody['video'] = [];
  for (const codec of Object.keys(CANDIDATES.video)) {
    const profiles = t.video.filter((s) => s.startsWith(`${codec}:`)).map((s) => s.slice(codec.length + 1));
    if (profiles.length) video.push({ codec, maxHeight: 2160, profiles });
  }
  if (!video.length && !t.audio.length && !t.containers.length) return null;
  return { client: 'webos', appVersion, containers: t.containers, video, audio: t.audio, subtitles: [...CANDIDATES.subtitles] };
}

let cached: ClientCapsBody | null | undefined;

/** the block for this page load (probed once); null outside the LG app or when the TV confirms nothing */
export function lgCaps(): ClientCapsBody | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined' || !isLgApp()) return null;
  let probe: MediaProbe | null = null;
  try {
    const v = document.createElement('video');
    const ms = (window as unknown as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource;
    probe = { canPlayType: (t) => v.canPlayType(t), isTypeSupported: ms?.isTypeSupported ? (t) => ms.isTypeSupported!(t) : undefined };
  } catch { /* no media element */ }
  cached = buildLgCaps(probe, APP_VERSION);
  return cached;
}

/** tests only */
export function _resetLgCaps(): void { cached = undefined; }
