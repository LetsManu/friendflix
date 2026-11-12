// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The rewind buffer (spec §12.1, rulings 47/48): where the viewer is against the live edge and where a programme starts in it. Pure. */

/** up to this many seconds behind the edge still counts as live (the pill is filled, +30 s is off) */
export const EDGE_SEC = 6;

/** seconds behind the live edge, never negative */
export function behind(video: { currentTime: number }, liveEdge: number): number {
  const d = liveEdge - video.currentTime;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function atEdge(behindSec: number): boolean {
  return behindSec <= EDGE_SEC;
}

/**
 * After a pause of `pausedSec`: resume no earlier than `at` (the oldest point still in the buffer). `tooLong` = the pause outlasted
 * the buffer, so the paused point is gone and the player says so (toast `live.player.pauseTooLong`, n = dvrSeconds / 60).
 */
export function resumePoint(pausedSec: number, dvrSeconds: number, oldest: number): { at: number; tooLong: boolean } {
  return { at: oldest, tooLong: pausedSec > dvrSeconds };
}

/** the oldest point of the buffer: its programme date-time (epoch ms) and its media time (s) */
export interface Oldest { pdt: number; time: number }

interface FragLike { programDateTime: number | null; start: number }
interface LevelLike { details?: { fragments: FragLike[] } }

/**
 * hls.js: the first fragment of the current level (an unset level, -1, reads the first level that has a playlist). Safari's
 * native HLS: getStartDate() is the date of media time 0, so the oldest point is it plus seekable.start(0).
 */
export function oldestPoint(src: { hls?: { levels: LevelLike[]; currentLevel: number } | null; video: { seekable: TimeRanges; getStartDate?(): Date } }): Oldest | null {
  const h = src.hls;
  if (h) {
    let level: LevelLike | undefined = h.currentLevel >= 0 ? h.levels[h.currentLevel] : undefined;
    if (!level || !level.details) level = h.levels.find((l) => Boolean(l && l.details));
    const f = level && level.details ? level.details.fragments[0] : undefined;
    if (!f || typeof f.programDateTime !== 'number' || !Number.isFinite(f.programDateTime) || !Number.isFinite(f.start)) return null;
    return { pdt: f.programDateTime, time: f.start };
  }
  const v = src.video;
  if (typeof v.getStartDate !== 'function' || !v.seekable || !v.seekable.length) return null;
  const d = v.getStartDate().getTime();
  if (!Number.isFinite(d)) return null;
  const s = v.seekable.start(0);
  return { pdt: d + s * 1000, time: s };
}

/** a little before the start: broadcasts rarely begin on the minute (ruling 48) */
export const RESTART_LEAD_MS = 30_000;

/** Von Anfang an: the media time of max(oldest, start − 30 s); null when the start is older than the buffer or nothing is known */
export function restartTarget(progStart: number, o: Oldest | null): number | null {
  if (!o || !Number.isFinite(progStart) || progStart < o.pdt) return null;
  return o.time + (Math.max(o.pdt, progStart - RESTART_LEAD_MS) - o.pdt) / 1000;
}
