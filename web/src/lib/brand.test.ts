// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appName, setLocale, t, tr } from '#lib/i18n';
import { markParams, richParts } from '#lib/i18n/rich';
import {
  applyBrand, applyCached, brand, BRAND_CACHE_KEY, brandInitial, brandPalette, builtInMark, DEFAULT_LOADED, GLASS_TEXT_ON, headerParts, loadBrand, parseBrand,
  refetchOnVisible, resetBrandForTests,
} from './brand';
import { ACC_FILL_ON, ACC_LIGHT_ON, ACC_LINE_ON, ACC_TEXT_ON, contrast, DEFAULT_TOKENS, deriveTokens, TOKENS_VERSION, type BrandTokens } from './brandColors';
import { AMB_PEAK, contrast as rgbContrast, DARK_BASE, frostComposite, luminance, SCRIM_LIGHT, SCRIM_MENU, type RGB } from './glass/tone';

// Branding stage A, Task 2: the web loads the public brand before sign-in and applies its colour tokens (inline custom properties on
// <html>), glow, name ({app}, the tab title), home-screen title and icons. Browser APIs are small doubles (fake document, storage).

// ---- a fake document: <html> with style and classes, the head's meta and link elements, visibility events ----
class FakeEl {
  attrs = new Map<string, string>();
  constructor(init: Record<string, string>) { for (const [k, v] of Object.entries(init)) this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  removeAttribute(k: string) { this.attrs.delete(k); }
}
function fakeDoc() {
  const props = new Map<string, string>();
  const classes = new Set<string>();
  const metas = [new FakeEl({ name: 'apple-mobile-web-app-title', content: 'FriendFlix' }), new FakeEl({ name: 'theme-color', content: '#101418' })];
  const links = [
    new FakeEl({ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }),
    new FakeEl({ rel: 'icon', href: '/favicon.ico', sizes: '48x48' }),
    new FakeEl({ rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }),
  ];
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    title: 'FriendFlix',
    visibilityState: 'visible' as DocumentVisibilityState,
    documentElement: {
      style: { setProperty: vi.fn((k: string, v: string) => void props.set(k, v)), getPropertyValue: (k: string) => props.get(k) ?? '' },
      classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c), contains: (c: string) => classes.has(c) },
    },
    querySelector: (sel: string) => metas.find((m) => sel === `meta[name="${m.getAttribute('name')}"]`) ?? null,
    querySelectorAll: (sel: string) => (sel === 'link[rel="icon"], link[rel="apple-touch-icon"]' ? links : []),
    addEventListener: (type: string, fn: () => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
  };
  const fire = (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); };
  return { doc, props, classes, metas, links, fire, listeners };
}
type Fake = ReturnType<typeof fakeDoc>;
const asDoc = (f: Fake) => f.doc as unknown as Document;
const meta = (f: Fake, name: string) => f.metas.find((m) => m.getAttribute('name') === name)!.getAttribute('content');

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}

const HASH = 'a'.repeat(64);
/** a public-route answer: Nordlicht Kino in blue */
function answer(rev: number, over: Record<string, unknown> = {}, images: Record<string, string> = {}) {
  const accent = (over.accent as string | undefined) ?? '#4c9dff';
  return {
    rev,
    brand: {
      name: 'Nordlicht Kino', byline: 'by Anna Beispiel', shortName: 'Nordlicht', website: 'https://kino.example.com/', about: '', header: 'wordmark',
      accent, glow: 'accent', signInBg: 'posters', logo: null, symbol: null, signInImage: null, ...over,
    },
    tokens: deriveTokens(accent),
    images,
  };
}
const loaded = (raw: unknown) => parseBrand(raw)!;
const respond = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

let f: Fake;
let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  resetBrandForTests();
  f = fakeDoc();
  storage = fakeStorage();
  vi.stubGlobal('document', f.doc);
  vi.stubGlobal('localStorage', storage);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetBrandForTests();
  await setLocale('de');
});

