// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AA, AMB_PEAK, BLUR_BRIGHTNESS, cachedTone, clearTones, contrast, DARK_BASE, frostComposite, luminance, MILK_RGB, SCRIM_LIGHT, SCRIM_MAX, SCRIM_MIN,
  MILK_TOP, SCRIM_RGB, SCRIM_SAFE, scrimFor, tintColor, TINT_LUM_MAX, toneFor, toneOf, toneVars, type RGB,
  BD, SCRIM_SAFE_DIM, TEXT_DIM, textContrast, menuScrim, SCRIM_MENU, SEL_A, GRAIN_LIFT, MENU_SCRIM_MAX,
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

  it('backdrop keys (BD) have their own small cache: they never push card tones out', async () => {
    for (let i = 0; i < 32; i++) await toneFor(`k${i}`, '/a.jpg');
    for (let i = 0; i < 9; i++) await toneFor(`${BD}${i}`, '/bd.jpg');
    expect(cachedTone('k0')).not.toBeUndefined();
    expect(cachedTone(`${BD}0`)).toBeUndefined(); // the 9th backdrop evicts the first
    expect(cachedTone(`${BD}8`)).not.toBeUndefined();
    expect(cachedTone(`${BD}1`)).not.toBeUndefined();
    clearTones();
    expect(cachedTone(`${BD}8`)).toBeUndefined();
  });

  it('an <img> that has loaded is drawn as it is (no second load); one still loading loads its currentSrc', async () => {
    let drawn: unknown = null;
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (i: unknown) => { drawn = i; }, getImageData: () => ({ data: pixels }) }) }),
    });
    const done = { complete: true, naturalWidth: 640, currentSrc: '/x.jpg', src: '/x.jpg' } as unknown as HTMLImageElement;
    expect(await toneFor(`${BD}done`, done)).toEqual(toneOf(pixels));
    expect(drawn).toBe(done);
    expect(loads).toBe(0);
    const busy = { complete: false, naturalWidth: 0, currentSrc: '/y.jpg', src: '/y-fallback.jpg' } as unknown as HTMLImageElement;
    expect(await toneFor(`${BD}busy`, busy)).toEqual(toneOf(pixels));
    expect(loads).toBe(1);
    expect(drawn).toBeInstanceOf(FakeImage);
    const noCur = { complete: true, naturalWidth: 0, currentSrc: '', src: '/broken.jpg' } as unknown as HTMLImageElement; // a failed picture
    expect(await toneFor(`${BD}nocur`, noCur)).toBeNull();
    expect(loads).toBe(2);
  });
});

describe('toneVars', () => {
  it('toneVars', () => {
    expect(toneVars(null)).toBe('');
    expect(toneVars({ tint: [1, 2, 3], bright: WHITE, scrim: 0.42 })).toBe('--fr-tint:1, 2, 3;--fr-scrim:0.42');
  });
  it('toneVars solves the scrim for the dimmest text when asked, never lighter than the tone\'s own', () => {
    const t = toneOf(px([576, [255, 255, 255], 255]))!;
    const want = scrimFor(t.bright, t.tint, AA, TEXT_DIM);
    expect(want).toBeGreaterThan(t.scrim);
    expect(toneVars(t, TEXT_DIM)).toBe(`--fr-tint:${t.tint.join(', ')};--fr-scrim:${want}`);
    // a dark picture: the light scrim is enough for dim text too (the tone's scrim stays)
    const d = toneOf(px([576, [20, 18, 26], 255]))!;
    expect(toneVars(d, TEXT_DIM)).toBe(toneVars(d));
    expect(toneVars({ tint: [1, 2, 3], bright: [0, 0, 0], scrim: 0.6 }, TEXT_DIM)).toBe('--fr-tint:1, 2, 3;--fr-scrim:0.6');
  });
});

