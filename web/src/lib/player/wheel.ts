// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Mouse wheel / trackpad -> volume steps: deltas are normalised to pixels and add up; one step per 100 px, idle for 200 ms starts over. */
export const WHEEL_STEP_PX = 100;
export const WHEEL_IDLE_MS = 200;
export class WheelAccumulator {
  private acc = 0;
  private last = -Infinity;
  /** returns the whole steps now due (positive = wheel down); deltaMode 1 = lines, 2 = pages */
  add(deltaY: number, deltaMode: number, now: number, pageHeight = 800): number {
    if (now - this.last > WHEEL_IDLE_MS) this.acc = 0;
    this.last = now;
    this.acc += deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
    const n = Math.trunc(this.acc / WHEEL_STEP_PX);
    this.acc -= n * WHEEL_STEP_PX;
    return n;
  }
}

/**
 * TV Magic Remote wheel -> seek steps: one notch arrives as a burst of wheel events (seen on LG webOS 25: 2-3 events within
 * ~100 ms), so a burst counts once - a step fires on the first event after WHEEL_TV_IDLE_MS of quiet.
 */
export const WHEEL_TV_IDLE_MS = 150;
export class TvWheelStepper {
  private last = -Infinity;
  /** returns +1 (wheel down = forward), -1 (wheel up = back) or 0 (part of a burst already counted) */
  add(deltaY: number, now: number): -1 | 0 | 1 {
    const fresh = now - this.last > WHEEL_TV_IDLE_MS;
    this.last = now;
    if (!fresh || !deltaY) return 0;
    return deltaY > 0 ? 1 : -1;
  }
}
