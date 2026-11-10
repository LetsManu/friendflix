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
 * - after a claimed format failed to start (player: a decode error, or metadata but no picture in time; then one retry as HLS), the
 *   device sends no block for 7 days or until its user agent changes: the server's fixed browser list of before applies.
 * The result is cached per device (localStorage, keyed by user agent and probe version, 7 days). No probing (no media element): null,
 * and the server keeps its fixed browser list as before.
 */
import { APP_VERSION } from '#lib/version/codenames';
import { isTizenApp } from '#lib/tizen/detect';
import { isLgApp } from '#lib/webos/detect';
import { isFireTvApp } from '#lib/firetv/detect';
import type { ClientCapsBody } from '#lib/webos/caps';

export interface DecodeQuery {
  type: 'file';
  video?: { contentType: string; width: number; height: number; bitrate: number; framerate: number; transferFunction?: string; colorGamut?: string; hdrMetadataType?: string };
  audio?: { contentType: string; channels: string; bitrate: number; samplerate: number };
}
export interface ProbeEnv {
  canPlayType(t: string): string;
  isTypeSupported?: (t: string) => boolean;
  decodingInfo?: (q: DecodeQuery) => Promise<{ supported: boolean }>;
  /** the screen shows high dynamic range (`(dynamic-range: high)`) */
  hdrDisplay: boolean;
}
export type ProbeClient = 'web' | 'tizen';
type Out = ClientCapsBody;

/** bump when the claims change: cached results of an older probe are thrown away */
export const PROBE_VERSION = 1;
export const CACHE_KEY = 'ff_devcaps';
export const SAFE_KEY = 'ff_devcaps_safe';
export const CACHE_MS = 7 * 86_400_000;
export const SAFE_MS = 7 * 86_400_000;

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

  return { client: o.client, appVersion: o.appVersion, containers, video, audio, subtitles: [...SUBTITLES], ranges };
}


// ---- this device: probe once, cache, remember a failure ----

/** `hdr`: the screen's HDR state at probe time (a switch to an SDR screen or HDR off must not keep the HDR claims) */
interface Cached { v: number; ua: string; at: number; hdr?: boolean; caps: Out | null }
export interface DeviceDeps { env: ProbeEnv | null; ua: string; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null; now: () => number; tizen: boolean;
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
      const mc = (navigator as Navigator & { mediaCapabilities?: { decodingInfo?: (q: unknown) => Promise<{ supported: boolean }> } }).mediaCapabilities;
      let hdrDisplay: boolean;
      try { hdrDisplay = w.matchMedia?.('(dynamic-range: high)').matches === true; } catch { hdrDisplay = false; }
      env = {
        canPlayType: (t) => v.canPlayType(t),
        isTypeSupported: ms?.isTypeSupported ? (t) => ms.isTypeSupported!(t) : undefined,
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

/**
 * The block for the next request (synchronous: the request body is built in one place, lib/player/infobody.ts): none after
 * a failure, else the probed (or cached) result, else the conservative synchronous claims while the probe still runs; null without probing.
 */
export function deviceCaps(): Out | null {
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
export function _resetDeviceCaps(next: DeviceDeps | null = null): void { deps = next; probed = undefined; syncResult = undefined; running = null; }
