// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { ltvGuideMock } from '../mocks/admin.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Live-TV → Kanäle → *Programm zuordnen…* on a phone (375 px), extra-guides plan Task 8: the sheet fits, every target ≥ 44 px,
// a pin, back to automatic and *Kein Programm* work, the row card names the pinned guide.
const W = 375;
async function fits(l: Locator, what: string, minH = 0) {
  const b = await l.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b!.x >= -0.5 && b!.x + b!.width <= W + 0.5, `${what} inside 375 px`).toBe(true);
  if (minH) expect(b!.height, `${what} height`).toBeGreaterThanOrEqual(minH);
}
const card = (page: Page, name: string): Locator =>
  page.getByRole('table', { name: 'Kanäle' }).getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });

test.describe('admin: Live-TV, Programm zuordnen (phone, 375 px)', () => {
  test.beforeEach(({ api, page }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    api.admin.livetv.area.sources.push(ltvGuideMock({ id: 'g-int', name: 'Sternwarte Guide mit einem recht langen Namen', position: 2 }));
    api.admin.livetv.area.epgIndex['g-int'] = [{ xmlId: 'sw.int.very.long.identifier.example', names: ['Sternwarte International Weltempfang Plus'] }];
    return page.setViewportSize({ width: W, height: 812 });
  });

  test('the sheet fits and pins, unpins and switches the programme off', async ({ page }) => {
    await page.goto('/admin/livetv?tab=channels');
    await expect(card(page, 'Sternwarte 24')).toBeVisible();
    await page.getByRole('button', { name: 'Aktionen für Sternwarte 24' }).click();
    await page.getByRole('dialog', { name: 'Sternwarte 24' }).getByRole('button', { name: 'Programm zuordnen…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Programm zuordnen: Sternwarte 24' });
    await expect(dlg.locator('[data-pin-hits] li')).toHaveCount(4);
    await fits(dlg, 'sheet');
    await fits(dlg.getByRole('button', { name: 'Schließen' }), 'close', 44);
    await fits(dlg.getByRole('button', { name: 'Automatisch' }), 'Automatisch', 44);
    await fits(dlg.getByRole('button', { name: 'Kein Programm' }), 'Kein Programm', 44);
    await fits(dlg.getByLabel('Programmführer', { exact: true }), 'guide picker', 44);
    await fits(dlg.getByRole('searchbox'), 'search', 44);
    await dlg.getByLabel('Programmführer', { exact: true }).selectOption('g-int');
    const hit = dlg.getByRole('button', { name: '„Sternwarte International Weltempfang Plus“ zuordnen' });
    await fits(hit, 'hit', 44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await hit.click();
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Sternwarte International Weltempfang Plus aus „Sternwarte Guide mit einem recht langen Namen“');
    await fits(dlg.locator('[data-pin-state]'), 'state line');
    await dlg.getByRole('button', { name: 'Automatisch' }).click();
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Automatisch');
    await dlg.getByRole('button', { name: 'Kein Programm' }).click();
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Kein Programm');
    await hit.click();
    await dlg.getByRole('button', { name: 'Schließen' }).click();
    const c = card(page, 'Sternwarte 24');
    await expect(c.locator('[data-pin]')).toHaveText('Von Hand: Sternwarte Guide mit einem recht langen Namen');
    await fits(c.locator('[data-pin]'), 'pinned line');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
