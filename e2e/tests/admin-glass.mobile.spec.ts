// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const css = (loc: Locator, prop: string) => loc.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

test.describe('dense glass admin (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('phone admin list is a glass card; rows ≥ 44 px', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/admin');
    const list = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(list.getByRole('heading', { name: 'Personen' })).toBeVisible();
    const cards = list.locator('ul.lst');
    await expect(cards.first()).toBeVisible();
    for (const c of await cards.all()) {
      await expect(c).toHaveClass(/frost-flat/);
      expect(await css(c, 'border-top-left-radius')).toBe('16px');
    }
    for (const h of await list.getByRole('link').evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    // a table on the phone: each row a card, at least 44 px
    await page.goto('/admin/users');
    const rows = page.getByRole('table').first().locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    for (const h of await rows.evaluateAll((rs) => rs.map((r) => r.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
    expect(await css(rows.first(), 'border-top-left-radius')).toBe('16px');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
