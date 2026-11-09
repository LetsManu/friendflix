// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';

/**
 * Phone glass surfaces (glass spec §6, §8.9): the tab bar, the scrolled header and the carousel's glass button are glass; the
 * preview sheet is a glass sheet tinted with the poster's tone; a touch squeezes a button and leaves a ripple from the touch
 * point. Calm mode: solid, no ripple.
 */

const css = (loc: Locator, prop: string, pseudo: string | null = null) =>
  loc.evaluate((e, [p, ps]) => getComputedStyle(e, ps).getPropertyValue(p!), [prop, pseudo] as const);

async function setup(page: Page, o: { calm?: boolean } = {}) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
  if (o.calm) await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
  await page.addInitScript((calm) => {
    sessionStorage.setItem('ff-intro-seen', '1');
    sessionStorage.setItem('ff-profile-picked', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    if (calm) localStorage.setItem('ff_calm:p1', '1');
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  }, Boolean(o.calm));
}
async function openSheet(page: Page) {
  const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
  await poster.scrollIntoViewIfNeeded();
  await poster.tap();
  const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
  await expect(sheet).toBeVisible();
  await expect.poll(() => sheet.evaluate((e) => e.getAnimations().length)).toBe(0); // risen
  return sheet;
}
/** a touch press on `loc` at (dx, dy) inside it: the pointerdown only (the link is not followed) */
async function touchDown(loc: Locator, dx: number, dy: number) {
  const b = (await loc.boundingBox())!;
  const at = { x: b.x + dx, y: b.y + dy };
  await loc.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: at.x, clientY: at.y, bubbles: true });
  return at;
}

test.describe('phone glass', () => {
  test('tab bar, header and carousel buttons are glass', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    const bar = page.getByRole('navigation', { name: 'Mobile Navigation' });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveClass(/(^|\s)frost(\s|$)/);
    expect(await css(bar, 'backdrop-filter')).toContain('blur(38px)');
    expect(parseFloat(await css(bar, 'border-top-left-radius'))).toBeGreaterThanOrEqual(30);
    // the safe scrim, solved for the .9 labels (above .7)
    expect(parseFloat(await css(bar, '--fr-scrim'))).toBeGreaterThan(0.7);
    expect(await css(bar.getByRole('link').last(), 'color')).toBe('rgba(255, 255, 255, 0.9)');
    for (const b of await bar.getByRole('link').evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) expect(b).toBeGreaterThanOrEqual(44);

    const g = page.locator('.mc .btn.g');
    await expect(g).toBeVisible();
    await expect(g).toHaveClass(/(^|\s)frost(\s|$)/);
    expect(await css(g, 'backdrop-filter')).toContain('blur(38px)');
    expect(await css(g, 'border-top-left-radius')).toBe('999px');

    // the header turns to glass once scrolled
    await page.mouse.wheel(0, 900);
    const mbg = page.locator('.nav.m .mbg');
    await expect(page.locator('.nav.m')).toHaveClass(/(^|\s)solid(\s|$)/);
    expect(await css(mbg, 'backdrop-filter', '::after')).toContain('blur(38px)');
    expect(await css(mbg, 'background-image', '::after')).toContain('linear-gradient');
  });

  test('preview sheet: a glass sheet with the poster\'s tone', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    const sheet = await openSheet(page);
    await expect(sheet).toHaveClass(/(^|\s)frost(\s|$)/);
    await expect(sheet).toHaveClass(/frost-sheet/);
    expect(await css(sheet, 'backdrop-filter')).toContain('blur(38px)');
    expect(await css(sheet, 'border-top-left-radius')).toBe('26px');
    await expect.poll(() => sheet.getAttribute('style')).toContain('--fr-tint');
    await expect(sheet.locator('.frost-tint i')).toHaveClass(/(^|\s)on(\s|$)/);
    // the scrim never drops under the safe one (the page behind the sheet is unsampled)
    expect(parseFloat(await css(sheet, '--fr-scrim'))).toBeGreaterThan(0.7);
  });

  test('press feedback: a tap scales the button and leaves a ripple from the touch point', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    const sheet = await openSheet(page);
    const play = sheet.locator('a.play');
    const box0 = (await play.boundingBox())!;
    const at = await touchDown(play, 30, box0.height / 2);
    await expect(play).toHaveClass(/(^|\s)pressed(\s|$)/);
    expect(await css(play, 'transition-duration')).toContain('0.08s');
    const rip = play.locator('.ripple');
    await expect(rip).toHaveCount(1);
    // its centre (in the button's own, unscaled box) is the touch point
    const c = await rip.evaluate((e) => ({ x: e.offsetLeft + e.offsetWidth / 2, y: e.offsetTop + e.offsetHeight / 2, w: e.offsetWidth }));
    expect(Math.abs(c.x - (at.x - box0.x))).toBeLessThanOrEqual(2);
    expect(Math.abs(c.y - (at.y - box0.y))).toBeLessThanOrEqual(2);
    expect(Math.abs(c.w - 2 * Math.max(box0.width, box0.height))).toBeLessThanOrEqual(2);
    await expect.poll(() => play.evaluate((e) => getComputedStyle(e).transform)).toBe('matrix(0.92, 0, 0, 0.92, 0, 0)');
    await play.dispatchEvent('pointerup', { pointerType: 'touch', bubbles: true });
    await expect(play).not.toHaveClass(/(^|\s)pressed(\s|$)/);
    await page.waitForTimeout(700);
    await expect(rip).toHaveCount(0);
    // a mouse press does nothing
    await play.dispatchEvent('pointerdown', { pointerType: 'mouse', clientX: box0.x + 5, clientY: box0.y + 5, bubbles: true });
    await expect(play).not.toHaveClass(/(^|\s)pressed(\s|$)/);
  });

  test('calm phone: no ripple, solid tab bar', async ({ page }) => {
    await setup(page, { calm: true });
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-still(\s|$)/);
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)m-glass(\s|$)/);
    const bar = page.getByRole('navigation', { name: 'Mobile Navigation' });
    expect(await css(bar, 'backdrop-filter')).toBe('none');
    expect(await css(bar, 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await css(bar, 'background-image')).toBe('none');
    const sheet = await openSheet(page);
    expect(await css(sheet, 'background-color')).toBe('rgb(28, 26, 33)');
    const play = sheet.locator('a.play');
    await touchDown(play, 30, 20);
    await expect(play.locator('.ripple')).toHaveCount(0);
    await expect(play).not.toHaveClass(/(^|\s)pressed(\s|$)/);
  });
});
