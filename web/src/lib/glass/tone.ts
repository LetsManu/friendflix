// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Glass contrast and artwork tone (glass spec §1.3). A frost surface paints, from back to front: whatever is behind it (the
 * backdrop, 5 % brighter through the blur's `brightness(1.05)`) → the dark scrim (`--fr-scrim-rgb` at alpha `--fr-scrim`) →
 * the milk (`--fr-milk` at its lighter top alpha; scrim and milk are the element's background) → the tint wash (`.frost-tint`,
 * artwork colour at `.5`, §8.2). White text sits on that composite and must reach WCAG AA (4.5:1).
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
 * The ambient background's glows (`.frost-amb` in app.css, painted coral → violet → orange over `DARK_BASE`): colour and
 * peak alpha. The alphas are the demo's scaled to 0.6 (owner ruling 2026-11-09, B′): with them the mockup's text hierarchy
 * (dim white .72, hints .66, the plain status colours) reaches AA on the light glass cards over the brightest glow.
 */
export const AMB_ORANGE: RGB = [214, 92, 64];
export const AMB_ORANGE_A = 0.33;
export const AMB_VIOLET: RGB = [78, 64, 190];
export const AMB_VIOLET_A = 0.25;
export const AMB_CORAL: RGB = [255, 79, 109];
export const AMB_CORAL_A = 0.13;
/**
 * The brightest point of the ambient background: the centre of the orange glow (78 % 22 %). The coral and violet glows end
 * (their 70 % stop) before they reach it, so nothing stacks there (a sweep of the real gradients agrees).
 */
export const AMB_PEAK: RGB = over(DARK_BASE, AMB_ORANGE, AMB_ORANGE_A);

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

/** the `brightness()` in `--fr-blur`: the blurred backdrop is 5 % brighter than the picture behind it */
export const BLUR_BRIGHTNESS = 1.05;

/**
 * What white text sits on, in the painted order: the backdrop (brightened by `BLUR_BRIGHTNESS`, clamped) → the scrim at
 * `scrim` → the milk at `milk` (the element's own background) → the tint wash at `TINT_PEAK` (if any; `.frost-tint` paints
 * above the background), rounded.
 */
export function frostComposite(back: RGB, scrim: number, tint: RGB | null = null, milk = MILK_TOP): RGB {
  let c = back.map((v) => Math.min(255, v * BLUR_BRIGHTNESS)) as RGB;
  c = over(c, SCRIM_RGB, scrim);
  c = over(c, MILK_RGB, milk);
  if (tint) c = over(c, tint, TINT_PEAK);
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}

/** white text at `alpha` over `c`, and its contrast against `c` (alpha 1: plain white) */
export function textContrast(c: RGB, alpha = 1): number {
  return contrast(over(c, WHITE, alpha), c);
}

/**
 * The lightest scrim in `SCRIM_MIN…SCRIM_MAX` (steps of .02) that gives the surface's dimmest text, white at `text` alpha,
 * `target` contrast; `SCRIM_MAX` if none does. The tint wash is a radial gradient that fades out towards the far corner, so
 * text can sit where it is at its peak or where it is gone: with a tint both composites must pass (the worst case decides; a
 * dark tint never lowers the scrim).
 */
export function scrimFor(bright: RGB, tint: RGB | null = null, target = AA, text = 1): number {
  const ok = (s: number) => textContrast(frostComposite(bright, s), text) >= target && (!tint || textContrast(frostComposite(bright, s, tint), text) >= target);
  for (let i = 0; ; i++) {
    const s = Math.round((SCRIM_MIN + i * 0.02) * 100) / 100;
    if (s > SCRIM_MAX) return SCRIM_MAX;
    if (ok(s)) return s;
  }
}

/**
 * The dimmest text on glass over artwork (the detail panel's secondary lines, inactive tab labels): white at this alpha. Such
 * surfaces solve their scrim for it (`scrimFor(…, TEXT_DIM)`, `toneVars(t, TEXT_DIM)`) instead of for plain white.
 */
export const TEXT_DIM = 0.9;
/**
 * The safe scrim for surfaces with `TEXT_DIM` text over unsampled artwork: their dimmest text passes AA over pure white with
 * the brightest possible tint (set it as the surface's `--fr-scrim-safe`; `.frost-safe` then uses it).
 */
export const SCRIM_SAFE_DIM = scrimFor(WHITE, tintColor(WHITE), AA, TEXT_DIM);

/** the light pill (`--fr-sel`) a hovered, focused or selected menu row draws over the glass: white at this alpha */
export const SEL_A = 0.13;
/**
 * The phone tab bar (lib/phone/TabBar.svelte): its inactive labels are white at `TAB_DIM` (the mockup's dim text), the active
 * one white on the light pill (`SEL_A`). `SCRIM_TAB` is the lightest scrim (steps of .01) with which both pass AA over pure
 * white (posters scroll under the bar unsampled).
 */
