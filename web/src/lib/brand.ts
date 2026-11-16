// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable, type Readable } from 'svelte/store';
import { DEFAULT_APP_NAME, setAppName, tr } from '#lib/i18n';
import { DEFAULT_ACCENT, DEFAULT_TOKENS, deriveTokens, lightenUntil, mixHex, rgbTriplet, type BrandTokens } from './brandColors';
import { AMB_PEAK, contrast as rgbContrast, DARK_BASE, frostComposite, SCRIM_LIGHT, type RGB } from './glass/tone';
import { rememberBrandName } from './sw/brandName';

/**
 * The instance's brand in the web app (branding plan Task 2): name, byline, colours, glow, icons. It loads before sign-in from the
 * public route `GET /api/public/brand` (no session; open during setup) and is applied to the page:
 * - the derived colour tokens (`tokens.*`, #rrggbb only) as inline custom properties on `<html>` (the CSP allows style attributes,
 *   not `<style>` elements), plus the palette derived from them (`brandPalette`: --acc-rgb, --acc-glass, --mark-from, --mark-to).
 *   Only those colour values ever reach a style: no brand text field is written into CSS;
 * - the glow as a class `glow-<mode>` on `<html>` (app.css paints `.frost-amb` per mode);
 * - the name for every `{app}` in the texts (i18n `setAppName`), the tab title, the home-screen title, the icons (the symbol, when
 *   there is one).
 * The last answer is kept in localStorage (`ff.brand`) and applied synchronously when this module loads, so a known brand shows on
 * the first paint instead of the defaults. There is no push channel: the page refetches when the tab becomes visible again
 * (`refetchOnVisible`) and the admin page calls `loadBrand()` after a save.
 */

export type BrandHeader = 'wordmark' | 'symbol' | 'logo';
export type BrandGlow = 'accent' | 'accentViolet' | 'neutral' | 'off';
export type BrandSignInBg = 'posters' | 'image' | 'color';

/** the public fields (the backend's PublicBrand, backend/src/brand/schema.ts) */
export interface PublicBrand {
  name: string;
  byline: string;
  /** '' = the name */
  shortName: string;
  website: string;
  about: string;
  header: BrandHeader;
  accent: string;
  glow: BrandGlow;
  signInBg: BrandSignInBg;
  logo: string | null;
  symbol: string | null;
  signInImage: string | null;
}

/** the URLs of the brand's images (same origin, content-hashed, immutable) */
export interface BrandImages { logo?: string; symbol?: string; signIn?: string }

export interface LoadedBrand {
  rev: number;
  brand: PublicBrand;
  tokens: BrandTokens;
  images: BrandImages;
  /** the name (never blank) */
  name: string;
  /** the short name for home screens, the name when none is set */
  shortName: string;
}

export const GLOWS: readonly BrandGlow[] = ['accent', 'accentViolet', 'neutral', 'off'];
const HEADERS: readonly BrandHeader[] = ['wordmark', 'symbol', 'logo'];
const SIGN_IN_BGS: readonly BrandSignInBg[] = ['posters', 'image', 'color'];

export const DEFAULT_BRAND: Readonly<PublicBrand> = Object.freeze({
  name: DEFAULT_APP_NAME, byline: '', shortName: '', website: '', about: '', header: 'wordmark', accent: '#ff4f6d', glow: 'accentViolet',
  signInBg: 'posters', logo: null, symbol: null, signInImage: null,
});

export const DEFAULT_LOADED: Readonly<LoadedBrand> = Object.freeze({
  rev: 0, brand: DEFAULT_BRAND, tokens: DEFAULT_TOKENS, images: {}, name: DEFAULT_APP_NAME, shortName: DEFAULT_APP_NAME,
});

/** localStorage key of the last answer */
export const BRAND_CACHE_KEY = 'ff.brand';
export const BRAND_URL = '/api/public/brand';

