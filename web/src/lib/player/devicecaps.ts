// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What THIS browser or Samsung TV (Tizen app) can direct-play, probed instead of assumed: the same capability block the Android and
 * Windows apps send with POST /api/playback/info (shape and allowlists: backend/src/media/clientCaps.ts). Before, browsers got a fixed
 * list (never HEVC, AV1 and VP9 claimed unchecked) and Tizen none, so many files were converted that the device plays itself.
 *
 * Conservative on purpose (a wrong claim is a black screen, worse than a conversion):
 * - a MIME type with a `codecs=` parameter counts only on canPlayType 'probably', or 'maybe' plus MediaSource.isTypeSupported;
 * - HEVC, AV1 and VP9 also need navigator.mediaCapabilities.decodingInfo to say `supported` where that API exists, and their height
 *   cap follows it (2160 when a 4K decode passes, else 1080); until the asynchronous probe has answered they are not claimed at all;
 * - HDR10 / HLG / HDR10+ only with an HDR display AND a passing 10-bit decode probe for that transfer; Dolby Vision never;
 * - what plays INSIDE an HLS stream (`hls`: hls.js on MSE) is stricter still: MSE isTypeSupported plus the `media-source` decode probe
 *   (HEVC at 1080p; eac3 / ac3 / aac with 6 channels). Surround and HEVC streams are never claimed before a positive answer;
 * - the number of output channels is measured (AudioContext destination), the device's "Surround sound" switch and the sound modes force
 *   stereo, and a failed HEVC / surround stream is remembered (`ff_devcaps_avoid`, 30 days or until the user agent changes);
 * - after a claimed format failed to start (player: a decode error, or metadata but no picture in time; then one retry as HLS), the
 *   device sends no block for 7 days or until its user agent changes: the server's fixed browser list of before applies.
 * The result is cached per device (localStorage, keyed by user agent and probe version, 7 days). No probing (no media element): null,
 * and the server keeps its fixed browser list as before.
 */
import { APP_VERSION } from '#lib/version/codenames';
import { isTizenApp } from '#lib/tizen/detect';
import { isLgApp } from '#lib/webos/detect';
import { isFireTvApp } from '#lib/firetv/detect';
import { getActiveProfile } from '#lib/api';
import { fxActive, loadFx } from '#lib/player/audiofx';
import type { ClientCapsBody } from '#lib/webos/caps';

export interface DecodeQuery {
  /** 'file' = direct play of a file; 'media-source' = what an MSE player (hls.js) can append */
  type: 'file' | 'media-source';
  video?: { contentType: string; width: number; height: number; bitrate: number; framerate: number; transferFunction?: string; colorGamut?: string; hdrMetadataType?: string };
  audio?: { contentType: string; channels: string; bitrate: number; samplerate: number };
}
export interface ProbeEnv {
  canPlayType(t: string): string;
  isTypeSupported?: (t: string) => boolean;
  /** MSE as hls.js uses it (`MediaSource`, or `ManagedMediaSource` on iPhone): the hls claim only; the direct-play claims keep isTypeSupported */
  hlsTypeSupported?: (t: string) => boolean;
  decodingInfo?: (q: DecodeQuery) => Promise<{ supported: boolean }>;
  /** the screen shows high dynamic range (`(dynamic-range: high)`) */
  hdrDisplay: boolean;
}
export type ProbeClient = 'web' | 'tizen';
type Out = ClientCapsBody;

/** bump when the claims change: cached results of an older probe are thrown away */
export const PROBE_VERSION = 2;
export const CACHE_KEY = 'ff_devcaps';
export const SAFE_KEY = 'ff_devcaps_safe';
export const CACHE_MS = 7 * 86_400_000;
export const SAFE_MS = 7 * 86_400_000;
/** a failed HEVC / surround stream: `{ ua, hevc?: at, surround?: at }` */
export const AVOID_KEY = 'ff_devcaps_avoid';
export const AVOID_MS = 30 * 86_400_000;
/** the device's "Surround sound" switch (player menu): '1' = stereo only */
export const STEREO_KEY = 'ff_audio_stereo';
/** what hls.js is asked to append: the H.264 level every browser plays, to see whether MSE works at all */
const MSE_H264 = 'video/mp4; codecs="avc1.640028"';