export const TAB_DIM = 0.72;
export const SCRIM_TAB = 0.84;
/** the brightest the glass grain (overlay, `--fr-grain-a`) lifts a pixel, in 8-bit levels (measured on screen over white) */
export const GRAIN_LIFT = 4;
/** menus may go past SCRIM_MAX: their light pill over a white backdrop needs it */
export const MENU_SCRIM_MAX = 0.9;
/**
 * The scrim a menu, sheet or toast (glass spec §5) needs over `bright`: its row text is white on the light pill (`SEL_A`, with the
 * grain's brightest lift, as the pill brings the text closest to the limit) and its dimmest text (non-interactive notes, never
 * on the pill) white at `dim`; both pass AA. No tint (menus are not tinted). The smallest such scrim in
 * `SCRIM_MIN…MENU_SCRIM_MAX` (steps of .02), else `MENU_SCRIM_MAX`.
 */
export function menuScrim(bright: RGB, dim = TEXT_DIM): number {
  for (let i = 0; ; i++) {
    const s = Math.round((SCRIM_MIN + i * 0.02) * 100) / 100;
    if (s > MENU_SCRIM_MAX) return MENU_SCRIM_MAX;
    const c = frostComposite(bright, s);
    const pill = over(c, WHITE, SEL_A).map((x) => Math.min(255, x + GRAIN_LIFT)) as RGB;
    if (textContrast(pill) >= AA && textContrast(c, dim) >= AA) return s;
  }
}
export const SCRIM_MENU = menuScrim(WHITE);

/** the cast bar's text inks over the glass (`.72` white lines, amber warning, light-red error); the expanded panel's lighter ones are `.78` */
export const BAR_INKS = { dim: 0.72, warn: [247, 179, 68] as RGB, error: [255, 168, 168] as RGB };
/**
 * The scrim of the floating cast bar (`.box`, `.exp`): it floats over any content (posters, white buttons), so its dimmest white
 * line and its amber and error lines pass AA over pure white. The smallest scrim in `SCRIM_SAFE…MENU_SCRIM_MAX` (steps of .02).
 */
export function barScrim(bright: RGB = WHITE): number {
  for (let i = 0; ; i++) {
    const s = Math.round((SCRIM_SAFE + i * 0.02) * 100) / 100;
    if (s >= MENU_SCRIM_MAX) return MENU_SCRIM_MAX;
    const c = frostComposite(bright, s);
    if (textContrast(c, BAR_INKS.dim) >= AA && contrast(BAR_INKS.warn, c) >= AA && contrast(BAR_INKS.error, c) >= AA) return s;
  }
}
export const SCRIM_BAR = barScrim();

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

/**
 * Sampled tones per key (oldest out after `CACHE_MAX`); null is cached too (a picture that cannot be read stays unread).
 * Card and hover-card tones (item keys) and detail backdrops (keys starting with `BD`) keep separate caches, so the backdrops
 * of a few detail visits never push the cards' tones out.
 */
const CACHE_MAX = 32;
const BD_CACHE_MAX = 8;
/** the key prefix of a detail page's backdrop tone */
export const BD = 'bd:';
const cache = new Map<string, Tone | null>(), bdCache = new Map<string, Tone | null>();
const cacheOf = (key: string) => (key.startsWith(BD) ? bdCache : cache);
function remember(key: string, t: Tone | null) {
  const c = cacheOf(key), max = c === bdCache ? BD_CACHE_MAX : CACHE_MAX;
  c.delete(key);
  c.set(key, t);
  while (c.size > max) c.delete(c.keys().next().value!);
}

/** the tone sampled for `key` before: undefined when it never was */
export const cachedTone = (key: string): Tone | null | undefined => cacheOf(key).get(key);

/** the tone of a decoded picture, drawn on a 24×24 canvas; null without a 2D context or when the canvas is tainted */
function sample(img: CanvasImageSource): Tone | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, 24, 24);
    return toneOf(g.getImageData(0, 0, 24, 24).data);
  } catch {
    return null;
  }
}

/**
 * Samples a picture (same origin) once per `key`; null on load or taint errors. `src` is a URL (loaded and decoded here) or an
 * `<img>` on the page: one that has finished loading is drawn as it is (no second load or decode), else its `currentSrc` loads.
 */
const pending = new Map<string, Promise<Tone | null>>();
export function toneFor(key: string, src: string | HTMLImageElement): Promise<Tone | null> {
  const c = cacheOf(key);
  if (c.has(key)) return Promise.resolve(c.get(key)!);
  const busy = pending.get(key);
  if (busy) return busy; // the hover card and the detail page asking at once: one load, one sample
  const loaded = typeof src !== 'string' && src.complete && src.naturalWidth > 0;
  const p = (loaded ? Promise.resolve(sample(src)) : new Promise<Tone | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(sample(img));
    img.onerror = () => resolve(null);
    img.src = typeof src === 'string' ? src : src.currentSrc || src.src;
  })).then((t) => { pending.delete(key); remember(key, t); return t; });
  pending.set(key, p);
  return p;
}

/**
 * Inline custom properties for a surface (`style=`): the tint triple and the scrim; '' without a tone. `text` is the alpha of
 * the surface's dimmest white text (default plain white): below 1 the scrim is solved for it (never lighter than the tone's).
 */
export function toneVars(t: Tone | null, text = 1): string {
  if (!t) return '';
  const scrim = text < 1 ? Math.max(t.scrim, scrimFor(t.bright, t.tint, AA, text)) : t.scrim;
  return `--fr-tint:${t.tint[0]}, ${t.tint[1]}, ${t.tint[2]};--fr-scrim:${scrim}`;
}

/** test hook: forget every sampled tone */
export function clearTones(): void { cache.clear(); bdCache.clear(); pending.clear(); }
