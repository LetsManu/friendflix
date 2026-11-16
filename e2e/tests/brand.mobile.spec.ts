// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { installLogin, loginState } from '../mocks/login.js';
import { BLUE_TOKENS, brandAnswer, brandImage } from '../mocks/api.js';

// Branding stage A, Task 3 on the phone: the header shows the brand per its header style, a long name ellipsizes without moving the
// buttons, the sign-in shows name and byline.

const box = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
const head = (page: Page) => page.locator('header.nav.m');
const LONG = 'Kinoabende am Nordlichts'; // 24 characters

test.describe('the brand on the phone', () => {
  test('the default header is today\'s: the F tile and FriendFlix', async ({ page, api: _api }) => {
    await page.goto('/');
    const a = head(page).locator('a.mlogo');
    await expect(a.locator('.wm')).toHaveText('FriendFlix');
    await expect(a.locator('svg path')).toHaveCount(2);
  });

  test('long name ellipsizes in the phone header; search and avatar do not move', async ({ page, api }) => {
    await page.goto('/');
    const search = head(page).getByRole('link', { name: 'Suche' }), avatar = head(page).locator('a.avatar');
    await expect(search).toBeVisible();
    const before = { search: await box(search), avatar: await box(avatar) };
    api.brand = brandAnswer({ name: LONG, header: 'symbol' });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    const wm = head(page).locator('a.mlogo .wm');
    await expect(wm).toHaveText(LONG);
    await expect(head(page).locator('a.mlogo svg text')).toHaveText('K');
    expect(await box(search)).toEqual(before.search);
    expect(await box(avatar)).toEqual(before.avatar);
    const logo = await box(head(page).locator('a.mlogo'));
    expect(logo.x + logo.w).toBeLessThanOrEqual(before.search.x);
    const m = await wm.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, r: el.getBoundingClientRect().right }));
    expect(m.r).toBeLessThanOrEqual(before.search.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // the 44 px target stays
    expect(logo.h).toBeGreaterThanOrEqual(44);
  });

  test('header styles on the phone: lettering alone, and the uploaded logo in its fixed box', async ({ page, api }) => {
    api.brand = brandAnswer({ header: 'wordmark' });
    await page.goto('/');
    const a = head(page).locator('a.mlogo');
    await expect(a.locator('.wm')).toHaveText('Nordlicht Kino');
    await expect(a.locator('svg, img')).toHaveCount(0);
    const wide = brandImage('10');
    api.brand = brandAnswer({ header: 'logo', logo: wide.slice(22, 86) }, { logo: wide });
    await page.evaluate(() => localStorage.removeItem('ff.brand'));
    await page.reload();
    await expect(a.locator('img.mlimg')).toHaveAttribute('src', wide);
    await expect(a.locator('.wm')).toHaveCount(0);
    expect(await box(a.locator('img.mlimg'))).toMatchObject({ w: 112, h: 28 });
  });

  test('sign-in on the phone shows the name and byline (a letter tile does not name the brand on its own)', async ({ page, api }) => {
    api.brand = brandAnswer();
    await installLogin(page.context(), loginState());
    await page.goto('/login');
    const logo = page.locator('.shell .logo');
    await expect(logo.locator('.txt')).toBeVisible();
    await expect(logo.locator('.by')).toHaveText('by Anna Beispiel');
    const fill = `rgb(${[1, 3, 5].map((i) => parseInt(BLUE_TOKENS.accFill.slice(i, i + 2), 16)).join(', ')})`;
    expect(await page.getByRole('button', { name: 'Weiter' }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
