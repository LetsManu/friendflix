// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Aufnahmen on a phone (Phase 3 Task 11): the list's rows become cards (the UI kit's DataTable at ≤ 720 px), nothing
// is wider than the screen, and *Abbrechen* stays a 44 px target.
test('rows become cards', async ({ page, api }) => {
  api.asAdmin = true;
  Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
  await page.goto('/admin/livetv?tab=recordings');
  const c = page.getByRole('region', { name: 'Geplante, laufende und fehlgeschlagene Aufnahmen' });
  const cards = c.locator('tbody tr');
  await expect(cards).toHaveCount(3);
  expect(await cards.first().evaluate((e) => getComputedStyle(e).display)).not.toBe('table-row');
  expect((await cards.first().boundingBox())!.width).toBeLessThanOrEqual(390);
  await expect(cards.first()).toContainText('Nordlicht TV');
  const b = (await cards.first().getByRole('button', { name: 'Abbrechen' }).boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
