// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Live-TV → Einstellungen on a phone: nothing scrolls sideways, the save button and the link are 44 px.
test.describe('admin: Live-TV, Einstellungen (phone)', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
  });

  test('the tab fits 390 px and the controls are 44 px', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=settings');
    await expect(page.getByRole('group', { name: 'Rückspulpuffer für Live-TV (Minuten)' })).toBeVisible();
    await expect(page.locator('[data-srt-ports]')).toHaveText('UDP 9000–9009');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.getByRole('group', { name: 'Rückspulpuffer für Live-TV (Minuten)' }).getByRole('spinbutton').fill('60');
    const save = page.getByRole('button', { name: 'Speichern' });
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await save.click();
    await expect.poll(() => api.settings.puts).toEqual([{ values: { LIVETV_DVR_MINUTES: 60 } }]);
  });

  test('the settings page link is a 44 px target', async ({ page }) => {
    await page.goto('/admin/settings');
    const link = page.getByRole('link', { name: 'Live-TV-Einstellungen findest du jetzt unter Live-TV.' });
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
