// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { anchorMoved, menuPlaceStyle, placeMenu, placePopover } from './popover';

const box = (left: number, top: number, w = 44, h = 44) => ({ left, top, right: left + w, bottom: top + h, width: w });
const vp = { w: 375, h: 812 };

describe('placePopover', () => {
  it('left-aligns below the trigger when there is room', () => {
    const p = placePopover(box(20, 100), vp);
    expect(p).toMatchObject({ left: 20, width: 260, top: 150, up: false });
  });
  it('right-aligns near the right edge and never leaves the viewport', () => {
    const p = placePopover(box(320, 100), vp);
    expect(p.left + p.width).toBeLessThanOrEqual(vp.w - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBe(364); // right edge of the trigger
  });
  it('opens upward when asked and there is room above', () => {
    const p = placePopover(box(20, 500), vp, { up: true });
    expect(p.up).toBe(true);
    expect(p.bottom).toBe(812 - 500 + 6);
  });
  it('flips upward near the bottom edge, falls back to below when above is tiny', () => {
    expect(placePopover(box(20, 700), vp).up).toBe(true);
    expect(placePopover(box(20, 40), vp, { up: true }).up).toBe(false);
  });
  it('clamps width on narrow viewports and supports wide rows', () => {
    expect(placePopover(box(0, 100), { w: 240, h: 600 }).width).toBe(224);
    expect(placePopover(box(8, 100, 500, 48), vp, { wide: true }).width).toBe(359);
  });
});

describe('placeMenu', () => {
  const big = { w: 1440, h: 900 };
  const size = { w: 264, h: 300 };
  const t = (left: number, top: number, w = 44, h = 44) => ({ left, top, right: left + w, bottom: top + h, width: w });
  it('opens below, right-aligned, for a trigger in the right half', () => {
    expect(placeMenu(t(1300, 100), size, big)).toEqual({ left: 1080, top: 150, maxHeight: 742, up: false });
  });
  it('left-aligned for a trigger in the left half', () => {
    expect(placeMenu(t(40, 100), size, big).left).toBe(40);
  });
  it('shifts inside the right edge', () => {
    expect(placeMenu(t(1400, 100, 40), size, big, { align: 'start' }).left).toBe(1168);
  });
  it('flips above near the bottom', () => {
    expect(placeMenu(t(1300, 800), size, big)).toMatchObject({ up: true, top: 494, maxHeight: 786 });
  });
  it('prefers above when asked and it fits', () => {
    expect(placeMenu(t(1300, 500), size, big, { up: true })).toMatchObject({ up: true, top: 194 });
  });
  it('a short window caps the height and never leaves it', () => {
    const p = placeMenu(t(100, 180), { w: 264, h: 600 }, { w: 1100, h: 400 });
    expect(p.up).toBe(true);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(392);
  });
  it('a menu wider than the window sits at the margin', () => {
    expect(placeMenu(t(10, 10), { w: 500, h: 100 }, { w: 400, h: 800 }).left).toBe(8);
  });
  it('whole pixels', () => {
    const p = placeMenu({ left: 100.4, right: 144.6, top: 50.3, bottom: 94.7, width: 44.2 }, size, big);
    for (const v of [p.left, p.top, p.maxHeight]) expect(Number.isInteger(v)).toBe(true);
    expect(menuPlaceStyle(p)).toBe(`left:${p.left}px;top:${p.top}px;max-height:${p.maxHeight}px;`);
  });
});

describe('anchorMoved', () => {
  it('ignores moves within the tolerance', () => {
    expect(anchorMoved({ left: 0, top: 0 }, { left: 0, top: 2 })).toBe(false);
  });
  it('detects vertical and horizontal moves beyond it', () => {
    expect(anchorMoved({ left: 0, top: 0 }, { left: 0, top: 3 })).toBe(true);
    expect(anchorMoved({ left: 0, top: 0 }, { left: -3, top: 0 })).toBe(true);
  });
});
