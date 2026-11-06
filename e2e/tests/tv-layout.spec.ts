// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** TV layout: a paired television gets the 10-foot design (html.tv) */
async function setTv(page: Page, tv: boolean) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [] } })); // the TV home warms its hero title
}

test.describe('TV layout', () => {
  test('tokens: black background and white focus ring on TV', async ({ page, api: _api }) => {
    await setTv(page, true);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(page.locator('nav.rail a.who')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { tag: el.tagName, color: s.outlineColor, width: s.outlineWidth, shadow: s.boxShadow };
    });
    expect(ring.color).toBe('rgb(255, 255, 255)');
    expect(ring.width).toBe('3px');
    expect(ring.shadow).toBe('none');
  });

  test('tokens: .tv-btn on a <button> keeps its own size', async ({ page, api: _api }) => {
    await setTv(page, true);
    await page.goto('/');
    await expect(page.locator('nav.rail a.who')).toBeVisible();
    const r = await page.evaluate(() => {
      const b = document.createElement('button'); b.className = 'tv-btn'; b.textContent = 'x'; document.body.append(b);
      return { fs: parseFloat(getComputedStyle(b).fontSize), root: parseFloat(getComputedStyle(document.documentElement).fontSize), h: b.getBoundingClientRect().height };
    });
    expect(r.fs).toBeCloseTo(r.root * 1.4, 1);
    expect(r.h).toBeGreaterThanOrEqual(56);
  });

  test('tokens: desktop keeps the dark grey background', async ({ page, api: _api }) => {
    await setTv(page, false);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 20, 24)');
  });

  test.describe('rail', () => {
    const open = (page: Page) => expect(page.locator('nav.rail')).toHaveClass(/open/);
    const closed = (page: Page) => expect(page.locator('nav.rail')).not.toHaveClass(/open/);
    async function home(page: Page) {
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('nav.rail a.who')).toBeAttached();
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused(); // the page's own first focus has landed
      const card = page.locator('main .card .thumb').first();
      await expect(card).toBeVisible();
      return card;
    }

    test('Left from the first card opens the rail on the active item, Right closes it and restores the card', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.keyboard.press('ArrowLeft');
      await open(page);
      await expect(page.locator('nav.rail a[aria-current="page"]')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await closed(page);
      await expect(card).toBeFocused();
    });

    test('Left from any element in the rail band (hero buttons) opens the rail instead of focusing a collapsed item', async ({ page, api: _api }) => {
      await home(page);
      const el = page.locator('main a[href], main button').filter({ visible: true });
      const n = await el.count();
      for (let i = 0; i < n; i++) {
        const e = el.nth(i);
        const box = await e.boundingBox();
        if (!box || box.y < 300 || box.y > 700 || box.x > 400) continue;
        await e.focus();
        await page.keyboard.press('ArrowLeft');
        const inRail = await page.evaluate(() => !!document.activeElement?.closest('nav.rail'));
        if (inRail) await open(page);
        else await closed(page); // a neighbour in the content took it
        await page.keyboard.press('ArrowRight').catch(() => {});
        await closed(page);
      }
      // collapsed items are never spatial targets
      await expect(page.locator('nav.rail')).toHaveAttribute('data-nav-skip', '');
    });

    test('OK on Movies navigates', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.keyboard.press('ArrowLeft');
      await open(page);
      await page.locator('nav.rail a[href="/browse/movies"]').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/browse\/movies/);
      await closed(page);
    });

    test('pointer hover opens the rail, leaving it closes it and the card keeps the focus', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.mouse.move(10, 400);
      await page.mouse.move(40, 420);
      await open(page);
      await page.mouse.move(900, 20); // the top margin: nothing focusable
      await closed(page);
      await expect(card).toBeFocused();
    });
  });

  test.describe('home', () => {
    const rowLabels = (page: Page) => page.locator('main .rows section.row').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

    test('focus tile with Play focused, Down reaches the first card, resting on it shows its title in the tile', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.goto('/');
      const tile = page.locator('section.tile');
      await expect(tile).toBeVisible();
      const play = tile.locator('[data-autofocus]');
      await expect(play).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('main .rows .card .thumb:focus')).toHaveCount(1);
      // resting on a card for 400 ms puts its title in the tile (instead of the hero and its buttons)
      const target = page.locator('main .rows section.row[aria-label="Diese Woche bei uns"] .card .thumb').first();
      await target.focus();
      const name = (await target.getAttribute('aria-label'))!.split(',')[0]!;
      await page.waitForTimeout(400);
      await expect(tile).toHaveAttribute('aria-label', name);
      await expect(tile.locator('[data-autofocus]')).toHaveCount(0); // the buttons give way to the card's info
      // Up from the first row returns to the tile: the hero and its buttons are back
      await page.locator('main .rows .card .thumb').first().focus();
      await page.keyboard.press('ArrowUp');
      await expect(play).toBeFocused();
    });

    test('the rows are the same list as on desktop', async ({ page, api: _api }) => {
      await setTv(page, false);
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      const desktop = await rowLabels(page);
      expect(desktop.length).toBeGreaterThan(3);
      await page.unroute('**/api/me');
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('html.tv')).toHaveCount(1);
      await expect(page.locator('section.tile')).toBeVisible();
      await expect(page.locator('main .rows section.cr')).toBeAttached();
      await page.waitForLoadState('networkidle');
      await expect.poll(() => rowLabels(page)).toEqual(desktop);
    });
  });
});
