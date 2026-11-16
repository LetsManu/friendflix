// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pop-ups never scale their text (menus glass stage 1): every frame of a menu, toast, dialog and the Update page's result note
 * is sampled while it opens and closes; the product of the text's own and all its ancestors' transforms stays at scale 1.
 * Full motion (the suite's default is reduced motion, which would animate nothing). Desktop.
 */
import type { Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { updaterState } from '../mocks/updater.js';
import { expect, test } from '../fixtures.js';
import { stableBox, textScaleDuring, watchTextScale } from '../frames.js';

const LIMIT = 0.001;

async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
}

test.describe('no text scaling in pop-ups (desktop)', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('the title page ⋯ menu', async ({ page }) => {
    await page.goto('/item/' + MOVIE.id);
    const more = page.getByRole('button', { name: 'Mehr', exact: true });
    expect(await textScaleDuring(page, '.ma-pop', () => more.click())).toBeLessThan(LIMIT);
    await expect(page.locator('.ma-pop')).toBeVisible();
    // closing: the same surface folds back, still unscaled
    const stop = await watchTextScale(page, '.ma-pop');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ma-pop')).toHaveCount(0);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });

  test('the header profile menu, open and close', async ({ page }) => {
    await page.goto('/');
    const acct = page.locator('[data-desk-bar]').getByRole('button', { name: /Profilmenü/ });
    expect(await textScaleDuring(page, '[role="menu"]', () => acct.click())).toBeLessThan(LIMIT);
    const stop = await watchTextScale(page, '[role="menu"]');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Profilmenü' })).toHaveCount(0);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });

  test('a toast, in and out', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin');
    const attn = page.getByRole('region', { name: 'Wartet auf dich' });
    const stop = await watchTextScale(page, '.toast');
    await attn.getByRole('button', { name: '„Dunmoor: Part Two“ freigeben' }).click();
    await expect(page.locator('.toast')).toBeVisible();
    await page.waitForTimeout(450);
    await page.getByRole('region', { name: 'Hinweise' }).locator('.toast').first().focus();
    await page.keyboard.press('Escape'); // closes the focused toast
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 9000 });
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });

  test('the confirm dialog, open and close; the heading does not move when it opens', async ({ page, api }) => {
    api.asAdmin = true;
    const extra = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    api.admin.matrix.roles.splice(4, 0, { ...extra, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 0, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...extra.values } });
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'Aktionen für Oma' }).click();
    const item = page.getByRole('dialog', { name: 'Oma' }).getByRole('button', { name: 'Löschen' });
    const h1 = 'main h1, h1';
    const before = await stableBox(page, h1);
    const dlg = page.locator('[role="alertdialog"]');
    expect(await textScaleDuring(page, '[role="alertdialog"]', () => item.click())).toBeLessThan(LIMIT);
    await expect(dlg).toBeVisible();
    expect(await stableBox(page, h1)).toEqual(before);
    const stop = await watchTextScale(page, '[role="alertdialog"]');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dlg).toHaveCount(0);
    await page.waitForTimeout(300);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
    expect(await stableBox(page, h1)).toEqual(before);
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
    expect(await stableBox(page, 'main h1, h1')).toEqual(before);
  });

  test('the Update page result note', async ({ page, api }) => {
    api.asAdmin = true;
    api.updater = { ...updaterState(false), redeployOutcome: 'unchanged' };
    await page.goto('/admin/update');
    const apply = page.getByRole('region', { name: 'Aktualisieren', exact: true });
    await apply.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const stop = await watchTextScale(page, '[data-result]');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const note = apply.locator('[data-result="unchanged"]');
    await expect(note).toContainText('Portainer ist fertig', { timeout: 15_000 });
    await page.waitForTimeout(600);
    const r = await stop();
    expect(r.frames).toBeGreaterThan(0);
    expect(r.dev).toBeLessThan(LIMIT);
  });
});
