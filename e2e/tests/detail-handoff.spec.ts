// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { episodes, ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { offer } from '../mocks/handoff.js';
import { mockPlayer } from '../mocks/scenes.js';
import { dunmoor } from './cast-remote-setup.js';

/** Device hand-off, the title page's hint (spec device hand-off 2.5): desktop page and TV. */
dunmoor(); // Dunmoor, S1 E4 "The Lantern Road" (position 25:00 of 45:00 on this device)

/** the series page: the next episode is E4 */
const seriesPage = async (page: Page) => {
  await page.route('**/api/library/nextup*', (r) => r.fulfill({ json: { items: [episodes[0]] } }));
  await page.goto('/item/' + SERIES.id);
};
const filmPage = async (page: Page, positionTicks = 9_000_000_000) => {
  await page.route(new RegExp(`/api/items/${MOVIE.id}$`), (r) => r.fulfill({ json: { item: { ...MOVIE, positionTicks }, inWatchlist: false, thumb: 0 } }));
  await page.goto('/item/' + MOVIE.id);
};
const filmOffer = () => offer({ id: 'hd-2', itemId: MOVIE.id, type: 'Movie', title: MOVIE.name, year: 2010, seriesName: undefined, season: undefined, episode: undefined, imageId: MOVIE.id });
const play = (page: Page) => page.locator('.dd a.play');
const line = (page: Page) => page.locator('.dd p.resume');

test('series page shows the hand-off line', async ({ page, api }) => {
  await seriesPage(page);
  await expect(play(page)).toBeVisible();
  await expect(line(page)).toHaveText(/Noch/); // without an offer: the normal remaining time
  const before = (await play(page).boundingBox())!;
  const lineBefore = (await line(page).boundingBox())!;
  api.handoff.byItem[SERIES.id] = offer();
  await page.reload();
  await expect(line(page)).toHaveText('Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
  await expect(play(page)).toHaveAttribute('href', /[?&]t=1390$/);
  await expect(play(page)).toHaveAccessibleName('Weiter S1·F4, weiter ab 23:10, zuletzt auf LG-Fernseher');
  const after = (await play(page).boundingBox())!;
  expect(after.width).toBe(before.width);
  expect(after.y).toBe(before.y);
  expect((await line(page).boundingBox())!.y).toBe(lineBefore.y);
});

test('film page shows it without the episode code', async ({ page, api }) => {
  api.handoff.byItem[MOVIE.id] = filmOffer();
  await filmPage(page);
  await expect(line(page)).toHaveText('Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
  await expect(play(page)).toHaveAttribute('href', `/watch/${MOVIE.id}?t=1390`);
  await expect(play(page)).toHaveAccessibleName('Fortsetzen, weiter ab 23:10, zuletzt auf LG-Fernseher');
});

test('nothing for this device\'s own playback', async ({ page, api }) => {
  api.handoff.byItem[MOVIE.id] = null;
  await filmPage(page);
  await expect(line(page)).toContainText('Noch');
  await expect(line(page)).not.toContainText('zuletzt auf');
  await expect(play(page)).toHaveAttribute('href', `/watch/${MOVIE.id}`);
  await expect(play(page)).toHaveAccessibleName(/^Fortsetzen$/);
});

test('an offer for another episode is not shown', async ({ page, api }) => {
  api.handoff.byItem[SERIES.id] = offer({ itemId: episodes[3]!.id });
  await seriesPage(page);
  await expect(line(page)).toContainText('Noch');
  await expect(play(page)).not.toHaveAttribute('href', /t=/);
});

test('no resume line: nothing is added, the link still starts at the position', async ({ page, api }) => {
  api.handoff.byItem[MOVIE.id] = filmOffer();
  await filmPage(page, 0);
  await expect(play(page)).toHaveAttribute('href', `/watch/${MOVIE.id}?t=1390`);
  await expect(play(page)).toHaveAccessibleName('Abspielen, weiter ab 23:10, zuletzt auf LG-Fernseher');
  await expect(page.locator('.dd p.resume')).toHaveCount(0);
});

test.describe('TV', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test('the resume line carries the hint', async ({ page, api }) => {
    api.handoff.byItem[SERIES.id] = offer();
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await mockPlayer(page);
    await seriesPage(page);
    await expect(page.locator('.tv-meta.resume')).toHaveText('S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
    await expect(page.locator('a.tv-btn.play')).toHaveAttribute('href', /[?&]t=1390$/);
    await expect(page.locator('a.tv-btn.play')).toHaveAccessibleName('Fortsetzen, weiter ab 23:10, zuletzt auf LG-Fernseher');
  });
});
