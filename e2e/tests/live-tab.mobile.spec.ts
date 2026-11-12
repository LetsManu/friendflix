// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { noHorizontalOverflow, opensPlayer } from '../helpers.js';
import { expect, test } from '../fixtures.js';

// The Live-TV tab on a phone (Task 36): the compact 64 px list without Danach and time left, the favourites carousel, the chips
// sticky under the header, the Live-TV chip of the chip bar and the fifth tab of the tab bar (it has to fit 320 px).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const grid = (page: Page) => page.getByRole('list', { name: 'Senderliste' });
const rows = (page: Page) => grid(page).getByRole('listitem');
const favs = (page: Page) => page.getByRole('region', { name: 'Läuft gerade bei dir' });
const tabbar = (page: Page) => page.getByRole('navigation', { name: 'Mobile Navigation' });

test.describe('Live-TV tab (phone)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    await page.clock.install({ time: NOW });
  });

  test('compact list: one column of 64 px rows, no Danach and no time left on rows', async ({ page }) => {
    await page.goto('/live');
    await expect(rows(page)).toHaveCount(6);
    const boxes = await rows(page).evaluateAll((l) => l.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; }));
    expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.h))).toEqual(new Set([64]));
    expect(boxes[0]!.w).toBeGreaterThan(300);
    // Jetzt with its progress stays; Danach moves into the info panel; the time left lives on tiles only
    await expect(rows(page).first()).toContainText('Jetzt');
    await expect(rows(page).first()).toContainText('20:15 Die Leuchtturmwärter');
    for (const el of await grid(page).getByText('Danach').all()) await expect(el).toBeHidden();
    await expect(grid(page)).not.toContainText('noch ');
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('the favourites are a swipeable carousel of 16:9 tiles', async ({ page }) => {
    await page.goto('/live');
    const strip = favs(page).getByRole('list');
    const tiles = favs(page).locator('button.tile');
    await expect(tiles).toHaveCount(3);
    const m = await strip.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, snap: getComputedStyle(e).scrollSnapType }));
    expect(m.sw).toBeGreaterThan(m.cw); // more tiles than the width: it scrolls sideways
    expect(m.snap).toContain('mandatory');
    const t = (await tiles.first().boundingBox())!;
    expect(t.width).toBeGreaterThan(280);
    expect(t.width).toBeLessThan(321);
    expect(Math.abs(t.width / t.height - 16 / 9)).toBeLessThan(0.03);
    await expect(tiles.first()).toContainText('noch 23 Min.');
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('titles keep their room on a phone (the slots are sized for German, not for every language)', async ({ page }) => {
    // at 390 px "20:15 Die Leuchtturmwärter" keeps ~20 characters in a row and ~17 in a tile; at 320 px at least ~10
    for (const [w, rowMin, tileMin] of [[390, 140, 120], [320, 70, 70]] as const) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto('/live');
      const row = await rows(page).filter({ hasText: 'Nordlicht TV' }).locator('.now .tx').evaluate((e) => e.clientWidth);
      expect(row, `row title at ${w}`).toBeGreaterThanOrEqual(rowMin);
      const tile = await favs(page).locator('button.tile').first().locator('.ti').evaluate((e) => e.clientWidth);
      expect(tile, `tile title at ${w}`).toBeGreaterThanOrEqual(tileMin);
    }
  });

  test('the chips are sticky under the header and filter', async ({ page }) => {
    await page.goto('/live');
    const bar = page.getByRole('group', { name: 'Sendergruppen' });
    expect(await bar.evaluate((e) => getComputedStyle(e.parentElement!).position)).toBe('sticky');
    await bar.getByRole('button', { name: 'Kinder' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(bar.getByRole('button', { name: 'Zuletzt gesehen' })).toBeVisible();
  });

  test('a row opens the player', async ({ page }) => {
    await page.goto('/live');
    await opensPlayer(page, () => rows(page).filter({ hasText: 'Nordlicht TV' }).getByRole('button').first().click(), 'ch-nord');
  });

  test('the chip bar of the home page has Live-TV after Filme', async ({ page }) => {
    await page.goto('/');
    const chipLinks = page.locator('nav.chipbar a.chip');
    await expect(chipLinks).toHaveText(['Serien', 'Filme', 'Live-TV']);
    await chipLinks.nth(2).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
  });

  test('five tabs fit 320 px, the new one reads Live', async ({ page, api }) => {
    api.canDownload = true;
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/live');
    const links = tabbar(page).getByRole('link');
    await expect(links).toHaveCount(5);
    expect(await links.allTextContents()).toEqual(['Start', 'Neu', 'Live', 'Merkliste', 'Downloads']);
    await expect(tabbar(page).getByRole('link', { name: 'Live-TV' })).toHaveAttribute('aria-current', 'page');
    // no label is cut off, nothing scrolls sideways
    const cut = await links.evaluateAll((l) => l.filter((a) => [...a.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1)).map((a) => a.textContent));
    expect(cut).toEqual([]);
    const bar = (await tabbar(page).boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(320);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('without the feature the tab bar keeps its three tabs', async ({ page, api }) => {
    api.features = { livetv: false };
    await page.goto('/');
    await expect(tabbar(page).getByRole('link')).toHaveText(['Start', 'Neu', 'Merkliste']);
    await expect(page.locator('nav.chipbar a.chip')).toHaveText(['Serien', 'Filme']);
  });
});
