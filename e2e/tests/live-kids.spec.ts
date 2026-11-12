// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';

// Live TV for kids profiles (Task 37, spec §11.4): the server sends only the channels of kid-friendly groups, the page shows
// them as big tiles (logo, name, *Jetzt* title) with the favourites above; a long press (touch / mouse) or a long OK (remote) is the
// favourite. Solid panels, no chips, no guide. A kids profile may open /live (it is on the kids route list).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, features: { livetv: true }, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };
const tiles = (page: Page) => page.getByRole('list', { name: 'Senderliste' }).getByRole('listitem');

test.describe('Live TV for kids', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    // the server already filtered: only the kid-friendly group comes back
    const kinder = api.livetv.channels.find((c) => c.id === 'ch-kinder')!;
    api.livetv.groups = [{ id: 'g-kinder', name: 'Kinder' }];
    api.livetv.channels = [kinder, { ...kinder, id: 'ch-pixel', number: 13, name: 'Pixel Piraten', now: { ...kinder.now!, title: 'Käpt’n Klecks' }, next: undefined, favourite: false, running: false }];
    api.livetv.favourites = ['ch-kinder'];
    api.livetv.recent = [];
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    await page.clock.install({ time: NOW });
  });

  test('only kid-friendly tiles, long press favourite', async ({ page, api }) => {
    await page.goto('/live');
    await expect(page).toHaveURL((u) => u.pathname === '/live'); // not sent back to the kids home
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    // favourites above, then every channel as a big tile with logo, name and the Jetzt title
    const fav = page.getByRole('region', { name: 'Läuft gerade bei dir' });
    await expect(fav.getByRole('button')).toHaveCount(1);
    await expect(fav.getByRole('button')).toHaveAccessibleName(/^12 Kinderinsel/);
    await expect(tiles(page)).toHaveCount(2);
    await expect(tiles(page).nth(0)).toContainText('Kinderinsel');
    await expect(tiles(page).nth(0)).toContainText('Abenteuer Wattenmeer');
    await expect(tiles(page).nth(0).locator('img')).toHaveCount(1);
    await expect(tiles(page).nth(1)).toContainText('Pixel Piraten');
    await expect(tiles(page).nth(1)).toContainText('Käpt’n Klecks');
    await expect(page.getByText('Nordlicht TV')).toHaveCount(0);
    // no chips, no guide, no star buttons: kids do not get a filter bar
    await expect(page.getByRole('group', { name: 'Sendergruppen' })).toHaveCount(0);
    const big = (await tiles(page).nth(0).boundingBox())!;
    expect(big.height).toBeGreaterThanOrEqual(120);
    // solid panel: no backdrop blur on a tile
    expect(await tiles(page).nth(0).locator('.tile').evaluate((e) => getComputedStyle(e).backdropFilter)).toBe('none');

    // a long press (mouse down, 650 ms, up) takes the channel into the favourites and does not open it
    const pixel = tiles(page).nth(1).locator('.tile');
    const b = (await pixel.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.clock.runFor(650);
    await page.mouse.up();
    await expect(fav.getByRole('button')).toHaveCount(2);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-pixel']);
    expect(new URL(page.url()).pathname).toBe('/live');

    // a long OK on the focused tile takes it out again
    await pixel.focus();
    await page.keyboard.down('Enter');
    await page.clock.runFor(650);
    await page.keyboard.up('Enter');
    await expect(fav.getByRole('button')).toHaveCount(1);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-pixel', 'DELETE /api/livetv/favourites/ch-pixel']);
    expect(new URL(page.url()).pathname).toBe('/live');
  });

  test('a long OK that loses the focus or the window fires nothing', async ({ page, api }) => {
    await page.goto('/live');
    const pixel = tiles(page).getByRole('button', { name: /Pixel Piraten/ });
    await pixel.focus();
    await page.keyboard.down('Enter');
    await page.clock.runFor(300);
    await page.getByRole('button', { name: /Kinderinsel/ }).first().focus(); // the focus moves while OK is held
    await page.clock.runFor(650);
    await page.keyboard.up('Enter');
    expect(api.livetv.calls).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/live');

    await pixel.focus();
    await page.keyboard.down('Enter');
    await page.clock.runFor(300);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.clock.runFor(650);
    await page.keyboard.up('Enter');
    expect(api.livetv.calls).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/live');
  });

  test('a tap opens the player', async ({ page }) => {
    await page.route('**/live/watch/**', (r) => (r.request().isNavigationRequest() ? r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title>' }) : r.fallback()));
    await page.goto('/live');
    await tiles(page).nth(1).locator('.tile').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/live/watch/ch-pixel');
  });

  test('the kids header and the kids home lead to Fernsehen', async ({ page }) => {
    await page.goto('/kids');
    const head = page.locator('header.kidsnav');
    await expect(head.getByRole('link', { name: 'Fernsehen' })).toHaveAttribute('href', '/live');
    await page.getByRole('main').getByRole('link', { name: 'Fernsehen' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(head.getByRole('link', { name: 'Fernsehen' })).toHaveAttribute('aria-current', 'page');
  });

  test('no entry without features.livetv', async ({ page, api }) => {
    api.features = { livetv: false };
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...KID, features: { livetv: false } } }));
    await page.goto('/kids');
    await expect(page.getByRole('link', { name: 'Fernsehen' })).toHaveCount(0);
  });
});
