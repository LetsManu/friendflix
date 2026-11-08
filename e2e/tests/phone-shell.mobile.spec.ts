// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

/** Phone browse block 3, shell: glass top bar, tucking chips, floating glass tab bar, categories bottom sheet. */
const allowDownloads = (page: Page) => page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } }));
const tabbar = (page: Page) => page.getByRole('navigation', { name: 'Mobile Navigation' });
const scrollTo = async (page: Page, y: number) => {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(y);
};

test.describe('phone shell', () => {
  test('tab bar: Start, Neu, Merkliste, Downloads; aria-current follows the page', async ({ page }) => {
    await allowDownloads(page);
    await page.goto('/');
    const bar = tabbar(page);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveClass(/\btabbar\b/);
    const tabs = bar.getByRole('link');
    await expect(tabs).toHaveCount(4);
    for (const [i, name] of ['Start', 'Neu & demnächst', 'Merkliste', 'Downloads'].entries()) await expect(tabs.nth(i)).toHaveAccessibleName(name);
    // short visible labels; the full name stays the accessible name
    await expect(bar.locator('a > span:last-child')).toHaveText(['Start', 'Neu', 'Merkliste', 'Downloads']);
    await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(bar.locator('[aria-current="page"]')).toHaveCount(1);
    for (const tab of await tabs.all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // floating pill: 14 px from the sides, above the bottom edge
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.x)).toBe(14);
    expect(Math.round(box.width)).toBe(390 - 28);
    expect(Math.round(box.y + box.height)).toBe(844 - 10);

    await tabs.nth(2).tap();
    await expect(page).toHaveURL(/\/watchlist$/);
    await expect(tabs.nth(2)).toHaveAttribute('aria-current', 'page');
    await expect(tabs.nth(0)).not.toHaveAttribute('aria-current');
    await expect(bar.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test('without download permission: three tabs, no Downloads tab, no Downloads in the header', async ({ page }) => {
    await page.goto('/');
    const tabs = tabbar(page).getByRole('link');
    await expect(tabs).toHaveCount(3);
    for (const [i, name] of ['Start', 'Neu & demnächst', 'Merkliste'].entries()) await expect(tabs.nth(i)).toHaveAccessibleName(name);
    await expect(page.locator('header.nav.m').getByRole('link', { name: 'Downloads' })).toHaveCount(0);
  });

  test('top bar: logo goes home, search, avatar goes to /me', async ({ page }) => {
    await page.goto('/me');
    const header = page.locator('header.nav.m');
    const logo = header.getByRole('link', { name: 'Startseite' });
    await expect(logo).toHaveAttribute('href', '/');
    await expect(header.getByRole('link', { name: 'Suche' })).toHaveAttribute('href', '/search');
    await expect(header.locator('a.avatar')).toHaveAttribute('href', '/me');
    await logo.tap();
    await expect(page).toHaveURL(/\/$/);
  });

  test('top bar turns solid after 30 px of scroll; chips tuck while scrolling down and return on scroll up', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('header.nav.m');
    const chips = header.locator('nav.chipbar');
    await expect(chips).toBeVisible();
    await expect(page.locator('section.row').first()).toBeVisible();
    await expect(header).not.toHaveClass(/\bsolid\b/); // transparent over the hero
    await scrollTo(page, 40);
    await expect(header).toHaveClass(/\bsolid\b/);
    await expect(chips).not.toHaveClass(/\btucked\b/); // not yet past 90 px

    await scrollTo(page, 300);
    await expect(chips).toHaveClass(/\btucked\b/);
    await expect(chips).toBeHidden(); // opacity 0 + visibility hidden once tucked

    await scrollTo(page, 250);
    await expect(chips).not.toHaveClass(/\btucked\b/);
    await expect(chips).toBeVisible();
    await expect(header).toHaveClass(/\bsolid\b/);

    await scrollTo(page, 0);
    await expect(header).not.toHaveClass(/\bsolid\b/);
  });

  test('categories open as a bottom sheet; Escape and close return focus to the chip', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('header.nav.m').getByRole('button', { name: 'Kategorien' });
    await btn.tap();
    const sheet = page.getByRole('dialog', { name: 'Kategorien' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Drama' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Schließen' })).toBeFocused();
    // docked to the bottom edge once it has sprung up
    await expect.poll(async () => { const b = (await sheet.boundingBox())!; return Math.round(b.y + b.height); }).toBe(844);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(btn).toBeFocused();

    await btn.tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name: 'Drama' }).tap();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/genre=Drama/);
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('the categories sheet slides out before it unmounts (Escape and close button)', async ({ page }) => {
      await page.goto('/');
      const btn = page.locator('header.nav.m').getByRole('button', { name: 'Kategorien' });
      const sheet = page.locator('.cats');
      for (const how of ['escape', 'button'] as const) {
        await btn.tap();
        await expect(page.getByRole('dialog', { name: 'Kategorien' })).toBeVisible();
        await expect(sheet).not.toHaveClass(/\bout\b/);
        if (how === 'escape') await page.keyboard.press('Escape');
        else await sheet.getByRole('button', { name: 'Schließen' }).tap();
        await expect(sheet).toHaveCount(1); // still there, leaving
        await expect(sheet).toHaveClass(/\bout\b/);
        await expect(page.locator('.catdim')).toHaveClass(/\bout\b/);
        await expect(sheet).toHaveCount(0);
        await expect(page.locator('.catdim')).toHaveCount(0);
        await expect(btn).toBeFocused();
      }
    });
  });

  for (const [w, h] of [[390, 844], [320, 640]] as const) {
    test(`no horizontal overflow at ${w}x${h}`, async ({ page }) => {
      await allowDownloads(page);
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await expect(tabbar(page).getByRole('link')).toHaveCount(4);
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      const box = (await tabbar(page).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      // no tab label is cut off (ellipsis)
      const cut = await tabbar(page).locator('a > span:last-child').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
      expect(cut).toEqual([]);
    });
  }
});

test('kids profile on the phone keeps its own header and gets no tab bar', async ({ page }) => {
  const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, downloads: { allowed: true, max: 5 }, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
  await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
  await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
  await page.goto('/');
  await expect(page).toHaveURL(/\/kids$/);
  await expect(page.locator('header.kidsnav')).toBeVisible();
  await expect(page.locator('header.nav.m')).toHaveCount(0);
  await expect(page.locator('.tabbar')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Mobile Navigation' })).toHaveCount(0);
});
