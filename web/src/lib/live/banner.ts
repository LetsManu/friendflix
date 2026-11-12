// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** the info banner stays this long after the first frame of a switch (ruling 49) */
export const BANNER_HOLD_MS = 4000;

/**
 * Whether the info banner shows (spec §12.2): never over an error state; always with the controls and while starting; else from
 * a switch (or the open) until its first frame plus 4 s. A first frame older than the latest switch belongs to the channel before,
 * so it does not end the hold.
 */
export function bannerVisible(s: { starting: boolean; switchingAt: number | null; firstFrameAt: number | null; controlsVisible: boolean; error: boolean }, now: number): boolean {
  if (s.error) return false;
  if (s.controlsVisible || s.starting) return true;
  if (s.firstFrameAt === null) return true;
  if (s.switchingAt !== null && s.firstFrameAt < s.switchingAt) return true;
  return now < s.firstFrameAt + BANNER_HOLD_MS;
}
