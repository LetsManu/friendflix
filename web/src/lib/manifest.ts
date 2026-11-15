// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_LOCALE, isLocale, loadLocale, pickLocale, trIn, type Locale } from '#lib/i18n';
import { BRAND_URL, DEFAULT_LOADED, parseBrand, type LoadedBrand } from '#lib/brand';

/**
 * The web app manifest in the viewer's language and the instance's brand (served by routes/manifest.webmanifest/+server.ts; the root
 * layout points `<link rel="manifest">` at `?lang=<ui language>`). Texts come from the i18n dictionaries, nothing is duplicated here;
 * the name, the short name and (when an app symbol is set) the icons come from the brand.
 */
const BASE = {
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#101418",
  "theme_color": "#101418",
  "categories": [
    "entertainment"
  ],
  "icons": [
    {
      "src": "/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    },
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
} as const;

const icons = [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }];

/** the app symbol as the icons (it is square, at least 512 px: the admin page uploads it as 512 × 512), for any use and maskable */
function symbolIcons(url: string) {
  const type = url.endsWith('.webp') ? 'image/webp' : 'image/png';
  return [{ src: url, sizes: '512x512', type, purpose: 'any' }, { src: url, sizes: '512x512', type, purpose: 'maskable' }];
}

/** how long the manifest route waits for the backend's brand before it answers with the defaults */
export const BRAND_TIMEOUT_MS = 2000;

/**
 * The brand for the manifest, fetched from the backend's public route over the internal network (`backend`: BACKEND_URL, e.g.
 * http://backend:3000). The defaults when no backend is configured, it does not answer in time or answers anything else.
 */
export async function manifestBrand(backend: string | undefined, fetchFn: typeof fetch = fetch): Promise<LoadedBrand> {
  if (!backend || !/^https?:\/\//.test(backend)) return DEFAULT_LOADED;
  try {
    const r = await fetchFn(new URL(BRAND_URL, backend), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(BRAND_TIMEOUT_MS) });
    if (!r.ok) return DEFAULT_LOADED;
    return parseBrand(await r.json()) ?? DEFAULT_LOADED;
  } catch {
    return DEFAULT_LOADED;
  }
}

/** `?lang` (only the 7 supported codes), else the best Accept-Language match (q-weighted), else German. */
export function chooseLang(param: string | null, acceptLanguage: string | null): Locale {
  if (isLocale(param)) return param;
  const ranked = (acceptLanguage ?? '').split(',').map((part, i) => {
    const [tag, ...ps] = part.trim().split(';');
    const q = Number(ps.map((p) => p.trim()).find((p) => p.startsWith('q='))?.slice(2) ?? 1);
    return { tag: (tag ?? '').trim(), q: Number.isFinite(q) ? q : 0, i };
  }).filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  return pickLocale(ranked.map((x) => x.tag)) ?? DEFAULT_LOCALE;
}

export async function manifestFor(lang: Locale, brand: LoadedBrand = DEFAULT_LOADED) {
  await loadLocale(lang);
  // every {app} is this brand's name (passed explicitly: the server process never uses the browser's global name)
  const T = (k: Parameters<typeof trIn>[1]) => trIn(lang, k, { app: brand.name });
  const symbol = brand.images.symbol;
  const shortcutIcons = symbol ? symbolIcons(symbol).slice(0, 1) : icons;
  return {
    ...BASE,
    ...(symbol ? { icons: symbolIcons(symbol) } : {}),
    name: T('common.appName'),
    short_name: brand.shortName,
    description: T('mine.manifest.description'),
    lang,
    shortcuts: [
      { name: T('home.rows.resume'), short_name: T('home.rows.resume'), description: T('mine.manifest.resumeDesc'), url: '/?shortcut=resume', icons: shortcutIcons },
      { name: T('shell.nav.myList'), url: '/watchlist', icons: shortcutIcons },
      { name: T('shell.mobile.search'), url: '/search', icons: shortcutIcons },
      { name: T('shell.mobile.downloads'), url: '/downloads', icons: shortcutIcons },
      { name: T('shell.menu.remote'), url: '/remote', icons: shortcutIcons },
    ],
  };
}