export const MIME = {
  h264: [
    { profile: 'constrained baseline', mime: 'video/mp4; codecs="avc1.42E01E"' },
    { profile: 'baseline', mime: 'video/mp4; codecs="avc1.42001E"' },
    { profile: 'main', mime: 'video/mp4; codecs="avc1.4D4033"' },
    { profile: 'high', mime: 'video/mp4; codecs="avc1.640033"' },
    { profile: 'high 10', mime: 'video/mp4; codecs="avc1.6E0033"' },
  ],
  hevcMain: 'video/mp4; codecs="hvc1.1.6.L153.B0"',
  hevcMain10: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  hevcHev1: 'video/mp4; codecs="hev1.1.6.L153.B0"',
  av1: 'video/mp4; codecs="av01.0.12M.08"',
  av1Ten: 'video/mp4; codecs="av01.0.12M.10"',
  vp9: 'video/webm; codecs="vp09.00.51.08"',
  audio: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mpeg',
    opus: 'audio/webm; codecs="opus"',
    flac: 'audio/flac',
    vorbis: 'audio/webm; codecs="vorbis"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
  },
  containers: { mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ts: 'video/mp2t' },
  /**
   * browsers: Matroska and QuickTime count only on 'probably' for a codec-qualified type (a bare 'maybe' is what Chromium says for
   * x-matroska whatever it can demux); MPEG-TS is never claimed (only MSE plays it, not a <video src>)
   */
  strictContainers: { mkv: 'video/x-matroska; codecs="avc1.640028"', mov: 'video/quicktime; codecs="avc1.640028"' },
} as const;
const SUBTITLES = ['srt', 'ass', 'ssa', 'vtt'];
/** surround codecs: they also need the decode probe (6 channels) where the API exists */
const SURROUND = new Set(['ac3', 'eac3']);

/** true when the device confirms this MIME type (see the module comment); a throwing probe is "no" */
export function confirmsType(env: Pick<ProbeEnv, 'canPlayType' | 'isTypeSupported'>, mime: string): boolean {
  let answer: string;
  try { answer = env.canPlayType(mime) ?? ''; } catch { answer = ''; }
  if (!/codecs=/i.test(mime)) return answer !== '';
  if (answer === 'probably') return true;
  if (answer !== 'maybe') return false;
  try { return env.isTypeSupported?.(mime) === true; } catch { return false; }
}

// ---- decode probes (navigator.mediaCapabilities): every query the claims below look at, keyed so a result map can answer them ----
const SIZES = { 2160: [3840, 2160, 20_000_000], 1080: [1920, 1080, 8_000_000] } as const;
type Hdr = 'pq' | 'hlg' | 'pq+';
const vKey = (mime: string, h: 2160 | 1080) => `${mime}@${h}`;
const hdrKey = (mime: string, k: Hdr) => `${mime}@hdr:${k}`;
const aKey = (mime: string) => `${mime}@6ch`;
/** media-source queries (MSE): HEVC at 1080p, and a 6-channel audio decode per surround codec */
const msKey = (mime: string, h?: 1080) => `${mime}@ms${h ?? '6ch'}`;
const SURROUND_HLS = ['eac3', 'ac3', 'aac'] as const;

