// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Live-Status on a phone (Task 26): the tables become cards, nothing scrolls sideways, the targets are 44 px.
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test.describe('admin: Live-TV, Live-Status (phone)', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    api.admin.livetv.status.ingest = [{ channelId: 'ch-wolkenlos', name: 'Kanal Wolkenlos', port: 9001, state: 'receiving', since: Date.now() - 20 * 60_000, bitrate: 2_000_000, rejected1h: 2 }];
  });

  test('the cards fit 390 px and the menu and buttons are 44 px', async ({ page }) => {
    await page.goto('/admin/livetv?tab=status');
    await expect(card(page, 'Laufende Sender').getByText('Nordlicht TV')).toBeVisible();
    await expect(card(page, 'Gesendete Streams').getByText('Kanal Wolkenlos')).toBeVisible();
    await expect(card(page, 'Ereignisse').getByText('Eingang verloren · 12 s bis zur Wiederverbindung')).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(wide).toBe(false);
    for (const loc of [page.getByRole('button', { name: 'Aktionen für Nordlicht TV' }), page.getByRole('button', { name: 'Live-TV ausschalten …' })]) {
      const b = await loc.boundingBox();
      expect(b!.height).toBeGreaterThanOrEqual(44);
      expect(b!.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('Stoppen from the menu sheet confirms', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    await page.getByRole('button', { name: 'Aktionen für Hafenkanal' }).click();
    await page.getByRole('dialog', { name: 'Hafenkanal' }).getByRole('button', { name: 'Stoppen' }).click();
    await page.getByRole('alertdialog', { name: '„Hafenkanal“ stoppen?' }).getByRole('button', { name: 'Stoppen' }).click();
    await expect(card(page, 'Laufende Sender').getByText('Hafenkanal')).toHaveCount(0);
    expect(api.admin.livetv.status.stops).toEqual(['ch-hafenkanal']);
  });
});
