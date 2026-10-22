// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';
import { episodes } from '../mocks/fixtures.js';
import { fakeNativeApp, nativeCalls } from '../mocks/native.js';

/** Inside the Windows app (user agent marker FriendFlixDesktop/) Play on the home page goes to the native player. */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 FriendFlixDesktop/2.3.0';

test.describe('in the Windows app', () => {
  test.use({ userAgent: DESKTOP_UA });

  test('Play on a Weiterschauen card goes to the native player and the page stays', async ({ page, api: _api }) => {
    await fakeNativeApp(page, { caps: { play: true, download: false, cast: false } });
    await page.goto('/');
    const card = row(page, 'Weiterschauen').locator('article.card').first();
    await expect(card).toBeVisible();
    await card.locator('a.thumb').click();
    await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
    const [call] = await nativeCalls(page, 'play');
    expect(call!.args).toMatchObject({ itemId: episodes[0]!.id });
    await page.waitForTimeout(300);
    expect(page.url()).not.toMatch(/\/watch\//);
  });
});
