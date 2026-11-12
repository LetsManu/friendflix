// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV, Task 42: the stream test's 10-second muted preview (Kanäle → Testen) that then stops watching, and the running
// channels of Live-Status with Stoppen (confirmed) and Neu starten (stop + test start).
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const PREVIEW_TOKEN = 'p'.repeat(43);
async function menu(page: Page, channel: string, item: string) {
  await page.getByRole('button', { name: `Aktionen für ${channel}` }).click();
  await page.getByRole('dialog', { name: channel }).getByRole('button', { name: item }).click();
}

test.describe('admin: stream test preview and running streams', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('the test sheet plays 10 s muted, then stops watching', async ({ page, api }) => {
    api.admin.livetv.area.chPreview = true;
    await page.goto('/admin/livetv?tab=channels');
    await menu(page, 'Nordlicht TV', 'Testen');
    const dlg = page.getByRole('dialog', { name: 'Stream testen: Nordlicht TV' });
    await expect(dlg.locator('[data-facts]')).toContainText('wird umverpackt');
    // the frame plays the channel's live playlist (the test token's URL), muted
    const frame = dlg.locator('[data-preview] video');
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveJSProperty('muted', true);
    await expect.poll(() => api.livetv.playlistLoads).toBeGreaterThan(0);
    expect(api.livetv.stops).toEqual([]);
    // after 10 s the player is gone and the token was let go (DELETE /api/livetv/watch)
    await expect(dlg.locator('[data-preview-ended]')).toBeVisible({ timeout: 15_000 });
    await expect(dlg.locator('video')).toHaveCount(0);
    expect(api.livetv.stops).toEqual([PREVIEW_TOKEN]);
    // closing the sheet later does not let it go a second time
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    await expect(dlg).toHaveCount(0);
    expect(api.livetv.stops).toEqual([PREVIEW_TOKEN]);
  });

  test('closing the test sheet during the preview stops watching at once', async ({ page, api }) => {
    api.admin.livetv.area.chPreview = true;
    await page.goto('/admin/livetv?tab=channels');
    await menu(page, 'Nordlicht TV', 'Testen');
    const dlg = page.getByRole('dialog', { name: 'Stream testen: Nordlicht TV' });
    await expect(dlg.locator('[data-preview] video')).toHaveCount(1);
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    await expect(dlg).toHaveCount(0);
    await expect.poll(() => api.livetv.stops).toEqual([PREVIEW_TOKEN]);
  });

  test('a test answer that arrives after the sheet closed lets its token go and plays nothing', async ({ page, api }) => {
    api.admin.livetv.area.chPreview = true;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let asked = false;
    await page.route('**/api/admin/livetv/channels/*/test', async (route) => { asked = true; await gate; await route.fallback(); });
    await page.goto('/admin/livetv?tab=channels');
    await menu(page, 'Nordlicht TV', 'Testen');
    const dlg = page.getByRole('dialog', { name: 'Stream testen: Nordlicht TV' });
    await expect.poll(() => asked).toBe(true);
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    await expect(dlg).toHaveCount(0);
    expect(api.livetv.stops).toEqual([]);
    open();
    await expect.poll(() => api.livetv.stops).toEqual([PREVIEW_TOKEN]);
    expect(api.livetv.playlistLoads).toBe(0);
  });

  test('Live-Status lists running channels; Stoppen confirms', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    const run = page.getByRole('region', { name: 'Laufende Sender', exact: true });
    await expect(run.getByRole('row', { name: /Nordlicht TV/ })).toContainText('4,2 Mbit/s');
    await expect(run.getByRole('row', { name: /Hafenkanal/ })).toContainText('Direkt');
    // Stoppen asks first; cancelling keeps the channel
    await menu(page, 'Hafenkanal', 'Stoppen');
    const ask = page.getByRole('alertdialog', { name: '„Hafenkanal“ stoppen?' });
    await ask.getByRole('button', { name: 'Abbrechen' }).click();
    expect(api.admin.livetv.status.stops).toEqual([]);
    await menu(page, 'Hafenkanal', 'Stoppen');
    await page.getByRole('alertdialog', { name: '„Hafenkanal“ stoppen?' }).getByRole('button', { name: 'Stoppen' }).click();
    await expect(toasts(page).getByText('„Hafenkanal“ gestoppt.')).toBeVisible();
    await expect(run.getByRole('row', { name: /Hafenkanal/ })).toHaveCount(0);
    expect(api.admin.livetv.status.stops).toEqual(['ch-hafenkanal']);
  });
});
