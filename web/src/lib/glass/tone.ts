// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Glass contrast and artwork tone (glass spec §1.3). A frost surface is, from back to front: whatever is behind it (the
 * backdrop) → the dark scrim (`--fr-scrim-rgb` at alpha `--fr-scrim`) → the tint wash (artwork colour at `.5`, §8.2) → the
 * milk (`--fr-milk` at its lighter top alpha). White text sits on that composite and must reach WCAG AA (4.5:1).
 *
 * Two kinds of backdrop (owner ruling 2026-11-09): over the dark ambient app background the composite is dark anyway, so
 * surfaces keep a light scrim (`SCRIM_LIGHT`) and stay milky. Where bright content nobody sampled can sit behind (artwork,
 * video) a surface takes the safe scrim (`SCRIM_SAFE`, passes over pure white). Over sampled artwork `scrimFor` picks the
 * lightest scrim the maths allows: a dark picture gets the light scrim, a bright one up to the heavy one.
 */

export type RGB = [number, number, number];

/** the scrim colour (`--fr-scrim-rgb`) and the milk colour (`--fr-milk`) */
export const SCRIM_RGB: RGB = [18, 16, 24];
export const MILK_RGB: RGB = [236, 232, 244];
/** the milk gradient's lighter (top) alpha: the worst case for white text */
export const MILK_TOP = 0.19;
/** the tint wash's peak opacity (§8.2) */
export const TINT_PEAK = 0.5;
/** the lightest scrim: surfaces over the dark ambient app background (`--fr-scrim` default), keeps the milky look */
export const SCRIM_MIN = 0.2;
export const SCRIM_LIGHT = SCRIM_MIN;
/** the heaviest scrim `scrimFor` may return */
export const SCRIM_MAX = 0.8;
/** the safe scrim for bright content nobody sampled (`--fr-scrim-safe`, `.frost-safe`): passes AA over pure white */
export const SCRIM_SAFE = 0.7;
/** the tint colour's luminance cap: with it a passing scrim always exists */
export const TINT_LUM_MAX = 0.18;
/** WCAG AA for normal text */
export const AA = 4.5;
/** the ambient app background's base (`.frost-amb`, #0a090d) */
export const DARK_BASE: RGB = [10, 9, 13];
/**
 * The brightest point of the ambient background (`.frost-amb`): its warm orange glow (214,92,64 at .55) over the base with
 * the coral glow (255,79,109 at .22) on top, as if both peaked at the same spot. The light scrim must pass over this too.
 */
export const AMB_PEAK: RGB = over(over(DARK_BASE, [214, 92, 64], 0.55), [255, 79, 109], 0.22);

const WHITE: RGB = [255, 255, 255];
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

/** WCAG relative luminance of an sRGB colour (0..1) */
export function luminance(c: RGB): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio (1..21), whichever colour is lighter */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB "over": `top` at `alpha` on `back` (not rounded) */
function over(back: RGB, top: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => back[i]! * (1 - alpha) + top[i]! * alpha) as RGB;
}

/** the colour scaled down (same hue) in 1 % steps until its luminance is at most `TINT_LUM_MAX`; dark colours stay as they are */
export function tintColor(c: RGB): RGB {
  let k = 1;
  const at = (f: number): RGB => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];
  while (luminance(at(k)) > TINT_LUM_MAX && k > 0) k = Math.round((k - 0.01) * 100) / 100;
  return at(k);
}

/** what white text sits on: backdrop → scrim at `scrim` → tint at `TINT_PEAK` (if any) → milk at `MILK_TOP`, rounded */
export function frostComposite(back: RGB, scrim: number, tint: RGB | null = null): RGB {
  let c = over(back, SCRIM_RGB, scrim);
  if (tint) c = over(c, tint, TINT_PEAK);
  c = over(c, MILK_RGB, MILK_TOP);
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}

/**
 * The lightest scrim in `SCRIM_MIN…SCRIM_MAX` (steps of .02) that gives white text `target` contrast; `SCRIM_MAX` if none does.
 * The tint wash is a radial gradient that fades out towards the far corner, so text can sit where it is at its peak or where
 * it is gone: with a tint both composites must pass (the worst case decides; a dark tint never lowers the scrim).
 */
export function scrimFor(bright: RGB, tint: RGB | null = null, target = AA): number {
  const ok = (s: number) => contrast(WHITE, frostComposite(bright, s)) >= target && (!tint || contrast(WHITE, frostComposite(bright, s, tint)) >= target);
  for (let i = 0; ; i++) {
    const s = Math.round((SCRIM_MIN + i * 0.02) * 100) / 100;
    if (s > SCRIM_MAX) return SCRIM_MAX;
    if (ok(s)) return s;
  }
}

/** a sampled picture's tone: the tint colour, its bright end, and the scrim white text needs over it */
export type Tone = { tint: RGB; bright: RGB; scrim: number };

/** the tone of RGBA pixels (alpha > 0 only); null when no pixel counts */
export function toneOf(px: Uint8ClampedArray): Tone | null {
  const seen: RGB[] = [];
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const c: RGB = [px[i]!, px[i + 1]!, px[i + 2]!];
    seen.push(c);
    const mx = Math.max(...c), mn = Math.min(...c);
    const wt = 0.15 + (mx - mn) / 255 + (mx > 40 && mx < 235 ? 0.4 : 0); // the weights of dominantColor (#lib/tint)
    r += c[0] * wt; g += c[1] * wt; b += c[2] * wt; w += wt;
  }
  if (!seen.length) return null;
  const tint = tintColor([Math.round(r / w), Math.round(g / w), Math.round(b / w)]);
  const top = seen.map((c) => ({ c, l: luminance(c) })).sort((x, y) => y.l - x.l).slice(0, Math.max(1, Math.round(seen.length / 10)));
  const bright = [0, 1, 2].map((k) => Math.round(top.reduce((s, t) => s + t.c[k]!, 0) / top.length)) as RGB;
  return { tint, bright, scrim: scrimFor(bright, tint) };
}

/** sampled tones per item (oldest out after `CACHE_MAX`); null is cached too (a picture that cannot be read stays unread) */
const CACHE_MAX = 32;
const cache = new Map<string, Tone | null>();
function remember(key: string, t: Tone | null) {
  cache.delete(key);
  cache.set(key, t);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** the tone sampled for `key` before: undefined when it never was */
export const cachedTone = (key: string): Tone | null | undefined => cache.get(key);

/** samples `src` (same origin) on a 24×24 canvas once per `key`; null on load or taint errors */
export function toneFor(key: string, src: string): Promise<Tone | null> {
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  return new Promise<Tone | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, 24, 24);
        resolve(toneOf(g.getImageData(0, 0, 24, 24).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  }).then((t) => { remember(key, t); return t; });
}

/** inline custom properties for a surface (`style=`): the tint triple and the scrim; '' without a tone */
export function toneVars(t: Tone | null): string {
  return t ? `--fr-tint:${t.tint[0]}, ${t.tint[1]}, ${t.tint[2]};--fr-scrim:${t.scrim}` : '';
}

/** test hook: forget every sampled tone */
export function clearTones(): void { cache.clear(); }
