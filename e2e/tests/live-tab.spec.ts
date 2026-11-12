// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { opensPlayer } from '../helpers.js';
import { livePlaylist, patchChannel, progAt } from '../mocks/livetv.js';

// The Live-TV tab on a desktop (Task 36): navigation entry, favourites tiles, group chips, the two-column channel grid with its
// always-reserved lines, the star, "Zuletzt gesehen", the time left in minute steps and the rule that arriving data moves nothing.
// A fake clock stands at Thursday 2026-11-12 20:37:10 (local), so the programmes of mocks/livetv.ts are running.
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const nav = (page: Page) => page.getByRole('navigation', { name: 'Hauptnavigation' });
const grid = (page: Page) => page.getByRole('list', { name: 'Senderliste' });
const rows = (page: Page) => grid(page).getByRole('listitem');
const rowOf = (page: Page, name: string) => rows(page).filter({ hasText: name });
const favs = (page: Page) => page.getByRole('region', { name: 'Läuft gerade bei dir' });
const chips = (page: Page) => page.getByRole('group', { name: 'Sendergruppen' });
const names = (loc: Locator) => loc.locator('.name').allTextContents();

test.describe('Live-TV tab (desktop)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    await page.clock.install({ time: NOW });
  });

  test('no tab without features.livetv', async ({ page, api }) => {
    api.features = { livetv: false };
    await page.goto('/');
    await expect(nav(page).getByRole('link', { name: 'Filme' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Live-TV' })).toHaveCount(0);
    // and there is no such page: /live leads home
    await page.goto('/live');
    await expect(page).toHaveURL((u) => u.pathname === '/');
  });

  test('the tab sits after Filme in the header', async ({ page }) => {
    await page.goto('/');
    await expect(nav(page).getByRole('link', { name: 'Live-TV' })).toBeVisible();
    const labels = await nav(page).getByRole('link').allTextContents();
    expect(labels.indexOf('Live-TV')).toBe(labels.indexOf('Filme') + 1);
    await nav(page).getByRole('link', { name: 'Live-TV' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(nav(page).getByRole('link', { name: 'Live-TV' })).toHaveAttribute('aria-current', 'page');
  });

  test('desktop layout', async ({ page }) => {
    await page.goto('/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();

    // favourites row: the person's order, preview only for running channels, else the logo on the glass
    const tiles = favs(page).getByRole('button');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(0)).toHaveAccessibleName('1 Nordlicht TV, jetzt: Die Leuchtturmwärter, bis 21:00');
    await expect(tiles.nth(1)).toHaveAccessibleName('4 Hafenkanal, jetzt: Wetter am Hafen, bis 21:30');
    await expect(tiles.nth(2)).toHaveAccessibleName('12 Kinderinsel, jetzt: Abenteuer Wattenmeer, bis 21:30');
    await expect(favs(page).locator('img.pv')).toHaveCount(2);
    await expect(tiles.nth(2).locator('img.lg')).toHaveCount(1);
    await expect(tiles.nth(2).locator('img.pv')).toHaveCount(0);
    const t0 = await tiles.nth(0).boundingBox();
    expect(Math.abs(t0!.width / t0!.height - 16 / 9)).toBeLessThan(0.03); // 16:9
    await expect(tiles.nth(0)).toContainText('noch 23 Min.');

    // group chips: Alle, Favoriten, Zuletzt gesehen, then the groups; they filter, so they are toggle buttons
    const bar = chips(page);
    await expect(bar.getByRole('button')).toHaveText(['Alle', 'Favoriten', 'Zuletzt gesehen', 'Allgemein', 'Sport', 'Kinder']);
    await expect(bar.getByRole('button', { name: 'Alle' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('tab')).toHaveCount(0);

    // two columns of 72 px rows, in channel order
    await expect(rows(page)).toHaveCount(6);
    const a = (await rows(page).nth(0).boundingBox())!, b = (await rows(page).nth(1).boundingBox())!, c = (await rows(page).nth(2).boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(b.x).toBeGreaterThan(a.x + a.width / 2);
    expect(c.y).toBeGreaterThan(a.y + 60);
    expect(a.height).toBeCloseTo(72, 0);
    expect(await names(grid(page))).toEqual(['Nordlicht TV', 'Hafenkanal', 'Bergblick Sport', 'Kinderinsel', 'Sternwarte 24', 'Kanal Wolkenlos']);
    await expect(rowOf(page, 'Nordlicht TV').getByRole('button').first()).toHaveAccessibleName('1 Nordlicht TV, jetzt: Die Leuchtturmwärter, bis 21:00');

    // the Jetzt and Danach lines and the honest states
    const nord = rowOf(page, 'Nordlicht TV');
    await expect(nord).toContainText('Jetzt');
    await expect(nord).toContainText('20:15 Die Leuchtturmwärter');
    await expect(nord).toContainText('Danach');
    await expect(nord).toContainText('21:00 Wetter am Hafen');
    await expect(rowOf(page, 'Sternwarte 24')).toContainText('Live');
    await expect(rowOf(page, 'Sternwarte 24')).toContainText('Kein Programm verfügbar');
    await expect(rowOf(page, 'Kanal Wolkenlos')).toContainText('Programm gerade nicht verfügbar');
    await expect(rowOf(page, 'Bergblick Sport')).toContainText('Gerade keine Übertragung');
    // the time left never shows on rows
    await expect(grid(page)).not.toContainText('noch ');
    // every row has the same height whatever its lines say
    const heights = await rows(page).evaluateAll((l) => l.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(heights)).toEqual(new Set([72]));

    // a chip filters
    await bar.getByRole('button', { name: 'Kinder' }).click();
    await expect(bar.getByRole('button', { name: 'Kinder' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar.getByRole('button', { name: 'Alle' })).toHaveAttribute('aria-pressed', 'false');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Kinderinsel');
    await bar.getByRole('button', { name: 'Favoriten' }).click();
    expect(await names(grid(page))).toEqual(['Nordlicht TV', 'Hafenkanal', 'Kinderinsel']);
  });

  test('star toggles', async ({ page, api }) => {
    await page.goto('/live');
    // the label stays, aria-pressed carries the state
    const star = (_pressed: boolean) => rowOf(page, 'Bergblick Sport').getByRole('button', { name: 'Zu Favoriten: Bergblick Sport' });
    await expect(star(false)).toHaveAttribute('aria-pressed', 'false');
    const box = (await star(false).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await star(false).click();
    await expect(star(true)).toHaveAttribute('aria-pressed', 'true');
    await expect(favs(page).getByRole('button')).toHaveCount(4);
    await star(true).click();
    await expect(star(false)).toHaveAttribute('aria-pressed', 'false');
    await expect(favs(page).getByRole('button')).toHaveCount(3);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-berg', 'DELETE /api/livetv/favourites/ch-berg']);
  });

  test('Zuletzt gesehen lists the recent channels newest first', async ({ page }) => {
    await page.goto('/live');
    await chips(page).getByRole('button', { name: 'Zuletzt gesehen' }).click();
    await expect(chips(page).getByRole('button', { name: 'Zuletzt gesehen' })).toHaveAttribute('aria-pressed', 'true');
    expect(await names(grid(page))).toEqual(['Kinderinsel', 'Hafenkanal']);
  });

  test('the chip is absent while the profile has watched nothing', async ({ page, api }) => {
    api.livetv.recent = [];
    await page.goto('/live');
    await expect(chips(page).getByRole('button')).toHaveText(['Alle', 'Favoriten', 'Allgemein', 'Sport', 'Kinder']);
  });

  test('tiles show noch 23 Min. and a minute later noch 22 Min. without moving', async ({ page }) => {
    await page.goto('/live');
    const tile = favs(page).getByRole('button', { name: /^1 Nordlicht TV/ });
    await expect(tile).toContainText('noch 23 Min.');
    const measure = async () => ({ title: await tile.locator('.ti').boundingBox(), left: await tile.locator('.left').boundingBox(), tile: await tile.boundingBox() });
    const before = await measure();
    await page.clock.runFor(60_000);
    await expect(tile).toContainText('noch 22 Min.');
    expect(await measure()).toEqual(before);
  });

  test('a row opens the player', async ({ page }) => {
    await page.goto('/live');
    await opensPlayer(page, () => rowOf(page, 'Hafenkanal').getByRole('button').first().click(), 'ch-hafen');
  });

  test('twelve favourites wrap into rows: every tile is inside the width, nothing scrolls sideways', async ({ page, api }) => {
    const first = api.livetv.channels[0]!;
    api.livetv.channels = [...api.livetv.channels, ...Array.from({ length: 6 }, (_, i) => ({ ...first, id: `ch-x${i}`, number: 40 + i, name: `Zusatz ${i + 1}` }))];
    api.livetv.favourites = api.livetv.channels.map((c) => c.id);
    await page.goto('/live');
    const tiles = favs(page).getByRole('button');
    await expect(tiles).toHaveCount(12);
    const vw = page.viewportSize()!.width;
    const boxes = await tiles.evaluateAll((l) => l.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, r: r.right, y: Math.round(r.y) }; }));
    for (const b of boxes) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.r).toBeLessThanOrEqual(vw); }
    expect(new Set(boxes.map((b) => b.y)).size).toBeGreaterThan(1); // more than one row
    expect(await favs(page).getByRole('list').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  });

  test('the active tab fill lines up with Neu when Live-TV is in the header', async ({ page }) => {
    await page.goto('/new');
    const tab = nav(page).locator('a.tab.active');
    await expect(tab).toHaveText(/^Neu/);
    const fill = nav(page).locator('.fill');
    await expect.poll(async () => Math.abs(((await fill.boundingBox())?.x ?? -99) - ((await tab.boundingBox())?.x ?? 99)), { timeout: 5000 }).toBeLessThan(3);
  });

  test('the slots fit the longest words of every language', async ({ page, api }) => {
    patchChannel(api.livetv, 'ch-nord', { now: progAt('Die Leuchtturmwärter', [19, 0], [22, 0]) });
    await page.goto('/live');
    const tile = favs(page).getByRole('button', { name: /^1 Nordlicht TV/ });
    await expect(tile).toContainText('noch 1 Std. 23 Min.'); // the long form
    // the longest time left (Polish) and the longest label (French) still fit their reserved slots
    const fits = await page.evaluate(() => {
      const left = document.querySelector('.cap .left') as HTMLElement, lb = document.querySelector('.row .lb') as HTMLElement;
      left.textContent = 'jeszcze 12 godz. 59 min'; lb.textContent = 'Maintenant';
      return [[left.scrollWidth, left.clientWidth], [lb.scrollWidth, lb.clientWidth]];
    });
    for (const [scroll, client] of fits as Array<[number, number]>) expect(scroll).toBeLessThanOrEqual(client);
  });

  test('now/next arriving moves nothing', async ({ page, api }) => {
    await page.goto('/live');
    await expect(rowOf(page, 'Sternwarte 24')).toContainText('Kein Programm verfügbar');
    const all = page.locator('.row, .cell, .chips .chip');
    const boxes = () => all.evaluateAll((l) => l.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x * 10), Math.round(r.y * 10), Math.round(r.width * 10), Math.round(r.height * 10)]; }));
    const before = await boxes();
    expect(before.length).toBeGreaterThan(12);
    // the list is refreshed with its ETag every 30 s; nothing changed yet: 304
    await page.clock.runFor(31_000);
    await expect.poll(() => api.livetv.gets.length).toBeGreaterThanOrEqual(2);
    expect(api.livetv.gets[0]).toBeNull();
    expect(api.livetv.gets[1]).toBe('"v1"');
    // programme data arrives for the channel that had none
    patchChannel(api.livetv, 'ch-stern', { epg: 'ok', now: progAt('Sternstunde Physik', [20, 0], [21, 0]), next: progAt('Die Leuchtturmwärter', [21, 0], [22, 0]) });
    await page.clock.runFor(31_000);
    await expect(rowOf(page, 'Sternwarte 24')).toContainText('20:00 Sternstunde Physik');
    await expect(rowOf(page, 'Sternwarte 24')).toContainText('21:00 Die Leuchtturmwärter');
    expect(api.livetv.gets[api.livetv.gets.length - 1]).toBe('"v1"'); // the refresh that brought version 2 still carried version 1
    expect(await boxes()).toEqual(before);
  });

  test('skeleton rows of the final height stand in while the list loads', async ({ page }) => {
    await page.route('**/api/livetv/channels', async (r) => { await new Promise((res) => setTimeout(res, 800)); await r.fallback(); });
    await page.goto('/live');
    const sk = page.locator('li.sk.skeleton').first();
    await expect(sk).toBeVisible();
    expect((await sk.boundingBox())!.height).toBeCloseTo(72, 0);
    await expect(rows(page)).toHaveCount(6);
  });

});

test.describe('Live-TV tab: a failing list (desktop)', () => {
  // the 500 is a mocked failure: the browser logs the answer
  test.use({ allowedConsole: /Failed to load resource: the server responded with a status of 500/ });
  test('a failed first load says so and can be retried', async ({ page, api }) => {
    api.features = { livetv: true };
    await page.clock.install({ time: NOW });
    api.livetv.status = 500;
    await page.goto('/live');
    await expect(page.getByRole('alert')).toContainText('Die Senderliste konnte nicht geladen werden.');
    api.livetv.status = 200;
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(rows(page)).toHaveCount(6);
  });
});

test.describe('the mocked live playlist (mocks/livetv.ts)', () => {
  test('slides and never ends', async ({ page, api }) => {
    await page.goto('/offline');
    const get = () => page.evaluate(async () => (await fetch('/media/l/tok-ch-nord/index.m3u8')).text());
    const first = await get();
    expect(first).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(first).not.toContain('#EXT-X-ENDLIST');
    expect(first).not.toContain('PLAYLIST-TYPE');
    expect(first.match(/#EXTINF/g)).toHaveLength(6);
    expect(livePlaylist(api.livetv, api.livetv.liveStart! + 10_000)).toContain('#EXT-X-MEDIA-SEQUENCE:5');
    const seg = await page.evaluate(async () => { const r = await fetch('/media/l/tok-ch-nord/s17.m4s'); return [r.status, (await r.arrayBuffer()).byteLength]; });
    expect(seg[0]).toBe(200);
    expect(seg[1]).toBeGreaterThan(100);
  });
});
