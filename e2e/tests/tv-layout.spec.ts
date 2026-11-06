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
    expect(ring.shadow).toBe('none');
  });

  test('tokens: .tv-btn on a <button> keeps its own size', async ({ page, api: _api }) => {
    await setTv(page, true);
    await page.goto('/');
    await expect(page.locator('button.avatar')).toBeEnabled();
    const r = await page.evaluate(() => {
      const b = document.createElement('button'); b.className = 'tv-btn'; b.textContent = 'x'; document.body.append(b);
      return { fs: parseFloat(getComputedStyle(b).fontSize), root: parseFloat(getComputedStyle(document.documentElement).fontSize), h: b.getBoundingClientRect().height };
    });
    expect(r.fs).toBeCloseTo(r.root * 1.4, 1);
    expect(r.h).toBeGreaterThanOrEqual(56);
  });

  test('tokens: desktop keeps the dark grey background', async ({ page, api: _api }) => {
    await setTv(page, false);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 20, 24)');
  });
});