/** the token → custom property map: the only values this module writes into a style */
const TOKEN_PROPS: ReadonlyArray<readonly [keyof Omit<BrandTokens, 'adjusted'>, string]> = [
  ['acc', '--acc'], ['accHover', '--acc-hover'], ['accFill', '--acc-fill'], ['accFillHover', '--acc-fill-hover'], ['accText', '--acc-text'],
  ['accLight', '--acc-light'], ['accLine', '--acc-line'],
];
const HEX = /^#[0-9a-f]{6}$/;
const RGB_TRIPLET = /^\d{1,3}, \d{1,3}, \d{1,3}$/;
const HASH = /^[0-9a-f]{64}$/;
/** an image URL of the public image route (nothing else becomes an icon or an <img> source) */
const IMAGE_URL = /^\/api\/public\/brand\/img\/[0-9a-f]{64}\.(png|webp)$/;
/** the page's dark background: the browser chrome colour (app.html, manifest.ts); the brand does not change it */
export const THEME_COLOR = '#101418';

// ---- the palette around the tokens (web only: the shades of the mark, the glass text, the glows) ----

/**
 * The shades the web derives from the tokens for its own surfaces (Task 3). The default accent keeps today's values verbatim, so an
 * unbranded instance looks exactly as before; any other accent derives them:
 * - `glassText` (`--acc-glass`): accent text on the light glass cards (`.panel`, `.frost-text`). `accLight` lightened until it
 *   passes AA on every background of GLASS_TEXT_ON (the light card over the ambient peak and over the base, the raw peak, the solid
 *   fallback, the ranked strip over a white poster);
 * - `rgb` (`--acc-rgb`): the accent as "r, g, b", for the translucent accent washes (`rgba(var(--acc-rgb), .13)`: works where
 *   `color-mix()` does not, the TV browsers);
 * - `markFrom` / `markTo` (`--mark-from`, `--mark-to`): the gradient of the built-in mark (the F tile) and the sign-in pill avatar;
 * - `flare`: the light flash of the intro ("r, g, b"); `wall`: the warm glow behind the sign-in wall; `deep`: the dark top of the
 *   year-in-review card; `art`: the bright colours of the generated sign-in tiles.
 */
export interface BrandPalette { glassText: string; rgb: string; markFrom: string; markTo: string; flare: string; wall: string; deep: string; art: string[] }

const DEFAULT_PALETTE: Readonly<BrandPalette> = Object.freeze({
  glassText: '#ffa7b6', rgb: '255, 79, 109', markFrom: '#ff6b81', markTo: '#e23c5b', flare: '255, 120, 140', wall: '#3a1a2a', deep: '#5a1424',
  art: Object.freeze(['#ff4f6d', '#d6325a', '#ff6b81']) as unknown as string[],
});

const SOLID_FALLBACK: RGB = [28, 26, 33]; // --fr-solid #1c1a21
/**
 * the backgrounds accent text on light glass must pass AA on: lib/glass/pages.test.ts ON_GLASS_BG (the card over the ambient peak,
 * the raw peak, the card over the base, the solid fallback) and the ranked strip's glass (.92 scrim) over a white poster
 * (lib/a11y/contrast.test.ts)
 */
export const GLASS_TEXT_ON: readonly RGB[] = [
  frostComposite(AMB_PEAK, SCRIM_LIGHT), AMB_PEAK, frostComposite(DARK_BASE, SCRIM_LIGHT), SOLID_FALLBACK, frostComposite([255, 255, 255], 0.92),
];
const hexRgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const glassOk = (c: string) => GLASS_TEXT_ON.every((bg) => rgbContrast(hexRgb(c), bg) >= 4.5);

/** true for today's coral (the stylesheet's own values) */
export const isDefaultAccent = (t: BrandTokens): boolean => t.acc === DEFAULT_ACCENT && t.accFill === DEFAULT_TOKENS.accFill && t.accLight === DEFAULT_TOKENS.accLight;

/** the palette of the tokens (see BrandPalette) */
export function brandPalette(t: BrandTokens): BrandPalette {
  if (isDefaultAccent(t)) return { ...DEFAULT_PALETTE, art: [...DEFAULT_PALETTE.art] };
  return {
    glassText: lightenUntil(t.accLight, glassOk),
    rgb: rgbTriplet(t.acc),
    markFrom: t.acc,
    markTo: t.accFill,
    flare: rgbTriplet(mixHex(t.acc, '#ffffff', 0.22)),
    wall: mixHex(THEME_COLOR, t.accFill, 0.21),
    deep: mixHex('#000000', t.accFill, 0.42),
    art: [t.acc, t.accFill, mixHex(t.acc, '#ffffff', 0.15)],
  };
}

