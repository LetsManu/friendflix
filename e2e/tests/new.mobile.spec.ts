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
const sug = (tmdbId: number, mediaType: 'movie' | 'tv', title: string, seed: string, state: 'none' | 'requested' = 'none') =>
  ({ tmdbId, mediaType, title, year: 2025, poster: `/media/seerr-${tmdbId}`, reason: { seed }, request: { state } });
const SUGGESTIONS = {
  movie: [sug(22, 'movie', 'Copper Sky', 'Cedar Falls')],
  series: [sug(31, 'tv', 'Lantern Row', 'Inkwell'), sug(32, 'tv', 'Foxglove Court', 'Marrow Coast', 'requested')],
  error: null,
} as const;
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const seg = (page: Page, name: string) => page.getByRole('tablist', { name: 'Bereiche' }).getByRole('tab', { name });

test.describe('new & upcoming, variant B (phone)', () => {
  test('Für dich: header button, segmented tabs, spotlight, suggestions as list cards with 44 px buttons, the "Etwas fehlt?" bar', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    const add = page.getByRole('button', { name: 'Wünschen', exact: true });
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('tablist', { name: 'Bereiche' }).getByRole('tab')).toHaveText([/^Für dich\s*$/, /^Neu\s*$/, /^Wünsche\s*$/]);
    for (const name of ['Für dich', 'Neu', 'Wünsche']) expect((await seg(page, name).boundingBox())!.height).toBeGreaterThanOrEqual(44);

    const fy = region(page, 'Für dich neu');
    await expect(fy.locator('li.c')).toHaveCount(1); // the spotlight; the rest is a row below it
    await expect(fy.getByText('Weil du „Inkwell“ gesehen hast · gleiche Regie')).toBeVisible();
    await expect(row(page, 'Mehr für dich').locator('.pc')).toHaveCount(2);
    await expect(row(page, 'Mehr für dich').getByText('Für dich ausgewählt · Genre Mystery')).toBeAttached();

    const ms = region(page, 'Noch nicht bei uns');
    await expect(ms.locator('li.c')).toHaveCount(3);
    const btn = ms.getByRole('button', { name: 'Wünschen: Lantern Row' });
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(ms.locator('li.c', { hasText: 'Foxglove Court' }).getByText('Angefragt')).toBeVisible();

    // Neue Folgen is a vertical list on the phone
    const eps = region(page, 'Neue Folgen');
    await expect(eps.getByRole('listitem')).toHaveCount(2);
    await expect(eps.getByRole('link', { name: /Bright Valley, Staffel 1 · Folge 2/ })).toBeVisible();

    const bar = page.getByRole('button', { name: /Etwas fehlt\?/ });
    await expect(bar).toContainText('Noch 4 frei');
    const tabs = page.locator('.tabbar').getByRole('link');
    await expect(tabs.nth(1)).toHaveAccessibleName('Neu & demnächst');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the Wünschen button on a list card: requested after the answer; the bar and the header button lead to the search', async ({ page, api }) => {
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    const card = region(page, 'Noch nicht bei uns').locator('li.c', { hasText: 'Lantern Row' });
    await card.getByRole('button', { name: 'Wünschen: Lantern Row' }).tap();
    await expect(card.getByText('Angefragt')).toBeVisible();
    expect(api.log.filter((l) => l.startsWith('POST /api/requests'))).toHaveLength(1);

    await page.getByRole('button', { name: /Etwas fehlt\?/ }).tap();
    await expect(page).toHaveURL(/tab=wuensche/);
    await expect(page.getByRole('searchbox', { name: 'Serie oder Film wünschen' })).toBeFocused();
  });

  test('tabs by tap: Neu is a poster grid with this week below, Wünsche has the requests and Demnächst', async ({ page, api }) => {
    api.newPage.upcoming = UPCOMING;
    api.newPage.mine = [{ title: 'Foxglove Court', mediaType: 'tv', status: 'angefragt', createdAt: '2026-11-08T10:00:00Z' }];
    await page.goto('/new');
    await seg(page, 'Neu').tap();
    await expect(page).toHaveURL(/\?tab=neu$/);
    await expect(seg(page, 'Neu')).toHaveAttribute('aria-selected', 'true');
    const lib = region(page, 'Neu in der Bibliothek');
    await expect(lib.locator('.pc').first()).toBeVisible();
    await expect(lib.locator('.note .nm').first()).toBeVisible();
    await expect(row(page, 'Diese Woche bei uns')).toBeAttached();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await seg(page, /^Wünsche/).tap();
    await expect(page).toHaveURL(/\?tab=wuensche$/);
    await expect(seg(page, /^Wünsche/)).toContainText('1');
    await expect(page.getByRole('region', { name: 'Deine Wünsche' }).getByText('Foxglove Court')).toBeVisible();
    const up = page.getByRole('region', { name: 'Demnächst' });
    await expect(up.getByRole('heading', { level: 3 })).toHaveText(['Nightingale Road', 'Vesper Bay']);
    expect((await up.getByRole('button', { name: 'Erinnere mich: Vesper Bay' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.goBack();
    await expect(seg(page, 'Neu')).toHaveAttribute('aria-selected', 'true');
  });

  test('the filter is a row of chips under the tabs; it works and survives a reload', async ({ page }) => {
    await page.goto('/new');
    const group = page.getByRole('radiogroup', { name: 'Anzeigen' });
    for (const name of ['Alles', 'Serien', 'Filme']) expect((await group.getByRole('radio', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await group.getByRole('radio', { name: 'Filme' }).tap();
    await expect(page).toHaveURL(/\?type=movie$/);
    await expect(region(page, 'Neue Folgen')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('radiogroup', { name: 'Anzeigen' }).getByRole('radio', { name: 'Filme' })).toBeChecked();
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

  test('without a request service: "Neu" in the title and the tab bar, two segments, no Wünschen, no bar', async ({ page, api }) => {
    api.features = { requests: false };
    api.newPage.upcoming = UPCOMING;
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Neu – FriendFlix');
    const tabs = page.locator('.tabbar').getByRole('link');
    await expect(tabs.nth(1)).toHaveAccessibleName('Neu');
    await expect(page.locator('.tabbar a > span:last-child')).toHaveText(['Start', 'Neu', 'Merkliste']);
    await expect(page.getByRole('tablist', { name: 'Bereiche' }).getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('button', { name: /Wünschen|Etwas fehlt/ })).toHaveCount(0);
    await expect(region(page, 'Noch nicht bei uns')).toHaveCount(0);
  });

  test('a kids profile: no Wünschen, no third segment, no suggestions', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, kids: true } }));
    api.newPage.kids = true;
    api.newPage.suggestions = { ...SUGGESTIONS };
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Bereiche' }).getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('button', { name: /Wünschen|Etwas fehlt/ })).toHaveCount(0);
    await expect(region(page, 'Noch nicht bei uns')).toHaveCount(0);
    await expect(region(page, 'Für dich neu')).toBeVisible();
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
