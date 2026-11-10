// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow, row } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

const UPCOMING = {
  movie: [{ tmdbId: 11, mediaType: 'movie', title: 'Vesper Bay', releaseDate: '2026-11-28T00:00:00Z', status: 'nicht_angefragt' }],
  tv: [{ tmdbId: 12, mediaType: 'tv', title: 'Nightingale Road', releaseDate: '2026-11-21T00:00:00Z', status: 'nicht_angefragt' }],
};
/** suggestions from outside the library (fictional titles) */
const sug = (tmdbId: number, mediaType: 'movie' | 'tv', title: string, seed: string, state: 'none' | 'requested' = 'none', extra: Record<string, unknown> = {}) =>
  ({ tmdbId, mediaType, title, year: 2025, poster: `/media/seerr-${tmdbId}`, reason: { seed }, request: { state }, ...extra });
const SUGGESTIONS = {
  movie: [sug(21, 'movie', 'Tin Meadow', 'Inkwell', 'none', { releaseDate: '2026-12-05' }), sug(22, 'movie', 'Copper Sky', 'Cedar Falls')],
  series: [sug(31, 'tv', 'Lantern Row', 'Inkwell'), sug(32, 'tv', 'Foxglove Court', 'Marrow Coast', 'requested')],
  error: null,
} as const;
const MINE = [
  { title: 'Foxglove Court', mediaType: 'tv', status: 'angefragt', createdAt: '2026-11-08T10:00:00Z' },
  { title: 'Glass Orchard', mediaType: 'movie', status: 'in_arbeit', createdAt: '2026-11-05T10:00:00Z' },
  { title: 'Old Harbor', mediaType: 'movie', status: 'verfuegbar', createdAt: '2026-10-01T10:00:00Z' },
];
const kidsProfile = async (page: Page) => page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, kids: true } }));
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Bereiche' });
const tab = (page: Page, name: string | RegExp) => tabs(page).getByRole('tab', { name });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test.describe('new & upcoming, variant B (desktop)', () => {
  test('Für dich: spotlight with the reason, suggestions with their wish state, new episodes without a repeated code', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(page).toHaveTitle('Neu & demnächst – FriendFlix');
    await expect(page.getByRole('button', { name: 'Wünschen', exact: true })).toBeVisible();

    const fy = region(page, 'Für dich neu');
    await expect(fy.locator('li.c')).toHaveCount(3);
    await expect(fy.getByText('Weil du „Inkwell“ gesehen hast · gleiche Regie')).toBeVisible();
    await expect(fy.getByRole('link', { name: 'Abspielen' })).toHaveAttribute('href', /^\/watch\//);
    await expect(fy.getByRole('button', { name: 'Merkliste' }).first()).toBeVisible();

    const ms = region(page, 'Noch nicht bei uns');
    await expect(ms.locator('li.c')).toHaveCount(4);
    await expect(ms.getByText('Nicht in der Bibliothek')).toHaveCount(4);
    await expect(ms.getByText('Ähnlich wie „Inkwell“')).toHaveCount(2);
    await expect(ms.getByText('Erscheint am 5. Dezember')).toBeVisible();
    await expect(ms.getByRole('button', { name: /^Wünschen: / })).toHaveCount(3);
    await expect(ms.locator('li.c', { hasText: 'Foxglove Court' }).getByText('Angefragt')).toBeVisible(); // asked before: calm status, no button
    await expect(ms.locator('li.c', { hasText: 'Foxglove Court' }).getByRole('button')).toHaveCount(0);

    // Neue Folgen: one card per followed show; the freshness only (the card overlay names season and episode)
    const eps = row(page, 'Neue Folgen');
    await expect(eps.locator('article.card')).toHaveCount(2);
    await expect(eps.locator('.note .meta')).toHaveCount(0);
    await expect(eps.getByText('Neu heute')).toBeVisible();
    await expect(eps.locator('a.thumb').first()).toHaveAttribute('href', /^\/watch\//);
    // the other tabs' sections are not on this tab
    await expect(row(page, 'Neue Serien')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('engine v1: no "Für dich neu" (just the newest titles are no picks), the library tab is complete', async ({ page, api }) => {
    api.newPage.engine = 'v1';
    await page.goto('/new');
    await expect(row(page, 'Neue Folgen')).toBeVisible();
    await expect(region(page, 'Für dich neu')).toHaveCount(0);
    await tab(page, 'Neu in der Bibliothek').click();
    // nothing is taken away from the library list: Interlace, Dahlia and Meridian are all in it when they are new
    const lib = region(page, 'Neu in der Bibliothek');
    await expect(lib.locator('li')).not.toHaveCount(0);
    await expect(lib.getByText('Neu seit gestern').first()).toBeVisible();
  });

  test('the Wünschen button: pending, then requested after the server said yes; the quota follows', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    const card = region(page, 'Noch nicht bei uns').locator('li.c', { hasText: 'Lantern Row' });
    let release = () => {};
    const held = new Promise<void>((res) => { release = res; });
    await page.route('**/api/requests', async (r) => { if (r.request().method() === 'POST') await held; await r.fallback(); });
    await card.getByRole('button', { name: 'Wünschen: Lantern Row' }).click();
    await expect(card.getByRole('button', { name: 'Wird gewünscht …' })).toBeDisabled(); // not "requested" before the answer
    await expect(card.getByText('Angefragt')).toHaveCount(0);
    release();
    await expect(card.getByText('Angefragt')).toBeVisible();
    await expect(card.getByRole('status')).toHaveText('„Lantern Row“ wurde gewünscht.');
    expect(api.log.filter((l) => l.startsWith('POST /api/requests'))).toEqual(['POST /api/requests {"mediaType":"tv","tmdbId":31} -> 200']);
    // the badge counts the wish once the own requests were read again
    await tab(page, 'Wünsche & demnächst').click();
    await expect(page.getByRole('region', { name: 'Deine Wünsche' })).toBeVisible();
  });

  test.describe('a refused wish', () => {
    test.use({ allowedConsole: /status of 429/ });
    test('a used-up quota: the answer blocks every open card with the day the quota renews', async ({ page, api }) => {
      api.newPage.suggestions = { ...SUGGESTIONS };
      api.newPage.wish = 'limit';
      await page.goto('/new');
      const ms = region(page, 'Noch nicht bei uns');
      await ms.getByRole('button', { name: 'Wünschen: Lantern Row' }).click();
      await expect(ms.getByRole('button', { name: /^Kontingent erschöpft/ })).toHaveCount(3);
      await expect(ms.locator('.note')).toHaveText(Array(3).fill('Neues Kontingent ab 1. Dezember'));
      await expect(ms.getByRole('button', { name: /^Wünschen: / })).toHaveCount(0);
      await expect(ms.locator('li.c', { hasText: 'Foxglove Court' }).getByText('Angefragt')).toBeVisible(); // asked already: stays
    });
  });

  test('a quota that is already used up shows no Wünschen button, an unlimited one never says exhausted', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    api.newPage.quota = { limit: 2, used: 2, resetsAt: '2026-12-01T00:00:00Z' };
    await page.goto('/new');
    await expect(region(page, 'Noch nicht bei uns').getByRole('button', { name: /^Kontingent erschöpft/ })).toHaveCount(3);
    api.newPage.quota = { limit: null, used: 40, resetsAt: '2026-12-01T00:00:00Z' };
    await page.goto('/new');
    await expect(region(page, 'Noch nicht bei uns').getByRole('button', { name: /^Wünschen: / })).toHaveCount(3);
    await expect(page.getByText('Kontingent erschöpft')).toHaveCount(0);
  });

  test.describe('a failing wish', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('the error shows inline with a retry, and nothing is shown as requested', async ({ page, api }) => {
      api.newPage.suggestions = { ...SUGGESTIONS };
      api.newPage.wish = 'fail';
      await page.goto('/new');
      const card = region(page, 'Noch nicht bei uns').locator('li.c', { hasText: 'Lantern Row' });
      await card.getByRole('button', { name: 'Wünschen: Lantern Row' }).click();
      await expect(card.getByRole('alert')).toHaveText('Wunsch konnte nicht gestellt werden.');
      await expect(card.getByText('Angefragt')).toHaveCount(0);
      api.newPage.wish = 'ok';
      await card.getByRole('button', { name: 'Wunsch für Lantern Row erneut versuchen' }).click();
      await expect(card.getByText('Angefragt')).toBeVisible();
    });
  });

  test('tabs: roles, arrow keys, the URL, the back button and a deep link', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    api.newPage.mine = MINE;
    await page.goto('/new');
    const list = tabs(page);
    await expect(list.getByRole('tab')).toHaveText([/^Für dich\s*$/, /^Neu in der Bibliothek\s*$/, /^Wünsche & demnächst\s*2/]);
    await expect(tab(page, 'Für dich')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, /Wünsche & demnächst/)).toContainText('2'); // badge: asked + in progress (not the available one)
    await expect(tab(page, /Wünsche & demnächst/)).toHaveAccessibleName('Wünsche & demnächst 2 offene Wünsche');
    for (const [i, v] of ['0', '-1', '-1'].entries()) await expect(list.getByRole('tab').nth(i)).toHaveAttribute('tabindex', v);
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'np-tab-foryou');

    await tab(page, 'Für dich').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Neu in der Bibliothek')).toBeFocused();
    await expect(tab(page, 'Neu in der Bibliothek')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\/new\?tab=neu$/);
    await page.keyboard.press('End');
    await expect(tab(page, /Wünsche & demnächst/)).toBeFocused();
    await expect(page).toHaveURL(/\/new\?tab=wuensche$/);
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(tab(page, 'Für dich')).toBeFocused();
    await expect(page).toHaveURL(/\/new$/);

    // a tab change is a history entry: back steps through the tabs
    await tab(page, 'Neu in der Bibliothek').click();
    await expect(page).toHaveURL(/tab=neu$/);
    await tab(page, /Wünsche & demnächst/).click();
    await expect(page).toHaveURL(/tab=wuensche$/);
    await page.goBack();
    await expect(tab(page, 'Neu in der Bibliothek')).toHaveAttribute('aria-selected', 'true');
    await page.goBack();
    await expect(tab(page, 'Für dich')).toHaveAttribute('aria-selected', 'true');

    // deep link, with the filter next to it
    await page.goto('/new?tab=wuensche&type=series');
    await expect(tab(page, /Wünsche & demnächst/)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('radio', { name: 'Serien' })).toBeChecked();
    await page.goto('/new?tab=quatsch');
    await expect(tab(page, 'Für dich')).toHaveAttribute('aria-selected', 'true');
  });

  test('Neu in der Bibliothek: series and films together, newest first, the filter narrows, this week at ours below', async ({ page }) => {
    await page.goto('/new?tab=neu');
    const lib = region(page, 'Neu in der Bibliothek');
    await expect(lib.locator('li')).not.toHaveCount(0);
    const fresh = await lib.locator('.note .fresh').allTextContents();
    expect(fresh[0]).toBe('Neu seit gestern');
    await expect(row(page, 'Diese Woche bei uns')).toBeVisible();
    await expect(row(page, 'Diese Woche bei uns').locator('.rkn').first()).toHaveText('1');
    await expect(lib.getByText('Film', { exact: false }).first()).toBeVisible();

    await page.getByRole('radio', { name: 'Serien' }).click();
    await expect(page).toHaveURL(/\/new\?tab=neu&type=series$/);
    await expect(lib.getByText(/^Film ·/)).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Wünsche & demnächst: own requests with their state, Demnächst with the reminder, a search with wish buttons', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    api.newPage.mine = MINE;
    api.newPage.search = [
      { tmdbId: 41, mediaType: 'movie', title: 'Paper Lanterns', year: 2023, poster: null, status: 'nicht_angefragt' },
      { tmdbId: 42, mediaType: 'tv', title: 'Dunmoor', year: 2022, poster: null, status: 'in_arbeit' },
    ];
    await page.goto('/new?tab=wuensche');
    await expect(page.getByText('Noch 4 von 5 frei')).toBeVisible();
    const mine = page.getByRole('region', { name: 'Deine Wünsche' });
    await expect(mine.getByRole('listitem')).toHaveCount(3);
    await expect(mine.getByRole('listitem').first()).toContainText('Foxglove Court');
    await expect(mine.getByText('Angefragt')).toBeVisible();
    await expect(mine.getByText('In Arbeit')).toBeVisible();
    await expect(mine.getByText('Verfügbar')).toBeVisible();

    const up = page.getByRole('region', { name: 'Demnächst' });
    await expect(up.getByRole('heading', { level: 3 })).toHaveText(['Nightingale Road', 'Vesper Bay']);
    await up.getByRole('button', { name: 'Erinnere mich: Nightingale Road' }).click();
    await expect(up.getByRole('button', { name: 'Erinnerung an: Nightingale Road' })).toHaveAttribute('aria-pressed', 'true');
    await expect(up.getByRole('link', { name: 'Zum Kalender' })).toHaveAttribute('href', '/calendar');

    const search = page.getByRole('searchbox', { name: 'Serie oder Film wünschen' });
    await search.fill('lan');
    await search.press('Enter');
    const hits = page.getByRole('region', { name: 'Suchergebnisse' });
    await expect(hits.getByRole('listitem')).toHaveCount(2);
    await expect(hits.getByRole('button', { name: 'Wünschen: Paper Lanterns' })).toBeVisible();
    await expect(hits.getByText('In Arbeit')).toBeVisible();
    await hits.getByRole('button', { name: 'Wünschen: Paper Lanterns' }).click();
    await expect(hits.getByText('Angefragt')).toBeVisible();
  });

  test('the header button "Wünschen" opens the wishes tab with the search field focused', async ({ page }) => {
    await page.goto('/new');
    await page.getByRole('button', { name: 'Wünschen', exact: true }).click();
    await expect(page).toHaveURL(/tab=wuensche/);
    await expect(page.getByRole('searchbox', { name: 'Serie oder Film wünschen' })).toBeFocused();
    await page.getByRole('button', { name: 'Wünschen', exact: true }).click(); // already there: it only focuses
    await expect(page.getByRole('searchbox', { name: 'Serie oder Film wünschen' })).toBeFocused();
  });

  test('the filter narrows the tabs, lives in the URL and survives reload and back', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    const group = page.getByRole('radiogroup', { name: 'Anzeigen' });
    await expect(group.getByRole('radio', { name: 'Alles' })).toBeChecked();
    await expect(region(page, 'Für dich neu').locator('li.c')).toHaveCount(3);

    await group.getByRole('radio', { name: 'Serien' }).click();
    await expect(page).toHaveURL(/\/new\?type=series$/);
    await expect(region(page, 'Für dich neu').locator('li.c')).toHaveCount(1);
    await expect(region(page, 'Noch nicht bei uns').locator('li.c')).toHaveCount(2); // the series suggestions only
    await expect(row(page, 'Neue Folgen')).toBeVisible();
    await page.reload();
    await expect(group.getByRole('radio', { name: 'Serien' })).toBeChecked();

    await group.getByRole('radio', { name: 'Filme' }).click();
    await expect(page).toHaveURL(/\/new\?type=movie$/);
    await expect(row(page, 'Neue Folgen')).toHaveCount(0); // a section that becomes empty disappears
    await expect(region(page, 'Noch nicht bei uns').locator('li.c')).toHaveCount(2);
    await group.getByRole('radio', { name: 'Alles' }).click();
    await expect(page).toHaveURL(/\/new$/);

    await group.getByRole('radio', { name: 'Serien' }).click();
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
    for (const [i, tabindex] of [-1, 0, -1].entries()) await expect(radios.nth(i)).toHaveAttribute('tabindex', String(tabindex));
    for (let i = 0; i < 3; i++) expect((await radios.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await radios.nth(1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(2)).toBeFocused();
    await expect(radios.nth(2)).toBeChecked();
    await expect(page).toHaveURL(/type=movie/);
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(radios.nth(0)).toBeChecked();
    await expect(page).toHaveURL(/\/new$/);
  });

  test('nothing new: the empty state replaces the sections of the tab', async ({ page, api }) => {
    api.newPage.forYou = [];
    api.newPage.episodes = [];
    await page.route('**/api/library/items?*', (r) => r.fulfill({ json: { items: [], total: 0 } }));
    await page.goto('/new');
    const empty = page.getByRole('region', { name: 'Diese Woche ist nichts Neues dazugekommen' });
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Kalender' })).toHaveAttribute('href', '/calendar');
    await tab(page, 'Neu in der Bibliothek').click();
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Zuletzt hinzugefügt ansehen' })).toHaveAttribute('href', '/browse/movies?sort=DateCreated');
    await page.getByRole('radio', { name: 'Serien' }).click();
    await expect(empty.getByRole('link', { name: 'Zuletzt hinzugefügt ansehen' })).toHaveAttribute('href', '/browse/series?sort=DateCreated');
  });

  test.describe('a failing endpoint', () => {
    test.use({ allowedConsole: /status of 500/ }); // the mocked 500s
    test('one failing section does not break the page, and no skeleton stays', async ({ page, api }) => {
      api.newPage.forYou = 'fail';
      api.newPage.episodes = 'fail';
      api.newPage.suggestions = { movie: [], series: [], error: 'fail' };
      await page.goto('/new');
      await expect(page.getByRole('tab', { name: 'Neu in der Bibliothek' })).toBeVisible();
      await expect(region(page, 'Für dich neu')).toHaveCount(0);
      await expect(region(page, 'Noch nicht bei uns')).toHaveCount(0);
      await expect(row(page, 'Neue Folgen')).toHaveCount(0);
      await expect(page.locator('.skeleton')).toHaveCount(0);
      await tab(page, 'Neu in der Bibliothek').click();
      await expect(region(page, 'Neu in der Bibliothek')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  });

  test('a section that never answers is given up after a while', async ({ page, api }) => {
    test.setTimeout(40_000);
    api.newPage.hang.add('episodes');
    await page.goto('/new');
    await expect(page.locator('.sk')).toBeVisible();
    await expect(region(page, 'Für dich neu')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, 'Neue Folgen')).toHaveCount(0);
    await expect(page.locator('.skeleton')).toHaveCount(0);
  });

  test('a kids profile: heading "Neu", two tabs, no Wünschen, no suggestions, no trending and no request-service call', async ({ page, api }) => {
    await kidsProfile(page);
    api.newPage.kids = true;
    api.newPage.upcoming = UPCOMING;
    api.newPage.suggestions = { ...SUGGESTIONS };
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/(seerr|requests|reminders)|request-suggestions|library\/trending/.test(r.url())) asked.push(new URL(r.url()).pathname); });
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Neu – FriendFlix');
    await expect(tabs(page).getByRole('tab')).toHaveText(['Für dich', 'Neu in der Bibliothek']);
    await expect(page.getByRole('button', { name: /Wünschen/ })).toHaveCount(0);
    await expect(region(page, 'Für dich neu')).toBeVisible();
    await expect(region(page, 'Noch nicht bei uns')).toHaveCount(0);
    await page.goto('/new?tab=wuensche'); // no such tab for a kid: Für dich
    await expect(tab(page, 'Für dich')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'Neu in der Bibliothek').click();
    await expect(region(page, 'Neu in der Bibliothek')).toBeVisible();
    await expect(row(page, 'Diese Woche bei uns')).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});

