// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pop-ups never scale their text, on a phone (menus glass stage 1): the title ⋯ sheet, the header's categories sheet and the
 * new-role dialog are sampled on every frame while they open and close. Full motion (the suite default is reduced motion).
 */
import type { Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { stableBox, textScaleDuring, watchTextScale } from '../frames.js';

const LIMIT = 0.001;

async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    sessionStorage.setItem('ff-profile-picked', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
}

test.describe('no text scaling in pop-ups (phone)', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('the title ⋯ sheet, open and close', async ({ page }) => {
    await page.goto('/item/' + MOVIE.id);
    const more = page.getByRole('button', { name: 'Mehr', exact: true }).first();
    expect(await textScaleDuring(page, '.ma-pop', () => more.click())).toBeLessThan(LIMIT);
    const stop = await watchTextScale(page, '.ma-pop');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ma-pop')).toHaveCount(0);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });

  test('the header categories sheet, open and close', async ({ page }) => {
    await page.goto('/');
    const chip = page.getByRole('button', { name: 'Kategorien' }).first();
    expect(await textScaleDuring(page, '.cats', () => chip.click())).toBeLessThan(LIMIT);
    const stop = await watchTextScale(page, '.cats');
    await page.getByRole('dialog', { name: 'Kategorien' }).getByRole('button', { name: 'Schließen' }).click();
    await expect(page.locator('.cats')).toHaveCount(0);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });

  test('the new-role dialog, open and close; the heading does not move', async ({ page, api }) => {
    api.asAdmin = true;
    api.admin.matrix.features.livetv = true;
    await page.goto('/admin/roles');
    const before = await stableBox(page, 'main h1, h1');
    expect(await textScaleDuring(page, '[role="dialog"]', () => page.getByRole('button', { name: 'Neue Rolle' }).click())).toBeLessThan(LIMIT);
    const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
    await expect(dlg).toBeVisible();
    expect(await stableBox(page, 'main h1, h1')).toEqual(before);
    const stop = await watchTextScale(page, '[role="dialog"]');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dlg).toHaveCount(0);
    await page.waitForTimeout(300);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });
});
