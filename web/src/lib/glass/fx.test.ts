// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ allowed: true, level: 'full' as 'full' | 'reduced' }));
vi.mock('#lib/preview', () => ({ motionAllowed: () => m.allowed }));
vi.mock('#lib/tv/motion', () => ({ motionLevel: () => m.level }));

import {
  COUNT_MS, countAt, cubicBezier, fxMode, grow, GROW_IN_MS, GROW_OUT_MS, growOrigin, inEase, outEase, PILL_MID, pillParts,
  REDUCED_MS, rippleBox, springEase,
} from './fx';

const node = {} as Element;
const ts = Array.from({ length: 101 }, (_, i) => i / 100);

describe('curves', () => {
  it('cubicBezier endpoints and the spring overshoot', () => {
    expect(springEase(0)).toBe(0);
    expect(springEase(1)).toBe(1);
    expect(springEase(-1)).toBe(0);
    expect(springEase(2)).toBe(1);
    expect(Math.max(...ts.map(springEase))).toBeGreaterThan(1.05);
    // in / out: monotonic, the ease-in slow at the start, the ease-out fast
    expect(inEase(0.25)).toBeLessThan(0.25);
    expect(outEase(0.25)).toBeGreaterThan(0.5);
    for (let i = 1; i < ts.length; i++) expect(outEase(ts[i]!)).toBeGreaterThanOrEqual(outEase(ts[i - 1]!) - 1e-9);
    // linear is the identity; a curve whose slope is 0 at the middle needs the bisection fallback
    const lin = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.5, 0.9]) expect(lin(t)).toBeCloseTo(t, 5);
    const flat = cubicBezier(0, 1, 1, 0);
    for (const t of [0.2, 0.5, 0.8]) expect(Number.isFinite(flat(t))).toBe(true);
    const steep = cubicBezier(1, 0, 0, 1);
    expect(steep(0.5)).toBeCloseTo(0.5, 4);
    expect(steep(0.49)).toBeLessThan(0.5);
    // Newton starting on a zero slope (x out of the CSS range): bisection takes over
    const odd = cubicBezier(1.2, 0, 0.2, 1);
    expect(Number.isFinite(odd(0.5))).toBe(true);
  });
});

describe('fxMode', () => {
  it('fxMode', () => {
    m.allowed = true; m.level = 'full';
    expect(fxMode()).toBe('full');
    m.level = 'reduced';
    expect(fxMode()).toBe('reduced');
    m.allowed = false;
    expect(fxMode()).toBe('still');
    m.level = 'full';
    expect(fxMode()).toBe('still');
    m.allowed = true;
  });
});

describe('grow', () => {
  it('growOrigin clamps', () => {
    const pop = { left: 100, top: 100, width: 300, height: 200 };
    expect(growOrigin({ left: 180, top: 60, width: 40, height: 40 }, pop)).toBe('100px 0px'); // above: clamped to the top edge
    expect(growOrigin({ left: 200, top: 150, width: 40, height: 40 }, pop)).toBe('120px 70px');
    expect(growOrigin({ left: 0, top: 500, width: 10, height: 10 }, pop)).toBe('0px 200px');
    expect(growOrigin({ left: 900, top: 120, width: 10, height: 11 }, pop)).toBe('300px 26px'); // 25.5 rounds up
  });

  it('grow per mode', () => {
    const fin = grow(node, { origin: '10px 20px', mode: 'full' });
    expect(fin.duration).toBe(GROW_IN_MS);
    expect(fin.duration).toBe(380);
    expect(fin.delay).toBe(0);
    expect(fin.easing).toBe(springEase);
    expect(fin.css(0, 1)).toContain('scale(0.4)');
    expect(fin.css(0, 1)).toContain('transform-origin:10px 20px');
    expect(fin.css(0, 1)).toContain('opacity:0');
    expect(fin.css(1, 0)).toBe('transform-origin:10px 20px;transform:scale(1);opacity:1');
    const fout = grow(node, { dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(GROW_OUT_MS);
    expect(fout.duration).toBe(200);
    expect(fout.easing).toBe(inEase);
    expect(fout.css(0.5, 0.5)).toContain('scale(0.7)');
    const red = grow(node, { mode: 'reduced', origin: '1px 1px' });
    expect(red.duration).toBe(REDUCED_MS);
    expect(red.duration).toBe(160);
    expect(red.easing(0.3)).toBe(0.3);
    expect(red.css(0.5, 0.5)).toBe('opacity:0.5');
    expect(red.css(0.5, 0.5)).not.toContain('transform');
    const still = grow(node, { mode: 'still' });
    expect(still.duration).toBe(0);
    expect(still.css(0, 1)).toBe('');
    expect(still.easing(0.4)).toBe(0.4);
  });

  it('grow reads the motion mode by default', () => {
    m.allowed = true; m.level = 'full';
    expect(grow(node).duration).toBe(380);
    expect(grow(node).css(1, 0)).toContain('transform-origin:50% 0');
    m.level = 'reduced';
    expect(grow(node).duration).toBe(160);
    m.allowed = false;
    expect(grow(node, { dir: 'out' }).duration).toBe(0);
    m.allowed = true; m.level = 'full';
  });
});

describe('pill, count-up, ripple', () => {
  it('pillParts', () => {
    expect(PILL_MID).toBe(100);
    expect(pillParts({ x: 10, w: 120 }, 40)).toEqual({ l: 'translateX(10px)', mid: 'translateX(30px) scaleX(0.8)', r: 'translateX(90px)' });
    expect(pillParts({ x: 0, w: 30 }, 40).mid).toBe('translateX(20px) scaleX(0)');
  });

  it('countAt', () => {
    const to = 1234;
    expect(countAt(to, 0)).toBe(0);
    expect(countAt(to, COUNT_MS / 2)).toBe(Math.round(to * 0.875));
    expect(countAt(to, 550)).toBe(Math.round(to * 0.875));
    expect(countAt(to, 1100)).toBe(to);
    expect(countAt(to, 5000)).toBe(to);
    expect(countAt(to, -10)).toBe(0);
    expect(countAt(to, 10, 0)).toBe(to);
    expect(countAt(to, 10, -1)).toBe(to);
  });

  it('rippleBox', () => {
    expect(rippleBox({ left: 10, top: 20, width: 100, height: 40 }, 60, 40)).toEqual({ size: 200, left: -50, top: -80 });
    expect(rippleBox({ left: 0, top: 0, width: 30, height: 80 }, 0, 0)).toEqual({ size: 160, left: -80, top: -80 });
  });
});
