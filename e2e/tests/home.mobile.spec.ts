// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';

test.describe('home (phone 390x844)', () => {
  test('shows poster rows, the tab bar and no desktop navigation', async ({ page }) => {
    await page.goto('/');
    const tabbar = page.locator('.tabbar');
    await expect(tabbar).toBeVisible();
    await expect(tabbar.getByRole('link')).not.toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeHidden();

    const because = row(page, 'Weil du „Inkwell“ gesehen hast');
    await because.scrollIntoViewIfNeeded();
    await expect(because.locator('.pc').first()).toBeVisible();
    // Weiterschauen keeps 16:9 cards on the phone
    await expect(row(page, 'Weiterschauen').locator('.pc.landscape')).toHaveCount(2);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('tab bar floats 10 px above the bottom edge, 14 px from the sides', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tabbar')).toBeVisible();
    const { tab, vw, vh } = await page.evaluate(() => ({ tab: document.querySelector('.tabbar')!.getBoundingClientRect(), vw: window.innerWidth, vh: window.innerHeight }));
    expect(Math.round(tab.bottom)).toBe(vh - 10);
    expect(Math.round(tab.left)).toBe(14);
    expect(Math.round(tab.right)).toBe(vw - 14);
  });
});
