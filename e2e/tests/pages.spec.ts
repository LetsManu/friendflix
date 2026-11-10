// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';

test.describe('account and news pages', () => {
  test('/me renders the quick links and notifications', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByRole('heading', { level: 1, name: 'Mein Bereich' })).toBeAttached();
    await expect(page.getByRole('list', { name: 'Schnellzugriff' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Benachrichtigungen' })).toBeVisible();
    await expect(page.getByText('Anna hat dich zur Liste „Annas Klassiker“ eingeladen')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('/new renders the filter, the new-titles rows and the week ranking', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Anzeigen' }).getByRole('radio')).toHaveText(['Alles', 'Serien', 'Filme']);
    for (const title of ['Für dich neu', 'Neue Serien', 'Neue Folgen', 'Neue Filme', 'Diese Woche bei uns']) await expect(row(page, title)).toBeVisible();
    await expect(row(page, 'Diese Woche bei uns').locator('.rkn')).toHaveCount(5);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
