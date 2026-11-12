// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { auid } from '../mocks/admin.js';

// Gruppen & Rechte on a phone (390 px): the list, the release sheet and the matrix stay inside the screen, every control is a 44 px target.
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const rows = (page: Page) => page.locator('ul.list > li');

test.describe('admin: Live-TV, Gruppen & Rechte (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('the list, the release sheet and the matrix fit the screen', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await expect(rows(page)).toHaveCount(7);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    // the controls of a row are 44 px targets
    for (const b of await rows(page).nth(2).getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    await rows(page).nth(0).getByRole('button', { name: 'Freigeben …' }).click();
    const dlg = page.getByRole('dialog', { name: 'Gruppen freigeben' });
    await dlg.getByRole('checkbox', { name: 'Gast' }).check();
    await dlg.getByRole('button', { name: 'Freigeben', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    expect(api.admin.livetv.area.calls.find((c) => /groups\/release$/.test(c.p))!.body).toEqual({ ids: ['g-kino'], roles: ['guest'], kidFriendly: false });
    await page.getByRole('radio', { name: 'Nach Rolle', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Gruppen nach Rolle' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the Rechte tab offers the group exceptions', async ({ page, api }) => {
    api.admin.matrix.features.livetv = true;
    await page.goto(`/admin/users/${auid(4)}?tab=rights`);
    const sec = page.getByRole('region', { name: 'Kanalgruppen-Ausnahmen' });
    await expect(sec.getByLabel('Gruppe hinzufügen (+)')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
