// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { holdSeekStep } from './keymap';
/**
 * TV seek preview (spec 4): with the focus on the progress bar, left / right move a marker instead of seeking at once.
 * OK or `SEEK_COMMIT_MS` without a key commits the seek, Back cancels it. The video keeps playing meanwhile. Pure state.
 */
export type SeekPreview = { active: boolean; target: number };

/** a preview commits after this long without a key */
export const SEEK_COMMIT_MS = 1000;

/** one step of the marker: from the playing position when it starts, then from the marker; held keys step faster (10 -> 30 -> 60 s) */
export function seekStep(p: SeekPreview, dir: -1 | 1, current: number, duration: number, heldMs: number): SeekPreview {
  const from = p.active ? p.target : current;
  const hi = duration > 0 ? duration : Infinity;
  return { active: true, target: Math.max(0, Math.min(hi, from + dir * holdSeekStep(heldMs))) };
}

/** OK / the timeout: where to seek (null = no preview running) and the next state */
export function seekCommit(p: SeekPreview): { seekTo: number | null; next: SeekPreview } {
  return { seekTo: p.active ? p.target : null, next: p.active ? seekCancel() : p };
}

/** Back: the preview ends, the position stays */
export const seekCancel = (): SeekPreview => ({ active: false, target: 0 });