// ---- what the surfaces show ----

/** the name's first character (a whole grapheme: an emoji stays whole), upper-cased: the symbol without an upload */
export function brandInitial(name: string): string {
  const s = name.trim() || DEFAULT_APP_NAME;
  let first = [...s][0] ?? 'F';
  try {
    const seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    if (seg) for (const g of new seg(undefined, { granularity: 'grapheme' }).segment(s)) { first = g.segment; break; }
  } catch { /* no Segmenter: the first code point */ }
  return first.toLocaleUpperCase();
}

/** the built-in FriendFlix mark (the F tile) is the symbol: no uploaded symbol and the shipped name */
export const builtInMark = (b: LoadedBrand): boolean => !b.images.symbol && b.name === DEFAULT_APP_NAME;

/**
 * What a header bar shows for the brand's header style:
 * - `wordmark`: the name as lettering. FriendFlix's own wordmark is its F tile plus the lettering (today's header); any other name
 *   is the lettering alone;
 * - `symbol`: the symbol (the upload, the F tile, or the initial on the accent fill) plus the name;
 * - `logo`: the uploaded logo alone (without an upload: symbol plus name).
 */
export function headerParts(b: LoadedBrand): { mark: boolean; name: boolean; logo: string | null } {
  if (b.brand.header === 'logo' && b.images.logo) return { mark: false, name: false, logo: b.images.logo };
  if (b.brand.header === 'wordmark') return { mark: builtInMark(b), name: true, logo: null };
  return { mark: true, name: true, logo: null };
}

/** the custom properties beyond the tokens (the palette), each value checked to be a colour right here */
function paletteProps(t: BrandTokens): Array<[string, string]> {
  const p = brandPalette(t);
  return [['--acc-rgb', p.rgb], ['--acc-glass', p.glassText], ['--mark-from', p.markFrom], ['--mark-to', p.markTo]];
}

// ---- parsing (an answer of the public route, or the cached copy) ----

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** a text of at most `max` characters (code points), else the default; the backend validated it, this guards the cached copy */
const textOr = (v: unknown, max: number, dflt: string): string => (typeof v === 'string' && [...v].length <= max ? v : dflt);
const oneOf = <T extends string>(v: unknown, all: readonly T[], dflt: T): T => (all.includes(v as T) ? (v as T) : dflt);
const hashOr = (v: unknown): string | null => (typeof v === 'string' && HASH.test(v) ? v : null);

function parseFields(v: unknown): PublicBrand {
  const b = isObj(v) ? v : {};
  const name = textOr(b.name, 24, '').trim();
  return {
    name: name || DEFAULT_BRAND.name,
    byline: textOr(b.byline, 32, ''),
    shortName: textOr(b.shortName, 12, ''),
    website: typeof b.website === 'string' && /^https?:\/\//i.test(b.website) && b.website.length <= 400 ? b.website : '',
    about: textOr(b.about, 280, ''),
    header: oneOf(b.header, HEADERS, DEFAULT_BRAND.header),
    accent: typeof b.accent === 'string' && HEX.test(b.accent) ? b.accent : DEFAULT_BRAND.accent,
    glow: oneOf(b.glow, GLOWS, DEFAULT_BRAND.glow),
    signInBg: oneOf(b.signInBg, SIGN_IN_BGS, DEFAULT_BRAND.signInBg),
    logo: hashOr(b.logo),
    symbol: hashOr(b.symbol),
    signInImage: hashOr(b.signInImage),
  };
}

/** the answer's tokens when every one is a #rrggbb colour, else the ones the accent derives to (the same algorithm as the backend) */
function parseTokens(v: unknown, accent: string): BrandTokens {
  const t = isObj(v) ? v : {};
  const adj = isObj(t.adjusted) ? t.adjusted : {};
  if (TOKEN_PROPS.every(([k]) => typeof t[k] === 'string' && HEX.test(t[k] as string)) && typeof adj.text === 'boolean' && typeof adj.fill === 'boolean') {
    const out = Object.fromEntries(TOKEN_PROPS.map(([k]) => [k, t[k]])) as Omit<BrandTokens, 'adjusted'>;
    return { ...out, adjusted: { text: adj.text, fill: adj.fill } };
  }
  return deriveTokens(accent);
}

