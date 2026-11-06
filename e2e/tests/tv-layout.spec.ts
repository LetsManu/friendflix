// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** TV layout: a paired television gets the 10-foot design (html.tv) */
async function setTv(page: Page, tv: boolean) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
}

test.describe('TV layout', () => {
  test('tokens: black background and white focus ring on TV', async ({ page, api: _api }) => {
    await setTv(page, true);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(page.locator('button.avatar')).toBeEnabled();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { tag: el.tagName, color: s.outlineColor, width: s.outlineWidth, shadow: s.boxShadow };
    });
    expect(ring.color).toBe('rgb(255, 255, 255)');
    expect(ring.width).toBe('3px');
  });

  test('tokens: desktop keeps the dark grey background', async ({ page, api: _api }) => {
    await setTv(page, false);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 20, 24)');
  });
});
