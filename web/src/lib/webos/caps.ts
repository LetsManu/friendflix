// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The capability block the TV apps (LG webOS, Fire TV) send with POST /api/playback/info: only what the TV itself confirms via
 * canPlayType / MediaSource.isTypeSupported ('maybe' and 'probably' both count), so the server direct-plays those formats.
 * Shape and allowlists: backend/src/media/clientCaps.ts. DTS and TrueHD are never claimed (the web player cannot decode them).
 */
import { APP_VERSION } from '#lib/version/codenames';
import { fireTvDisplayHeight, isFireTvApp } from '#lib/firetv/detect';
import { deviceCaps, withOutput } from '#lib/player/devicecaps';
import { isLgApp } from './detect';

export interface MediaProbe { canPlayType(t: string): string; isTypeSupported?: (t: string) => boolean }

export interface ClientCapsBody {
  /** webos / firetv: this module; web / tizen: a probing browser or the Samsung TV app (lib/player/devicecaps.ts) */
  client: 'webos' | 'firetv' | 'web' | 'tizen';
  appVersion: string;
  containers: string[];
  video: Array<{ codec: string; maxHeight?: number; profiles?: string[]; tags?: string[] }>;
  audio: string[];
  subtitles: string[];
  /** dynamic ranges the device shows (only the probing browsers state them) */
  ranges?: Array<'sdr' | 'hdr10' | 'hlg' | 'hdr10plus' | 'dovi'>;
  /** what the device plays INSIDE an HLS stream (hls.js on MSE; Samsung / probing browsers): stricter than the direct-play lists; absent = H.264 + stereo AAC as before */
  hls?: { video: Array<'h264' | 'hevc'>; audio: Array<'aac' | 'mp3' | 'ac3' | 'eac3'>; surround: Array<'eac3' | 'ac3' | 'aac'> };
  /** output channels right now (an integer 1 to 16; absent counts as 2) */
  audioChannels?: number;
}

interface Variant { profile: string; mime: string }
export const CANDIDATES = {
  video: {
    h264: [
      { profile: 'constrained baseline', mime: 'video/mp4; codecs="avc1.42E01E"' },
      { profile: 'baseline', mime: 'video/mp4; codecs="avc1.42001E"' },
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
  } satisfies Record<string, Variant[]>,
  audio: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    opus: 'audio/webm; codecs="opus"',
    vorbis: 'audio/webm; codecs="vorbis"',
  } satisfies Record<string, string>,
  containers: {
    mkv: 'video/x-matroska',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    ts: 'video/mp2t',
    webm: 'video/webm',
  } satisfies Record<string, string>,
  subtitles: ['srt', 'ass', 'ssa', 'vtt'],
};

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

/**
 * Containers LG's player plays from a URL although the browser engine answers "" when asked (owner's probe on an
 * LG 43QNED82A6B, webOS 25: containers=mp4,m4v,ts,webm, so every MKV was transcoded). Added once anything else is
 * confirmed; a file that still fails is caught by the 10 s first-frame fallback (lib/player/firstframe.ts).
 */
export const ASSUMED_CONTAINERS: readonly string[] = ['mkv'];

/**
 * What the TV plays INSIDE an HLS stream (hls.js on MSE): counted only on `isTypeSupported === true` (canPlayType 'maybe' is enough for the
 * direct-play lists, not for hls.js). HEVC needs the hvc1 type and the file claim; surround is Dolby only (EAC3 / AC3 confirmed by MSE;
 * AAC 5.1 is never claimed: nothing here proves it). Undefined without `isTypeSupported` or when MSE confirms neither video nor audio.
 */
export function hlsClaim(m: MediaProbe | null, hevcFiles: boolean): NonNullable<ClientCapsBody['hls']> | undefined {
  const f = m?.isTypeSupported;
  if (typeof f !== 'function') return undefined;
  const mse = (mime: string) => { try { return f.call(m, mime) === true; } catch { return false; } };
  const video: NonNullable<ClientCapsBody['hls']>['video'] = [];
  if (mse(CANDIDATES.video.h264[3].mime)) video.push('h264');
  if (hevcFiles && mse(CANDIDATES.video.hevc[0].mime)) video.push('hevc');
  const audio: NonNullable<ClientCapsBody['hls']>['audio'] = [];
  if (mse(CANDIDATES.audio.aac)) audio.push('aac');
  for (const k of ['ac3', 'eac3'] as const) if (mse(CANDIDATES.audio[k])) audio.push(k);
  if (!video.length && !audio.length) return undefined;
  return { video, audio, surround: (['eac3', 'ac3'] as const).filter((k) => audio.includes(k)) };
}

/**
 * The block for one TV app: every confirmed video profile is capped at `maxHeight` (LG: 2160; Fire TV: its display), and the
 * `assumed` containers are added once anything else is confirmed (LG: mkv; Fire TV: none, its WebView plays only what it confirms).
 */
export function buildTvCaps(m: MediaProbe | null, o: { client: 'webos' | 'firetv'; appVersion: string; maxHeight: number; assumed: readonly string[] }): ClientCapsBody | null {
  const confirmed = confirmedTypes(m);
  const t = { ...confirmed, containers: confirmed.containers.length ? [...new Set([...o.assumed, ...confirmed.containers])] : [] };
  const video: ClientCapsBody['video'] = [];
  for (const codec of Object.keys(CANDIDATES.video)) {
    const profiles = t.video.filter((s) => s.startsWith(`${codec}:`)).map((s) => s.slice(codec.length + 1));
    if (profiles.length) video.push({ codec, maxHeight: o.maxHeight, profiles });
  }
  if (!video.length && !t.audio.length && !t.containers.length) return null;
  const hls = hlsClaim(m, video.some((v) => v.codec === 'hevc'));
  return {
    client: o.client, appVersion: o.appVersion, containers: t.containers, video, audio: t.audio, subtitles: [...CANDIDATES.subtitles],
    ...(hls ? { hls, ...(hls.surround.length ? { audioChannels: 6 } : {}) } : {}),
  };
}

export function buildLgCaps(m: MediaProbe | null, appVersion: string): ClientCapsBody | null {
  return buildTvCaps(m, { client: 'webos', appVersion, maxHeight: 2160, assumed: ASSUMED_CONTAINERS });
}

let cached: ClientCapsBody | null | undefined;
/** the probe-time block of the TV apps; the output facts are applied on top at every call (not cached) */

/**
 * the block for this page load: LG app, Fire TV app (probed once here); every other browser and the Samsung TV app probe themselves
 * (lib/player/devicecaps.ts: strict claims, cached per device, safe profile after a failure); null without a media element
 */
export function appCaps(): ClientCapsBody | null {
  if (cached !== undefined) return cached && withOutput(cached);
  if (typeof window === 'undefined') return null;
  const lg = isLgApp();
  if (!lg && !isFireTvApp()) return deviceCaps();
  let probe: MediaProbe | null = null;
  try {
    const v = document.createElement('video');
    const ms = (window as unknown as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource;
    probe = { canPlayType: (t) => v.canPlayType(t), isTypeSupported: ms?.isTypeSupported ? (t) => ms.isTypeSupported!(t) : undefined };
  } catch { /* no media element */ }
  cached = lg
    ? buildLgCaps(probe, APP_VERSION)
    : buildTvCaps(probe, { client: 'firetv', appVersion: APP_VERSION, maxHeight: fireTvDisplayHeight(), assumed: [] });
  return cached && withOutput(cached);
}

/** tests only */
export function _resetAppCaps(): void { cached = undefined; }
