// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { installLogin, loginState } from '../mocks/login.js';
import { BLUE_TOKENS, brandAnswer, brandImage, DEFAULT_BRAND_ANSWER } from '../mocks/api.js';
import { row } from '../helpers.js';

// Branding stage A, Task 3: every surface shows the brand (GET /api/public/brand, mocked per test through `api.brand`) and the accent
// follows it everywhere. The default brand must look exactly like today.

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const BLUE_FILL = rgb(BLUE_TOKENS.accFill); // rgb(0, 111, 244)
const BLUE = rgb(BLUE_TOKENS.acc); // rgb(76, 157, 255)
const CORAL = ['rgb(255, 79, 109)', 'rgb(214, 50, 90)', 'rgb(255, 107, 129)', 'rgb(226, 60, 91)', 'rgb(255, 167, 182)', 'rgb(255, 138, 160)'];
const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
const box = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
const bar = (page: Page) => page.locator('header.desk');
/** 24 characters, the longest name the backend accepts */
const LONG = 'Kinoabende am Nordlichts';

async function signIn(page: Page) {
  await installLogin(page.context(), loginState());
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Willkommen zurück' })).toBeVisible();
}

test.describe('the brand on every surface', () => {
  test('sign-in shows the brand: name, byline, the derived fill on the primary button, its own background', async ({ page, api }) => {
    api.brand = brandAnswer();
    await signIn(page);
    const logo = page.locator('.shell .logo');
    await expect(logo.locator('.txt')).toHaveText('Nordlicht Kino');
    await expect(logo.locator('.by')).toHaveText('by Anna Beispiel');
    // no uploaded symbol and not FriendFlix: the initial on the accent fill
    await expect(logo.locator('svg text')).toHaveText('N');
    expect(await logo.locator('svg rect').evaluate((el) => getComputedStyle(el).fill)).toBe(BLUE_FILL);
    expect(await bg(page.getByRole('button', { name: 'Weiter' }))).toBe(BLUE_FILL);
    await expect(page.locator('.wall:is([data-wall="covers"], [data-wall="generated"])')).toBeAttached(); // posters: the cover wall, as today
    await expect(page).toHaveTitle(/Nordlicht Kino/);
  });

  test('sign-in background: its own image (dimmed by the same shade), or just the glow (nothing fetched)', async ({ page, api }) => {
    const img = brandImage('51');
    api.brand = brandAnswer({ signInBg: 'image', signInImage: img.slice(22, 86) }, { signIn: img });
    await signIn(page);
    await expect(page.locator('.wall[data-wall="image"] img.own')).toHaveAttribute('src', img);
    await expect(page.locator('.wall .shade')).toBeAttached();
    await expect(page.locator('.wall .tiles')).toHaveCount(0);

    // just the glow: a first visit (nothing cached) never fetches the covers, not even before the brand is known
    const art: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/public/login-art')) art.push(r.url()); });
    api.brand = brandAnswer({ signInBg: 'color' });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    await expect(page.locator('.wall[data-wall="color"]')).toBeAttached();
    await expect(page.locator('.wall .tiles, .wall img')).toHaveCount(0);
    expect(art).toEqual([]);
    // the warm glow behind it follows the accent: no wine any more
    expect(await page.locator('.wall').evaluate((el) => getComputedStyle(el).backgroundImage)).not.toContain('rgb(58, 26, 42)');
  });

  test('header styles: wordmark, symbol plus name, logo image', async ({ page, api }) => {
    api.brand = brandAnswer({ header: 'wordmark' });
    await page.goto('/');
    const logo = bar(page).locator('a.logo');
    await expect(logo.locator('.txt')).toHaveText('Nordlicht Kino');
    await expect(logo.locator('svg, img')).toHaveCount(0); // another name's wordmark is its lettering alone
    expect(await logo.locator('.txt').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); // a usual name is never cut
    await expect(logo.locator('.by')).toHaveCount(0); // the header shows only the name

    api.brand = brandAnswer({ header: 'symbol' });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    await expect(logo.locator('svg text')).toHaveText('N');
    await expect(logo.locator('.txt')).toHaveText('Nordlicht Kino');

    const sym = brandImage('5a');
    api.brand = brandAnswer({ header: 'symbol', symbol: sym.slice(22, 86) }, { symbol: sym });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    await expect(logo.locator('img.sym')).toHaveAttribute('src', sym);

    const wide = brandImage('10');
    api.brand = brandAnswer({ header: 'logo', logo: wide.slice(22, 86) }, { logo: wide });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    const img = logo.locator('img.limg');
    await expect(img).toHaveAttribute('src', wide);
    await expect(img).toHaveAttribute('alt', 'Nordlicht Kino');
    await expect(logo.locator('.txt')).toHaveCount(0);
    // a fixed 4:1 box (30 px high): the image cannot move anything when it loads
    expect(await box(img)).toMatchObject({ w: 120, h: 30 });
  });

  test('tab title uses the brand', async ({ page, api }) => {
    api.brand = brandAnswer();
    await page.goto('/watchlist');
    await expect(page).toHaveTitle(/ – Nordlicht Kino$/);
    await page.goto('/');
    await expect(page).toHaveTitle(/Nordlicht Kino/);
    await expect(page).not.toHaveTitle(/FriendFlix/);
  });

  test('no coral left when the accent is blue: primary button, the active nav dot, the progress bar, the glow', async ({ page, api }) => {
    api.brand = brandAnswer();
    await page.goto('/');
    // the resume row's progress bar
    const prog = row(page, 'Weiterschauen').locator('.progress i').first();
    await expect(prog).toBeAttached();
    expect(await bg(prog)).toBe(BLUE);
    // the ambient glow's accent spot (pages without artwork)
    await page.goto('/watchlist');
    const amb = await page.locator('.frost-amb').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(amb).toContain('rgba(76, 157, 255, 0.13)');
    expect(amb).not.toContain('255, 79, 109');
    // the tokens and the palette on <html>
    const vars = await page.evaluate(() => ['--acc', '--acc-fill', '--acc-rgb', '--acc-glass', '--mark-from'].map((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim()));
    expect(vars).toEqual(['#4c9dff', '#006ff4', '76, 157, 255', '#93c5ff', '#4c9dff']);
    // a filled button anywhere takes the fill
    const fill = await page.evaluate(() => { const b = document.createElement('button'); document.body.append(b); const c = getComputedStyle(b).backgroundColor; b.remove(); return c; });
    expect(fill).toBe(BLUE_FILL);
    for (const c of [fill, BLUE]) expect(CORAL).not.toContain(c);
  });

  test('no coral left on the TV: the active page dot of the rail, and the rail shows the brand', async ({ page, api }) => {
    api.brand = brandAnswer();
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [] } }));
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const dot = page.locator('nav.rail .dot.on');
    await expect(dot).toBeAttached();
    expect(await bg(dot)).toBe(BLUE);
    const brand = page.locator('nav.rail .brand');
    await expect(brand).toHaveAttribute('aria-hidden', 'true');
    await expect(brand.locator('.bn')).toHaveText('Nordlicht Kino');
    // the brand sits above the list: it never covers an item
    const b = await box(brand), first = await box(page.locator('nav.rail ul a').first());
    expect(b.y + b.h).toBeLessThanOrEqual(first.y);
  });

  test('TV rail: the brand never overlaps an item or squeezes the rail (8 items with Live TV and Aufnahmen)', async ({ page, api }) => {
    api.brand = brandAnswer();
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, features: { requests: true, postplay: true, surround: false, livetv: true } } }));
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    for (const [w, h] of [[960, 540], [1280, 720], [1920, 1080]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await expect(page.locator('html.tv')).toHaveCount(1);
      const items = page.locator('nav.rail ul a');
      await expect(items).toHaveCount(8);
      const first = await box(items.first());
      const brand = page.locator('nav.rail .brand');
      // the brand shows only where the eight items, the account and the profile keep their full 56 px below it
      if (h >= 800) {
        await expect(brand).toBeVisible();
        const b = await box(brand);
        expect(b.y + b.h, `${w}x${h}`).toBeLessThanOrEqual(first.y);
      } else await expect(brand).toBeHidden();
      // 960 x 540 cannot hold ten 56 px entries at all (main's rail, with or without a brand): the positions are checked from 720 up
      if (h < 720) continue;
      for (const a of [...await items.all(), page.locator('nav.rail a.acct'), page.locator('nav.rail a.who')]) {
        const r = await box(a);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y + r.h).toBeLessThanOrEqual(h);
        if (h >= 800) expect(r.h, `${w}x${h}`).toBe(56);
      }
    }
  });

  test('long name ellipsizes in the desktop header; the pill and the buttons do not move', async ({ page, api }) => {
    await page.goto('/');
    const pill = bar(page).locator('.pill'), right = bar(page).locator('.right');
    await expect(bar(page).locator('a.logo .txt')).toHaveText('FriendFlix');
    const before = { pill: await box(pill), right: await box(right) };
    api.brand = brandAnswer({ name: LONG, header: 'symbol' });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    const txt = bar(page).locator('a.logo .txt');
    await expect(txt).toHaveText(LONG);
    expect(LONG).toHaveLength(24);
    const m = await txt.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, to: getComputedStyle(el).textOverflow }));
    expect(m.to).toBe('ellipsis');
    expect(m.sw).toBeGreaterThan(m.cw); // cut with an ellipsis, not overflowing
    const logo = await box(bar(page).locator('a.logo'));
    expect(await txt.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBeLessThan(220);
    expect(await box(pill)).toEqual(before.pill);
    expect(await box(right)).toEqual(before.right);
    expect(logo.x + logo.w).toBeLessThanOrEqual(before.pill.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('TV start screen shows the name and byline', async ({ page, api }) => {
    api.brand = brandAnswer();
    await page.goto('/tv');
    const logo = page.locator('main.pair .logo');
    await expect(logo.locator('.txt')).toHaveText('Nordlicht Kino');
    await expect(logo.locator('.by')).toHaveText('by Anna Beispiel');
    await expect(page.locator('main.pair .code')).toBeVisible();
    // its glow follows the accent
    expect(await page.locator('main.pair').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('rgba(76, 157, 255, 0.16)');
  });

  test('default brand looks like today: the F tile and FriendFlix, today\'s coral everywhere, no byline', async ({ page, api }) => {
    expect(api.brand).toEqual(DEFAULT_BRAND_ANSWER);
    await page.goto('/');
    const logo = bar(page).locator('a.logo');
    await expect(logo.locator('.txt')).toHaveText('FriendFlix');
    await expect(logo.locator('svg path')).toHaveCount(2); // the F and the play mark
    const stops = await logo.locator('svg stop').evaluateAll((els) => els.map((e) => getComputedStyle(e).stopColor));
    expect(stops).toEqual(['rgb(255, 107, 129)', 'rgb(226, 60, 91)']);
    await page.goto('/watchlist');
    expect(await page.locator('.frost-amb').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe(
      'radial-gradient(60% 55% at 78% 22%, rgba(214, 92, 64, 0.33), rgba(0, 0, 0, 0) 70%), radial-gradient(45% 50% at 20% 85%, rgba(78, 64, 190, 0.25), rgba(0, 0, 0, 0) 70%), radial-gradient(40% 40% at 55% 60%, rgba(255, 79, 109, 0.13), rgba(0, 0, 0, 0) 70%), none',
    );
    const vars = await page.evaluate(() => ['--acc', '--acc-fill', '--acc-light', '--acc-rgb', '--acc-glass'].map((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim()));
    expect(vars).toEqual(['#ff4f6d', '#d6325a', '#ff8aa0', '255, 79, 109', '#ffa7b6']);
    await expect(page.locator('footer .by')).toHaveCount(0);
    await expect(page).toHaveTitle(/FriendFlix/);
  });

  test('the footer shows the byline', async ({ page, api }) => {
    api.brand = brandAnswer();
    await page.goto('/watchlist');
    await expect(page.locator('footer .brand')).toContainText('Nordlicht Kino · privat unter Freunden');
    await expect(page.locator('footer .brand .by')).toHaveText('· by Anna Beispiel');
  });
});
