// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';

// A person without libraries on a phone (roles redesign §6): the tab bar has only Live, the header has no search and no category
// chips, and the start page is Live TV. Anna Beispiel watches Nordlicht TV and Hafenkanal (mocks/livetv.ts).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const tabbar = (page: Page) => page.getByRole('navigation', { name: 'Mobile Navigation' });

test.describe('a person without libraries (phone)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    api.areas = { library: false, livetv: true, requests: false, together: false, downloads: false };
    api.canDownload = true; // the role may download, but downloads are library items: no Downloads tab without a library
    api.accountSaved = { name: 'Anna Beispiel', avatar: 'a1' };
    await mockLivePlayer(page);
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await page.clock.install({ time: NOW });
  });

  test('tab bar shows only Live; no category chips', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    await expect(tabbar(page).getByRole('link')).toHaveCount(1);
    await expect(tabbar(page).getByRole('link')).toHaveAttribute('href', '/live');
    await expect(tabbar(page).getByRole('link')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Kategorien' })).toHaveCount(0);
    await expect(page.locator('html.m-chips')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Suche' })).toHaveCount(0);
    // /me: account things only, no library tiles or rows
    await page.getByRole('link', { name: 'Mein Bereich' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/me');
    await expect(page.getByRole('main').getByRole('link', { name: 'Einstellungen', exact: true })).toBeVisible();
    const hrefs = await page.locator('main .tiles2 a, main .groups a').evaluateAll((l) => l.map((a) => a.getAttribute('href')!));
    for (const h of hrefs) expect(h, h).toMatch(/^\/(settings|devices|remote|me|admin|diagnose)(\/|#|$)/);
    await expect(page.getByRole('button', { name: 'Überrasch mich' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Weiterschauen' })).toHaveCount(0);
  });
});
