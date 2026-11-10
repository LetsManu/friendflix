// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';

const UPCOMING = {
  movie: [{ tmdbId: 11, mediaType: 'movie', title: 'Vesper Bay', releaseDate: '2026-11-28T00:00:00Z', status: 'nicht_angefragt' }],
  tv: [{ tmdbId: 12, mediaType: 'tv', title: 'Nightingale Road', releaseDate: '2026-11-21T00:00:00Z', status: 'nicht_angefragt' }],
};

test.describe('new & upcoming (phone)', () => {
  test('poster rows with their notes, new episodes as a list, the tab bar says Neu', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    for (const s of ['Für dich neu', 'Neue Serien', 'Neue Filme', 'Diese Woche bei uns']) await expect(row(page, s)).toBeAttached();
    await expect(row(page, 'Für dich neu').locator('.pc')).toHaveCount(3); // poster cards of the phone
    await expect(row(page, 'Für dich neu').getByText('Weil du „Inkwell“ gesehen hast · gleiche Regie')).toBeAttached();
    await expect(row(page, 'Neue Serien').locator('.note .fresh').first()).toHaveText('Neu seit gestern');
    await expect(row(page, 'Neue Serien').locator('.note .nm').first()).toBeVisible(); // the phone names the title under the poster

    // Neue Folgen is a vertical list, not a row: one link per show that plays the newest episode
    const eps = page.getByRole('region', { name: 'Neue Folgen' });
    await expect(eps.getByRole('listitem')).toHaveCount(2);
    await expect(eps.getByRole('link').first()).toHaveAttribute('href', /^\/watch\//);
    await expect(eps.getByRole('link', { name: /Bright Valley, Staffel 1 · Folge 2/ })).toBeVisible();
    await expect(eps.getByText('Neu heute')).toBeVisible();
    expect((await eps.getByRole('link').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('section.row[aria-label="Neue Folgen"]')).toHaveCount(0);

    await expect(page.getByRole('region', { name: 'Demnächst' })).toBeAttached();
    const tabs = page.locator('.tabbar').getByRole('link');
    await expect(tabs.nth(1)).toHaveAccessibleName('Neu & demnächst');
    await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the filter is a full-width segment bar; it works and survives a reload', async ({ page }) => {
    await page.goto('/new');
    const group = page.getByRole('radiogroup', { name: 'Anzeigen' });
    for (const name of ['Alles', 'Serien', 'Filme']) expect((await group.getByRole('radio', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await group.getByRole('radio', { name: 'Filme' }).tap();
    await expect(page).toHaveURL(/\?type=movie$/);
    await expect(row(page, 'Neue Serien')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Neue Folgen' })).toHaveCount(0);
    await expect(row(page, 'Neue Filme')).toBeAttached();
    await page.reload();
    await expect(page.getByRole('radiogroup', { name: 'Anzeigen' }).getByRole('radio', { name: 'Filme' })).toBeChecked();
    await expect(row(page, 'Neue Serien')).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('nothing new: the empty state', async ({ page, api }) => {
    api.newPage.forYou = [];
    api.newPage.episodes = [];
    await page.route('**/api/library/items?*', (r) => r.fulfill({ json: { items: [], total: 0 } }));
    await page.goto('/new');
    const empty = page.getByRole('region', { name: 'Diese Woche ist nichts Neues dazugekommen' });
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Zuletzt hinzugefügt ansehen' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('without a request service: "Neu" in the title, the tab bar and no Demnächst', async ({ page, api }) => {
    api.features = { requests: false };
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Neu – FriendFlix');
    const tabs = page.locator('.tabbar').getByRole('link');
    await expect(tabs.nth(1)).toHaveAccessibleName('Neu');
    await expect(page.locator('.tabbar a > span:last-child')).toHaveText(['Start', 'Neu', 'Merkliste']);
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);
    await expect(row(page, 'Diese Woche bei uns')).toBeAttached();
  });

  test('the start page has no inline request row without a request service', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Demnächst – jetzt wünschen' })).toBeAttached();
    api.features = { requests: false };
    await page.goto('/');
    await expect(row(page, 'Weiterschauen')).toBeAttached();
    await expect(page.getByRole('region', { name: 'Demnächst – jetzt wünschen' })).toHaveCount(0);
  });
});
