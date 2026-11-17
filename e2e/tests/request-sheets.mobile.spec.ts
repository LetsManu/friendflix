// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { boxInViewport, noHorizontalOverflow } from '../helpers.js';

/** The season picker and the collection sheet on a phone: inside the screen, 44 px targets, stacked full-width buttons. */
async function targets(dlg: Locator) {
  for (const el of await dlg.locator('label:has(input[type="checkbox"]), button').all()) {
    const b = (await el.boundingBox())!;
    expect(b.height, await el.innerText()).toBeGreaterThanOrEqual(44);
  }
}
async function fits(page: Page, dlg: Locator) {
  expect((await boxInViewport(page, dlg)).ok).toBe(true);
  expect(await noHorizontalOverflow(page)).toBe(true);
  // phone: the two buttons are stacked, each the panel's width
  const btns = dlg.locator('.dlg-acts > button');
  const [a, b] = [(await btns.nth(0).boundingBox())!, (await btns.nth(1).boundingBox())!];
  expect(Math.abs(a.width - b.width)).toBeLessThan(2);
  expect(Math.abs(a.y - b.y)).toBeGreaterThan(40);
}

test('season picker on a phone', async ({ page, api }) => {
  api.newPage.search = [{ tmdbId: 7001, mediaType: 'tv', title: 'Nordlicht', year: '2019', status: 'nicht_angefragt' }];
  api.requestSheets.seasons[7001] = {
    title: 'Nordlicht',
    seasons: [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ number: n, episodes: 10, airDate: `${2015 + n}-03-01`, state: n === 1 ? 'available' : n === 2 ? 'partial' : 'none' })),
  };
  await page.goto('/requests?q=Nordlicht');
  await page.locator('.card', { hasText: 'Nordlicht' }).getByRole('button', { name: 'Wünschen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Staffeln wählen' });
  await expect(dlg.getByRole('checkbox', { name: 'Staffel 7' })).toBeChecked();
  await fits(page, dlg);
  await targets(dlg);
  // a long list scrolls inside the sheet; the buttons stay in view
  await expect(dlg.getByRole('button', { name: '5 Staffeln anfragen' })).toBeInViewport();
  await dlg.getByRole('checkbox', { name: 'Specials' }).scrollIntoViewIfNeeded();
  await dlg.getByRole('checkbox', { name: 'Specials' }).tap();
  await dlg.getByRole('button', { name: '6 Staffeln anfragen' }).tap();
  await expect(dlg).toHaveCount(0);
  expect(api.log.filter((l) => l.startsWith('POST /api/requests '))).toEqual(['POST /api/requests {"mediaType":"tv","tmdbId":7001,"seasons":[0,3,4,5,6,7]} -> 200']);
});

test('collection sheet on a phone', async ({ page, api }) => {
  api.newPage.search = [{ tmdbId: 8002, mediaType: 'movie', title: 'Sternwarte 24: Funkstille', year: '2014', status: 'nicht_angefragt' }];
  api.requestSheets.movieCollection[8002] = { id: 900, name: 'Sternwarte 24 – Die Reihe' };
  api.requestSheets.collections[8002] = {
    collection: {
      id: 900, name: 'Sternwarte 24 – Die Reihe',
      parts: [
        { tmdbId: 8001, title: 'Sternwarte 24', year: '2012', releaseDate: '2012-06-01', state: 'available' },
        { tmdbId: 8002, title: 'Sternwarte 24: Funkstille', year: '2014', releaseDate: '2014-06-01', state: 'requested' },
        { tmdbId: 8008, title: 'Sternwarte 24: Kometen mit einem sehr langen Titel, der umbrechen muss', year: '2020', releaseDate: '2020-06-01', state: 'none' },
      ],
    },
  };
  await page.route('**/api/seerr/image/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
  await page.goto('/requests?q=Sternwarte');
  await page.locator('.card', { hasText: 'Funkstille' }).getByRole('button', { name: 'Wünschen' }).tap();
  await page.getByRole('button', { name: 'Ganze Reihe anfragen…' }).tap();
  const dlg = page.getByRole('dialog', { name: 'Ganze Reihe anfragen' });
  await expect(dlg.getByRole('checkbox', { name: 'Kometen' })).toBeChecked();
  await fits(page, dlg);
  await targets(dlg);
  const row = dlg.locator('li').nth(2);
  const before = (await row.boundingBox())!;
  await dlg.getByRole('button', { name: '1 Film anfragen' }).tap();
  await expect(row).toContainText('Angefragt');
  expect((await row.boundingBox())!.height).toBe(before.height); // the result pill replaces the state pill: the row keeps its height
});
