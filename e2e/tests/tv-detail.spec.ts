// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** TV detail page (spec section 3): one screen, a vertical button list, no scrolling sections */
async function setTv(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [] } }));
}
const labels = (page: Page) => page.locator('.tvd .btns > .it').evaluateAll((els) => els.map((e) => (e.querySelector('a, button') as HTMLElement).innerText.trim().split('\n')[0]));
/** the series' next episode is the one with progress (S1:F1, 15 of 45 min) */
const withProgress = (page: Page) => page.route('**/api/library/nextup*', (r) => r.fulfill({ json: { items: [episodes[0]] } }));

test.describe('TV detail page', () => {
  test('series with progress: button order, Play focused, Down walks the whole list, hidden parts are absent', async ({ page, api: _api }) => {
    await setTv(page);
    await withProgress(page);
    await page.goto(`/item/${SERIES.id}`);
    const play = page.locator('.tvd .btns a.play');
    await expect(play).toBeFocused();
    await expect.poll(() => labels(page)).toEqual(['Fortsetzen', 'Von vorne', 'Folgen & Staffeln', 'Mehr davon', 'Merkliste', 'Bewerten', 'Audio und Untertitel', 'Weitere Infos']);
    await expect(play).toHaveAttribute('href', `/watch/${episodes[0]!.id}`);
    await expect(page.locator('.tvd .btns a', { hasText: 'Von vorne' })).toHaveAttribute('href', `/watch/${episodes[0]!.id}?t=0`);
    await expect(page.locator('.tvd .btns a', { hasText: 'Folgen & Staffeln' })).toHaveAttribute('href', `/item/${SERIES.id}/episodes`);
    await expect(page.locator('.tvd .resume')).toContainText('S1:F1');
    // every row is a 56 px target (x root scale) and the column is one width
    const rows = await page.locator('.tvd .btns > .it').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ h: r.height, w: Math.round(r.width) })));
    const root = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const r of rows) expect(r.h).toBeGreaterThanOrEqual(56 * root / 16 - 0.5);
    expect(new Set(rows.map((r) => r.w)).size).toBe(1);
    // Down walks the list in order, without skipping (the list window glides along); the page itself never scrolls
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('ArrowDown');
      order.push(await page.evaluate(() => (document.activeElement as HTMLElement).innerText.trim().split('\n')[0]!));
    }
    expect(order).toEqual(['Von vorne', 'Folgen & Staffeln', 'Mehr davon', 'Merkliste', 'Bewerten', 'Audio und Untertitel', 'Weitere Infos']);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // the focused (last) button is fully inside the list window
    await expect.poll(() => page.evaluate(() => {
      const w = document.querySelector('.tvd .win')!.getBoundingClientRect(), b = document.activeElement!.getBoundingClientRect();
      return b.top >= w.top - 1 && b.bottom <= w.bottom + 1;
    })).toBe(true);
    // not on TV: friends strip, comments, download, share, tabs, autostart countdown
    await expect(page.locator('main .tabs, main .friends, main [aria-label*="Teilen"], main .auto, main .dl')).toHaveCount(0);
    await expect(page.locator('main').getByText('Teilen', { exact: true })).toHaveCount(0);
    await expect(page.locator('main .tvd .btns').getByText('Trailer')).toHaveCount(0); // no trailer for this title
  });

  test('movie: trailer, collection and extras appear when present, in the spec order; no restart without progress', async ({ page, api: _api }) => {
    await setTv(page);
    await page.route('**/api/items/*/extras/all', (r) => r.fulfill({ json: { items: [
      { ...MOVIE, id: 'a'.repeat(32), name: 'Trailer 1', kind: 'trailer' },
      { ...MOVIE, id: 'b'.repeat(32), name: 'Making-of', kind: 'extra' },
    ] } }));
    await page.route('**/api/items/*/about', (r) => r.fulfill({ json: { ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], tagline: 'Träume sind real.', collection: { name: 'Inkwell-Reihe', from: 'jellyfin', parts: [{ id: MOVIE.id, name: MOVIE.name, image: true, played: false, current: true, inLibrary: true, from: 'jellyfin' }] }, canRequest: false, sources: ['jellyfin'] } }));
    await page.goto(`/item/${MOVIE.id}`);
    await expect(page.locator('.tvd .btns a.play')).toBeFocused();
    await expect.poll(() => labels(page)).toEqual(['Abspielen', 'Trailer', 'Mehr davon', 'Merkliste', 'Bewerten', 'Audio und Untertitel', 'Filmreihe', 'Extras', 'Weitere Infos']);
    await expect(page.locator('.tvd .btns a', { hasText: 'Trailer' })).toHaveAttribute('href', `/watch/${'a'.repeat(32)}`);
    await expect(page.locator('.tvd .tag')).toHaveText('Träume sind real.');
    await expect(page.locator('.tvd .with')).toHaveText('Mit: Lena Doria, Elsa Prell, Tomas Hart');
  });

  test('Rate opens its options in place, Back closes them and stays on the page', async ({ page, api }) => {
    await setTv(page);
    await page.goto(`/item/${MOVIE.id}`);
    await expect(page.locator('.tvd .btns a.play')).toBeFocused();
    const rate = page.locator('.tvd .btns .rb .trig');
    await rate.focus();
    await expect(page.locator('.tvd .rb .pill')).toHaveCount(0); // focus alone does not open it
    await page.keyboard.press('Enter');
    await expect(page.locator('.tvd .rb .pill .opt')).toHaveCount(3);
    await expect(page.locator('.tvd .rb .pill .opt:focus')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.tvd .rb .pill .opt').nth(2)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tvd .rb .pill')).toHaveCount(0);
    await expect(rate).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
    void api;
  });

  test('Audio & subtitles opens two lists next to the button; OK applies, Back closes and the play links carry the choice', async ({ page, api: _api }) => {
    await setTv(page);
    await page.goto(`/item/${MOVIE.id}`);
    await expect(page.locator('.tvd .btns a.play')).toBeFocused();
    const trig = page.locator('.tvd .btns button.tvl');
    await trig.focus();
    await page.keyboard.press('Enter');
    const panel = page.locator('.tvlp');
    await expect(panel.locator('[role="radio"]:focus')).toHaveCount(1);
    await panel.locator('[role="radio"]', { hasText: 'Englisch' }).first().focus();
    await page.keyboard.press('Enter');
    await expect(panel.locator('[role="radio"][aria-checked="true"]', { hasText: 'Englisch' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trig).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
    await expect(page.locator('.tvd .btns a.play')).toHaveAttribute('href', `/watch/${MOVIE.id}?audio=eng`);
  });

  test('Back on the detail page returns to the page it came from, focus back on the card', async ({ page, api: _api }) => {
    await setTv(page);
    await page.goto('/');
    await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
    const card = page.locator('main .rows section.row .card a.thumb[href^="/item/"]').first();
    await card.focus();
    const href = await card.getAttribute('href');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(href! + '$'));
    await expect(page.locator('.tvd .btns [data-autofocus]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(`main .rows a.thumb[href="${href}"]:focus`)).toHaveCount(1);
  });

  test.describe('full motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('Back within 200 ms of opening a detail page still navigates and leaves no transition classes behind', async ({ page, api: _api }) => {
      await setTv(page);
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // no trailer clips
      await page.goto('/');
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
      const card = page.locator('main .rows section.row .card a.thumb[href^="/item/"]').first();
      await card.focus();
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/item\//);
      await page.waitForTimeout(120);
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('main .rows section.row .card').first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => ({
        cls: [...document.documentElement.classList].filter((c) => c.startsWith('ff-vt')),
        dx: document.documentElement.style.getPropertyValue('--ff-vt-dx'),
        named: [...document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')].length,
      }))).toEqual({ cls: [], dx: '', named: 0 });
    });

    test('the detail page enters: the backdrop settles and the text and buttons stagger in', async ({ page, api: _api }) => {
      await setTv(page);
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
      await page.goto(`/item/${MOVIE.id}`);
      await page.waitForFunction(() => [...document.querySelectorAll('.tvd .btns > .it[data-st]')].some((e) => e.getAnimations().length > 0), null, { polling: 'raf', timeout: 3000 });
      await expect(page.locator('.tvd .btns a.play')).toBeFocused();
    });
  });
});