describe('dim text on glass (secondary lines, inactive tabs)', () => {
  it('textContrast: white at an alpha over a colour; alpha 1 is plain white', () => {
    expect(textContrast([60, 60, 60])).toBeCloseTo(contrast(WHITE, [60, 60, 60]), 6);
    expect(textContrast([60, 60, 60], 0.5)).toBeLessThan(textContrast([60, 60, 60]));
    expect(textContrast([60, 60, 60], 0)).toBeCloseTo(1, 6);
  });
  it('scrimFor with TEXT_DIM: the dim text passes AA over pure white (worst tint too); .72 white cannot at any scrim', () => {
    const tint = tintColor(WHITE);
    const s = scrimFor(WHITE, tint, AA, TEXT_DIM);
    expect(s).toBeLessThan(SCRIM_MAX);
    expect(textContrast(frostComposite(WHITE, s), TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    expect(textContrast(frostComposite(WHITE, s, tint), TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    expect(textContrast(frostComposite(WHITE, SCRIM_MAX), 0.72)).toBeLessThan(AA); // why the dim colours went up to .9
    // the plain-white scrim is too light for it
    expect(textContrast(frostComposite(WHITE, SCRIM_SAFE), TEXT_DIM)).toBeLessThan(AA);
    expect(scrimFor(WHITE, null, AA, 0.5)).toBe(SCRIM_MAX); // nothing passes: the heaviest
  });
  it('SCRIM_MENU: white rows on the light pill and TEXT_DIM notes pass AA over any grey', () => {
    expect(SEL_A).toBe(0.13);
    expect(SCRIM_MENU).toBe(menuScrim(WHITE));
    expect(SCRIM_MENU).toBeGreaterThanOrEqual(SCRIM_SAFE_DIM); // the pill needs more than the dim text alone
    expect(SCRIM_MENU).toBeGreaterThan(SCRIM_MAX - 0.01);
    expect(SCRIM_MENU).toBeLessThanOrEqual(MENU_SCRIM_MAX);
    const sel = (c: RGB): RGB => c.map((x) => Math.min(255, x * (1 - SEL_A) + 255 * SEL_A + GRAIN_LIFT)) as RGB;
    for (let c = 0; c <= 255; c += 15) {
      const comp = frostComposite([c, c, c], SCRIM_MENU);
      expect(textContrast(sel(comp))).toBeGreaterThanOrEqual(AA);
      expect(textContrast(comp, TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    }
    expect(menuScrim(DARK_BASE)).toBe(SCRIM_MIN); // over the dark base the light scrim does
    expect(menuScrim(WHITE, 0.5)).toBe(MENU_SCRIM_MAX); // nothing passes: the heaviest
  });
  it('SCRIM_SAFE_DIM: the safe scrim for TEXT_DIM surfaces over unsampled artwork', () => {
    expect(SCRIM_SAFE_DIM).toBe(scrimFor(WHITE, tintColor(WHITE), AA, TEXT_DIM));
    expect(SCRIM_SAFE_DIM).toBeGreaterThan(SCRIM_SAFE);
    for (let c = 0; c <= 255; c += 15) {
      const back: RGB = [c, c, c];
      expect(textContrast(frostComposite(back, SCRIM_SAFE_DIM), TEXT_DIM)).toBeGreaterThanOrEqual(AA);
      expect(textContrast(frostComposite(back, SCRIM_SAFE_DIM, tintColor(WHITE)), TEXT_DIM)).toBeGreaterThanOrEqual(AA);
    }
  });
  it('the light coral (#ff8aa0) eyebrow: on the bare panel it fails over bright artwork, on its .5 scrim underlay it passes', () => {
    const coral: RGB = [255, 138, 160];
    const under = (c: RGB, a: number): RGB => c.map((v, i) => Math.round(v * (1 - a) + SCRIM_RGB[i]! * a)) as RGB;
    // the bare panel: only over a near-black backdrop (the milk lightens what is behind it); the coral accent not even there
    expect(contrast(coral, frostComposite([20, 19, 24], SCRIM_SAFE_DIM))).toBeGreaterThanOrEqual(AA);
    expect(contrast(coral, frostComposite(WHITE, SCRIM_MAX))).toBeLessThan(AA);
    expect(contrast([255, 79, 109], frostComposite([20, 19, 24], SCRIM_SAFE))).toBeLessThan(AA);
    // DetailDesk .eyebrow: the scrim colour at .5 under it passes over any grey backdrop, with the worst tint, at the scrims the
    // panel can have there (solved for its dim text, or the safe one)
    for (let c = 0; c <= 255; c += 15) {
      const back: RGB = [c, c, c];
      for (const s of [scrimFor(back, tintColor(WHITE), AA, TEXT_DIM), SCRIM_SAFE_DIM, SCRIM_MAX]) {
        expect(contrast(coral, under(frostComposite(back, s), 0.5))).toBeGreaterThanOrEqual(AA);
        expect(contrast(coral, under(frostComposite(back, s, tintColor(WHITE)), 0.5))).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});
