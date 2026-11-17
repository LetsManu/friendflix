// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { brandAnswer, brandImage } from './api.js';

/** The brand in the start intro (Intro.svelte): symbol, name and accent; the default intro without branding; a symbol that fails or is slow. */
export function brandIntroTests(): void {
  test.describe('the brand in the intro', () => {
    test.use({ reducedMotion: 'no-preference' }); // the suite default (reduce) would skip the cold-start intro

    test('without branding the intro is the built-in F tile and FriendFlix', async ({ page, api: _api }) => {
      await page.goto('/');
      const intro = page.locator('.intro');
      await expect(intro).toBeVisible();
      await expect(intro).not.toHaveClass(/own/);
      await expect(intro.locator('svg.tile path.fstroke')).toHaveCount(1);
      await expect(intro.locator('img.sym')).toHaveCount(0);
      await expect(intro.locator('.word')).toHaveText('FriendFlix');
    });

    test('with branding the intro shows the brand symbol, name and accent', async ({ page, api }) => {
      const symbol = brandImage('5e');
      api.brand = brandAnswer({ name: 'Nordlicht Kino', symbol: symbol.slice(22, 86) }, { symbol });
      await page.goto('/');
      const intro = page.locator('.intro');
      await expect(intro.locator('img.sym')).toHaveAttribute('src', symbol);
      await expect(intro.locator('svg.tile path.fstroke')).toHaveCount(0);
      await expect(intro.locator('.word')).toHaveText('Nordlicht Kino');
      await expect(intro.locator('.glow')).toHaveCSS('background-image', /rgba\(76, 157, 255/);
    });

    test('a custom name without a symbol shows its initial on the accent', async ({ page, api }) => {
      api.brand = brandAnswer({ name: 'Nordlicht Kino' });
      await page.goto('/');
      const intro = page.locator('.intro');
      await expect(intro.locator('svg.tile text')).toHaveText('N');
      await expect(intro.locator('.word')).toHaveText('Nordlicht Kino');
    });

    test('a logo without a symbol is shown wide, with no separate name', async ({ page, api }) => {
      const logo = brandImage('1090');
      api.brand = brandAnswer({ name: 'Nordlicht Kino', header: 'logo', logo: logo.slice(22, 86) }, { logo });
      await page.goto('/');
      const intro = page.locator('.intro');
      await expect(intro.locator('img.logo')).toHaveAttribute('src', logo);
      await expect(intro.locator('.tilewrap.wide')).toHaveCount(1);
      await expect(intro.locator('.word')).toHaveCount(0);
      await expect(intro.locator('img.sym, svg.tile')).toHaveCount(0);
      await expect(intro.locator('.glow')).toHaveCSS('background-image', /rgba\(76, 157, 255/);
      const box = (await intro.locator('.tilewrap').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual((await page.viewportSize())!.width);
    });

    test('with symbol and logo the symbol wins', async ({ page, api }) => {
      const symbol = brandImage('5e'), logo = brandImage('1090');
      api.brand = brandAnswer({ name: 'Nordlicht Kino', symbol: symbol.slice(22, 86), logo: logo.slice(22, 86) }, { symbol, logo });
      await page.goto('/');
      await expect(page.locator('.intro img.sym')).toHaveAttribute('src', symbol);
      await expect(page.locator('.intro img.logo')).toHaveCount(0);
      await expect(page.locator('.intro .word')).toHaveText('Nordlicht Kino');
    });

    test('a slow symbol: nothing animates, and no default mark shows, until it has loaded', async ({ page, api }) => {
      const symbol = brandImage('5e');
      api.brand = brandAnswer({ name: 'Nordlicht Kino', symbol: symbol.slice(22, 86) }, { symbol });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let seen!: () => void;
      const requested = new Promise<void>((r) => { seen = r; });
      await page.route('**/api/public/brand/img/**', async (route) => { seen(); await gate; await route.fallback(); });
      await page.goto('/');
      const intro = page.locator('.intro');
      await expect(intro).toBeVisible();
      await requested; // the symbol is being fetched, and held
      await expect(intro.locator('.stage')).toHaveCount(0);
      await expect(intro.locator('svg.tile')).toHaveCount(0);
      release();
      await expect(intro.locator('img.sym')).toBeVisible();
      await expect(intro.locator('svg.tile')).toHaveCount(0);
    });

    test('skipping under reduced motion fades with ff-skip, no abrupt cut', async ({ page, api: _api }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/settings');
      await page.getByRole('button', { name: 'Vorschau abspielen' }).click();
      const intro = page.locator('.intro.rm');
      await expect(intro).toBeVisible();
      await page.waitForTimeout(250); // the click that opened it must not count as the skip
      await page.keyboard.press('Escape');
      await expect(intro).toHaveClass(/leaving/);
      expect(await intro.evaluate((e) => getComputedStyle(e).animationName)).toMatch(/ff-skip$/);
      await expect(intro).toHaveCount(0);
    });

    test.describe('failing symbol', () => {
    test.use({ allowedConsole: /ERR_FAILED/ }); // the aborted image request
    test('a symbol that fails to load falls back to the name\'s initial, never a broken image', async ({ page, api }) => {
      const symbol = brandImage('5e');
      api.brand = brandAnswer({ name: 'Nordlicht Kino', symbol: symbol.slice(22, 86) }, { symbol });
      await page.route('**/api/public/brand/img/**', (route) => route.abort());
      await page.goto('/');
      const intro = page.locator('.intro');
      await expect(intro.locator('svg.tile text')).toHaveText('N');
      await expect(intro.locator('img.sym')).toHaveCount(0);
      await expect(intro.locator('.word')).toHaveText('Nordlicht Kino');
    });
    });
  });
}
