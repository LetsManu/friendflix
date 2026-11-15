// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ allowed: true, level: 'full' as 'full' | 'reduced', watched: 0 }));
vi.mock('#lib/preview', () => ({ motionAllowed: () => m.allowed }));
vi.mock('#lib/tv/motion', () => ({ motionLevel: () => m.level, watchFrames: () => { m.watched++; } }));

import {
  COUNT_MS, countAt, cubicBezier, fxMode, grow, growBoth, growFrom, GROW_IN_MS, GROW_OUT_MS, growShift, emphOut, inEase, outEase, PILL_MID, pillParts,
  REDUCED_MS, rippleBox, scrimFade, twoWay, SHEET_IN_MS, SHEET_OUT_MS, sheetSlide, springEase, TOAST_IN_MS, TOAST_OUT_MS, toastRise, barRise, BAR_IN_MS, BAR_OUT_MS,
  dialogRise, dialogBoth, DIALOG_IN_MS, DIALOG_OUT_MS,
} from './fx';

type Cfg = ReturnType<typeof grow>;
const node = {} as Element;
const box = (left: number, top: number, width: number, height: number) => ({ getBoundingClientRect: () => ({ left, top, width, height }) }) as unknown as Element;
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
  it('growShift slides down from a trigger above and up from one below, at most 8 px', () => {
    const pop = { left: 100, top: 100, width: 300, height: 200 };
    expect(growShift({ left: 180, top: 60, width: 40, height: 40 }, pop)).toEqual({ x: 0, y: -8 });
    expect(growShift({ left: 180, top: 400, width: 40, height: 40 }, pop)).toEqual({ x: 0, y: 8 });
  });

  it('growShift: a side-opening popover slides 8 px sideways from its trigger, never vertically', () => {
    const pop = { left: 100, top: 100, width: 300, height: 200 };
    // the trigger sits level with the popover, left of it: the popover opens to the right and slides in from the left
    expect(growShift({ left: 20, top: 150, width: 40, height: 40 }, pop)).toEqual({ x: -8, y: 0 });
    // right of it: it opens to the left and slides in from the right
    expect(growShift({ left: 420, top: 150, width: 40, height: 40 }, pop)).toEqual({ x: 8, y: 0 });
    // level with the popover's top or bottom third (still overlapping the trigger's centre line): the same rule
    expect(growShift({ left: 20, top: 90, width: 40, height: 40 }, pop)).toEqual({ x: -8, y: 0 });
    expect(growShift({ left: 420, top: 270, width: 40, height: 40 }, pop)).toEqual({ x: 8, y: 0 });
    // and the css starts 8 px to that side, on x only
    expect(grow(node, { shift: { x: -8, y: 0 }, mode: 'full' }).css(0, 1)).toBe('transform:translate(-8px,0px);opacity:0');
    expect(grow(node, { shift: { x: 8, y: 0 }, mode: 'full' }).css(0, 1)).toBe('transform:translate(8px,0px);opacity:0');
  });

  it('grow css never scales', () => {
    for (const dir of ['in', 'out'] as const) {
      const g = grow(node, { dir, mode: 'full' });
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(g.css(t, 1 - t)).not.toMatch(/scale/);
        expect(g.css(t, 1 - t)).toMatch(/translate/);
      }
    }
  });

  it('grow moves at most 8 px', () => {
    for (const shift of [undefined, { x: 0, y: -8 }, { x: 8, y: 0 }]) {
      const g = grow(node, { shift, mode: 'full' });
      const m0 = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(g.css(0, 1))!;
      expect(Math.abs(Number(m0[1]))).toBeLessThanOrEqual(8);
      expect(Math.abs(Number(m0[2]))).toBeLessThanOrEqual(8);
      expect(g.css(1, 0)).toMatch(/translate\(0px,\s*0px\)/);
    }
  });

  it('no pop-up easing overshoots', () => {
    for (const e of [grow(node, { mode: 'full' }).easing, sheetSlide(node, { mode: 'full' }).easing, toastRise(node, { mode: 'full' }).easing]) {
      const v = Array.from({ length: 201 }, (_, i) => e(i / 200));
      expect(Math.max(...v)).toBeLessThanOrEqual(1);
      expect(Math.min(...v)).toBeGreaterThanOrEqual(0);
    }
    expect(emphOut(0)).toBe(0);
    expect(emphOut(1)).toBe(1);
  });

  it('reverses mid-flight without a jump', () => {
    const el = { getBoundingClientRect: () => ({ left: 0, top: 50, width: 200, height: 100 }) } as unknown as Element;
    const g = growBoth(el, { trigger: box(80, 0, 40, 40), mode: 'full' });
    const fin = g({ direction: 'in' }), fout = g({ direction: 'out' });
    // the frame Svelte 5 draws `p` into a run from t1 to t2 (transitions.js animate(): t = t1 + (t2 - t1) * easing(p))
    const at = (c: Cfg, t1: number, t2: number, p: number) => { const t = t1 + (t2 - t1) * c.easing(p); return c.css(t, 1 - t); };
    const ty = (css: string) => Number(/translate\(-?[\d.]+px,\s*(-?[\d.]+)px\)/.exec(css)![1]);
    for (const p of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      // a close p into the opening: the closing run starts where the opening stood, same position and opacity
      const now = fin.easing(p);
      expect(at(fout, now, 0, 0), `close at ${p}`).toBe(at(fin, 0, 1, p));
      // and moves on from there toward its start, by less than a pixel in its first 1/60 of the way
      expect(Math.abs(ty(at(fout, now, 0, 1 / 60)) - ty(at(fout, now, 0, 0)))).toBeLessThan(1);
      // a reopen p into the closing: the same, the other way round
      const back = 1 - fout.easing(p);
      expect(at(fin, back, 1, 0), `reopen at ${p}`).toBe(at(fout, 1, 0, p));
      // the css is one function of t whichever way it runs ('both' included)
      expect(fout.css(now, 1 - now)).toBe(fin.css(now, 1 - now));
      expect(g({ direction: 'both' }).css(now, 1 - now)).toBe(fin.css(now, 1 - now));
    }
    // the shift is the one measured at the open, kept for the close
    expect(fout.css(0, 1)).toBe(fin.css(0, 1));
    expect(fin.css(0, 1)).toBe('transform:translate(0px,-8px);opacity:0');
  });

  it('grow per mode', () => {
    const fin = grow(node, { shift: { x: 0, y: -8 }, mode: 'full' });
    expect(fin.duration).toBe(GROW_IN_MS);
    expect(fin.duration).toBe(220);
    expect(fin.delay).toBe(0);
    expect(fin.easing).toBe(emphOut);
    expect(fin.css(0, 1)).toBe('transform:translate(0px,-8px);opacity:0');
    expect(fin.css(1, 0)).toBe('transform:translate(0px,0px);opacity:1');
    const fout = grow(node, { dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(GROW_OUT_MS);
    expect(fout.duration).toBe(150);
    expect(fout.easing).toBe(inEase);
    const red = grow(node, { mode: 'reduced', shift: { x: 1, y: 1 } });
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
    expect(grow(node).duration).toBe(220);
    expect(grow(node).css(1, 0)).toContain('translate(0px,0px)');
    m.level = 'reduced';
    expect(grow(node).duration).toBe(160);
    m.allowed = false;
    expect(grow(node, { dir: 'out' }).duration).toBe(0);
    m.allowed = true; m.level = 'full';
  });
});

