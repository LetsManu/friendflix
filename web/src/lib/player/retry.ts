// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Error recovery policy of the player (pure): what to do after the n-th fatal error. */
export const MAX_NETWORK_TRIES = 3;
export const BACKOFF_MS = [1000, 2500, 5000];
export const backoffMs = (attempt: number) => BACKOFF_MS[Math.max(0, Math.min(BACKOFF_MS.length - 1, attempt - 1))];

export type ErrorKind = 'network' | 'media' | 'other';
/** `avoided`: the one automatic fallback of this session (an HEVC / surround stream replaced by H.264 stereo) has been used */
export interface RecoveryState { networkTries: number; mediaRecovered: boolean; loweredQuality: boolean; forcedHls: boolean; avoided: boolean }
export const freshRecovery = (): RecoveryState => ({ networkTries: 0, mediaRecovered: false, loweredQuality: false, forcedHls: false, avoided: false });

export type Recovery =
  | { do: 'retry'; attempt: number; delay: number }
  | { do: 'recover-media' }
  | { do: 'force-hls' }
  | { do: 'avoid' }
  | { do: 'lower-quality' }
  | { do: 'fail' };

/**
 * network: up to 3 retries with backoff, resuming at the last position.
 * media: hls.recoverMediaError once, then (direct play) switch to HLS/transcode, then a lower quality; `canLowerQuality` = the quality switcher still has a lower step.
 * `avoidable` = the stream carries HEVC or surround that can still be given up (once per session); a codec error there avoids at once
 * (recovering the media would only repeat it), a generic media error avoids after the recover attempt and before the lower quality.
 */
export function decideRecovery(kind: ErrorKind, s: RecoveryState, o: { isHls: boolean; canLowerQuality: boolean; avoidable?: boolean; codecError?: boolean }): Recovery {
  if (kind === 'network') return s.networkTries < MAX_NETWORK_TRIES ? { do: 'retry', attempt: s.networkTries + 1, delay: backoffMs(s.networkTries + 1) } : { do: 'fail' };
  if (kind === 'media') {
    const canAvoid = Boolean(o.avoidable) && !s.avoided;
    if (o.codecError && canAvoid) return { do: 'avoid' };
    // after the fallback a codec error is not a hiccup: no second recover attempt
    if (o.isHls && !s.mediaRecovered && !(o.codecError && s.avoided)) return { do: 'recover-media' };
    if (canAvoid) return { do: 'avoid' };
    if (!o.isHls && !s.forcedHls) return { do: 'force-hls' };
    if (o.canLowerQuality && !s.loweredQuality) return { do: 'lower-quality' };
  }
  return { do: 'fail' };
}

/** map a MediaError code of a plain <video> to a kind (1 aborted by the user is ignored by the caller) */
export function kindOfMediaError(code: number): ErrorKind {
  return code === 2 ? 'network' : code === 3 || code === 4 ? 'media' : 'other';
}

/** next lower bitrate from the quality ladder (descending), below what plays now (0 = automatic = the source bitrate) */
export function lowerQuality(ladder: number[], current: number, sourceBitrate: number): number | null {
  const cur = current || sourceBitrate || Infinity;
  const lower = ladder.filter((b) => b < cur).sort((a, b) => b - a)[0];
  return lower ?? null;
}

/** pause before the same rung is tried again while the step-down cooldown is running */
export const COOLDOWN_RETRY_MS = 3000;

/**
 * What a network error does once the quality controller has answered (after the first failed retry):
 * a lower rung, a pause on the same rung that does NOT spend the retry budget (cooldown), or give up (already at the lowest rung).
 */
export function networkStep(d: { do: 'none' } | { do: 'switch' } | { do: 'fail' }): 'switch' | 'wait' | 'giveup' {
  return d.do === 'switch' ? 'switch' : d.do === 'fail' ? 'giveup' : 'wait';
}

// ---- HEVC / surround streams: which feature a failure points at, and which variant the player pins ----
export type AvoidWhat = 'hevc' | 'surround' | 'both';
/** hls.js error details that mean "this device cannot decode what the stream carries" (bufferAddCodecError is not fatal, the others are) */
export const isCodecError = (details: string | undefined): boolean =>
  details === 'bufferAddCodecError' || details === 'bufferIncompatibleCodecsError' || details === 'manifestIncompatibleCodecsError';

/**
 * What to give up after a codec failure: the audio buffer / an audio MIME is surround, the video buffer / video MIME is HEVC, anything
 * else both (narrowed to the one the stream actually carried). A report for a feature the stream does not carry names the one it does.
 */
export function avoidTarget(d: { sourceBufferName?: string; mimeType?: string }, active: { hevc: boolean; surround: boolean }): AvoidWhat {
  const name = d.sourceBufferName ?? '';
  const mime = d.mimeType ?? '';
  const kind = name === 'audio' || (!name && /^audio\//.test(mime)) ? 'audio' : name === 'video' || (!name && /^video\//.test(mime)) ? 'video' : 'other';
  // a feature that is not in the stream cannot be the cause: the other one is what moves the stream back to the plain H.264 one
  if (kind === 'audio') return active.surround ? 'surround' : active.hevc ? 'hevc' : 'both';
  if (kind === 'video') return active.hevc ? 'hevc' : active.surround ? 'surround' : 'both';
  return active.hevc && !active.surround ? 'hevc' : active.surround && !active.hevc ? 'surround' : 'both';
}

/**
 * The variant to pin (hls.js `currentLevel`): Jellyfin adds SDR variants at the same bandwidth when it copies HDR video, so with more than
 * one level the player takes the highest-bitrate level of the planned codec (hvc1 / hev1 for HEVC, else avc1). -1 = no lock (one level,
 * or none of the planned codec).
 */
/**
 * Native HLS (no hls.js, so no codec details): a media error counts as "the device cannot play what the stream carries" only after
 * metadata arrived or as a decode error. A code 4 before any metadata is also what an expired token or an HTTP error on the playlist looks like.
 */
export const isNativeCodecFailure = (o: { code?: number | null; readyState: number }): boolean => o.code === 3 || o.readyState >= 1;

/** (equal bandwidth: the first listed level wins, which relies on Jellyfin listing the planned variant first) */
export function pickLockedLevel(levels: Array<{ bitrate: number; videoCodec?: string }>, hevc: boolean): number {
  if (levels.length < 2) return -1;
  const want = hevc ? /^(hvc1|hev1)/ : /^avc1/;
  let best = -1;
  levels.forEach((l, i) => { if (l.videoCodec && want.test(l.videoCodec) && (best < 0 || l.bitrate > levels[best]!.bitrate)) best = i; });
  return best;
}
