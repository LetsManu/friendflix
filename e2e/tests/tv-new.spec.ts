// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';

/** The new-titles page on a paired television: side-bar entry, solid panels, D-pad navigation (a TV remote sends arrow keys, Enter and Back). */
async function asTv(page: Page, features?: { requests?: boolean }) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, ...(features ? { features } : {}) } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [] } }));
}

test.describe('TV: new & upcoming', () => {
  test('the side bar has a New entry; the D-pad leads from the start page to it', async ({ page }) => {
    await asTv(page);
    await page.goto('/');
    await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
    const rail = page.locator('nav.rail');
    await expect(rail.locator('li > a')).toHaveCount(6); // search, start, series, movies, new, my list
    await expect(rail.locator('a[href="/new"]')).toHaveAttribute('aria-label', 'Neu & demnächst');

    await page.locator('main .card .thumb').first().focus();
    await page.keyboard.press('ArrowLeft'); // from the first card: the rail opens on the active entry (Start)
    await expect(rail).toHaveClass(/open/);
    await expect(rail.locator('a[aria-current="page"]')).toBeFocused();
    for (const href of ['/browse/series', '/browse/movies', '/new']) {
      await page.keyboard.press('ArrowDown');
      await expect(rail.locator(`a[href="${href}"]`)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & demnächst' })).toBeVisible();
    await expect(rail.locator('a[aria-current="page"]')).toHaveAttribute('href', '/new');
    await expect(rail).not.toHaveClass(/open/);
    // the page takes the focus: the first control is the filter
    await expect(page.getByRole('radio', { name: 'Alles' })).toBeFocused();
  });

  test('rows of 16:9 cards with their notes in solid panels; the ranked row keeps its corner chip', async ({ page, api }) => {
    api.newPage.upcoming = { movie: [{ tmdbId: 11, mediaType: 'movie', title: 'Vesper Bay', releaseDate: '2026-11-28T00:00:00Z', status: 'nicht_angefragt' }], tv: [] };
    await asTv(page);
    await page.goto('/new');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const forYou = row(page, 'Für dich neu');
    await expect(forYou.locator('article.card')).toHaveCount(3);
    // no focus tile on this page: the note names the title and gives the reason
    const note = forYou.locator('.note').first();
    await expect(note.locator('.nm')).toBeVisible();
    await expect(note.locator('.nm')).toHaveText('Interlace');
    await expect(note.locator('.why')).toHaveText('Weil du „Inkwell“ gesehen hast · gleiche Regie');
    const bg = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(28, 26, 33)'); // --fr-solid: a solid panel, no blur
    expect(await page.locator('.in .seg').evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');
    // 16:9 thumbnails, never the posters
    const thumb = (await forYou.locator('a.thumb').first().boundingBox())!;
    expect(thumb.width / thumb.height).toBeCloseTo(16 / 9, 1);
    // the ranked row: corner chip with the number only
    const ranked = row(page, 'Diese Woche bei uns');
    await expect(ranked.locator('.rkn').first()).toHaveText('1');
    await expect(ranked.locator('.rkt').first()).toBeHidden();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toBeAttached();
    // an episode card keeps its season and episode in the panel (the overlay is not shown on TV)
    await expect(row(page, 'Neue Folgen').locator('.note.ep .meta').first()).toBeVisible();
    await expect(row(page, 'Neue Folgen').locator('.note.ep .meta').first()).toHaveText(/S1:F2|Staffel 1/);
    await expect(page.getByRole('tablist')).toHaveCount(0); // no tabs and no wishes on TV
    await expect(page.getByRole('button', { name: /Wünschen/ })).toHaveCount(0);
  });

  test('D-pad: the filter selects with OK, Down reaches the cards with a focus ring, Back opens the side bar', async ({ page }) => {
    await asTv(page);
    await page.goto('/new');
    const alles = page.getByRole('radio', { name: 'Alles' });
    await expect(alles).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const serien = page.getByRole('radio', { name: 'Serien' });
    await expect(serien).toBeFocused();
    await expect(serien).not.toBeChecked(); // moving the focus does not choose
    expect((await serien.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await page.keyboard.press('Enter');
    await expect(serien).toBeChecked();
    await expect(page).toHaveURL(/\/new\?type=series$/);
    await expect(row(page, 'Neue Filme')).toHaveCount(0);

    await page.keyboard.press('ArrowDown'); // the spatial navigation picks the card below the filter
    const first = page.locator('main section.row a.thumb:focus');
    await expect(first).toHaveCount(1);
    const ring = await first.evaluate((el) => getComputedStyle(el.closest('.media')!, '::after').boxShadow);
    expect(ring).toContain('rgb(255, 255, 255)'); // the white focus ring (spec 5.2)
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('main section.row a.thumb:focus')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(true);

    await page.keyboard.press('Backspace'); // Back on a rail destination (even with the filter set) opens the side bar
    await expect(page.locator('nav.rail')).toHaveClass(/open/);
  });

  test('without a request service the side bar entry reads "Neu" and the page has no Demnächst', async ({ page }) => {
    await asTv(page, { requests: false });
    await page.goto('/new');
    await expect(page.locator('nav.rail a[href="/new"]')).toHaveAttribute('aria-label', 'Neu');
    await page.locator('nav.rail a[href="/new"]').focus();
    await expect(page.locator('nav.rail a[href="/new"] .lb')).toHaveText('Neu');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demnächst' })).toHaveCount(0);
  });
});
