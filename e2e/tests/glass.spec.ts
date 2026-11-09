// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

/**
 * Glass foundation (glass spec §1, app.css .frost): a probe surface is blurred, milky and grainy with full motion, and a solid
 * panel with the same shape in calm mode, with reduced motion, after the frame guard tripped and on TV.
 */

/** a glass panel injected into the current page */
async function probe(page: Page) {
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.className = 'frost frost-panel';
    d.id = 'probe';
    d.setAttribute('style', 'position:fixed;left:10px;top:100px;width:200px;height:100px');
    document.body.appendChild(d);
  });
  return page.locator('#probe');
}
const css = (page: Page, prop: string, pseudo: string | null = null) =>
  page.locator('#probe').evaluate((e, [p, ps]) => getComputedStyle(e, ps).getPropertyValue(p!), [prop, pseudo] as const);

/** no brand intro over the page; the frame guard with a budget no test host misses (it is unit-tested, lib/tv/motion.test.ts) */
async function quiet(page: Page, guard = { slowMs: 1000, frames: 8 }) {
  await page.addInitScript((g) => {
    sessionStorage.setItem('ff-intro-seen', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: typeof g }).__ffDeskGuard = g;
  }, guard);
}

async function expectSolid(page: Page) {
  await expect(page.locator('html')).not.toHaveClass(/(^|\s)m-glass(\s|$)/);
  await probe(page);
  expect(await css(page, 'backdrop-filter')).toBe('none');
  expect(await css(page, 'background-color')).toBe('rgb(28, 26, 33)');
  expect(await css(page, 'background-image')).toBe('none');
  expect(await css(page, 'display', '::before')).toBe('none');
  expect(await css(page, 'border-radius')).toBe('24px');
}

test.describe('glass', () => {
  test.use({ reducedMotion: 'no-preference' });
  test.beforeEach(({ page }) => page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }))); // no clips

  test('full motion: the probe is blurred, translucent, with grain and the 24 px radius', async ({ page }) => {
    await quiet(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    await probe(page);
    expect(await css(page, 'backdrop-filter')).toContain('blur(38px)');
    expect(await css(page, 'background-image')).toContain('linear-gradient');
    // the light scrim over the dark app background: translucent, not the heavy one (owner ruling)
    expect(await css(page, 'background-color')).toBe('rgba(18, 16, 24, 0.2)');
    expect(await css(page, 'opacity', '::before')).toBe('0.22');
    expect(await css(page, 'border-radius')).toBe('24px');
    expect(await css(page, 'border-top-color')).toBe('rgba(255, 255, 255, 0.2)');
    // .frost-safe (bright content nobody sampled behind it) takes the heavy scrim; a sampled tone set inline wins
    await page.locator('#probe').evaluate((e) => e.classList.add('frost-safe'));
    expect(await css(page, 'background-color')).toBe('rgba(18, 16, 24, 0.7)');
    await page.locator('#probe').evaluate((e) => e.style.setProperty('--fr-scrim', '0.42'));
    expect(await css(page, 'background-color')).toBe('rgba(18, 16, 24, 0.42)');
  });

  test('calm mode: solid', async ({ page }) => {
    await quiet(page);
    await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
    await page.addInitScript(() => localStorage.setItem('ff_calm:p1', '1'));
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/m-still/);
    await expectSolid(page);
  });

  test('reduced motion: solid', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await quiet(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/m-still/);
    await expectSolid(page);
  });

  test('a tripped frame guard turns glass solid', async ({ page }) => {
    await quiet(page, { slowMs: 1, frames: 1 }); // every frame is "slow": the first motion trips it
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    // start motion: a row card under the pointer, then the row glides a page
    const row = page.locator('section.row', { has: page.getByRole('heading', { name: /Weil du/ }) });
    await row.scrollIntoViewIfNeeded();
    await row.locator('article.card').first().hover();
    await row.getByRole('heading', { name: /Weil du/ }).hover();
    await row.locator('button.pg.next').click();
    await expect(page.locator('html')).toHaveClass(/tv-motion-reduced/);
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)m-glass(\s|$)/);
    await probe(page);
    expect(await css(page, 'backdrop-filter')).toBe('none');
    expect(await css(page, 'background-color')).toBe('rgb(28, 26, 33)');
  });

  test('TV (?tv=1): no backdrop filter, same shape', async ({ page }) => {
    await quiet(page);
    await page.goto('/?tv=1');
    await expect(page.locator('html')).toHaveClass(/(^|\s)tv(\s|$)/);
    await probe(page);
    expect(await css(page, 'backdrop-filter')).toBe('none');
    expect(await css(page, 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await css(page, 'display', '::before')).toBe('none');
    expect(await css(page, 'border-radius')).toBe('24px');
  });
});
