// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { LOCALE_CODES, trIn, loadLocale } from '#lib/i18n';
import { DEFAULT_LOADED, parseBrand } from '#lib/brand';
import { deriveTokens } from '#lib/brandColors';
import { BRAND_CACHE_MS, BRAND_FAIL_CACHE_MS, cachedManifestBrand, chooseLang, manifestBrand, manifestFor, resetManifestBrandCache } from './manifest';

describe('manifest language', () => {
  it('?lang is whitelisted to the supported codes', () => {
    expect(chooseLang('fr', 'en')).toBe('fr');
    expect(chooseLang('xx', 'pl')).toBe('pl'); // unknown code: Accept-Language decides
    expect(chooseLang('../etc', null)).toBe('de');
    expect(chooseLang('', '')).toBe('de');
  });
  it('Accept-Language: best q-weighted supported match, else German', () => {
    expect(chooseLang(null, 'ja,en-US;q=0.8,it;q=0.9')).toBe('it');
    expect(chooseLang(null, 'tr-TR,tr;q=0.9,en;q=0.5')).toBe('tr');
    expect(chooseLang(null, 'ja,zh;q=0.5')).toBe('de');
    expect(chooseLang(null, 'en;q=0,es;q=0.1')).toBe('es');
    expect(chooseLang(null, null)).toBe('de');
  });
  it.each(LOCALE_CODES)('%s: name, description and every shortcut come from the dictionary', async (l) => {
    const m = await manifestFor(l);
    await loadLocale(l);
    expect(m.lang).toBe(l);
    expect(m.name).toBe('FriendFlix');
    expect(m.description).toBe(trIn(l, 'mine.manifest.description'));
    expect(m.shortcuts.map((s) => s.name)).toEqual([trIn(l, 'home.rows.resume'), trIn(l, 'shell.nav.myList'), trIn(l, 'shell.mobile.search'), trIn(l, 'shell.mobile.downloads'), trIn(l, 'shell.menu.remote')]);
    expect(m.shortcuts.every((s) => s.name && s.url.startsWith('/'))).toBe(true);
    expect(m.start_url).toBe('/');
  });
  it('languages differ', async () => {
    expect((await manifestFor('en')).shortcuts[1]!.name).not.toBe((await manifestFor('de')).shortcuts[1]!.name);
  });
});

describe('manifest brand', () => {
  const HASH = 'b'.repeat(64);
  const answer = (over: Record<string, unknown> = {}, images: Record<string, string> = {}) => ({
    rev: 4,
    brand: { name: 'Nordlicht Kino', byline: '', shortName: 'Nordlicht', website: '', about: '', header: 'symbol', accent: '#4c9dff', glow: 'accent', signInBg: 'posters', logo: null, symbol: null, signInImage: null, ...over },
    tokens: deriveTokens('#4c9dff'), images,
  });

  it('name, short name and every {app} follow the brand; without a symbol the icons stay', async () => {
    const m = await manifestFor('en', parseBrand(answer())!);
    expect([m.name, m.short_name]).toEqual(['Nordlicht Kino', 'Nordlicht']);
    expect(JSON.stringify(m)).not.toContain('FriendFlix');
    expect(m.icons.map((i) => i.src)).toEqual(['/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
    // the defaults: today's manifest
    const d = await manifestFor('de');
    expect([d.name, d.short_name]).toEqual(['FriendFlix', 'FriendFlix']);
  });

  it('an app symbol becomes the icons (any and maskable) and the shortcut icon', async () => {
    const url = `/api/public/brand/img/${HASH}.webp`;
    const m = await manifestFor('de', parseBrand(answer({ symbol: HASH }, { symbol: url }))!);
    expect(m.icons).toEqual([
      { src: url, sizes: '512x512', type: 'image/webp', purpose: 'any' }, { src: url, sizes: '512x512', type: 'image/webp', purpose: 'maskable' },
    ]);
    expect(m.shortcuts.every((s) => s.icons.length === 1 && s.icons[0]!.src === url)).toBe(true);
  });

  it('fetches the public brand from the backend, and falls back to the defaults on any error', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(answer())));
    const b = await manifestBrand('http://backend:3000', ok as unknown as typeof fetch);
    expect(b.name).toBe('Nordlicht Kino');
    expect(String((ok.mock.calls[0] as unknown[])[0])).toBe('http://backend:3000/api/public/brand');
    const fails = [
      async () => { throw new TypeError('ECONNREFUSED'); },
      async () => new Response('{"error":"setup_required"}', { status: 503 }),
      async () => new Response('not json'),
      async () => new Response('{"rev":"x"}'),
    ];
    for (const f of fails) expect(await manifestBrand('http://backend:3000', f as unknown as typeof fetch)).toBe(DEFAULT_LOADED);
    // no (or no http) backend address: no request at all
    const never = vi.fn();
    expect(await manifestBrand(undefined, never as unknown as typeof fetch)).toBe(DEFAULT_LOADED);
    expect(await manifestBrand('file:///etc/passwd', never as unknown as typeof fetch)).toBe(DEFAULT_LOADED);
    expect(never).not.toHaveBeenCalled();
  });

  it('the route reuses the brand for a minute, a failure for 10 s; concurrent requests share one fetch', async () => {
    resetManifestBrandCache();
    let fail = false;
    const f = vi.fn(async () => (fail ? new Response('{}', { status: 502 }) : new Response(JSON.stringify(answer()))));
    const fx = f as unknown as typeof fetch;
    const B = 'http://backend:3000';
    const [a, b] = await Promise.all([cachedManifestBrand(B, fx, 0), cachedManifestBrand(B, fx, 0)]);
    expect([a.name, b.name]).toEqual(['Nordlicht Kino', 'Nordlicht Kino']);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await cachedManifestBrand(B, fx, BRAND_CACHE_MS - 1)).name).toBe('Nordlicht Kino');
    expect(f).toHaveBeenCalledTimes(1);
    fail = true;
    expect(await cachedManifestBrand(B, fx, BRAND_CACHE_MS)).toBe(DEFAULT_LOADED); // expired: fetched again, failed
    expect(f).toHaveBeenCalledTimes(2);
    expect(await cachedManifestBrand(B, fx, BRAND_CACHE_MS + BRAND_FAIL_CACHE_MS - 1)).toBe(DEFAULT_LOADED);
    expect(f).toHaveBeenCalledTimes(2);
    fail = false;
    expect((await cachedManifestBrand(B, fx, BRAND_CACHE_MS + BRAND_FAIL_CACHE_MS)).name).toBe('Nordlicht Kino'); // a failure is retried after 10 s
    expect(f).toHaveBeenCalledTimes(3);
    resetManifestBrandCache();
  });
});
