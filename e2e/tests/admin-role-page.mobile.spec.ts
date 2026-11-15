// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The role page on the phone (roles redesign §5.3): one column of area cards, 44 px targets, the save bar never covers a section. */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const areas = (page: Page) => page.getByRole('region', { name: 'Bereiche' });

test.describe('Rollen & Rechte: the role page (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('one column of area cards, every toggle ≥ 44 px, the save bar does not cover the last section', async ({ page }) => {
    await page.goto('/admin/roles/family');
    const cards = areas(page).getByRole('switch');
    await expect(cards).toHaveCount(4); // Live TV is not installed: no Live-TV card
    const boxes = await Promise.all((await cards.all()).map((c) => c.boundingBox()));
    for (const b of boxes) {
      expect(b!.height).toBeGreaterThanOrEqual(44);
      expect(Math.round(b!.x)).toBe(Math.round(boxes[0]!.x)); // one column
    }
    for (const t of await page.getByRole('main').getByRole('switch').all()) {
      const b = (await t.boundingBox())!;
      expect(b.height, await t.getAttribute('aria-labelledby') ?? '').toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    // stage something, scroll to the end: the last section ends above the bar
    await page.getByRole('switch', { name: 'Gemeinsam', exact: true }).click();
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = page.locator('section.sec').last();
    await expect.poll(async () => {
      const [l, b] = await Promise.all([last.boundingBox(), bar(page).boundingBox()]);
      return l && b ? Math.round(l.y + l.height) <= Math.round(b.y) : false;
    }).toBe(true);
  });
});
