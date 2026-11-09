// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Playback speed that survives a new source. Every load of a media element (a new `src`, an hls.js / MSE attach for a track or
 * quality switch, a retry, hls.js' own media-error recovery) resets `playbackRate` to `defaultPlaybackRate` (HTML load algorithm),
 * so setting only `playbackRate` let the film fall back to 1× while the speed button still showed the old speed. Setting both keeps
 * the chosen speed through every reload; `reapplyRate` is the safety net after an attach (a browser that ignores the default).
 */
type RateTarget = Pick<HTMLMediaElement, 'playbackRate' | 'defaultPlaybackRate'>;

export function applyRate(v: RateTarget, r: number): void {
  if (!Number.isFinite(r) || r <= 0) return;
  try {
    v.defaultPlaybackRate = r;
    if (v.playbackRate !== r) v.playbackRate = r;
  } catch { /* NotSupportedError for a rate the element refuses: keep what plays */ }
}

/** after a new source: the UI speed back on the element when it was reset (never in a watch party: its drift correction owns the rate) */
export function reapplyRate(v: RateTarget | null | undefined, r: number, party: boolean): boolean {
  if (!v || party || v.playbackRate === r) return false;
  applyRate(v, r);
  return true;
}
