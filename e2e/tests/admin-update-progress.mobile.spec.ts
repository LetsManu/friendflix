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

  // the reserves are sized for the longest locale: a failure lands without moving anything below in every one of them
  for (const loc of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
    test(`320 px, ${loc}: the failure note and the end label fit their reserved room`, async ({ page, api }) => {
      api.updater = { ...updaterState(false), redeployOutcome: 'failed' };
      await page.addInitScript((l) => { try { localStorage.setItem('ff-locale', l); } catch { /* blocked storage */ } }, loc);
      await page.setViewportSize({ width: 320, height: 844 });
      await page.goto('/admin/update');
      const go = page.locator('.apply button').first();
      await go.tap();
      await page.getByRole('alertdialog').locator('button[type="submit"]').tap();
      const below = page.locator('table').first();
      await expect(page.locator('li[aria-current="step"]')).toHaveCount(1);
      const y0 = (await below.boundingBox())!.y;
      await expect(page.locator('[data-result="failed"]')).toBeVisible({ timeout: 15_000 });
      expect((await below.boundingBox())!.y).toBe(y0);
    });
  }

  test('320 px, pl: a rolled-back job (the longest note) lands in the reserved room', async ({ page, api }) => {
    api.updater = { ...updaterState(true), outcome: 'rolled_back', downPolls: 0 };
    await page.addInitScript(() => { try { localStorage.setItem('ff-locale', 'pl'); } catch { /* blocked storage */ } });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/admin/update');
    const c = page.locator('[data-updater]').locator('xpath=ancestor::section[1]');
    await c.locator('.row.actions button').first().tap();
    await c.locator('.confirm button').first().tap();
    const below = c.locator('.auto h3');
    await expect(c.locator('li[aria-current="step"]')).toHaveCount(1);
    const y0 = (await below.boundingBox())!.y;
    await expect(c.locator('[data-result="rolled_back"]')).toBeVisible({ timeout: 20_000 });
    expect((await below.boundingBox())!.y).toBe(y0);
  });
});
