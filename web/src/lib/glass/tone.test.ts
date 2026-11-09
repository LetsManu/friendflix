// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AA, AMB_PEAK, BLUR_BRIGHTNESS, cachedTone, clearTones, contrast, DARK_BASE, frostComposite, luminance, MILK_RGB, SCRIM_LIGHT, SCRIM_MAX, SCRIM_MIN,
  MILK_TOP, SCRIM_RGB, SCRIM_SAFE, scrimFor, tintColor, TINT_LUM_MAX, toneFor, toneOf, toneVars, type RGB,
} from './tone';

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const passes = (back: RGB, s: number, tint: RGB | null = null) => contrast(WHITE, frostComposite(back, s, tint)) >= AA;

describe('tone maths', () => {
  it('luminance and contrast match WCAG', () => {
    expect(luminance(WHITE)).toBeCloseTo(1, 6);
    expect(luminance(BLACK)).toBe(0);
    expect(contrast(WHITE, BLACK)).toBeCloseTo(21, 6);
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 6); // order does not matter
    expect(Math.abs(contrast([118, 116, 123], WHITE) - 4.6)).toBeLessThan(0.05);
    expect(luminance([2, 2, 2])).toBeCloseTo(2 / 255 / 12.92, 8); // the linear segment
  });

  it('frostComposite brightens the backdrop like the blur does (brightness 1.05, clamped)', () => {
    expect(BLUR_BRIGHTNESS).toBe(1.05);
    expect(frostComposite([100, 100, 100], 0)).toEqual([0, 1, 2].map((i) => Math.round(105 * 0.81 + MILK_RGB[i]! * 0.19)));
    expect(frostComposite([250, 250, 250], 0)).toEqual(frostComposite(WHITE, 0)); // 262.5 clamps to 255
  });

  it('what scrimFor picks passes AA on screen for mid and light greys (brightness included)', () => {
    // an independent model of the painted surface: brightened backdrop, scrim, milk at its top alpha
    const onScreen = (c: number, s: number): RGB => {
      const b = Math.min(255, c * 1.05);
      return [0, 1, 2].map((i) => Math.round((b * (1 - s) + SCRIM_RGB[i]! * s) * (1 - MILK_TOP) + MILK_RGB[i]! * MILK_TOP)) as RGB;
    };
    for (let c = 120; c <= 230; c += 5) expect(contrast(WHITE, onScreen(c, scrimFor([c, c, c])))).toBeGreaterThanOrEqual(4.5);
  });

  it('a glass button hover must not add milk over the same scrim (app.css .frost-btn:hover lights the edge instead)', () => {
    expect(contrast(WHITE, frostComposite(WHITE, SCRIM_SAFE))).toBeGreaterThanOrEqual(AA);
    expect(contrast(WHITE, frostComposite(WHITE, SCRIM_SAFE, null, MILK_TOP + 0.07))).toBeLessThan(AA);
    // nor would raising the scrim along with it keep every computed scrim passing
    expect(contrast(WHITE, frostComposite([180, 180, 180], scrimFor([180, 180, 180]) + 0.04, null, MILK_TOP + 0.07))).toBeLessThan(AA);
  });

  it('frostComposite paints backdrop, scrim, milk, then the tint', () => {
    // no scrim, no tint: only the milk over the backdrop
    expect(frostComposite(BLACK, 0)).toEqual(MILK_RGB.map((c) => Math.round(c * 0.19)));
    // a full scrim hides the backdrop
    expect(frostComposite(WHITE, 1)).toEqual(frostComposite(BLACK, 1));
    expect(frostComposite(WHITE, 1)).toEqual(SCRIM_RGB.map((c, i) => Math.round(c * 0.81 + MILK_RGB[i]! * 0.19)));
    // the tint wash sits between them at .5
    const tinted = frostComposite(BLACK, 1, [200, 0, 0]);
    expect(tinted[0]).toBeGreaterThan(frostComposite(BLACK, 1)[0]);
    // the tint is the top layer: half of it shows over whatever is under it
    expect(frostComposite(BLACK, 1, [200, 0, 0])).toEqual(frostComposite(BLACK, 1).map((c, i) => Math.round(c * 0.5 + [200, 0, 0][i]! * 0.5)));
  });

  it('the safe default passes over pure white', () => {
    expect(contrast(WHITE, frostComposite(WHITE, SCRIM_SAFE))).toBeGreaterThanOrEqual(4.5);
  });

  it('the light scrim keeps surfaces over the dark ambient background milky and still passes AA', () => {
    expect(SCRIM_LIGHT).toBe(SCRIM_MIN);
    expect(SCRIM_LIGHT).toBeLessThanOrEqual(0.2);
    // the dark base and the brightest glow of the ambient background need no more than the light scrim
    expect(scrimFor(DARK_BASE)).toBe(SCRIM_LIGHT);
    expect(scrimFor(AMB_PEAK)).toBe(SCRIM_LIGHT);
    expect(passes(DARK_BASE, SCRIM_LIGHT)).toBe(true);
    expect(passes(AMB_PEAK, SCRIM_LIGHT)).toBe(true);
    expect(contrast(WHITE, frostComposite(DARK_BASE, SCRIM_LIGHT))).toBeGreaterThan(10); // far above AA
    // but the light scrim alone would fail over bright, unsampled artwork: that needs the heavy one
    expect(passes(WHITE, SCRIM_LIGHT)).toBe(false);
    expect(scrimFor(WHITE)).toBeGreaterThan(0.6);
  });

  it('scrimFor', () => {
    const w = scrimFor(WHITE);
    expect(w).toBeGreaterThanOrEqual(0.66);
    expect(w).toBeLessThanOrEqual(0.7);
    expect(scrimFor([10, 9, 13])).toBe(SCRIM_MIN);
    for (let c = 0; c <= 255; c += 32) {
      const s = scrimFor([c, c, c]);
      expect(passes([c, c, c], s) || s === SCRIM_MAX).toBe(true);
      expect(s).toBeGreaterThanOrEqual(SCRIM_MIN);
      expect(Math.round(s * 100) / 100).toBe(s); // two decimals
    }
    const s255 = scrimFor(WHITE);
    expect(passes(WHITE, s255)).toBe(true);
    expect(passes(WHITE, s255 - 0.02)).toBe(false); // the smallest that passes
    const warm: RGB = [240, 170, 70], tint = tintColor(warm);
    const sw = scrimFor(warm, tint);
    expect(passes(warm, sw, tint) || sw === SCRIM_MAX).toBe(true);
    expect(passes(warm, sw) || sw === SCRIM_MAX).toBe(true); // also where the tint wash has faded out
    // over a dark backdrop a light tint makes the tinted composite the lighter one: it must pass too
    const lightTint: RGB = tintColor([255, 250, 240]);
    expect(scrimFor(DARK_BASE, null, 9)).toBe(SCRIM_MIN); // untinted, 9:1 is easy
    expect(contrast(WHITE, frostComposite(DARK_BASE, SCRIM_MAX, lightTint))).toBeLessThan(9);
    expect(scrimFor(DARK_BASE, lightTint, 9)).toBe(SCRIM_MAX); // the tinted one never gets there
    expect(scrimFor(WHITE, null, 30)).toBe(SCRIM_MAX); // nothing reaches 30:1
    // bright sampled art: a heavy scrim; dark sampled art: the light one
    expect(scrimFor([250, 245, 235], tintColor([250, 245, 235]))).toBeGreaterThanOrEqual(0.6);
    expect(scrimFor([30, 25, 40], tintColor([30, 25, 40]))).toBe(SCRIM_LIGHT);
  });

  it('tintColor keeps hue and caps luminance', () => {
    const t = tintColor([240, 170, 70]);
    expect(luminance(t)).toBeLessThanOrEqual(TINT_LUM_MAX);
    expect(t[0]).toBeGreaterThan(t[1]);
    expect(t[1]).toBeGreaterThan(t[2]);
    expect(t[0] / t[1]).toBeCloseTo(240 / 170, 1);
    expect(tintColor([20, 30, 40])).toEqual([20, 30, 40]);
    expect(luminance(tintColor(WHITE))).toBeLessThanOrEqual(TINT_LUM_MAX);
  });
});

