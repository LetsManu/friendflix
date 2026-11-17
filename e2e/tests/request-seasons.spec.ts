// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';

/** The season picker of a series (lib/requests/SeasonSheet.svelte), here from the wishes page (/requests). Fictional titles. */
const NORDLICHT = {
  title: 'Nordlicht',
  seasons: [
    { number: 0, name: 'Specials', episodes: 2, airDate: '2019-12-24', state: 'none' },
    { number: 1, episodes: 8, airDate: '2019-03-01', state: 'available' },
    { number: 2, episodes: 8, airDate: '2020-03-01', state: 'requested' },
    { number: 3, episodes: 10, airDate: '2021-03-01', state: 'none' },
    { number: 4, episodes: 10, airDate: '2022-03-01', state: 'declined' },
  ],
};
const HIT = { tmdbId: 7001, mediaType: 'tv', title: 'Nordlicht', year: '2019', status: 'teilweise' };

async function openPicker(page: Page, api: MockState) {
  api.newPage.search = [{ ...HIT, status: 'nicht_angefragt' }];
  api.requestSheets.seasons[7001] = NORDLICHT;
  await page.goto('/requests?q=Nordlicht');
  await page.locator('.card', { hasText: 'Nordlicht' }).getByRole('button', { name: 'Wünschen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Staffeln wählen' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('checkbox', { name: 'Alle Staffeln' })).toBeVisible();
  return dlg;
}
const posts = (api: MockState) => api.log.filter((l) => l.startsWith('POST /api/requests '));

test.describe('season picker', () => {
  test('every season with its state; the open regular ones start chosen, the specials off; only the chosen ones are sent', async ({ page, api }) => {
    const dlg = await openPicker(page, api);
    await expect(dlg.getByText('Nordlicht', { exact: true })).toBeVisible();
    // regular seasons in order, the specials last; closed seasons say why and have no checkbox
    await expect(dlg.locator('li .nm')).toHaveText(['Staffel 1', 'Staffel 2', 'Staffel 3', 'Staffel 4', 'Specials']);
    await expect(dlg.locator('li').nth(0)).toContainText('Vorhanden');
    await expect(dlg.locator('li').nth(0)).toContainText('8 Folgen · 2019');
    await expect(dlg.locator('li').nth(1)).toContainText('Angefragt');
    await expect(dlg.locator('li').nth(3)).toContainText('Abgelehnt');
    await expect(dlg.getByRole('checkbox')).toHaveCount(4); // Alle, Staffel 3, Staffel 4 (declined: may be asked again), Specials
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 3' })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 4' })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Specials' })).not.toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Alle Staffeln' })).toBeChecked();
    await expect(dlg.getByText('Zählt als ein Wunsch. Noch 4 Wünsche frei in diesem Monat.')).toBeVisible();

    // one season off: "Alle" turns mixed; the specials on
    await dlg.getByRole('checkbox', { name: 'Staffel 4' }).click();
    await expect(dlg.getByRole('checkbox', { name: 'Alle Staffeln' })).toHaveJSProperty('indeterminate', true);
    await dlg.getByRole('checkbox', { name: 'Specials' }).click();
    const send = dlg.getByRole('button', { name: '2 Staffeln anfragen' });
    await send.click();
    await expect(dlg).toHaveCount(0);
    expect(posts(api)).toEqual(['POST /api/requests {"mediaType":"tv","tmdbId":7001,"seasons":[0,3]} -> 200']);
    await expect(page.getByRole('status').filter({ hasText: '„Nordlicht“ wurde gewünscht.' })).toBeVisible();
  });

  test('"Alle Staffeln" switches the open regular seasons; with none chosen the send is off and says why', async ({ page, api }) => {
    const dlg = await openPicker(page, api);
    const all = dlg.getByRole('checkbox', { name: 'Alle Staffeln' });
    await all.uncheck();
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 3' })).not.toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 4' })).not.toBeChecked();
    await expect(dlg.getByText('Wähle mindestens eine Staffel.')).toBeVisible();
    await expect(dlg.getByRole('button', { name: /Staffeln anfragen$/ })).toBeDisabled();
    await all.check();
    await expect(dlg.getByRole('button', { name: '2 Staffeln anfragen' })).toBeEnabled();
    await expect(dlg.getByRole('checkbox', { name: 'Specials' })).not.toBeChecked();
  });

  test('keyboard: the focus starts on the first row, Space toggles, Tab stays inside, Escape closes without a wish', async ({ page, api }) => {
    const dlg = await openPicker(page, api);
    await expect(dlg.getByRole('checkbox', { name: 'Alle Staffeln' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 3' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 3' })).not.toBeChecked();
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(posts(api)).toEqual([]);
    await expect(page.locator('.card', { hasText: 'Nordlicht' }).getByRole('button', { name: 'Wünschen' })).toBeFocused();
  });

  test('a series with nothing left to ask for says so and offers only Schließen', async ({ page, api }) => {
    api.newPage.search = [{ ...HIT, status: 'nicht_angefragt' }];
    api.requestSheets.seasons[7001] = { title: 'Nordlicht', seasons: [{ number: 1, state: 'available' }, { number: 2, state: 'processing' }] };
    await page.goto('/requests?q=Nordlicht');
    await page.locator('.card', { hasText: 'Nordlicht' }).getByRole('button', { name: 'Wünschen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Staffeln wählen' });
    await expect(dlg.getByText('Alle Staffeln sind schon angefragt oder vorhanden.')).toBeVisible();
    await expect(dlg.getByRole('checkbox')).toHaveCount(0);
    await expect(dlg.getByRole('button')).toHaveText(['Schließen']);
    await dlg.getByRole('button', { name: 'Schließen' }).click();
    await expect(dlg).toHaveCount(0);
  });

  test.describe('failures', () => {
    test.use({ allowedConsole: /status of (500|502)/ });
    test('seasons that cannot be read: a retry; a failed wish keeps the sheet open with the reason', async ({ page, api }) => {
      api.newPage.search = [{ ...HIT, status: 'nicht_angefragt' }];
      api.requestSheets.seasons[7001] = NORDLICHT;
      api.requestSheets.seasonsFail = true;
      await page.goto('/requests?q=Nordlicht');
      await page.locator('.card', { hasText: 'Nordlicht' }).getByRole('button', { name: 'Wünschen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Staffeln wählen' });
      await expect(dlg.getByText('Die Staffeln konnten nicht geladen werden.')).toBeVisible();
      api.requestSheets.seasonsFail = false;
      await dlg.getByRole('button', { name: 'Erneut laden' }).click();
      await expect(dlg.getByRole('checkbox', { name: 'Staffel 3' })).toBeChecked();
      api.newPage.wish = 'fail';
      const send = dlg.getByRole('button', { name: '2 Staffeln anfragen' });
      const before = await send.boundingBox();
      await send.click();
      await expect(dlg.getByRole('alert').filter({ hasText: 'Der Wunsch konnte nicht gestellt werden.' })).toBeVisible();
      expect(await send.boundingBox()).toEqual(before); // the reserved error line: the buttons do not move
      api.newPage.wish = 'ok';
      await send.click();
      await expect(dlg).toHaveCount(0);
    });
  });

  test('the wish button of a series on Neu & demnächst opens the picker too', async ({ page, api }) => {
    api.newPage.search = [{ tmdbId: 7002, mediaType: 'tv', title: 'Hafenkanal', year: 2024, poster: null, status: 'nicht_angefragt' }];
    await page.goto('/new?tab=wuensche');
    const search = page.getByRole('searchbox', { name: 'Serie oder Film wünschen' });
    await search.fill('Hafenkanal');
    await search.press('Enter');
    const hits = page.getByRole('region', { name: 'Suchergebnisse' });
    await hits.getByRole('button', { name: 'Wünschen: Hafenkanal' }).click();
    const dlg = page.getByRole('dialog', { name: 'Staffeln wählen' });
    await dlg.getByRole('button', { name: '2 Staffeln anfragen' }).click();
    await expect(dlg).toHaveCount(0);
    expect(posts(api)).toEqual(['POST /api/requests {"mediaType":"tv","tmdbId":7002,"seasons":[1,2]} -> 200']);
    await expect(hits.getByText('Angefragt')).toBeVisible();
  });

  test('TV: the d-pad walks the rows, OK ticks, Back closes the picker and stays on the page', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    const dlg = await openPicker(page, api);
    await expect(page.locator('html.tv')).toHaveCount(1);
    const all = dlg.getByRole('checkbox', { name: 'Alle Staffeln' });
    await expect(all).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 3' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 4' })).toBeFocused();
    await page.keyboard.press('Enter'); // OK on the remote
    await expect(dlg.getByRole('checkbox', { name: 'Staffel 4' })).not.toBeChecked();
    await expect(dlg).toBeVisible(); // OK on a row never sends
    await page.keyboard.press('ArrowDown');
    await expect(dlg.getByRole('checkbox', { name: 'Specials' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dlg.getByRole('button', { name: /Abbrechen|1 Staffel anfragen/ }).first()).toBeFocused();
    await page.keyboard.press('Backspace'); // Back
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/requests\?q=Nordlicht$/);
    expect(posts(api)).toEqual([]);
  });
});
