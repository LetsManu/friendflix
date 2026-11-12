// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin: Live-TV entry (phone, 375 px)', () => {
  test.beforeEach(({ api, page }) => { api.asAdmin = true; return page.setViewportSize({ width: 375, height: 812 }); });

  test('the card and the admin list row with the chip fit; targets are at least 44 px', async ({ page, api }) => {
    await page.goto('/admin');
    const list = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    const link = list.getByRole('link', { name: /Live-TV/ });
    await expect(link).toContainText('optional');
    const lb = await link.boundingBox();
    expect(lb && lb.height >= 44 && lb.x >= 0 && lb.x + lb.width <= 375).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await link.click();
    await expect(page).toHaveURL(/\/admin\/livetv$/);
    const card = page.getByRole('region', { name: 'Live-TV (optional)' });
    await expect(card.getByRole('button', { name: 'Live-TV aktivieren' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    for (const name of ['Live-TV aktivieren', 'Nicht mehr anzeigen']) {
      const b = await card.getByRole('button', { name }).boundingBox();
      expect(b && b.height >= 44 && b.x >= 0 && b.x + b.width <= 375, name).toBe(true);
    }
    // the manual way fits as well
    api.admin.livetv.updater = false;
    await page.reload();
    await expect(card.getByRole('button', { name: 'Kopieren' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the off dialog fits the phone', async ({ page, api }) => {
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Live-TV ausschalten …' }).click();
    const dlg = page.getByRole('dialog', { name: 'Live-TV ausschalten?' });
    await expect(dlg).toBeVisible();
    const box = await dlg.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    for (const name of ['Image entfernen', 'Ausschalten', 'Abbrechen']) {
      const b = await dlg.getByText(name, { exact: true }).first().boundingBox();
      expect(b && b.height >= 20, name).toBe(true);
    }
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