function parseImages(v: unknown): BrandImages {
  const i = isObj(v) ? v : {};
  const out: BrandImages = {};
  for (const k of ['logo', 'symbol', 'signIn'] as const) if (typeof i[k] === 'string' && IMAGE_URL.test(i[k] as string)) out[k] = i[k] as string;
  return out;
}

/** a brand from the public route's answer (or the cached copy of one); null when it is not one */
export function parseBrand(raw: unknown): LoadedBrand | null {
  if (!isObj(raw) || !isObj(raw.brand) || typeof raw.rev !== 'number' || !Number.isSafeInteger(raw.rev) || raw.rev < 0) return null;
  const brand = parseFields(raw.brand);
  return {
    rev: raw.rev, brand, tokens: parseTokens(raw.tokens, brand.accent), images: parseImages(raw.images),
    name: brand.name, shortName: brand.shortName.trim() || brand.name,
  };
}

// ---- applying ----

const store = writable<LoadedBrand>(DEFAULT_LOADED);
/** the brand the page shows (the defaults until one is applied) */
export const brand: Readable<LoadedBrand> = { subscribe: store.subscribe };

const known = writable(false);
/**
 * true once the page knows its brand: a cached one was applied, or the first fetch answered (or failed: the defaults stand). A
 * surface whose content depends on a brand choice (the sign-in wall fetches covers only for `posters`) waits for it, so a first visit
 * does not flash the defaults' content.
 */
export const brandKnown: Readable<boolean> = { subscribe: known.subscribe };

/** what applyBrand last applied (null: nothing yet, the page shows app.html's and app.css's defaults) */
let applied: LoadedBrand | null = null;

const docOrNull = (): Document | null => (typeof document === 'undefined' ? null : document);

/**
 * The tab title in the new name: the bare name (app.html's title, the start page) or a page title made by `common.pageTitle`
 * (`{page} – {app}`), recognised by the old name. Pages set their titles with `$t('common.pageTitle')`, which follows `{app}` on its
 * own; this covers the moment until they render again.
 */
function retitle(doc: Document, from: string, to: string): void {
  if (from === to) return;
  if (doc.title === from) { doc.title = to; return; }
  const MARK = '\uE002'; // a private-use character no title contains
  const [pre = '', post = ''] = tr('common.pageTitle', { page: MARK, app: from }).split(MARK);
  const title = doc.title;
  if (title.length >= pre.length + post.length && title.startsWith(pre) && title.endsWith(post)) {
    doc.title = tr('common.pageTitle', { page: title.slice(pre.length, title.length - post.length), app: to });
  }
}

const ICONS = 'link[rel="icon"], link[rel="apple-touch-icon"]';
const DEFAULT_ATTR = (a: string) => `data-ff-default-${a}`;

/** the icons point at the symbol, or back at app.html's own files (remembered on the first change) */
function setIcons(doc: Document, symbol: string | undefined): void {
  const mime = symbol?.endsWith('.webp') ? 'image/webp' : 'image/png';
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>(ICONS))) {
    const attrs = ['href', 'type', 'sizes'] as const;
    if (link.getAttribute(DEFAULT_ATTR('href')) === null) for (const a of attrs) link.setAttribute(DEFAULT_ATTR(a), link.getAttribute(a) ?? '');
    const icon = link.getAttribute('rel') === 'icon';
    if (symbol) {
      link.setAttribute('href', symbol);
      if (icon) { link.setAttribute('type', mime); link.removeAttribute('sizes'); }
      continue;
    }
    for (const a of attrs) {
      const d = link.getAttribute(DEFAULT_ATTR(a)) ?? '';
      if (d) link.setAttribute(a, d); else link.removeAttribute(a);
    }
  }
}

function setMeta(doc: Document, name: string, content: string): void {
  doc.querySelector(`meta[name="${name}"]`)?.setAttribute('content', content);
}

