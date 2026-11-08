// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

/** Phone browse block 3, search: rounded field, popular rows, genre tiles, live results. */
const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };

test.describe('phone search', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); sessionStorage.setItem('ff-intro-seen', '1'); });
  });
  test('field is focused and rounded; popular rows and genre tiles show before typing', async ({ page }) => {
    await page.goto('/search');
    const q = page.locator('#q');
    await expect(q).toBeFocused();
    const box = (await q.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await q.evaluate((e) => getComputedStyle(e).borderRadius)).toBe('12px');

    await expect(page.getByRole('heading', { name: 'Beliebt hier' })).toBeVisible();
    const rows = page.locator('.top li');
    await expect(rows.first()).toBeVisible();
    const play = rows.first().getByRole('link', { name: / abspielen$/ });
    await expect(play).toHaveAttribute('href', /^\/watch\//);
    const pb = (await play.boundingBox())!;
    expect(pb.width).toBeGreaterThanOrEqual(44);
    expect(pb.height).toBeGreaterThanOrEqual(44);

    await expect(page.getByRole('heading', { name: 'Nach Genre stöbern' })).toBeVisible();
    const tiles = page.locator('.gt a');
    await expect(tiles).toHaveCount(5);
    await expect(tiles.first()).toHaveAttribute('href', '/browse/movies?genre=Action');
    expect(Math.round((await tiles.first().boundingBox())!.height)).toBe(74);
    await noHorizontalOverflow(page);
  });

  test('without genres the last popular row still clears the floating tab bar', async ({ page }) => {
    await page.route('**/api/library/genres', (r) => r.fulfill({ json: { genres: [] } }));
    await page.goto('/search');
    const last = page.locator('.top li').last();
    await expect(last).toBeVisible();
    await expect(page.locator('.gt')).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const bar = page.locator('nav.tabbar');
    await expect(bar).toBeVisible();
    await expect.poll(async () => (await last.boundingBox())!.y + (await last.boundingBox())!.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
  });

  test('typing shows results as before and hides the browse sections', async ({ page }) => {
    await page.goto('/search');
    await page.locator('#q').fill('nolan');
    await expect(page.getByRole('heading', { name: 'Filme & Serien' })).toBeVisible();
    await expect(page.locator('.gt')).toHaveCount(0);
    await expect(page.locator('.top')).toHaveCount(0);
  });

  test('kids search has no popular rows or genre tiles', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.goto('/search');
    await expect(page.locator('#q')).toBeVisible();
    await expect(page.locator('.gt')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Beliebt hier' })).toHaveCount(0);
  });
});
