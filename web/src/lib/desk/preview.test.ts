// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HOVER_MARGIN, HOVER_MIN_HEIGHT, hoverAllowed, hoverBox, hoverWidth } from './preview';

describe('hoverAllowed', () => {
  const ok = { width: 1280, height: 800, coarse: false, scrolling: false };
  it('needs a wide window, a fine pointer and no scrolling', () => {
    expect(hoverAllowed({ ...ok, width: 1100 })).toBe(true);
    expect(hoverAllowed({ ...ok, width: 1099 })).toBe(false);
    expect(hoverAllowed({ ...ok, coarse: true })).toBe(false);
    expect(hoverAllowed({ ...ok, scrolling: true })).toBe(false);
  });
  it('hoverAllowed needs 600 px height', () => {
    expect(HOVER_MIN_HEIGHT).toBe(600);
    expect(hoverAllowed({ ...ok, height: 600 })).toBe(true);
    expect(hoverAllowed({ ...ok, height: 599 })).toBe(false);
  });
});

describe('hoverWidth', () => {
  it('is 43 % of the window, 560…720, inside the margins', () => {
    expect(hoverWidth(1280)).toBe(560);
    expect(hoverWidth(1440)).toBe(619);
    expect(hoverWidth(2000)).toBe(720);
    expect(hoverWidth(560)).toBe(536);
  });
});

describe('hoverBox', () => {
  const vp = { w: 1280, h: 800 };
  const inside = (b: { left: number; top: number; width: number; height: number }, v = vp) =>
    b.left >= HOVER_MARGIN && b.top >= HOVER_MARGIN && b.left + b.width <= v.w - HOVER_MARGIN && b.top + b.height <= v.h - HOVER_MARGIN;

  it('same width and picture height for a 16:9, a poster and a far-right card', () => {
    const wide = hoverBox({ left: 100, top: 300, width: 240, height: 135 }, vp, 200);
    const poster = hoverBox({ left: 500, top: 300, width: 140, height: 210 }, vp, 200);
    const right = hoverBox({ left: 1180, top: 300, width: 240, height: 135 }, vp, 200);
    for (const b of [poster, right]) {
      expect(b.width).toBe(wide.width);
      expect(b.picH).toBe(wide.picH);
    }
    expect(wide.width).toBe(560);
    expect(wide.picH).toBe(315);
    expect(wide.height).toBe(515);
    // the picture is centred on the card where there is room
    expect(poster.left + poster.width / 2).toBe(570);
    expect(poster.top + poster.picH / 2).toBe(405);
  });

  it('fully inside the viewport at all four edges', () => {
    const cards = [
      { left: 0, top: 300, width: 240, height: 135 },
      { left: vp.w - 100, top: 300, width: 240, height: 135 },
      { left: 500, top: 0, width: 240, height: 135 },
      { left: 500, top: vp.h - 50, width: 240, height: 135 },
    ];
    for (const c of cards) expect(inside(hoverBox(c, vp, 220))).toBe(true);
    expect(hoverBox(cards[0]!, vp, 220).left).toBe(12);
    expect(hoverBox(cards[1]!, vp, 220).left).toBe(vp.w - 12 - 560);
    expect(hoverBox(cards[2]!, vp, 220).top).toBe(12);
    const low = hoverBox(cards[3]!, vp, 220);
    expect(low.top + low.height).toBe(vp.h - 12);
  });

  it('a short window shrinks the width but not below 560', () => {
    // 1680 → 720 wide; 405 + 200 > 576: the picture gets what is left, (600 − 24 − 200) × 16/9 = 668
    const b = hoverBox({ left: 800, top: 200, width: 240, height: 135 }, { w: 1680, h: 600 }, 200);
    expect(b.width).toBe(668);
    expect(b.picH).toBe(376);
    expect(inside(b, { w: 1680, h: 600 })).toBe(true);
    // far too little room: 560 is the floor (top stays on the margin)
    const tight = hoverBox({ left: 800, top: 200, width: 240, height: 135 }, { w: 1680, h: 600 }, 400);
    expect(tight.width).toBe(560);
    expect(tight.top).toBe(12);
  });

  it('origin is the card centre clamped to the box', () => {
    const mid = hoverBox({ left: 500, top: 300, width: 240, height: 135 }, vp, 200);
    expect([mid.ox, mid.oy]).toEqual([620 - mid.left, 367.5 - mid.top]);
    expect(mid.ox).toBe(280);
    // a card scrolled off the left edge: x clamps to 0
    const off = hoverBox({ left: -400, top: 300, width: 240, height: 135 }, vp, 200);
    expect(off.ox).toBe(0);
    // a card far below a short box: y clamps to the box height
    const below = hoverBox({ left: 500, top: 2000, width: 240, height: 135 }, vp, 200);
    expect(below.oy).toBe(below.height);
  });

  it('takes its own margin', () => {
    expect(hoverBox({ left: 0, top: 0, width: 240, height: 135 }, vp, 200, 20)).toMatchObject({ left: 20, top: 20 });
  });
});