/**
 * Shows `b` on the page: the colour tokens (inline custom properties on <html>), the glow class, the name (`{app}`, the tab title,
 * the home-screen title), the icons and the theme colour; then the `brand` store.
 */
export function applyBrand(b: LoadedBrand, doc: Document | null = docOrNull()): void {
  const prev = applied?.name ?? DEFAULT_APP_NAME;
  applied = b;
  setAppName(b.name);
  if (doc) {
    const root = doc.documentElement;
    // only the derived tokens, each checked to be #rrggbb right here: never a brand text field, never anything else
    for (const [k, prop] of TOKEN_PROPS) {
      const v = b.tokens[k];
      if (typeof v === 'string' && HEX.test(v)) root.style.setProperty(prop, v);
    }
    // the palette (derived from those tokens only; lib/brand.ts brandPalette): #rrggbb or "r, g, b" and nothing else
    if (TOKEN_PROPS.every(([k]) => HEX.test(b.tokens[k]))) {
      for (const [prop, v] of paletteProps(b.tokens)) if (HEX.test(v) || RGB_TRIPLET.test(v)) root.style.setProperty(prop, v);
    }
    for (const g of GLOWS) root.classList.remove(`glow-${g}`);
    root.classList.add(`glow-${GLOWS.includes(b.brand.glow) ? b.brand.glow : DEFAULT_BRAND.glow}`);
    retitle(doc, prev, b.name);
    setMeta(doc, 'apple-mobile-web-app-title', b.shortName);
    setMeta(doc, 'theme-color', THEME_COLOR);
    setIcons(doc, b.images.symbol);
  }
  store.set(b);
  known.set(true);
}

// ---- cache ----

function readCache(): LoadedBrand | null {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    return raw ? parseBrand(JSON.parse(raw)) : null;
  } catch {
    return null; // blocked storage, or not JSON
  }
}

function writeCache(b: LoadedBrand): void {
  try { localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(b)); } catch { /* private mode, quota */ }
  void rememberBrandName(b.name); // the service worker's default notification title (lib/sw/brandName.ts)
}

/** applies the cached brand (synchronously); false when there is none */
export function applyCached(doc: Document | null = docOrNull()): boolean {
  const c = readCache();
  if (c) applyBrand(c, doc);
  return c !== null;
}

const same = (a: LoadedBrand, b: LoadedBrand) => JSON.stringify(a) === JSON.stringify(b);

// ---- loading ----

let seq = 0;
/**
 * Fetches the public brand, keeps it in the cache and applies it when it differs from what the page shows. Before the first answer
 * the cached brand is applied at once. A failed request (offline, an older backend) keeps what is shown; of overlapping calls the last
 * one wins.
 */
export async function loadBrand(fetchFn: typeof fetch = fetch): Promise<void> {
  if (!applied) applyCached();
  const my = ++seq;
  let next: LoadedBrand | null;
  try {
    const r = await fetchFn(BRAND_URL, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!r.ok) { known.set(true); return; }
    next = parseBrand(await r.json());
  } catch {
    known.set(true); // offline, an older backend: the defaults (or the cached brand) stand
    return;
  }
  if (!next) known.set(true);
  if (!next || my !== seq) return;
  writeCache(next);
  if (applied && same(applied, next)) { known.set(true); return; }
  applyBrand(next);
}

/**
 * Refetches the brand when the tab becomes visible again (at most every `minGapMs`); it is applied only when it changed (another
 * admin saved meanwhile). Returns the function that stops listening.
 */
export function refetchOnVisible(fetchFn: typeof fetch = fetch, minGapMs = 10_000): () => void {
  const doc = docOrNull();
  if (!doc) return () => undefined;
  let last = -Infinity;
  const onChange = () => {
    if (doc.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - last < minGapMs) return;
    last = now;
    void loadBrand(fetchFn);
  };
  doc.addEventListener('visibilitychange', onChange);
  return () => doc.removeEventListener('visibilitychange', onChange);
}

/** tests: forget what was applied */
export function resetBrandForTests(): void {
  applied = null;
  seq = 0;
  store.set(DEFAULT_LOADED);
  known.set(false);
  setAppName(null);
}

// boot: the last known brand before anything renders (the layout imports this module before its first render)
if (typeof window !== 'undefined') applyCached();
