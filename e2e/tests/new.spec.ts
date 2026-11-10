// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

const UPCOMING = {
  movie: [{ tmdbId: 11, mediaType: 'movie', title: 'Vesper Bay', releaseDate: '2026-11-28T00:00:00Z', status: 'nicht_angefragt' }],
  tv: [{ tmdbId: 12, mediaType: 'tv', title: 'Nightingale Road', releaseDate: '2026-11-21T00:00:00Z', status: 'nicht_angefragt' }],
};
const SECTIONS = ['Für dich neu', 'Neue Serien', 'Neue Folgen', 'Neue Filme', 'Diese Woche bei uns'];

test.describe('new & upcoming (desktop)', () => {
  test('every section renders from its endpoint; freshness and reasons sit under the cards', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(page).toHaveTitle('Neu & demnächst – FriendFlix');
    for (const s of SECTIONS) await expect(row(page, s)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toBeVisible();

    // Für dich neu: the engine's reason in the wording of the recommendation rows; a null reason shows no line
    const forYou = row(page, 'Für dich neu');
    await expect(forYou.locator('article.card')).toHaveCount(3);
    await expect(forYou.getByText('Weil du „Inkwell“ gesehen hast · gleiche Regie')).toBeVisible();
    await expect(forYou.getByText('Für dich ausgewählt · Genre Mystery')).toBeVisible();
    await expect(forYou.locator('.note .why')).toHaveCount(2);
    await expect(forYou.locator('.note').nth(2).locator('.why')).toHaveCount(0);

    // new series / films: the last 14 days of dateCreated (the mock's oldest films are older), without what For you already shows
    const series = row(page, 'Neue Serien');
    await expect(series.locator('.note .fresh')).toHaveText(['Neu seit gestern', 'Neu seit 7 Tagen', 'Neu seit 10 Tagen']);
    await expect(series.locator('article.card')).toHaveCount(3);
    const films = row(page, 'Neue Filme');
    await expect(films.locator('article.card')).toHaveCount(3);
    await expect(films.getByText('Neu seit 10 Tagen')).toBeVisible();
    await expect(films.getByText('Neu seit 16 Tagen')).toHaveCount(0);

    // Neue Folgen: one card per followed show, freshness of the newest episode
    const eps = row(page, 'Neue Folgen');
    await expect(eps.locator('article.card')).toHaveCount(2);
    await expect(eps.getByText('Neu heute')).toBeVisible();
    await expect(eps.getByText('Neu seit gestern')).toBeVisible();
    await expect(eps.locator('a.thumb').first()).toHaveAttribute('href', /^\/watch\//);

    // the ranked strip keeps its rank labels
    await expect(row(page, 'Diese Woche bei uns').locator('.rkn').first()).toHaveText('1');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Demnächst: dated cards with a reminder button and a link to the calendar', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    const up = page.getByRole('region', { name: 'Demnächst' });
    await expect(up.getByRole('heading', { level: 3 })).toHaveText(['Nightingale Road', 'Vesper Bay']); // by date
    await expect(up.getByText('Serie · Erscheint am 21. November 2026')).toBeVisible();
    await expect(up.getByRole('button', { name: 'Erinnere mich: Nightingale Road' })).toBeVisible();
    await expect(up.getByRole('link', { name: 'Zum Kalender' })).toHaveAttribute('href', '/calendar');
  });

  test('the filter narrows every section, lives in the URL and survives reload and back', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    const group = page.getByRole('radiogroup', { name: 'Anzeigen' });
    await expect(group.getByRole('radio', { name: 'Alles' })).toBeChecked();

    await group.getByRole('radio', { name: 'Serien' }).click();
    await expect(page).toHaveURL(/\/new\?type=series$/);
    await expect(row(page, 'Neue Filme')).toHaveCount(0);
    await expect(row(page, 'Für dich neu').locator('article.card')).toHaveCount(1);
    await expect(row(page, 'Neue Folgen')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' }).getByRole('heading', { level: 3 })).toHaveText(['Nightingale Road']);

    await page.reload();
    await expect(group.getByRole('radio', { name: 'Serien' })).toBeChecked();
    await expect(row(page, 'Neue Filme')).toHaveCount(0);

    await group.getByRole('radio', { name: 'Filme' }).click();
    await expect(page).toHaveURL(/\/new\?type=movie$/);
    await expect(row(page, 'Neue Serien')).toHaveCount(0); // a section that becomes empty disappears
    await expect(row(page, 'Neue Folgen')).toHaveCount(0);
    await expect(row(page, 'Neue Filme')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' }).getByRole('heading', { level: 3 })).toHaveText(['Vesper Bay']);

    await group.getByRole('radio', { name: 'Alles' }).click();
    await expect(page).toHaveURL(/\/new$/);
    for (const s of SECTIONS) await expect(row(page, s)).toBeVisible();

    // away and back: the filter is still there
    await group.getByRole('radio', { name: 'Serien' }).click();
    await expect(page).toHaveURL(/type=series/);
    await page.goto('/browse/series');
    await page.goBack();
    await expect(page.getByRole('radiogroup', { name: 'Anzeigen' }).getByRole('radio', { name: 'Serien' })).toBeChecked();
  });

  test('the filter is a radio group: one Tab stop, arrows move and select, targets are 44 px', async ({ page }) => {
    await page.goto('/new?type=series');
    const group = page.getByRole('radiogroup', { name: 'Anzeigen' });
    const radios = group.getByRole('radio');
    await expect(radios).toHaveCount(3);
    await expect(radios.nth(1)).toBeChecked();
    for (const [i, tab] of [-1, 0, -1].entries()) await expect(radios.nth(i)).toHaveAttribute('tabindex', String(tab));
    for (let i = 0; i < 3; i++) expect((await radios.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await radios.nth(1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(2)).toBeFocused();
    await expect(radios.nth(2)).toBeChecked();
    await expect(page).toHaveURL(/type=movie/);
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(radios.nth(0)).toBeChecked();
    await expect(page).toHaveURL(/\/new$/);
    await page.keyboard.press('End');
    await expect(radios.nth(2)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(radios.nth(0)).toBeFocused();
  });

  test('nothing new: the empty state replaces the rows, the rest of the page stays', async ({ page, api }) => {
    api.newPage.forYou = [];
    api.newPage.episodes = [];
    api.newPage.upcoming = UPCOMING;
    await page.route('**/api/library/items?*', (r) => r.fulfill({ json: { items: [], total: 0 } }));
    await page.goto('/new');
    const empty = page.getByRole('region', { name: 'Diese Woche ist nichts Neues dazugekommen' });
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Zuletzt hinzugefügt ansehen' })).toHaveAttribute('href', '/browse/movies?sort=DateCreated');
    await expect(empty.getByRole('link', { name: 'Kalender' })).toHaveAttribute('href', '/calendar');
    for (const s of ['Für dich neu', 'Neue Serien', 'Neue Folgen', 'Neue Filme']) await expect(row(page, s)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Demnächst' })).toBeVisible(); // still announced
    await page.getByRole('radio', { name: 'Serien' }).click();
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Zuletzt hinzugefügt ansehen' })).toHaveAttribute('href', '/browse/series?sort=DateCreated');
  });

  test.describe('a failing endpoint', () => {
    test.use({ allowedConsole: /status of 500/ }); // the two mocked 500s
    test('one failing section does not break the page, and no skeleton stays', async ({ page, api }) => {
      api.newPage.forYou = 'fail';
      api.newPage.episodes = 'fail';
      await page.goto('/new');
      await expect(row(page, 'Neue Filme')).toBeVisible();
      await expect(row(page, 'Neue Serien')).toBeVisible();
      await expect(row(page, 'Für dich neu')).toHaveCount(0);
      await expect(row(page, 'Neue Folgen')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('.skeleton')).toHaveCount(0);
    });
  });

  test('a section that never answers is given up after a while', async ({ page, api }) => {
    test.setTimeout(40_000);
    api.newPage.hang.add('episodes');
    await page.goto('/new');
    await expect(page.locator('.sk')).toBeVisible();
    await expect(row(page, 'Neue Filme')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, 'Neue Folgen')).toHaveCount(0);
    await expect(page.locator('.skeleton')).toHaveCount(0);
  });

  test('a kids profile gets the page with what the endpoints return, and no request-service call', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, kids: true } }));
    api.newPage.upcoming = UPCOMING;
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/seerr\//.test(r.url())) asked.push(r.url()); });
    await page.goto('/new');
    await expect(row(page, 'Neue Serien')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});

test.describe('without a request service', () => {
  test('the page, the nav and the tab title read "Neu", there is no Demnächst and no call to the service', async ({ page, api }) => {
    api.features = { requests: false };
    api.newPage.upcoming = UPCOMING; // would be shown if the page asked
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/(seerr|requests)\//.test(r.url())) asked.push(r.url()); });
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Neu – FriendFlix');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link')).toHaveText(['Start', 'Serien', 'Filme', 'Neu', 'Merkliste']);
    await expect(nav.getByRole('link', { name: 'Neu', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(row(page, 'Neue Filme')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);
    await expect(page.getByText('Nightingale Road')).toHaveCount(0);
    expect(asked).toEqual([]);
  });

  test('the ranked strip takes the full width when Demnächst is gone', async ({ page, api }) => {
    api.features = { requests: false };
    await page.goto('/new');
    await expect(page.locator('.split')).not.toHaveClass(/two/);
    await expect(row(page, 'Diese Woche bei uns')).toBeVisible();
  });

  test('the start page has no inline request row, with the service it does', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/');
    await expect(row(page, 'Weiterschauen')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst – jetzt wünschen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wünschen' }).first()).toBeVisible();

    api.features = { requests: false };
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/(seerr|requests)\//.test(r.url())) asked.push(r.url()); });
    await page.goto('/');
    await expect(row(page, 'Weiterschauen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Demnächst – jetzt wünschen' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Wünschen' })).toHaveCount(0);
    expect(asked).toEqual([]);
  });

  test('the answer of /api/me decides on the next load, no rebuild: the label and the section come back', async ({ page, api }) => {
    api.features = { requests: false };
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link', { name: 'Neu', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);

    api.features = { requests: true }; // the service was connected meanwhile
    await page.goto('/new');
    await expect(nav.getByRole('link', { name: 'Neu & demnächst' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toBeVisible();

    api.features = { requests: false }; // and removed again
    await page.goto('/new');
    await expect(nav.getByRole('link', { name: 'Neu', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);
  });
});