/** all queries of one probe run: key -> query */
export function decodeQueries(): Map<string, DecodeQuery> {
  const q = new Map<string, DecodeQuery>();
  const video = (contentType: string, h: 2160 | 1080, extra: Partial<NonNullable<DecodeQuery['video']>> = {}): DecodeQuery => {
    const [width, height, bitrate] = SIZES[h];
    return { type: 'file', video: { contentType, width, height, bitrate, framerate: 30, ...extra } };
  };
  q.set(vKey(MIME.h264[4]!.mime, 1080), video(MIME.h264[4]!.mime, 1080)); // High 10: only the profile, at HD
  for (const mime of [MIME.h264[3]!.mime, MIME.hevcMain, MIME.hevcMain10, MIME.av1, MIME.av1Ten, MIME.vp9]) {
    q.set(vKey(mime, 2160), video(mime, 2160));
    q.set(vKey(mime, 1080), video(mime, 1080));
  }
  for (const mime of [MIME.hevcMain10, MIME.av1Ten]) {
    q.set(hdrKey(mime, 'pq'), video(mime, 1080, { transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086' }));
    q.set(hdrKey(mime, 'hlg'), video(mime, 1080, { transferFunction: 'hlg', colorGamut: 'rec2020' }));
    q.set(hdrKey(mime, 'pq+'), video(mime, 1080, { transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2094-40' }));
  }
  for (const k of SURROUND) {
    const mime = MIME.audio[k as 'ac3' | 'eac3'];
    q.set(aKey(mime), { type: 'file', audio: { contentType: mime, channels: '6', bitrate: 640_000, samplerate: 48_000 } });
  }
  q.set(msKey(MIME.hevcMain, 1080), { type: 'media-source', video: { contentType: MIME.hevcMain, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 } });
  for (const k of SURROUND_HLS) {
    const mime = MIME.audio[k];
    q.set(msKey(mime), { type: 'media-source', audio: { contentType: mime, channels: '6', bitrate: k === 'aac' ? 384_000 : 640_000, samplerate: 48_000 } });
  }
  return q;
}

/** runs every decode query (in parallel); a rejected or throwing query is "not supported" */
export async function runDecodeQueries(env: ProbeEnv): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const dec = env.decodingInfo;
  if (!dec) return out;
  await Promise.all([...decodeQueries()].map(async ([k, q]) => {
    try { out.set(k, (await dec(q))?.supported === true); } catch { out.set(k, false); }
  }));
  return out;
}

/**
 * The claims for one device. `decoded`: the decode-probe answers, or null while they are pending. Without the decodingInfo API
 * (older engines) canPlayType alone decides and nothing gets a height cap; with the API, nothing that needs it is claimed before it answered.
 */
export function buildDeviceCaps(env: ProbeEnv, o: { client: ProbeClient; appVersion: string }, decoded: Map<string, boolean> | null): Out | null {
  const api = typeof env.decodingInfo === 'function';
  const ok = (mime: string) => confirmsType(env, mime);
  /** the decode probe agrees (no API: nothing to ask, canPlayType decided; API pending: no) */
  const dec = (key: string) => (!api ? true : decoded ? decoded.get(key) === true : false);
  /** 2160 / 1080 by decode probe; undefined without the API; 0 = neither size decodes (or still pending) */
  const height = (mime: string): number | undefined => (!api ? undefined : dec(vKey(mime, 2160)) ? 2160 : dec(vKey(mime, 1080)) ? 1080 : 0);

  const video: Out['video'] = [];
  // High 10 is rare in hardware decoders: it also needs the decode probe where the API exists
  const h264 = MIME.h264.filter((v) => ok(v.mime) && (v.profile !== 'high 10' || dec(vKey(v.mime, 1080)))).map((v) => v.profile);
  if (h264.length) {
    const h = height(MIME.h264[3]!.mime);
    // H.264 never needs the decode probe to be claimed (every engine decodes it); the probe only adds the height cap once it answered
    video.push({ codec: 'h264', ...(h ? { maxHeight: h } : decoded && api ? { maxHeight: 1080 } : {}), profiles: h264 });
  }
  const hevcH = height(MIME.hevcMain);
  if (ok(MIME.hevcMain) && hevcH !== 0) {
    const profiles = ['main', ...(ok(MIME.hevcMain10) && height(MIME.hevcMain10) !== 0 ? ['main 10'] : [])];
    video.push({ codec: 'hevc', ...(hevcH ? { maxHeight: hevcH } : {}), profiles, tags: ['hvc1', ...(ok(MIME.hevcHev1) ? ['hev1'] : [])] });
  }
  // AV1: Jellyfin names 8 and 10 bit both "Main", so the profile cannot tell them apart: claimed only when both decode
  const av1H = height(MIME.av1);
  if (ok(MIME.av1) && ok(MIME.av1Ten) && av1H !== 0 && height(MIME.av1Ten) !== 0) video.push({ codec: 'av1', ...(av1H ? { maxHeight: av1H } : {}), profiles: ['main'] });
  const vp9H = height(MIME.vp9);
  if (ok(MIME.vp9) && vp9H !== 0) video.push({ codec: 'vp9', ...(vp9H ? { maxHeight: vp9H } : {}), profiles: ['profile 0'] });

  const audio = Object.entries(MIME.audio).filter(([k, mime]) => ok(mime) && (!SURROUND.has(k) || dec(aKey(mime)))).map(([k]) => k);
  const strict = o.client === 'web';
  const probably = (mime: string) => { try { return env.canPlayType(mime) === 'probably'; } catch { return false; } };
  const containers = Object.entries(MIME.containers).filter(([k, mime]) => {
    if (!strict) return ok(mime);
    if (k === 'ts') return false;
    if (k === 'mkv' || k === 'mov') return probably(MIME.strictContainers[k]);
    return ok(mime);
  }).map(([k]) => k);
  if (!video.length && !audio.length && !containers.length) return null;

  // ranges: SDR always; HDR only with an HDR screen, the decode API and a passing 10-bit probe for that transfer on a claimed codec
  const tenBit = [
    ...(video.some((v) => v.codec === 'hevc' && v.profiles?.includes('main 10')) ? [MIME.hevcMain10] : []),
    ...(video.some((v) => v.codec === 'av1') ? [MIME.av1Ten] : []),
  ];
  const hdr = (k: Hdr) => env.hdrDisplay && api && decoded !== null && tenBit.some((m) => dec(hdrKey(m, k)));
  const ranges: NonNullable<Out['ranges']> = ['sdr', ...(hdr('pq') ? ['hdr10' as const] : []), ...(hdr('hlg') ? ['hlg' as const] : []), ...(hdr('pq+') ? ['hdr10plus' as const] : [])];

  // what plays inside an HLS stream (hls.js): only with MSE; hevc also needs the file claim and (with the API) the media-source decode,
  // surround needs the media-source 6-channel decode per codec (no API, no pending answer: no surround)
  let hls: Out['hls'];
  const hlsMse = env.hlsTypeSupported ?? env.isTypeSupported;
  if (typeof hlsMse === 'function') {
    const mse = (m: string) => { try { return hlsMse(m) === true; } catch { return false; } };
    const hv: NonNullable<Out['hls']>['video'] = [];
    if (mse(MSE_H264)) hv.push('h264');
    if (video.some((v) => v.codec === 'hevc') && mse(MIME.hevcMain) && (!api || dec(msKey(MIME.hevcMain, 1080)))) hv.push('hevc');
    const ha: NonNullable<Out['hls']>['audio'] = [];
    if (mse(MIME.audio.aac)) ha.push('aac');
    for (const k of ['ac3', 'eac3'] as const) if (audio.includes(k) && mse(MIME.audio[k])) ha.push(k);
    const surround = SURROUND_HLS.filter((k) => ha.includes(k) && api && dec(msKey(MIME.audio[k])));
    if (hv.length || ha.length) hls = { video: hv, audio: ha, surround };
  }

  return { client: o.client, appVersion: o.appVersion, containers, video, audio, subtitles: [...SUBTITLES], ranges, ...(hls ? { hls } : {}) };
}


// ---- this device: probe once, cache, remember a failure ----

/** `hdr`: the screen's HDR state at probe time (a switch to an SDR screen or HDR off must not keep the HDR claims) */
interface Cached { v: number; ua: string; at: number; hdr?: boolean; caps: Out | null }
export interface DeviceDeps { env: ProbeEnv | null;
  /** the output's channel count (default: AudioContext destination.maxChannelCount) */
  channels?: () => number;
  /** where `devicechange` is heard (default navigator.mediaDevices) */
  mediaDevices?: { addEventListener(type: string, fn: () => void): void } | null;
  /** a sound mode ("Clear voices" / "Night mode") is on for the active profile (default: the player's stored preference) */
  soundMode?: () => boolean; ua: string; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null; now: () => number; tizen: boolean;
  /** the LG webOS or Fire TV app: it sends its own caps (webos/caps.ts appCaps), so nothing is probed and nothing waits for a probe */
  ownCaps?: boolean }

function realDeps(): DeviceDeps {
  const w = typeof window === 'undefined' ? null : window;
  let storage: DeviceDeps['storage'];
  try { storage = w?.localStorage ?? null; } catch { storage = null; }
  let env: ProbeEnv | null = null;
  try {
    if (w && typeof document !== 'undefined') {
      const v = document.createElement('video');
      const ms = (w as unknown as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource;
      const hlsMs = ms?.isTypeSupported ? ms : (w as unknown as { ManagedMediaSource?: { isTypeSupported?: (t: string) => boolean } }).ManagedMediaSource;
      const mc = (navigator as Navigator & { mediaCapabilities?: { decodingInfo?: (q: unknown) => Promise<{ supported: boolean }> } }).mediaCapabilities;
      let hdrDisplay: boolean;
      try { hdrDisplay = w.matchMedia?.('(dynamic-range: high)').matches === true; } catch { hdrDisplay = false; }
      env = {
        canPlayType: (t) => v.canPlayType(t),
        isTypeSupported: ms?.isTypeSupported ? (t) => ms.isTypeSupported!(t) : undefined,
        hlsTypeSupported: hlsMs?.isTypeSupported ? (t) => hlsMs.isTypeSupported!(t) : undefined,
        decodingInfo: mc?.decodingInfo ? (q) => mc.decodingInfo!(q) : undefined,
        hdrDisplay,
      };
    }
  } catch { env = null; }
  let tizen: boolean;
  try { tizen = w ? isTizenApp() : false; } catch { tizen = false; }
  let ownCaps: boolean;
  try { ownCaps = w ? isLgApp() || isFireTvApp() : false; } catch { ownCaps = false; }
  return { env, ua: w?.navigator?.userAgent ?? '', storage, now: () => Date.now(), tizen, ownCaps };
}

let deps: DeviceDeps | null = null;
const d = () => (deps ??= realDeps());
let probed: Out | null | undefined; // the async probe's result for this page load
let syncResult: Out | null | undefined;
let running: Promise<void> | null = null;

const opts = () => ({ client: (d().tizen ? 'tizen' : 'web') as ProbeClient, appVersion: APP_VERSION });

function read<T>(key: string): T | null {
  try { const raw = d().storage?.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function write(key: string, v: unknown): void {
  try { d().storage?.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: probe again next time */ }
}

/** a claimed format failed on this device recently (same user agent, within 7 days) */
export function inSafeMode(): boolean {
  const s = read<{ ua: string; at: number }>(SAFE_KEY);
  return Boolean(s && s.ua === d().ua && d().now() - s.at < SAFE_MS && s.at <= d().now());
}

function cached(): Out | null | undefined {
  const c = read<Cached>(CACHE_KEY);
  if (!c || c.v !== PROBE_VERSION || c.ua !== d().ua || d().now() - c.at >= CACHE_MS || c.at > d().now() || c.hdr !== d().env?.hdrDisplay) return undefined;
  return c.caps ? { ...c.caps, client: opts().client, appVersion: APP_VERSION } : null;
}

/** starts the asynchronous probe once per page load (cheap to call again); its result is cached for the device */
export function warmDeviceCaps(): Promise<void> {
  const env = d().env;
  if (!env || d().ownCaps || probed !== undefined) return Promise.resolve();
  if (cached() !== undefined) { probed = cached(); return Promise.resolve(); }
  running ??= runDecodeQueries(env).then((res) => {
    probed = buildDeviceCaps(env, opts(), res);
    write(CACHE_KEY, { v: PROBE_VERSION, ua: d().ua, at: d().now(), hdr: env.hdrDisplay, caps: probed } satisfies Cached);
  }, () => { probed = buildDeviceCaps(env, opts(), new Map()); }).finally(() => { running = null; });
  return running;
}

/** the probed (or cached, or conservative synchronous) block before the output facts are applied; null in safe mode and without probing */
function baseCaps(): Out | null {
  const env = d().env;
  if (!env) return null;
  // after a failure: no block, so the server uses its fixed browser list of before this probe (never narrower than that); the player's
  // watchdog is off then, so nothing re-arms the period
  if (inSafeMode()) return null;
  if (probed !== undefined) return probed;
  const c = cached();
  if (c !== undefined) { probed = c; return c; }
  void warmDeviceCaps();
  if (syncResult === undefined) syncResult = buildDeviceCaps(env, opts(), env.decodingInfo ? null : new Map());
  return syncResult;
}

// ---- the output: channels, the stereo choice, sound modes, the avoid memory ----
let channels: number | undefined;
let listening = false;
/** S2: the avoid memory of this page load, for when storage is blocked */
let memAvoid: { ua: string; hevc?: number; surround?: number } | null = null;
/** the destination's channel count of a short-lived AudioContext (2 without one; a throwing constructor throws, the caller counts it as 2) */
export function measureChannelsWith(AC: (new () => AudioContext) | undefined): number {
  if (!AC) return 2;
  const ctx = new AC();
  try { return ctx.destination.maxChannelCount; } finally { try { void ctx.close?.()?.catch?.(() => undefined); } catch { /* already closed */ } }
}
const measureChannels = (): number => {
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return measureChannelsWith(w.AudioContext ?? w.webkitAudioContext);
};
/** forget the measured count: the next read measures again (the player calls this at every start; `devicechange` is not reliable without media permissions) */
export function remeasureOutput(): void { channels = undefined; }
/** how many channels the output can play (2 when unknown or when measuring throws); measured once per page and again after a `devicechange` */
export function outputChannels(): number {
  if (channels !== undefined) return channels;
  let n: number;
  try { n = d().channels ? d().channels!() : measureChannels(); } catch { n = 2; }
  channels = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  const md = d().mediaDevices !== undefined ? d().mediaDevices : !d().channels && typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (md?.addEventListener && (!listening || d().mediaDevices)) {
    listening = true;
    try { md.addEventListener('devicechange', () => { channels = undefined; }); } catch { listening = false; }
  }
  return channels;
}
/** the device's "Surround sound" switch is off (stereo only) */
export const stereoOnly = (): boolean => { try { return d().storage?.getItem(STEREO_KEY) === '1'; } catch { return false; } };
export function setStereoOnly(on: boolean): void {
  try { if (on) d().storage?.setItem(STEREO_KEY, '1'); else d().storage?.removeItem(STEREO_KEY); } catch { /* storage blocked: not remembered */ }
}
function soundModeOn(): boolean {
  try { return d().soundMode ? d().soundMode!() : fxActive(loadFx(getActiveProfile())); } catch { return false; }
}

type AvoidRec = { ua: string; hevc?: number; surround?: number };
/** until when each feature is left out on this device (ms timestamps); a different user agent or an old entry counts as nothing */
export function avoidedUntil(): { hevc?: number; surround?: number } {
  const stored = read<AvoidRec>(AVOID_KEY);
  const mem = memAvoid && memAvoid.ua === d().ua ? memAvoid : null;
  // the stored record and this page's own copy: the later failure of each feature counts
  const a: AvoidRec | null = stored && stored.ua === d().ua ? { ua: stored.ua, ...(mem ? { hevc: Math.max(stored.hevc ?? 0, mem.hevc ?? 0) || undefined, surround: Math.max(stored.surround ?? 0, mem.surround ?? 0) || undefined } : stored) } : mem;
  const out: { hevc?: number; surround?: number } = {};
  if (!a || a.ua !== d().ua) return out;
  for (const k of ['hevc', 'surround'] as const) {
    const at = a[k];
    if (typeof at === 'number' && at <= d().now() && d().now() - at < AVOID_MS) out[k] = at + AVOID_MS;
  }
  return out;
}
/** an HEVC and / or surround stream did not start on this device: for 30 days (or until the user agent changes) it is not asked for again */
export function noteHlsFailure(what: 'hevc' | 'surround' | 'both'): void {
  const prev = read<AvoidRec>(AVOID_KEY);
  const keep = prev && prev.ua === d().ua ? prev : { ua: d().ua };
  const at = d().now();
  const next = { ...keep, ...(what !== 'surround' ? { hevc: at } : {}), ...(what !== 'hevc' ? { surround: at } : {}) } satisfies AvoidRec;
  memAvoid = { ...(memAvoid && memAvoid.ua === d().ua ? memAvoid : { ua: d().ua }), ...(what !== 'surround' ? { hevc: at } : {}), ...(what !== 'hevc' ? { surround: at } : {}) };
  write(AVOID_KEY, next);
}

/** the channel count the device states before the stereo choice and the sound modes apply (TV apps: 6 when its Dolby probe passed) */
function statedChannels(c: Out): number {
  if (c.client !== 'web') return (c.hls?.surround.length ?? 0) > 0 ? 6 : 2;
  const n = outputChannels();
  return n >= 6 ? Math.min(16, n) : 2;
}

/**
 * The block for the next request (synchronous: the request body is built in one place, lib/player/infobody.ts): none after
 * a failure, else the probed (or cached) result, else the conservative synchronous claims while the probe still runs; null without probing.
 * The output facts are applied here, not cached: `audioChannels` (stereo while the "Surround sound" switch is off or a sound mode is on,
 * then also no surround codec) and the avoid memory (no hevc stream / no surround after a failed one).
 */
export function deviceCaps(): Out | null {
  const c = baseCaps();
  return c ? withOutput(c) : null;
}

/** the output facts on top of a probed block (shared with the LG / Fire TV apps, whose block is built in lib/webos/caps.ts) */
export function withOutput(c: Out): Out {
  const av = avoidedUntil();
  const stereo = stereoOnly() || soundModeOn();
  let hls = c.hls;
  if (hls) hls = { ...hls, video: av.hevc ? hls.video.filter((v) => v !== 'hevc') : hls.video, surround: stereo || av.surround ? [] : hls.surround };
  const { audioChannels: _a, ...rest } = c;
  // a TV block without an hls claim (no MSE answer) states nothing about channels, like today
  if (!hls && c.client !== 'web' && c.client !== 'tizen' && c.audioChannels === undefined) return rest;
  return { ...rest, ...(hls ? { hls } : {}), audioChannels: stereo ? 2 : statedChannels(hls ? { ...c, hls } : c) };
}

/** what Diagnose shows (Task 4; `base`: the TV app's own probe-time block, see tvBaseCaps): the device's abilities before the stereo choice and the avoid memory, then those two */
export function capsSummary(base?: Out | null): { hevcFiles: boolean; hevcStreams: boolean; surround: string[]; channels: number; stereoChoice: boolean; soundMode: boolean; avoided: { hevc?: number; surround?: number } } {
  const c = base !== undefined ? base : baseCaps();
  return {
    hevcFiles: Boolean(c?.video.some((v) => v.codec === 'hevc')),
    hevcStreams: Boolean(c?.hls?.video.includes('hevc')),
    surround: [...(c?.hls?.surround ?? [])],
    channels: c ? statedChannels(c) : 2,
    stereoChoice: stereoOnly(),
    soundMode: soundModeOn(),
    avoided: avoidedUntil(),
  };
}

/** a direct play that relied on the probed claims did not start: for 7 days this device sends no block (an active period is not restarted) */
export function noteDirectFailure(): void {
  if (inSafeMode()) return;
  write(SAFE_KEY, { ua: d().ua, at: d().now() });
}

/**
 * Is a failed direct play evidence of a format the device cannot play? The watchdog (no picture in time) counts once metadata arrived
 * (bytes flowed); a media error counts as MEDIA_ERR_DECODE (3), or once metadata arrived. A code 4 before any metadata is also what
 * an HTTP error (expired session, server hiccup) looks like on a <video src>: not counted.
 */
export function isFormatFailure(o: { watchdog: boolean; code?: number | null; readyState: number }): boolean {
  if (o.readyState >= 1) return true;
  return !o.watchdog && o.code === 3;
}

/** waits (bounded) for the decode probe when it still runs, so the play-button prefetch and the player send the same block; null = nothing to wait for */
export function capsPending(ms = 400): Promise<void> | null {
  const env = d().env;
  if (!env || d().ownCaps || inSafeMode() || probed !== undefined) return null;
  if (cached() !== undefined) { probed = cached(); return null; }
  return Promise.race([warmDeviceCaps(), new Promise<void>((r) => setTimeout(r, ms))]);
}

/** a block this module produced (the player watches its direct plays and remembers failures) */
export const isProbedBlock = (c: { client?: string } | null | undefined): boolean => c?.client === 'web' || c?.client === 'tizen';

/** tests only */
export function _resetDeviceCaps(next: DeviceDeps | null = null): void { deps = next; probed = undefined; syncResult = undefined; running = null; channels = undefined; memAvoid = null; listening = false; }
