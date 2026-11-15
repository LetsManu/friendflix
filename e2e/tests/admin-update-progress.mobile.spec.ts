// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { updaterState } from '../mocks/updater.js';

// Admin → Update on a phone: the result box is reserved for a closed failure note, so nothing below moves when it lands; the
// retry button sits under the text and the advice stays folded away.
test.describe('admin update progress (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  for (const width of [390, 320]) {
    test(`${width} px: a failure lands without moving the card below; retry under the text; nothing overflows`, async ({ page, api }) => {
      api.updater = { ...updaterState(false), redeployOutcome: 'failed' };
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/admin/update');
      const apply = page.getByRole('region', { name: 'Aktualisieren', exact: true });
      await apply.getByRole('button', { name: 'Jetzt aktualisieren' }).tap();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).tap();
      const below = page.getByRole('region', { name: 'Änderungen' });
      await expect(apply.locator('li[aria-current="step"]')).toHaveCount(1);
      const y0 = (await below.boundingBox())!.y;
      const note = apply.locator('[data-result="failed"]');
      await expect(note).toBeVisible({ timeout: 15_000 });
      expect((await below.boundingBox())!.y).toBe(y0);
      const text = (await note.locator('p').first().boundingBox())!;
      const retry = (await note.getByRole('button', { name: 'Erneut versuchen' }).boundingBox())!;
      expect(retry.y).toBeGreaterThanOrEqual(text.y + text.height);
      expect(retry.height).toBeGreaterThanOrEqual(44);
      await page.waitForLoadState('networkidle');
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    });
  }
});
