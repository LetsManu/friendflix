// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ allowed: true, level: 'full' as 'full' | 'reduced', watched: 0 }));
vi.mock('#lib/preview', () => ({ motionAllowed: () => m.allowed }));
vi.mock('#lib/tv/motion', () => ({ motionLevel: () => m.level, watchFrames: () => { m.watched++; } }));

import {
  COUNT_MS, countAt, cubicBezier, fxMode, grow, growBoth, growFrom, GROW_IN_MS, GROW_OUT_MS, growOrigin, inEase, outEase, PILL_MID, pillParts,
  REDUCED_MS, rippleBox, scrimFade, twoWay, SHEET_IN_MS, SHEET_OUT_MS, sheetSlide, springEase, TOAST_IN_MS, TOAST_OUT_MS, toastRise,
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

describe('growFrom, sheetSlide, toastRise, scrimFade', () => {
  const box = (left: number, top: number, width: number, height: number) => ({ getBoundingClientRect: () => ({ left, top, width, height }) }) as unknown as Element;

  it('growFrom measures the origin once (open) and keeps it for the close and a reverse', () => {
    let pop = { left: 100, top: 100, width: 300, height: 200 };
    const el = { getBoundingClientRect: () => pop } as unknown as Element;
    const trig = box(180, 60, 40, 40);
    const fin = growFrom(el, { trigger: trig, mode: 'full' });
    expect(fin.duration).toBe(380);
    expect(fin.css(1, 0)).toContain('transform-origin:100px 0px');
    pop = { left: 40, top: 40, width: 120, height: 80 }; // scaled mid-flight: not measured again
    const fout = growFrom(el, { trigger: trig, dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(200);
    expect(fout.css(0.5, 0.5)).toContain('transform-origin:100px 0px');
    // no trigger and nothing measured: grow()'s default origin; the mode passes through
    const other = box(0, 0, 10, 10);
    expect(growFrom(other, { mode: 'full' }).css(1, 0)).toContain('transform-origin:50% 0');
    expect(growFrom(other, { trigger: null, mode: 'reduced' }).duration).toBe(160);
    expect(growFrom(other).duration).toBe(380);
  });

  it('twoWay / growBoth pick the config once the direction is known', () => {
    const make = vi.fn((dir: 'in' | 'out') => grow(node, { dir, mode: 'full' }));
    const t = twoWay(make);
    expect(make).not.toHaveBeenCalled();
    expect(t({ direction: 'in' }).duration).toBe(380);
    expect(t({ direction: 'out' }).duration).toBe(200);
    expect(t({ direction: 'both' }).duration).toBe(380);
    expect(t({}).duration).toBe(380);
    expect(t().duration).toBe(380);
    const el = { getBoundingClientRect: () => ({ left: 0, top: 50, width: 200, height: 100 }) } as unknown as Element;
    const g = growBoth(el, { trigger: box(80, 0, 40, 40), mode: 'full' });
    expect(g({ direction: 'in' }).css(1, 0)).toContain('transform-origin:100px 0px');
    expect(g({ direction: 'out' }).easing).toBe(inEase);
    expect(growBoth(el)({ direction: 'in' }).duration).toBe(380);
  });

  it('sheetSlide per mode', () => {
    const fin = sheetSlide(node, { mode: 'full' });
    expect(fin.duration).toBe(SHEET_IN_MS);
    expect(fin.duration).toBe(380);
    expect(fin.delay).toBe(0);
    expect(fin.easing).toBe(springEase);
    expect(fin.css(0, 1)).toBe('transform:translateY(100%)');
    expect(fin.css(1, 0)).toBe('transform:translateY(0%)');
    expect(fin.css(0.5, 0.5)).toBe('transform:translateY(50%)');
    const fout = sheetSlide(node, { dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(SHEET_OUT_MS);
    expect(fout.duration).toBe(200);
    expect(fout.easing).toBe(inEase);
    expect(fout.css(0.25, 0.75)).toBe('transform:translateY(75%)');
    const red = sheetSlide(node, { mode: 'reduced' });
    expect(red.duration).toBe(160);
    expect(red.easing(0.3)).toBe(0.3);
    expect(red.css(0.5, 0.5)).toBe('opacity:0.5');
    const still = sheetSlide(node, { dir: 'out', mode: 'still' });
    expect(still.duration).toBe(0);
    expect(still.css(0, 1)).toBe('');
    expect(still.easing(0.4)).toBe(0.4);
    m.allowed = true; m.level = 'full';
    expect(sheetSlide(node).duration).toBe(380);
    m.allowed = false;
    expect(sheetSlide(node).duration).toBe(0);
    m.allowed = true;
  });

  it('toastRise per mode', () => {
    const fin = toastRise(node, { mode: 'full' });
    expect(fin.duration).toBe(TOAST_IN_MS);
    expect(fin.duration).toBe(420);
    expect(fin.easing).toBe(springEase);
    expect(fin.css(0, 1)).toBe('transform:translateY(140%);opacity:0');
    expect(fin.css(1, 0)).toBe('transform:translateY(0%);opacity:1');
    expect(fin.css(1.1, -0.1)).toBe('transform:translateY(-14%);opacity:1'); // the spring overshoots up; opacity stays ≤ 1
    expect(fin.css(-0.1, 1.1)).toContain('opacity:0');
    const fout = toastRise(node, { dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(TOAST_OUT_MS);
    expect(fout.duration).toBe(260);
    expect(fout.easing).toBe(inEase);
    const red = toastRise(node, { mode: 'reduced' });
    expect(red.duration).toBe(160);
    expect(red.css(0.5, 0.5)).toBe('opacity:0.5');
    expect(red.easing(0.2)).toBe(0.2);
    const still = toastRise(node, { mode: 'still' });
    expect(still.duration).toBe(0);
    expect(still.css(0, 1)).toBe('');
    expect(still.easing(0.7)).toBe(0.7);
    m.level = 'reduced';
    expect(toastRise(node).duration).toBe(160);
    m.level = 'full';
  });

  it('scrimFade per mode', () => {
    expect(scrimFade(node, { mode: 'full' }).duration).toBe(200);
    expect(scrimFade(node, { mode: 'reduced' }).duration).toBe(160);
    expect(scrimFade(node, { mode: 'still' }).duration).toBe(0);
    const f = scrimFade(node);
    expect(f.duration).toBe(200);
    expect(f.css(0.3)).toBe('opacity:0.3');
    expect(f.easing(0.3)).toBe(0.3);
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

describe('the frame guard watches glass motion', () => {
  it('grow, sheetSlide and toastRise pulse it when built with full motion, never in the reduced set or when still', () => {
    for (const make of [grow, sheetSlide, toastRise]) {
      m.watched = 0;
      make(node, { mode: 'full' });
      make(node, { dir: 'out', mode: 'full' });
      expect(m.watched).toBe(2);
      make(node, { mode: 'reduced' });
      make(node, { mode: 'still' });
      expect(m.watched).toBe(2);
    }
    // the mode from the page: full motion pulses, calm mode does not
    m.allowed = true; m.level = 'full'; m.watched = 0;
    grow(node);
    expect(m.watched).toBe(1);
    m.allowed = false;
    grow(node);
    expect(m.watched).toBe(1);
    m.allowed = true;
  });
});