describe('growFrom, sheetSlide, toastRise, scrimFade', () => {
  it('growFrom measures the shift once (open) and keeps it for the close and a reverse', () => {
    let pop = { left: 100, top: 100, width: 300, height: 200 };
    const el = { getBoundingClientRect: () => pop } as unknown as Element;
    const trig = box(180, 60, 40, 40);
    const fin = growFrom(el, { trigger: trig, mode: 'full' });
    expect(fin.duration).toBe(220);
    expect(fin.css(0, 1)).toContain('translate(0px,-8px)');
    pop = { left: 40, top: 300, width: 120, height: 80 }; // moved mid-flight: not measured again
    const fout = growFrom(el, { trigger: trig, dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(150);
    expect(fout.css(0, 1)).toContain('translate(0px,-8px)');
    // no trigger and nothing measured: grow()'s default shift; the mode passes through
    const other = box(0, 0, 10, 10);
    expect(growFrom(other, { mode: 'full' }).css(0, 1)).toContain('translate(0px,-8px)');
    expect(growFrom(other, { trigger: null, mode: 'reduced' }).duration).toBe(160);
    expect(growFrom(other).duration).toBe(220);
  });

  it('twoWay / growBoth pick the config once the direction is known', () => {
    const make = vi.fn((dir: 'in' | 'out') => grow(node, { dir, mode: 'full' }));
    const t = twoWay(make);
    expect(make).not.toHaveBeenCalled();
    expect(t({ direction: 'in' }).duration).toBe(220);
    expect(t({ direction: 'out' }).duration).toBe(150);
    expect(t({ direction: 'both' }).duration).toBe(220);
    expect(t({}).duration).toBe(220);
    expect(t().duration).toBe(220);
    const el = { getBoundingClientRect: () => ({ left: 0, top: 50, width: 200, height: 100 }) } as unknown as Element;
    const g = growBoth(el, { trigger: box(80, 0, 40, 40), mode: 'full' });
    expect(g({ direction: 'in' }).css(0, 1)).toContain('translate(0px,-8px)');
    expect(g({ direction: 'out' }).easing).toBe(inEase);
    expect(growBoth(el)({ direction: 'in' }).duration).toBe(220);
  });

  it('sheetSlide from the right edge moves on x with the same timing', () => {
    const fin = sheetSlide(node, { mode: 'full', side: 'right' });
    expect(fin.duration).toBe(320);
    expect(fin.css(0, 1)).toBe('transform:translateX(100%)');
    expect(fin.css(1, 0)).toBe('transform:translateX(0%)');
    expect(sheetSlide(node, { dir: 'out', mode: 'full', side: 'right' }).css(0.25, 0.75)).toBe('transform:translateX(75%)');
    expect(sheetSlide(node, { mode: 'reduced', side: 'right' }).css(0.5, 0.5)).toBe('opacity:0.5');
    expect(sheetSlide(node, { mode: 'still', side: 'right' }).duration).toBe(0);
  });

  it('sheetSlide per mode', () => {
    const fin = sheetSlide(node, { mode: 'full' });
    expect(fin.duration).toBe(SHEET_IN_MS);
    expect(fin.duration).toBe(320);
    expect(fin.delay).toBe(0);
    expect(fin.easing).toBe(emphOut);
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
    expect(sheetSlide(node).duration).toBe(320);
    m.allowed = false;
    expect(sheetSlide(node).duration).toBe(0);
    m.allowed = true;
  });

  it('toastRise per mode', () => {
    const fin = toastRise(node, { mode: 'full' });
    expect(fin.duration).toBe(TOAST_IN_MS);
    expect(fin.duration).toBe(300);
    expect(fin.easing).toBe(emphOut);
    expect(fin.css(0, 1)).toBe('transform:translateY(140%);opacity:0');
    expect(fin.css(1, 0)).toBe('transform:translateY(0%);opacity:1');
    expect(fin.css(1.1, -0.1)).toBe('transform:translateY(-14%);opacity:1'); // extrapolated past 1: opacity stays ≤ 1
    expect(fin.css(-0.1, 1.1)).toContain('opacity:0');
    const fout = toastRise(node, { dir: 'out', mode: 'full' });
    expect(fout.duration).toBe(TOAST_OUT_MS);
    expect(fout.duration).toBe(200);
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
  it('grow, sheetSlide, toastRise and dialogRise pulse it when built with full motion, never in the reduced set or when still', () => {
    for (const make of [grow, sheetSlide, toastRise, dialogRise]) {
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

describe('barRise (the cast bar)', () => {
  const node = {} as Element;
  it('rises 16 px with opacity, 240 ms in (outEase) and 180 ms out', () => {
    const fin = barRise(node, { mode: 'full' });
    expect([fin.duration, BAR_IN_MS]).toEqual([240, 240]);
    expect(fin.easing).toBe(outEase);
    expect(fin.css(0, 1)).toBe('transform:translateY(16px);opacity:0');
    expect(fin.css(1, 0)).toBe('transform:translateY(0px);opacity:1');
    const fout = barRise(node, { dir: 'out', mode: 'full' });
    expect([fout.duration, BAR_OUT_MS]).toEqual([180, 180]);
    expect(fout.css(0, 1)).toBe('transform:translateY(16px);opacity:0');
  });
  it('reduced set crossfades, still is instant', () => {
    expect(barRise(node, { mode: 'reduced' }).css(0.5, 0.5)).toBe('opacity:0.5');
    const still = barRise(node, { mode: 'still' });
    expect(still.duration).toBe(0);
    expect(still.css(0, 1)).toBe('');
  });
});

describe('dialogRise (ModalShell)', () => {
  const ty = (css: string) => /^transform:translateY\((-?\d+)px\);opacity:([\d.]+)$/.exec(css);
  it('dialogRise never scales and moves at most 10 px, in whole pixels', () => {
    for (const dir of ['in', 'out'] as const) {
      const d = dialogRise(node, { dir, mode: 'full' });
      for (let i = 0; i <= 20; i++) {
        const t = i / 20, css = d.css(t, 1 - t);
        expect(css).not.toMatch(/scale|zoom|font-size|letter-spacing/);
        const m = ty(css)!;
        expect(m, css).not.toBeNull();
        expect(Number(m[1])).toBeGreaterThanOrEqual(0);
        expect(Number(m[1])).toBeLessThanOrEqual(10);
        expect(Number(m[2])).toBe(t);
      }
      expect(d.css(0, 1)).toBe('transform:translateY(10px);opacity:0');
      expect(d.css(1, 0)).toBe('transform:translateY(0px);opacity:1');
      expect(d.css(0.5, 0.5)).toBe('transform:translateY(5px);opacity:0.5');
    }
  });

  it('dialogRise is symmetric: the close at t stands where the open stood at t', () => {
    const fin = dialogRise(node, { mode: 'full' }), fout = dialogRise(node, { dir: 'out', mode: 'full' });
    for (const t of ts) expect(fout.css(t, 1 - t)).toBe(fin.css(t, 1 - t));
    // a close mid-open (Svelte starts the close from the current t) continues from the same frame
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const now = fin.easing(p);
      expect(fout.css(now + (0 - now) * fout.easing(0), 1 - now)).toBe(fin.css(now, 1 - now));
    }
  });

  it('dialogRise per mode: 220 ms emphOut in, 150 ms inEase out; the reduced set fades 160 ms; still is instant', () => {
    const fin = dialogRise(node, { mode: 'full' });
    expect([fin.duration, DIALOG_IN_MS, fin.delay]).toEqual([220, 220, 0]);
    expect(fin.easing).toBe(emphOut);
    const fout = dialogRise(node, { dir: 'out', mode: 'full' });
    expect([fout.duration, DIALOG_OUT_MS]).toEqual([150, 150]);
    expect(fout.easing).toBe(inEase);
    for (const e of [fin.easing, fout.easing]) {
      const v = Array.from({ length: 201 }, (_, i) => e(i / 200));
      expect(Math.max(...v)).toBeLessThanOrEqual(1);
      expect(Math.min(...v)).toBeGreaterThanOrEqual(0);
    }
    const red = dialogRise(node, { dir: 'out', mode: 'reduced' });
    expect(red.duration).toBe(160);
    expect(red.css(0.5, 0.5)).toBe('opacity:0.5');
    expect(red.easing(0.3)).toBe(0.3);
    for (const dir of ['in', 'out'] as const) {
      const still = dialogRise(node, { dir, mode: 'still' });
      expect(still.duration).toBe(0);
      expect(still.css(0, 1)).toBe('');
    }
    // the page's mode by default: calm mode is instant
    m.allowed = false;
    expect(dialogRise(node).duration).toBe(0);
    m.allowed = true; m.level = 'full';
    expect(dialogRise(node).duration).toBe(220);
  });

  it('dialogBoth picks the direction once Svelte knows it', () => {
    const b = dialogBoth(node, { mode: 'full' });
    expect(b({ direction: 'in' }).duration).toBe(220);
    expect(b({ direction: 'out' }).duration).toBe(150);
    expect(b({ direction: 'out' }).easing).toBe(inEase);
    expect(b().duration).toBe(220);
    expect(dialogBoth(node, { mode: 'still' })({ direction: 'out' }).duration).toBe(0);
  });
});
