// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** Desktop top bar (spec desktop browse §1): logo, a floating pill with the tabs, search that stretches open, bell, avatar. */
test.describe('desktop pill bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: false } }));
  });

  test('pill tabs: Home active, clicking Series moves aria-current and the fill', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    await expect(bar).toBeVisible();
    const active = bar.locator('.pill [aria-current="page"]');
    await expect(active).toHaveText('Start');
    const fill = bar.locator('.pill .fill');
    await expect(fill).toHaveCount(1);
    await expect.poll(() => fill.evaluate((e) => getComputedStyle(e).opacity)).toBe('0.14'); // a light fill (group opacity)
    const before = await fill.evaluate((e) => e.style.transform);
    await bar.locator('.pill').getByRole('link', { name: 'Serien' }).click();
    await expect(page).toHaveURL(/\/browse\/series$/);
    await expect(active).toHaveText('Serien');
    await expect.poll(() => fill.evaluate((e) => e.style.transform)).not.toBe(before);
    // the fill sits under the active tab
    const box = async (sel: string) => (await bar.locator(sel).boundingBox())!;
    await expect.poll(async () => Math.round((await box('.pill .fill')).x - (await box('.pill [aria-current="page"]')).x)).toBe(0);
    // and its width follows the tab (transform only: caps + a scaled middle)
    const fillW = () => bar.locator('.pill .fill').evaluate((e) => { const l = e.getBoundingClientRect().left; return Math.max(...[...e.children].map((c) => c.getBoundingClientRect().right)) - l; });
    await expect.poll(async () => Math.abs(Math.round((await fillW()) - (await box('.pill [aria-current="page"]')).width))).toBeLessThanOrEqual(1);
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('the fill slides and its width glides (springs running right after the click)', async ({ page }) => {
      await page.goto('/watchlist');
      const bar = page.locator('[data-desk-bar]');
      await expect(bar.locator('.pill [aria-current="page"]')).toHaveText('Merkliste');
      await expect.poll(() => bar.locator('.pill .fill').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.14');
      await bar.locator('.pill').getByRole('link', { name: 'Serien' }).click();
      await expect.poll(() => bar.locator('.pill .fill').evaluate((e) => e.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
    });
  });

  test('bar is transparent over the billboard and solid after scrolling 40px; no full-width band', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).not.toHaveClass(/solid/);
    const scrim = bar.locator('.scrim');
    await expect.poll(() => scrim.evaluate((e) => getComputedStyle(e).opacity)).toBe('0'); // nothing over the billboard
    expect(await bar.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await bar.evaluate((e) => getComputedStyle(e).backgroundImage)).toBe('none');
    await page.evaluate(() => window.scrollTo(0, 40));
    await expect(bar).toHaveClass(/solid/);
    expect(await bar.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)'); // the pill turns opaque, not the bar
    await expect.poll(() => scrim.evaluate((e) => getComputedStyle(e).opacity)).toBe('1'); // a soft shade behind logo and buttons
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).not.toHaveClass(/solid/);
    // a page without a billboard: solid right away
    await page.goto('/watchlist');
    await expect(bar).toHaveClass(/solid/);
  });

  test('search: icon expands the field and focuses it; "/" too; typing goes to /search?q=; Esc clears, then closes and refocuses the icon', async ({ page }) => {
    await page.goto('/watchlist');
    const bar = page.locator('[data-desk-bar]');
    const icon = bar.getByRole('button', { name: 'Suche öffnen' });
    const input = bar.locator('#hq');
    await expect(bar.locator('form.search')).not.toHaveClass(/open/);
    await icon.click();
    await expect(bar.locator('form.search')).toHaveClass(/open/);
    await expect(input).toBeFocused();
    await expect.poll(async () => Math.round((await input.boundingBox())?.width ?? 0)).toBeGreaterThan(150);
    // Esc on an empty field closes it, focus goes back to the icon
    await input.press('Escape');
    await expect(bar.locator('form.search')).not.toHaveClass(/open/);
    await expect(icon).toBeFocused();

    await page.locator('main').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await page.keyboard.type('nolan', { delay: 30 });
    await expect(page).toHaveURL(/\/search\?q=nolan$/);
    await expect(input).toHaveValue('nolan');
    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/search$/);
    await input.press('Escape');
    await expect(icon).toBeFocused();
    await page.keyboard.press('Control+K');
    await expect(input).toBeFocused();
  });

  test('narrow window (1024px) on /search: the tabs stay visible and usable; the focused field covers them', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/search?q=nolan');
    const bar = page.locator('[data-desk-bar]');
    const input = bar.locator('#hq');
    await expect(input).toHaveValue('nolan');
    await expect(bar.locator('form.search')).toHaveClass(/open/);
    const series = bar.locator('.pill').getByRole('link', { name: 'Serien' });
    await expect(series).toBeVisible();
    // the field does not lie over any tab
    const field = (await bar.locator('form.search .sbg').boundingBox())!, pill = (await bar.locator('.pill').boundingBox())!;
    expect(field.x).toBeGreaterThanOrEqual(pill.x + pill.width);
    // typing: the field gets its full width and may cover the pill; leaving it brings the tabs back
    await bar.getByRole('button', { name: /Such/ }).click();
    await expect(input).toBeFocused();
    await expect(bar.locator('.pill')).toHaveClass(/covered/);
    await page.locator('main').click({ position: { x: 5, y: 400 } });
    await expect(bar.locator('.pill')).not.toHaveClass(/covered/);
    await series.click();
    await expect(page).toHaveURL(/\/browse\/series$/);
  });

  test('categories, notifications and profile menus open from the bar and close with Esc', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    await bar.locator('.pill').getByRole('button', { name: 'Kategorien' }).click();
    const cats = page.getByRole('region', { name: 'Kategorien' });
    await expect(cats.getByRole('link', { name: 'Drama' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cats).toHaveCount(0);

    const bell = bar.getByRole('button', { name: /Benachrichtigungen/ });
    await expect(bell.locator('.dot')).toHaveText('1');
    await bell.click();
    await expect(page.getByRole('menuitem', { name: /Annas Klassiker/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: /Annas Klassiker/ })).toHaveCount(0);

    await bar.getByRole('button', { name: /Profilmenü/ }).click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    await expect(menu.getByRole('menuitem', { name: 'Konto & Einstellungen' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('phone layout (390px) still renders header.nav.m; TV (?tv=1) still renders nav.rail', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('header.nav.m')).toBeVisible();
    await expect(page.locator('[data-desk-bar]')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await page.goto('/?tv=1');
    await expect(page.locator('nav.rail')).toBeAttached();
    await expect(page.locator('[data-desk-bar]')).toHaveCount(0);
  });
});