/** RGBA pixels from [rgb, alpha] runs */
function px(...runs: [number, RGB, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [n, c, a] of runs) for (let i = 0; i < n; i++) out.push(...c, a);
  return new Uint8ClampedArray(out);
}

describe('toneOf', () => {
  it('transparent pixels are ignored', () => {
    const t = toneOf(px([10, [200, 40, 60], 255], [90, WHITE, 0]))!;
    expect(t.bright).toEqual([200, 40, 60]);
    expect(t.tint).toEqual(tintColor([200, 40, 60]));
    expect(t.scrim).toBe(scrimFor([200, 40, 60], t.tint));
  });

  it('all-transparent gives null', () => {
    expect(toneOf(px([50, WHITE, 0]))).toBeNull();
    expect(toneOf(new Uint8ClampedArray(0))).toBeNull();
  });

  it('the brightest tenth decides the scrim', () => {
    const t = toneOf(px([90, BLACK, 255], [10, WHITE, 255]))!;
    expect(t.bright).toEqual([255, 255, 255]);
    expect(t.scrim).toBeGreaterThanOrEqual(0.66);
    // a single pixel still counts as the brightest tenth
    expect(toneOf(px([1, [30, 30, 30], 255]))!.bright).toEqual([30, 30, 30]);
  });

  it('a dark picture keeps the light scrim', () => {
    expect(toneOf(px([100, [20, 18, 30], 255]))!.scrim).toBe(SCRIM_LIGHT);
  });

  it('weights colourful pixels like dominantColor', () => {
    const t = toneOf(px([75, BLACK, 255], [25, [30, 120, 220], 255]))!;
    expect(t.tint[2]).toBeGreaterThan(t.tint[0]);
  });
});