describe('applyBrand', () => {
  it('applies tokens as inline custom properties', () => {
    const b = loaded(answer(3));
    applyBrand(b, asDoc(f));
    const tk = deriveTokens('#4c9dff');
    const pal = brandPalette(tk);
    expect(Object.fromEntries(f.props)).toEqual({
      '--acc': tk.acc, '--acc-hover': tk.accHover, '--acc-fill': tk.accFill, '--acc-fill-hover': tk.accFillHover, '--acc-text': tk.accText,
      '--acc-light': tk.accLight, '--acc-line': tk.accLine,
      // the palette around them (Task 3): the accent as "r, g, b", the glass text, the built-in mark's gradient
      '--acc-rgb': pal.rgb, '--acc-glass': pal.glassText, '--mark-from': pal.markFrom, '--mark-to': pal.markTo,
    });
    expect(pal.rgb).toBe('76, 157, 255');
    expect([...f.classes]).toEqual(['glow-accent']);
    expect(get(brand)).toBe(b);
    // another glow replaces the class
    applyBrand(loaded(answer(4, { glow: 'off' })), asDoc(f));
    expect([...f.classes]).toEqual(['glow-off']);
  });

  it('only the derived #rrggbb tokens reach a style: never a brand text field, never anything else', () => {
    // a hostile answer: text fields that look like CSS, tokens that are not colours
    const evil = 'x;background:url(//a.example)';
    const raw = answer(5, { name: '};--acc:red', byline: evil, about: `}html{${evil}}`, accent: '#4c9dff' });
    const b = loaded({ ...raw, tokens: { ...raw.tokens, acc: evil } });
    expect([b.name, b.brand.byline]).toEqual(['};--acc:red', evil]);
    applyBrand(b, asDoc(f));
    // the bad token made parseBrand derive all of them from the accent instead
    expect(b.tokens).toEqual(deriveTokens('#4c9dff'));
    // and applyBrand itself checks every value again (a LoadedBrand built by hand)
    applyBrand({ ...b, tokens: { ...b.tokens, accLine: evil } as BrandTokens }, asDoc(f));
    expect(f.doc.documentElement.style.setProperty.mock.calls.map(([k]) => k).every((k) => k.startsWith('--acc') || k.startsWith('--mark-'))).toBe(true);
    // the hand-built brand with a bad token wrote no palette (it is derived from the tokens, so only from valid ones)
    expect(f.doc.documentElement.style.setProperty.mock.calls.filter(([k]) => k === '--acc-rgb')).toHaveLength(1);
    for (const [k, v] of f.doc.documentElement.style.setProperty.mock.calls) {
      expect(v, k).toMatch(k === '--acc-rgb' ? /^\d{1,3}, \d{1,3}, \d{1,3}$/ : /^#[0-9a-f]{6}$/);
      expect(v).not.toContain(b.brand.byline);
    }
    // no brand field value is ever written as a property value
    const written = f.doc.documentElement.style.setProperty.mock.calls.map(([, v]) => v);
    for (const field of Object.values(b.brand)) if (typeof field === 'string' && field && !/^#[0-9a-f]{6}$/.test(field)) expect(written).not.toContain(field);
  });

  it('sets the name for {app}, the tab title (bare and page titles), the home-screen title and the theme colour', () => {
    applyBrand(loaded(answer(1)), asDoc(f));
    expect(f.doc.title).toBe('Nordlicht Kino');
    expect(meta(f, 'apple-mobile-web-app-title')).toBe('Nordlicht');
    expect(meta(f, 'theme-color')).toBe('#101418');
    f.doc.title = tr('common.pageTitle', { page: 'Einstellungen' });
    expect(f.doc.title).toBe('Einstellungen – Nordlicht Kino');
    applyBrand(loaded(answer(2, { name: 'Kinoabend', shortName: '' })), asDoc(f));
    expect(f.doc.title).toBe('Einstellungen – Kinoabend');
    expect(meta(f, 'apple-mobile-web-app-title')).toBe('Kinoabend'); // no short name: the name
    f.doc.title = 'Something else';
    applyBrand(loaded(answer(3, { name: 'Filmclub' })), asDoc(f));
    expect(f.doc.title).toBe('Something else'); // not a title of ours: left alone
  });

  it('no symbol keeps the default icons; a symbol replaces them, and removing it restores them', () => {
    applyBrand(loaded(answer(1)), asDoc(f));
    expect(f.links.map((l) => [l.getAttribute('href'), l.getAttribute('type'), l.getAttribute('sizes')])).toEqual([
      ['/favicon.svg', 'image/svg+xml', null], ['/favicon.ico', null, '48x48'], ['/apple-touch-icon.png', null, null],
    ]);
    const url = `/api/public/brand/img/${HASH}.png`;
    applyBrand(loaded(answer(2, { symbol: HASH }, { symbol: url })), asDoc(f));
    expect(f.links.map((l) => [l.getAttribute('href'), l.getAttribute('type'), l.getAttribute('sizes')])).toEqual([
      [url, 'image/png', null], [url, 'image/png', null], [url, null, null],
    ]);
    applyBrand(loaded(answer(3)), asDoc(f));
    expect(f.links.map((l) => [l.getAttribute('href'), l.getAttribute('type'), l.getAttribute('sizes')])).toEqual([
      ['/favicon.svg', 'image/svg+xml', null], ['/favicon.ico', null, '48x48'], ['/apple-touch-icon.png', null, null],
    ]);
    // an image URL that is not the public image route is dropped
    expect(loaded(answer(4, {}, { symbol: 'https://cdn.example.com/x.png', logo: `/api/public/brand/img/${HASH}.svg` })).images).toEqual({});
  });
});

describe('parseBrand', () => {
  it('rejects what is not an answer, and falls back to the default per field', () => {
    for (const bad of [null, 'x', [], {}, { rev: -1, brand: {} }, { rev: 1.5, brand: {} }, { rev: 1 }]) expect(parseBrand(bad), JSON.stringify(bad)).toBeNull();
    const b = loaded({ rev: 2, brand: { name: '   ', glow: 'rainbow', header: 'banner', signInBg: 'video', accent: 'red', logo: 'abc', byline: 'x'.repeat(33), website: 'javascript:alert(1)' } });
    expect(b.brand).toEqual(DEFAULT_LOADED.brand);
    expect(b.tokens).toEqual(DEFAULT_TOKENS);
    expect([b.name, b.shortName]).toEqual(['FriendFlix', 'FriendFlix']);
  });
});

describe('loading', () => {
  it('cached brand applies before the fetch resolves', async () => {
    storage.setItem(BRAND_CACHE_KEY, JSON.stringify(loaded(answer(7))));
    let resolve!: (r: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const done = loadBrand(fetchFn as unknown as typeof fetch);
    // synchronously, before the answer: the cached colours and name
    expect(f.props.get('--acc')).toBe(deriveTokens('#4c9dff').acc);
    expect(f.doc.title).toBe('Nordlicht Kino');
    expect(fetchFn).toHaveBeenCalledWith('/api/public/brand', expect.objectContaining({ credentials: 'same-origin' }));
    resolve(await respond(answer(8, { name: 'Kinoabend', accent: '#2fc4b2' })));
    await done;
    expect(f.props.get('--acc')).toBe(deriveTokens('#2fc4b2').acc);
    expect(get(brand).rev).toBe(8);
    // the new answer is the cache for the next boot
    expect(JSON.parse(storage.getItem(BRAND_CACHE_KEY)!).rev).toBe(8);
    resetBrandForTests();
    expect(applyCached(asDoc(f))).toBe(true);
    expect(get(brand).name).toBe('Kinoabend');
  });

  it('no cache, a failed request or a broken answer keeps what is shown (the defaults)', async () => {
    expect(applyCached(asDoc(f))).toBe(false);
    await loadBrand((() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch);
    await loadBrand((() => respond({ error: 'setup_required' }, 503)) as unknown as typeof fetch);
    await loadBrand((() => respond({ nothing: true })) as unknown as typeof fetch);
    await loadBrand((() => Promise.resolve(new Response('<html>', { status: 200 }))) as unknown as typeof fetch);
    expect(f.props.size).toBe(0);
    expect(get(brand)).toEqual(DEFAULT_LOADED);
    expect(storage.getItem(BRAND_CACHE_KEY)).toBeNull();
    // blocked storage is no error either
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(applyCached(asDoc(f))).toBe(false);
    await loadBrand((() => respond(answer(1))) as unknown as typeof fetch);
    expect(get(brand).rev).toBe(1);
  });

  it('of overlapping loads the last one wins', async () => {
    let first!: (r: Response) => void;
    const a = loadBrand((() => new Promise<Response>((r) => (first = r))) as unknown as typeof fetch);
    await loadBrand((() => respond(answer(9, { name: 'Neu' }))) as unknown as typeof fetch);
    first(await respond(answer(8, { name: 'Alt' })));
    await a;
    expect(get(brand).name).toBe('Neu');
  });

  it('refetches on visibility only when rev changed', async () => {
    let body = answer(1);
    const fetchFn = vi.fn(() => respond(body));
    await loadBrand(fetchFn as unknown as typeof fetch);
    expect(get(brand).rev).toBe(1);
    const sets = () => f.doc.documentElement.style.setProperty.mock.calls.length;
    const before = sets();
    const stop = refetchOnVisible(fetchFn as unknown as typeof fetch, 0);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    // hidden: no request
    f.doc.visibilityState = 'hidden';
    f.fire('visibilitychange');
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // visible, same rev: a request, nothing applied again
    f.doc.visibilityState = 'visible';
    f.fire('visibilitychange');
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sets()).toBe(before);
    // another admin saved: the new rev applies
    body = answer(2, { accent: '#f2b52c' });
    f.fire('visibilitychange');
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(get(brand).rev).toBe(2);
    expect(f.props.get('--acc-fill')).toBe(deriveTokens('#f2b52c').accFill);
    // stopped: no more requests
    stop();
    f.fire('visibilitychange');
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('visibility refetches are spaced (no request storm from quick tab switches)', async () => {
    const fetchFn = vi.fn(() => respond(answer(1)));
    const stop = refetchOnVisible(fetchFn as unknown as typeof fetch, 10_000);
    f.fire('visibilitychange');
    f.fire('visibilitychange');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    stop();
    vi.stubGlobal('document', undefined);
    expect(refetchOnVisible(fetchFn as unknown as typeof fetch)()).toBeUndefined(); // no document (server): nothing to listen to
  });
});

describe('{app}', () => {
  it('{app} in a message uses the brand name', async () => {
    expect(tr('common.pageTitle', { page: 'Suche' })).toBe('Suche – FriendFlix');
    applyBrand(loaded(answer(1)), asDoc(f));
    expect(tr('common.pageTitle', { page: 'Suche' })).toBe('Suche – Nordlicht Kino');
    expect(get(t)('shell.footer.tagline')).toBe('Nordlicht Kino · privat unter Freunden');
    expect(tr('common.appName')).toBe('Nordlicht Kino');
    expect(tr('home.meta.shareText', { title: 'Heat' })).toBe('Heat auf Nordlicht Kino');
    // a caller's own value wins
    expect(tr('common.pageTitle', { page: 'Suche', app: 'Andere' })).toBe('Suche – Andere');
    // every language
    await setLocale('en');
    expect(tr('shell.account.logout')).toContain('Nordlicht Kino');
    expect(tr('shell.account.logout')).not.toContain('FriendFlix');
    resetBrandForTests();
    expect(tr('shell.account.logout')).toContain('FriendFlix');
  });

  it('a name with markup stays text in a rich message (Rich inserts {app} as a value)', () => {
    applyBrand(loaded(answer(1, { name: '<a href="/x">y</a>' })), asDoc(f));
    const values = { app: get(appName) };
    const parts = richParts(get(t)('player.tv.step1', markParams(values)), values);
    expect(parts.filter((p) => p.kind === 'a')).toEqual([]);
    expect(parts.map((p) => p.text).join('')).toContain('<a href="/x">y</a>');
  });

  it('no message names the app literally in the texts that follow the brand', () => {
    const dir = fileURLToPath(new URL('./i18n/locales/', import.meta.url));
    for (const lang of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
      for (const area of ['account', 'common', 'diagnose', 'home', 'kids', 'login', 'player', 'shell', 'social']) {
        const src = readFileSync(`${dir}${lang}/${area}.ts`, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
        expect(src.filter((l) => l.includes('FriendFlix')), `${lang}/${area}`).toEqual([]);
      }
    }
  });
});

describe('brandColors', () => {
  interface Vectors {
    targets: Record<'accText' | 'accFill' | 'accLight' | 'accLine', { on: string; min: number }>;
    vectors: Array<{ accent: string; adjusted: { text: boolean; fill: boolean }; tokens: Omit<BrandTokens, 'adjusted'> }>;
  }
  const V = JSON.parse(readFileSync(fileURLToPath(new URL('../../../test-vectors/brand-colors.json', import.meta.url)), 'utf8')) as Vectors;

  it('brandColors matches the backend vectors', () => {
    expect(V.vectors.length).toBeGreaterThanOrEqual(10);
    expect(V.targets).toEqual({
      accText: { on: ACC_TEXT_ON, min: 4.5 }, accFill: { on: ACC_FILL_ON, min: 4.5 }, accLight: { on: ACC_LIGHT_ON, min: 4.5 }, accLine: { on: ACC_LINE_ON, min: 3 },
    });
    for (const v of V.vectors) {
      const tk = deriveTokens(v.accent);
      expect({ ...tk, adjusted: undefined }, v.accent).toEqual({ ...v.tokens, adjusted: undefined });
      expect(tk.adjusted, v.accent).toEqual(v.adjusted);
      expect(contrast(tk.accText, ACC_TEXT_ON)).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#ffffff', tk.accFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tk.accLight, ACC_LIGHT_ON)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tk.accLine, ACC_LINE_ON)).toBeGreaterThanOrEqual(3);
    }
    expect(deriveTokens('#FF4F6D')).toEqual(DEFAULT_TOKENS);
    expect(() => deriveTokens('red')).toThrow(TypeError);
  });

  it('the line target is the toast glass over a white backdrop, and the tokens version equals the backend\'s', () => {
    const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    expect(hex(frostComposite([255, 255, 255], SCRIM_MENU))).toBe(ACC_LINE_ON);
    const backend = readFileSync(fileURLToPath(new URL('../../../backend/src/brand/colors.ts', import.meta.url)), 'utf8');
    expect(backend).toContain(`export const TOKENS_VERSION = '${TOKENS_VERSION}';`);
  });
});

describe('the glow classes', () => {
  it('app.css paints every glow mode the brand can choose', () => {
    const css = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');
    // accentViolet (the default) is the plain .frost-amb rule: today's look, also before any brand is known
    for (const g of ['accent', 'neutral', 'off']) expect(css.includes(`html.glow-${g} .frost-amb {`), g).toBe(true);
    expect(css.includes('html.glow-accentViolet')).toBe(false);
    // pages on the ambient background keep the lighter coral text although the tokens sit inline on <html>
    expect(css.includes('html.amb body { --acc-text: var(--acc-light); }')).toBe(true);
  });

  it('no glow mode paints a spot brighter than today\'s peak (the contrast checks of the glass and text measure against it)', () => {
    const css = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');
    const rule = (g: string) => css.slice(css.indexOf(`html.glow-${g} .frost-amb {`), css.indexOf('}', css.indexOf(`html.glow-${g} .frost-amb {`)));
    // the spots as app.css paints them (checked here, so the model below cannot drift from the stylesheet)
    expect(rule('accent')).toContain('color-mix(in srgb, var(--acc-fill) 33%, transparent)');
    expect(rule('accent')).toContain('color-mix(in srgb, var(--acc-fill) 18%, transparent)');
    expect(rule('accent')).toContain('color-mix(in srgb, var(--acc) 13%, transparent)');
    expect(rule('neutral')).toContain('rgba(150, 150, 165, .2)');
    expect(rule('neutral')).toContain('rgba(110, 110, 128, .16)');
    type Glow = { rx: number; ry: number; x: number; y: number; c: RGB; a: number };
    /** the brightest point of the glows over the base (painted bottom → top, as tone.test.ts models them) */
    const peak = (glows: Glow[]) => {
      let best = 0;
      for (let i = 0; i <= 50; i++) for (let j = 0; j <= 50; j++) {
        let c: RGB = [...DARK_BASE] as RGB;
        for (const g of [...glows].reverse()) {
          const d = Math.hypot((i / 50 - g.x) / g.rx, (j / 50 - g.y) / g.ry);
          if (d < 0.7) c = [0, 1, 2].map((k) => c[k]! * (1 - g.a * (1 - d / 0.7)) + g.c[k]! * g.a * (1 - d / 0.7)) as RGB;
        }
        best = Math.max(best, luminance(c));
      }
      return best;
    };
    const rgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
    const limit = luminance(AMB_PEAK) + 1e-9;
    for (const accent of ['#ffffff', '#ffff00', '#00ff00', '#00ffff', '#f2e94e', '#4c9dff', '#ff4f6d', '#808080', '#000000']) {
      const tk = deriveTokens(accent);
      const at = (x: number, y: number, rx: number, ry: number, c: RGB, a: number): Glow => ({ x, y, rx, ry, c, a });
      expect(peak([at(.78, .22, .6, .55, rgb(tk.accFill), .33), at(.2, .85, .45, .5, rgb(tk.accFill), .18), at(.55, .6, .4, .4, rgb(tk.acc), .13)]), `accent ${accent}`).toBeLessThanOrEqual(limit);
    }
    expect(peak([{ x: .78, y: .22, rx: .6, ry: .55, c: [150, 150, 165], a: .2 }, { x: .2, y: .85, rx: .45, ry: .5, c: [110, 110, 128], a: .16 }])).toBeLessThanOrEqual(limit);
  });
});

// ---- Task 3: what the surfaces show ----

const css = () => readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');
const rootVar = (k: string) => new RegExp(`${k}: ([^;]+);`).exec(css().slice(css().indexOf(':root {')))![1]!.trim();

describe('brandPalette', () => {
  it('the default accent keeps today\'s stylesheet values verbatim (an unbranded instance paints what it did)', () => {
    const p = brandPalette(DEFAULT_TOKENS);
    expect([p.rgb, p.glassText, p.markFrom, p.markTo]).toEqual([rootVar('--acc-rgb'), rootVar('--acc-glass'), rootVar('--mark-from'), rootVar('--mark-to')]);
    expect(p).toEqual({ glassText: '#ffa7b6', rgb: '255, 79, 109', markFrom: '#ff6b81', markTo: '#e23c5b', flare: '255, 120, 140', wall: '#3a1a2a', deep: '#5a1424', art: ['#ff4f6d', '#d6325a', '#ff6b81'] });
    // and the light glass cards take it: .panel and .frost-text read --acc-glass
    expect(css()).toContain('--info: #80cbd4; --acc-text: var(--acc-glass); }');
  });

  it('accent text on light glass passes AA on all four glass backgrounds for any accent', () => {
    const rgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
    expect(GLASS_TEXT_ON[0]).toEqual(frostComposite(AMB_PEAK, SCRIM_LIGHT));
    for (const accent of ['#ff4f6d', '#4c9dff', '#a37cff', '#2fc4b2', '#f2b52c', '#5ccf6a', '#0000ff', '#000000', '#ffffff', '#808080', '#ff0000']) {
      const p = brandPalette(deriveTokens(accent));
      for (const bg of GLASS_TEXT_ON) expect(rgbContrast(rgb(p.glassText), bg), `${accent} → ${p.glassText}`).toBeGreaterThanOrEqual(4.5);
      expect(p.rgb).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
      for (const c of [p.glassText, p.markFrom, p.markTo, p.wall, p.deep, ...p.art]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('a blue accent has no coral left in its palette', () => {
    const p = brandPalette(deriveTokens('#4c9dff'));
    const coral = ['#ff4f6d', '#d6325a', '#ff6b81', '#e23c5b', '#ffa7b6', '#3a1a2a', '#5a1424'];
    for (const v of [p.glassText, p.markFrom, p.markTo, p.wall, p.deep, ...p.art]) expect(coral).not.toContain(v);
    expect(p.rgb).not.toBe('255, 79, 109');
  });
});

describe('the surfaces', () => {
  const b = (over: Record<string, unknown> = {}, images: Record<string, string> = {}) => loaded(answer(1, over, images));
  const IMG = `/api/public/brand/img/${HASH}.png`;

  it('headerParts: wordmark, symbol plus name, the uploaded logo', () => {
    // FriendFlix's own wordmark is its F tile plus the lettering (today's header); another name is the lettering alone
    expect(headerParts(DEFAULT_LOADED)).toEqual({ mark: true, name: true, logo: null });
    expect(headerParts(b())).toEqual({ mark: false, name: true, logo: null });
    expect(headerParts(b({ header: 'symbol' }))).toEqual({ mark: true, name: true, logo: null });
    expect(headerParts(b({ header: 'logo' }, { logo: IMG }))).toEqual({ mark: false, name: false, logo: IMG });
    // the logo style without an upload: symbol plus name
    expect(headerParts(b({ header: 'logo' }))).toEqual({ mark: true, name: true, logo: null });
  });

  it('the built-in F tile only for the shipped name without an uploaded symbol', () => {
    expect(builtInMark(DEFAULT_LOADED)).toBe(true);
    expect(builtInMark(b())).toBe(false);
    expect(builtInMark(b({ name: 'FriendFlix' }))).toBe(true);
    expect(builtInMark(b({ name: 'FriendFlix' }, { symbol: IMG }))).toBe(false);
  });

  it('the initial: the first grapheme, upper-cased (an emoji stays whole)', () => {
    expect(brandInitial('nordlicht Kino')).toBe('N');
    expect(brandInitial('  ärger')).toBe('Ä');
    expect(brandInitial('👨‍👩‍👧 Kino')).toBe('👨‍👩‍👧');
    expect(brandInitial('')).toBe('F');
  });
});

describe('the default glow follows the accent', () => {
  it('its small spot is rgba(var(--acc-rgb), .13): today\'s coral by default, never brighter than the orange peak', () => {
    const rule = css().slice(css().indexOf('.frost-amb {'), css().indexOf('}', css().indexOf('.frost-amb {')));
    expect(rule).toContain('radial-gradient(40% 40% at 55% 60%, rgba(var(--acc-rgb), .13), transparent 70%)');
    const at = (x: number, y: number, rx: number, ry: number, c: RGB, a: number) => ({ x, y, rx, ry, c, a });
    let best = 0;
    for (const accent of ['#ffffff', '#ffff00', '#00ff00', '#00ffff', '#4c9dff', '#ff4f6d']) {
      const c = brandPalette(deriveTokens(accent)).rgb.split(', ').map(Number) as RGB;
      const glows = [at(.78, .22, .6, .55, [214, 92, 64], .33), at(.2, .85, .45, .5, [78, 64, 190], .25), at(.55, .6, .4, .4, c, .13)];
      for (let i = 0; i <= 50; i++) for (let j = 0; j <= 50; j++) {
        let px: RGB = [...DARK_BASE] as RGB;
        for (const g of [...glows].reverse()) {
          const d = Math.hypot((i / 50 - g.x) / g.rx, (j / 50 - g.y) / g.ry);
          if (d < 0.7) px = [0, 1, 2].map((k) => px[k]! * (1 - g.a * (1 - d / 0.7)) + g.c[k]! * g.a * (1 - d / 0.7)) as RGB;
        }
        best = Math.max(best, luminance(px));
      }
      expect(best, accent).toBeLessThanOrEqual(luminance(AMB_PEAK) + 1e-9);
    }
  });
});
