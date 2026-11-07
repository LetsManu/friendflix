// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** TV player (spec 4): Back order, pause-screen timing and the labelled button row. Pure helpers. */

/** what is on top: an open menu / overlay, the seek preview, the focused controls, or nothing (the picture) */
export type TvLayer = 'overlay' | 'seek' | 'controls' | 'none';

/** Back peels one layer: open menu -> seek preview -> controls -> leave the player */
export function playerBack(l: TvLayer): { next: TvLayer; leave: boolean } {
  switch (l) {
    case 'overlay': case 'seek': return { next: 'controls', leave: false };
    case 'controls': return { next: 'none', leave: false };
    default: return { next: 'none', leave: true };
  }
}

/** the pause screen shows after this long paused without a key */
export const PAUSE_SCREEN_MS = 8000;

/** paused since `pausedAt`, last key at `lastKey` (ms): is the pause screen due? Calm mode: never (no dimming, no block). */
export function pauseScreenDue(pausedAt: number, lastKey: number, now: number, calm: boolean): boolean {
  return !calm && now - Math.max(pausedAt, lastKey) >= PAUSE_SCREEN_MS;
}

export type TvButton = 'episodes' | 'next' | 'tracks' | 'speed' | 'quality';

/** the row under the progress bar: Episodes (series) · Next episode (when there is one) · Audio & subtitles · Speed · Quality */
export function tvPlayerButtons(i: { isEpisode: boolean; hasNext: boolean }): TvButton[] {
  return [...(i.isEpisode ? ['episodes' as const] : []), ...(i.hasNext ? ['next' as const] : []), 'tracks', 'speed', 'quality'];
}
