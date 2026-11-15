// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live player's own catch-up (H3). hls.js speeds up a little while just behind the sync point and goes back to it beyond the
 * max latency, but only as it loads; after a stall, a resume or the tab coming back the player checks itself. Being behind is the
 * viewer's choice only after their own pause (the OS media session's too: lock screen, headset, media keys), a rewind or Von
 * Anfang an (`deliberate`); a pause from outside (a hidden tab, audio focus lost) is not one. Pure.
 */

/** back to the sync point: further behind the newest end than `maxLatencyS`, playing, and not deliberately behind */
export function shouldCatchUp(o: { latencyS: number; maxLatencyS: number; deliberate: boolean; paused: boolean }): boolean {
  return !o.deliberate && !o.paused && Number.isFinite(o.latencyS) && o.latencyS > o.maxLatencyS;
}

/**
 * How far behind the newest end: the distance behind the sync point plus hls.js' target latency (`targetLatency`, which grows a
 * little after each stall), else `fallback` (the configured sync distance; 0 for Safari's own HLS, whose edge is the end already).
 */
export function latencyOf(behindSync: number, targetLatency: number | null | undefined, fallback: number): number {
  const t = typeof targetLatency === 'number' && Number.isFinite(targetLatency) && targetLatency > 0 ? targetLatency : fallback;
  return behindSync + t;
}

/**
 * Whether the next media `pause` is the viewer's own: the player calls `own()` right before it pauses the element for a press of
 * theirs; the `pause` event then `take()`s it. `drop()` forgets it when no event follows (the element was paused already).
 */
export function createPauseIntent(): { own(): void; drop(): void; take(): boolean } {
  let pending = false;
  return {
    own() { pending = true; },
    drop() { pending = false; },
    take() { const p = pending; pending = false; return p; },
  };
}
