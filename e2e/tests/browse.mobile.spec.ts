// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

test.describe('browse (phone)', () => {
  test('filters live in a bottom sheet: apply, chip, close with Escape, reset', async ({ page }) => {
    await page.goto('/browse/movies');
    await expect(page.locator('#g')).toBeHidden();
    const open = page.locator('.fbtn');
    await expect(open).toBeVisible();

    await open.tap();
    const sheet = page.getByRole('dialog', { name: 'Filter' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Genre').selectOption('Drama');
    await sheet.getByLabel('Sortierung').selectOption('DateCreated');
    await sheet.getByRole('button', { name: 'Anwenden' }).tap();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/genre=Drama/);
    await expect(page).toHaveURL(/sort=DateCreated/);
    await expect(page.getByRole('button', { name: /^Filter Drama entfernen/ })).toBeVisible();

    await open.tap();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    await open.tap();
    await sheet.getByRole('button', { name: 'Zurücksetzen', exact: true }).tap();
    await expect(page).not.toHaveURL(/genre=/);
    await expect(page.getByRole('list', { name: 'Aktive Filter' })).toHaveCount(0);
  });

  test('an empty language and genre index is a final answer: asked once per visit, never in a loop (phone)', async ({ page }) => {
    // regression: the browse page re-requested /api/library/languages ~50 times a second while the index was empty, which filled the
    // per-address rate limit so /api/me and /api/playback/info got 429 and playback failed
    const hits = { languages: 0, genres: 0 };
    await page.route('**/api/library/languages', (r) => { hits.languages++; return r.fulfill({ json: { audio: [], subs: [] } }); });
    await page.route('**/api/library/genres', (r) => { hits.genres++; return r.fulfill({ json: { genres: [] } }); });
    for (const [path, title] of [['/browse/movies', 'Filme'], ['/browse/series', 'Serien']] as const) {
      hits.languages = 0; hits.genres = 0;
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await page.waitForTimeout(3000);
      expect(hits.languages, `${path}: /api/library/languages requests`).toBeLessThanOrEqual(2);
      expect(hits.genres, `${path}: /api/library/genres requests`).toBeLessThanOrEqual(2);
      expect(hits.languages, `${path}: languages asked at all`).toBeGreaterThanOrEqual(1);
    }
  });
});
