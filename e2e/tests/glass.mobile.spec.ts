// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';

/** Glass foundation on the phone (glass spec §1): blurred with full motion; solid on a kids profile (the kids UI keeps its look). */

const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };

async function probe(page: Page) {
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.className = 'frost frost-panel';
    d.id = 'probe';
    d.setAttribute('style', 'position:fixed;left:10px;top:100px;width:200px;height:100px');
    document.body.appendChild(d);
  });
}
const css = (page: Page, prop: string, pseudo: string | null = null) =>
  page.locator('#probe').evaluate((e, [p, ps]) => getComputedStyle(e, ps).getPropertyValue(p!), [prop, pseudo] as const);

test.describe('glass on the phone', () => {
  test.use({ reducedMotion: 'no-preference' });
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
    await page.addInitScript(() => {
      sessionStorage.setItem('ff-intro-seen', '1');
      sessionStorage.setItem('ff-profile-picked', '1');
      for (const p of ['p1', 'p3']) localStorage.setItem(`ff-intro:${p}`, JSON.stringify({ show: false, sound: false }));
      (window as unknown as { __ffDeskGuard: { slowMs: number; frames: number } }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
    });
  });

  test('phone full motion: probe blurred', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    await probe(page);
    expect(await css(page, 'backdrop-filter')).toContain('blur(38px)');
    expect(await css(page, 'background-image')).toContain('linear-gradient');
    expect(await css(page, 'opacity', '::before')).toBe('0.22');
    expect(await css(page, 'border-radius')).toBe('24px');
  });

  test('kids profile: probe solid', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.goto('/');
    await expect(page).toHaveURL(/\/kids$/);
    await expect(page.locator('html')).toHaveClass(/(^|\s)kids(\s|$)/);
    await probe(page);
    expect(await css(page, 'backdrop-filter')).toBe('none');
    expect(await css(page, 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await css(page, 'display', '::before')).toBe('none');
    expect(await css(page, 'border-radius')).toBe('24px');
  });
});
