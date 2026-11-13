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

/** a seek or resume lands this far after the oldest point: the playlist slides, and a target on the edge of the buffer would fall off it */
export const RESUME_MARGIN_S = 2;

/**
 * After a pause: resume no earlier than `at` (the oldest point still in the buffer). `tooLong` = the paused point is gone from the
 * buffer (it slid past `currentTime` while paused), so the player says so (toast `live.player.pauseTooLong`, n = dvrSeconds / 60).
 * Decided by where the viewer is, not by how long the pause was: one already far behind loses the point with a shorter pause.
 */
export function resumePoint(currentTime: number, oldest: number): { at: number; tooLong: boolean } {
  return { at: oldest, tooLong: currentTime < oldest };
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

/** Von Anfang an: the media time of max(oldest + margin, start − 30 s); null when the start is older than the buffer or nothing is known */
export function restartTarget(progStart: number, o: Oldest | null): number | null {
  if (!o || !Number.isFinite(progStart) || progStart < o.pdt) return null;
  // never exactly the oldest point: the playlist slides under it and hls.js would jump to the live edge (RESUME_MARGIN_S as the resume path)
  return o.time + Math.max(RESUME_MARGIN_S, (progStart - RESTART_LEAD_MS - o.pdt) / 1000);
}
