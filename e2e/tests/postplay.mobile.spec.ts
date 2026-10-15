// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { boxInViewport, noHorizontalOverflow } from '../helpers.js';
import { MOVIE } from '../mocks/fixtures.js';
import { CAUGHT_UP, FINISHED, LAST_EP, MOVIE_END, endTitle, mockPostplay, toCredits } from '../mocks/postplay.js';
import { mockPlayer } from '../mocks/scenes.js';

// 1.1 A1+A2 on a phone: the card fits the screen, the screen fills it without sideways scrolling, nothing autoplays, the back
// button keeps the viewer on the title.

test.describe('post-play screen (phone)', () => {
  test('movie end: card in the viewport, full-screen screen, back stays on the title', async ({ page, api }) => {
    await mockPlayer(page, { chapters: [] });
    await mockPostplay(page, MOVIE.id, MOVIE_END);
    await page.goto('/watch/' + MOVIE.id);
    await toCredits(page);
    const card = page.getByTestId('postplay-card');
    await expect(card).toBeVisible();
    expect((await boxInViewport(page, card)).ok).toBe(true);
    await endTitle(page);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveText('Du hast „Inkwell“ gesehen');
    const box = await pp.boundingBox();
    expect(box && box.width).toBe(390);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    expect(await pp.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).pathname).toBe('/watch/' + MOVIE.id);
    await pp.getByRole('button', { name: 'Zurück zum Titel' }).tap();
    await expect(pp).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/watch/' + MOVIE.id);
    await expect.poll(() => api.postplayEvents.map((e) => e.type)).toEqual(['shown', 'dismiss']);
  });

  test('ongoing series: caught up with a reminder', async ({ page }) => {
    await mockPostplay(page, LAST_EP.id, CAUGHT_UP);
    await page.route('**/api/reminders', (r) => r.fulfill({ json: { id: 7, coveredByFollow: false } }));
    await page.goto('/postplay/' + LAST_EP.id);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByRole('heading', { level: 1 })).toHaveText('Du bist auf dem neuesten Stand');
    await pp.getByRole('button', { name: 'Erinnere mich' }).tap();
    await expect(pp.getByRole('button', { name: 'Erinnerung aktiv' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('finished series: wish for the missing season', async ({ page }) => {
    await mockPostplay(page, LAST_EP.id, FINISHED);
    await page.route('**/api/requests', (r) => r.fulfill({ json: { id: 9, status: 'angefragt' } }));
    await page.goto('/postplay/' + LAST_EP.id);
    const pp = page.getByTestId('postplay');
    await expect(pp.getByText('Noch 2 Wünsche in diesem Monat')).toBeVisible();
    const wish = pp.getByRole('button', { name: 'Fehlende Staffel wünschen' });
    expect((await boxInViewport(page, wish)).ok).toBe(true);
    await wish.tap();
    await expect(pp.getByRole('button', { name: 'Gewünscht' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