test.describe('without a request service', () => {
  test('the page, the nav and the tab title read "Neu": two tabs, no Wünschen, no call to the service', async ({ page, api }) => {
    api.features = { requests: false };
    api.newPage.upcoming = UPCOMING; // would be shown if the page asked
    api.newPage.suggestions = { ...SUGGESTIONS };
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/(seerr|requests)\/|request-suggestions/.test(r.url())) asked.push(r.url()); });
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Neu – FriendFlix');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link')).toHaveText(['Start', 'Serien', 'Filme', 'Neu', 'Merkliste']);
    await expect(tabs(page).getByRole('tab')).toHaveText(['Für dich', 'Neu in der Bibliothek']);
    await expect(page.getByRole('button', { name: /Wünschen/ })).toHaveCount(0);
    await expect(region(page, 'Für dich neu')).toBeVisible();
    await expect(region(page, 'Noch nicht bei uns')).toHaveCount(0);
    await expect(page.getByText('Nightingale Road')).toHaveCount(0);
    // this week at ours does not depend on the flag
    await tab(page, 'Neu in der Bibliothek').click();
    await expect(row(page, 'Diese Woche bei uns')).toBeVisible();
    expect(asked).toEqual([]);
  });

  test('the start page has no inline request row, with the service it does', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    await page.goto('/');
    await expect(row(page, 'Weiterschauen')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst – jetzt wünschen' })).toBeVisible();

    api.features = { requests: false };
    const asked: string[] = [];
    page.on('request', (r) => { if (/\/api\/(seerr|requests)\//.test(r.url())) asked.push(r.url()); });
    await page.goto('/');
    await expect(row(page, 'Weiterschauen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Demnächst – jetzt wünschen' })).toHaveCount(0);
    expect(asked).toEqual([]);
  });

  test('the answer of /api/me decides on the next load, no rebuild: the label, the tab and the button come back', async ({ page, api }) => {
    api.features = { requests: false };
    api.newPage.upcoming = UPCOMING;
    await page.goto('/new');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link', { name: 'Neu', exact: true })).toBeVisible();
    await expect(tabs(page).getByRole('tab')).toHaveCount(2);

    api.features = { requests: true }; // the service was connected meanwhile
    await page.goto('/new');
    await expect(nav.getByRole('link', { name: 'Neu & demnächst' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(tabs(page).getByRole('tab')).toHaveCount(3);

    api.features = { requests: false }; // and removed again
    await page.goto('/new?tab=wuensche');
    await expect(tabs(page).getByRole('tab')).toHaveCount(2);
    await expect(tab(page, 'Für dich')).toHaveAttribute('aria-selected', 'true');
  });

  test.describe('the service vanishes while the page is open', () => {
    test.use({ allowedConsole: /status of 404/ });
    test('"requests_disabled" from the service drops the tab, the button and the heading without a reload', async ({ page, api }) => {
      api.newPage.suggestions = { movie: [], series: [], error: 'disabled' };
      await page.goto('/new');
      await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
      await expect(tabs(page).getByRole('tab')).toHaveCount(2);
      await expect(page.getByRole('button', { name: /Wünschen/ })).toHaveCount(0);
    });
  });
});

test.describe('when /api/me cannot be read', () => {
  test.use({ allowedConsole: /status of 50\d/ });
  test('this week at ours still appears (it does not wait for the feature flags)', async ({ page }) => {
    let n = 0;
    await page.route('**/api/me', (r) => (n++ === 0 ? r.fulfill({ json: ME }) : r.fulfill({ status: 502, json: { error: 'bad_gateway' } })));
    await page.goto('/new?tab=neu');
    await expect(row(page, 'Diese Woche bei uns')).toBeVisible();
  });
});
