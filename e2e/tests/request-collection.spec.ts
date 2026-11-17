// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { MOVIE } from '../mocks/fixtures.js';

/** "Ganze Reihe anfragen" (lib/requests/CollectionSheet.svelte): from the detail page's collection row and after a movie wish. */
const part = (o: object) => ({ image: true, played: false, current: false, inLibrary: true, from: 'tmdb', ...o });
const ABOUT = {
  ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], canRequest: true, sources: ['jellyfin', 'tmdb'],
  collection: {
    name: 'Sternwarte 24 – Die Reihe', from: 'tmdb',
    parts: [
      part({ id: MOVIE.id, tmdbId: 8001, name: MOVIE.name, year: 2012, current: true }),
      part({ tmdbId: 8002, name: 'Sternwarte 24: Funkstille', year: 2014, inLibrary: false, image: false }),
      part({ tmdbId: 8004, name: 'Sternwarte 24: Sonnenwind', year: 2018, inLibrary: false, image: false }),
      part({ tmdbId: 8008, name: 'Sternwarte 24: Kometen', year: 2020, inLibrary: false, image: false }),
    ],
  },
};
const P = (tmdbId: number, title: string, year: string | undefined, state: string) => ({ tmdbId, title, ...(year ? { year, releaseDate: `${year}-06-01` } : {}), poster: `/api/seerr/image/p${tmdbId}.jpg`, state });
const COLLECTION = {
  collection: {
    id: 900, name: 'Sternwarte 24 – Die Reihe', poster: '/api/seerr/image/col900.jpg',
    parts: [
      P(8001, 'Sternwarte 24', '2012', 'none'), // the library has it (the service does not know yet): shown as in the library
      P(8002, 'Sternwarte 24: Funkstille', '2014', 'none'),
      P(8003, 'Sternwarte 24: Nachtschicht', '2016', 'requested'),
      P(8004, 'Sternwarte 24: Sonnenwind', '2018', 'declined'),
      P(8008, 'Sternwarte 24: Kometen', '2020', 'none'),
      P(8005, 'Sternwarte 24: Morgen', '2099', 'unreleased'),
    ],
  },
};

async function openFromDetail(page: Page, api: MockState) {
  api.requestSheets.collections[8001] = COLLECTION;
  await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: ABOUT }));
  await page.route('**/api/seerr/image/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
  await page.goto('/item/' + MOVIE.id);
  await page.getByRole('tablist', { name: 'Weitere Inhalte' }).getByRole('tab', { name: 'Details' }).click();
  const open = page.getByRole('button', { name: 'Ganze Reihe anfragen: Sternwarte 24 – Die Reihe' });
  await expect(open).toHaveText('Ganze Reihe anfragen…');
  await open.click();
  const dlg = page.getByRole('dialog', { name: 'Ganze Reihe anfragen' });
  await expect(dlg.getByRole('checkbox', { name: 'Alle anfragbaren Filme' })).toBeVisible();
  return dlg;
}