let pixels: Uint8ClampedArray;
let noContext = false;
let throwOnRead = false;
let loads = 0;
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(v: string) { loads++; queueMicrotask(() => (v.includes('broken') ? this.onerror?.() : this.onload?.())); }
}

describe('toneFor', () => {
  beforeEach(() => {
    clearTones();
    pixels = px([576, [200, 40, 60], 255]);
    noContext = false; throwOnRead = false; loads = 0;
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: (_k: string, o: { willReadFrequently?: boolean }) => {
          expect(o.willReadFrequently).toBe(true);
          return noContext ? null : {
            drawImage: () => undefined,
            getImageData: () => { if (throwOnRead) throw new DOMException('tainted', 'SecurityError'); return { data: pixels }; },
          };
        },
      }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('toneFor caches per key (32 max) and returns null on load or taint errors', async () => {
    expect(cachedTone('a')).toBeUndefined();
    const t = await toneFor('a', '/a.jpg');
    expect(t).toEqual(toneOf(pixels));
    expect(cachedTone('a')).toEqual(t);
    expect(await toneFor('a', '/other.jpg')).toBe(t); // from the cache, no second load
    expect(loads).toBe(1);

    // two callers for one key at once: one load, one result
    const [p1, p2] = [toneFor('both', '/b.jpg'), toneFor('both', '/b.jpg')];
    expect(p2).toBe(p1);
    expect(await p1).toEqual(t);
    expect(loads).toBe(2);
    expect(await toneFor('broken', '/broken.jpg')).toBeNull();
    expect(cachedTone('broken')).toBeNull(); // null is cached too
    expect(await toneFor('broken', '/broken.jpg')).toBeNull();
    expect(loads).toBe(3);

    noContext = true;
    expect(await toneFor('noctx', '/a.jpg')).toBeNull();
    noContext = false;
    throwOnRead = true; // a cross-origin picture taints the canvas
    expect(await toneFor('taint', '/a.jpg')).toBeNull();
    throwOnRead = false;

    clearTones();
    for (let i = 0; i < 32; i++) await toneFor(`k${i}`, '/a.jpg');
    expect(cachedTone('k0')).not.toBeUndefined();
    await toneFor('k32', '/a.jpg'); // the 33rd key evicts the first
    expect(cachedTone('k0')).toBeUndefined();
    expect(cachedTone('k1')).not.toBeUndefined();
    expect(cachedTone('k32')).not.toBeUndefined();
  });
});

describe('toneVars', () => {
  it('toneVars', () => {
    expect(toneVars(null)).toBe('');
    expect(toneVars({ tint: [1, 2, 3], bright: WHITE, scrim: 0.42 })).toBe('--fr-tint:1, 2, 3;--fr-scrim:0.42');
  });
});
