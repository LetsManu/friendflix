// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TvWheelStepper, WheelAccumulator, WHEEL_TV_IDLE_MS } from './wheel';

describe('WheelAccumulator', () => {
  it('one notch of 100 px = one step, direction kept', () => {
    const w = new WheelAccumulator();
    expect(w.add(100, 0, 0)).toBe(1); expect(w.add(-100, 0, 1000)).toBe(-1);
  });
  it('small trackpad deltas add up to a step', () => {
    const w = new WheelAccumulator();
    expect([w.add(30, 0, 0), w.add(30, 0, 16), w.add(30, 0, 32), w.add(30, 0, 48)]).toEqual([0, 0, 0, 1]);
  });
  it('a momentum swipe gives few steps, not one per event', () => {
    const w = new WheelAccumulator();
    let n = 0; for (let i = 0; i < 40; i++) n += w.add(5, 0, i * 16);
    expect(n).toBe(2);
  });
  it('idle for more than 200 ms drops the remainder', () => {
    const w = new WheelAccumulator();
    w.add(60, 0, 0); expect(w.add(60, 0, 500)).toBe(0);
  });
  it('line and page modes are normalised', () => {
    const w = new WheelAccumulator();
    expect(w.add(1, 1, 0)).toBe(0); expect(w.add(6, 1, 10)).toBe(1); expect(w.add(1, 2, 2000, 800)).toBe(8);
  });
});

describe('TvWheelStepper (LG Magic Remote wheel)', () => {
  it('a burst of events (one notch, as logged on webOS 25) counts once', () => {
    const w = new TvWheelStepper();
    expect(w.add(-3, 0)).toBe(-1); expect(w.add(-3, 38)).toBe(0); expect(w.add(-3, 102)).toBe(0);
  });
  it('the next notch after a pause steps again, in its own direction', () => {
    const w = new TvWheelStepper();
    expect(w.add(-3, 0)).toBe(-1);
    expect(w.add(3, 435)).toBe(1); expect(w.add(3, 465)).toBe(0);
    expect(w.add(-3, 465 + WHEEL_TV_IDLE_MS + 1)).toBe(-1);
  });
  it('wheel down = forward, a zero delta does nothing', () => {
    const w = new TvWheelStepper();
    expect(w.add(5, 0)).toBe(1); expect(new TvWheelStepper().add(0, 0)).toBe(0);
  });
});