test.describe('collection sheet', () => {
  test('parts with poster, year and state; the open ones pre-checked; one wish per checked part, in order; per-part results', async ({ page, api }) => {
    api.requestSheets.batch = { 8008: 'limit' };
    const dlg = await openFromDetail(page, api);
    await expect(dlg.getByText('Sternwarte 24 – Die Reihe', { exact: true })).toBeVisible();
    await expect(dlg.locator('li .nm')).toHaveText(['Sternwarte 24', 'Sternwarte 24: Funkstille', 'Sternwarte 24: Nachtschicht', 'Sternwarte 24: Sonnenwind', 'Sternwarte 24: Kometen', 'Sternwarte 24: Morgen']);
    const li = (i: number) => dlg.locator('li').nth(i);
    await expect(li(0)).toContainText('In der Bibliothek');
    await expect(li(1)).toContainText('Anfragbar');
    await expect(li(2)).toContainText('Angefragt');
    await expect(li(3)).toContainText('Abgelehnt');
    await expect(li(5)).toContainText('Noch nicht erschienen');
    await expect(li(1).locator('img')).toHaveAttribute('src', '/api/seerr/image/p8002.jpg');
    await expect(li(1)).toContainText('2014');
    // requestable: Funkstille and Kometen checked, the declined Sonnenwind only on purpose; the rest cannot be checked
    await expect(dlg.getByRole('checkbox')).toHaveCount(4);
    await expect(dlg.getByRole('checkbox', { name: 'Funkstille' })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Kometen' })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Sonnenwind' })).not.toBeChecked();
    await expect(dlg.getByText('Jeder Film zählt als ein Wunsch. Noch 4 Wünsche frei in diesem Monat.')).toBeVisible();

    await dlg.getByRole('button', { name: '2 Filme anfragen' }).click();
    await expect(dlg.getByText('1 von 2 angefragt. 1 nicht angefragt: Kontingent erschöpft, neues ab 1. Dezember.')).toBeVisible();
    expect(api.requestSheets.batches).toEqual([{ items: [{ mediaType: 'movie', tmdbId: 8002 }, { mediaType: 'movie', tmdbId: 8008 }], collectionId: 900 }]);
    await expect(li(1)).toContainText('Angefragt');
    await expect(li(4)).toContainText('Kontingent erschöpft');
    await expect(dlg.getByRole('checkbox', { name: 'Funkstille' })).toHaveCount(0); // done: no second wish for it
    await dlg.getByRole('button', { name: 'Fertig' }).click();
    await expect(dlg).toHaveCount(0);
    // the row on the page follows: the requested part says so
    await expect(page.getByRole('button', { name: 'Angefragt: Sternwarte 24: Funkstille' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anfragen: Sternwarte 24: Kometen' })).toBeVisible();
  });

  test('a failed part stays checked for another try; the others are not sent again', async ({ page, api }) => {
    api.requestSheets.batch = { 8008: 'failed' };
    const dlg = await openFromDetail(page, api);
    await dlg.getByRole('button', { name: '2 Filme anfragen' }).click();
    await expect(dlg.getByText('1 von 2 angefragt. 1 Anfrage ist fehlgeschlagen.')).toBeVisible();
    await expect(dlg.locator('li').nth(4)).toContainText('Fehlgeschlagen');
    await expect(dlg.getByRole('checkbox', { name: 'Kometen' })).toBeChecked();
    api.requestSheets.batch = {};
    await dlg.getByRole('button', { name: 'Fehlgeschlagene erneut anfragen' }).click();
    await expect(dlg.getByText('2 von 2 angefragt.')).toBeVisible();
    expect(api.requestSheets.batches.map((b) => (b as { items: Array<{ tmdbId: number }> }).items.map((x) => x.tmdbId))).toEqual([[8002, 8008], [8008]]);
    await expect(dlg.getByRole('button', { name: 'Fertig' })).toBeVisible();
  });

  test('keyboard: focus on the first row, Space toggles, Escape closes and the focus returns', async ({ page, api }) => {
    const dlg = await openFromDetail(page, api);
    const all = dlg.getByRole('checkbox', { name: 'Alle anfragbaren Filme' });
    await expect(all).toBeFocused();
    await page.keyboard.press('Space');
    await expect(dlg.getByRole('checkbox', { name: 'Sonnenwind' })).toBeChecked(); // "Alle" adds the declined one too
    await expect(dlg.getByRole('button', { name: '3 Filme anfragen' })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(dlg.getByRole('checkbox')).not.toHaveCount(0);
    await expect(dlg.getByRole('button', { name: '0 Filme anfragen' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(api.requestSheets.batches).toEqual([]);
    await expect(page.getByRole('button', { name: 'Ganze Reihe anfragen: Sternwarte 24 – Die Reihe' })).toBeFocused();
  });

  test('after a movie wish on the wishes page: "Ganze Reihe anfragen…" opens the sheet of its collection', async ({ page, api }) => {
    api.newPage.search = [{ tmdbId: 8002, mediaType: 'movie', title: 'Sternwarte 24: Funkstille', year: '2014', status: 'nicht_angefragt' }];
    api.requestSheets.movieCollection[8002] = { id: 900, name: 'Sternwarte 24 – Die Reihe' };
    api.requestSheets.collections[8002] = { collection: { ...COLLECTION.collection, parts: COLLECTION.collection.parts.map((p) => (p.tmdbId === 8002 ? { ...p, state: 'requested' } : p)) } };
    await page.route('**/api/seerr/image/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
    await page.goto('/requests?q=Sternwarte');
    await page.locator('.card', { hasText: 'Funkstille' }).getByRole('button', { name: 'Wünschen' }).click();
    await expect(page.getByText('„Sternwarte 24: Funkstille“ gehört zur Reihe „Sternwarte 24 – Die Reihe“.')).toBeVisible();
    await page.getByRole('button', { name: 'Ganze Reihe anfragen…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Ganze Reihe anfragen' });
    // the movie just wished counts as requested; Sternwarte 24 itself is open here (no library knowledge on this page)
    await expect(dlg.locator('li').nth(1)).toContainText('Angefragt');
    await dlg.getByRole('button', { name: '2 Filme anfragen' }).click();
    await expect(dlg.getByText('2 von 2 angefragt.')).toBeVisible();
    expect((api.requestSheets.batches[0] as { items: Array<{ tmdbId: number }> }).items.map((x) => x.tmdbId)).toEqual([8001, 8008]);
  });

  test('a movie without a collection: the sheet says so', async ({ page, api }) => {
    api.requestSheets.collections[8001] = { collection: null };
    await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: ABOUT }));
    await page.route('**/api/seerr/image/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
    await page.goto('/item/' + MOVIE.id);
    await page.getByRole('tablist', { name: 'Weitere Inhalte' }).getByRole('tab', { name: 'Details' }).click();
    await page.getByRole('button', { name: 'Ganze Reihe anfragen: Sternwarte 24 – Die Reihe' }).click();
    const dlg = page.getByRole('dialog', { name: 'Ganze Reihe anfragen' });
    await expect(dlg.getByText('Dieser Film gehört zu keiner Reihe.')).toBeVisible();
    await expect(dlg.getByRole('button')).toHaveText(['Schließen']);
  });

  test.describe('failure', () => {
    test.use({ allowedConsole: /status of 502/ });
    test('the whole send failing: the reason in the reserved line, the choice kept', async ({ page, api }) => {
      api.requestSheets.batchFail = true;
      const dlg = await openFromDetail(page, api);
      await dlg.getByRole('button', { name: '2 Filme anfragen' }).click();
      await expect(dlg.getByText('Die Anfragen konnten nicht gestellt werden.')).toBeVisible();
      await expect(dlg.getByRole('checkbox', { name: 'Funkstille' })).toBeChecked();
      await expect(dlg.getByRole('button', { name: '2 Filme anfragen' })).toBeEnabled();
    });
  });
});
