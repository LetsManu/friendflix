// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hoverAllowed, wideBox } from './preview';

describe('hoverAllowed', () => {
  it('needs a wide window, a fine pointer and no scrolling', () => {
    expect(hoverAllowed({ width: 1100, coarse: false, scrolling: false })).toBe(true);
    expect(hoverAllowed({ width: 1099, coarse: false, scrolling: false })).toBe(false);
    expect(hoverAllowed({ width: 1280, coarse: true, scrolling: false })).toBe(false);
    expect(hoverAllowed({ width: 1280, coarse: false, scrolling: true })).toBe(false);
  });
});

describe('wideBox', () => {
  const vp = { w: 1280, h: 800 };
  it('anchors on the card left edge', () => {
    const b = wideBox({ left: 100, top: 300, width: 240, height: 135 }, vp);
    expect(b).toMatchObject({ left: 100, width: 600, height: 600 * 9 / 16 * 0.62, origin: 'left' });
    expect(b.top).toBeCloseTo(300 - 0.08 * 600 * 9 / 16 * 0.62);
  });
  it('flips to the card right edge near the viewport edge', () => {
    const b = wideBox({ left: 1100, top: 300, width: 240, height: 135 }, vp);
    expect(b.left + b.width).toBeLessThanOrEqual(1268);
    expect(b.left + b.width).toBe(1268);
    expect(b.origin).toBe('right');
  });
  it('moves up to stay inside the bottom margin', () => {
    const low = wideBox({ left: 100, top: 760, width: 240, height: 135 }, vp);
    expect(low.top + low.width * 9 / 16 * 0.62).toBeLessThanOrEqual(788);
  });
  it('never goes above the top margin', () => {
    expect(wideBox({ left: 100, top: 0, width: 240, height: 135 }, vp).top).toBe(12);
  });
  it('clamps both edges to the margin and centres when neither fits', () => {
    const b = wideBox({ left: 20, top: 300, width: 240, height: 135 }, { w: 500, h: 800 });
    expect(b.origin).toBe('center');
    expect(b.left).toBe(12);
  });
  it('clamps left to the margin when flipped box overflows left', () => {
    const b = wideBox({ left: 5, top: 300, width: 240, height: 135 }, { w: 1280, h: 800 });
    expect(b.left).toBe(12);
    expect(b.origin).toBe('left');
  });
});
