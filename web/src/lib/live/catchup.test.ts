// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createPauseIntent, latencyOf, shouldCatchUp } from './catchup';

/**
 * H3: the live player catches up by itself after a stall, a resume or the tab coming back, unless the viewer chose to be behind;
 * and only the viewer's own pause is such a choice (one from the OS media session, a hidden tab or audio focus is not).
 */
describe('shouldCatchUp', () => {
  const base = { latencyS: 45, maxLatencyS: 30, deliberate: false, paused: false };
  it('back to the edge when further behind than the max latency', () => {
    expect(shouldCatchUp(base)).toBe(true);
    expect(shouldCatchUp({ ...base, latencyS: 30 })).toBe(false);
    expect(shouldCatchUp({ ...base, latencyS: 18 })).toBe(false);
  });
  it('never while the viewer is deliberately behind (paused by them, rewound, Von Anfang an) or the picture is paused', () => {
    expect(shouldCatchUp({ ...base, deliberate: true })).toBe(false);
    expect(shouldCatchUp({ ...base, latencyS: 600, deliberate: true })).toBe(false);
    expect(shouldCatchUp({ ...base, paused: true })).toBe(false);
  });
  it('nothing known is no reason to seek', () => {
    expect(shouldCatchUp({ ...base, latencyS: Number.NaN })).toBe(false);
    expect(shouldCatchUp({ ...base, latencyS: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('latencyOf', () => {
  it('the distance behind the sync point plus the target latency hls.js keeps (it grows after stalls)', () => {
    expect(latencyOf(20, 12, 12)).toBe(32);
    expect(latencyOf(20, 15, 12)).toBe(35);
    // without hls.js (Safari's own HLS) the distance is to the end of the seekable range already
    expect(latencyOf(20, null, 0)).toBe(20);
    expect(latencyOf(20, Number.NaN, 12)).toBe(32);
  });
});

describe('createPauseIntent', () => {
  it('a pause the player asked for is the viewer\'s; the next one from outside is not', () => {
    const p = createPauseIntent();
    p.own();
    expect(p.take()).toBe(true);
    expect(p.take()).toBe(false);
  });
  it('a pause the player asked for that never came (the element was already paused) does not make the next system pause the viewer\'s', () => {
    const p = createPauseIntent();
    p.own();
    p.drop();
    expect(p.take()).toBe(false);
  });
});
