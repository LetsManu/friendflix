// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { episodes } from '../mocks/fixtures.js';
import { APP_UA, fakeNativeApp, nativeCalls } from '../mocks/native.js';
import { dunmoor } from './cast-remote-setup.js';
import { offer } from '../mocks/handoff.js';

/** Device hand-off in the Android app: the card's action starts the native player at the shown position. */
test.use({ userAgent: APP_UA });
dunmoor();

test("the card's action plays natively at the position", async ({ page, api }) => {
  api.handoff.home = offer();
  await fakeNativeApp(page, { api: 2, caps: { play: true, download: true, cast: true, castBar: true } });
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Auf einem anderen Gerät angefangen' });
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: /^Hier weiterschauen:/ }).tap();
  await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
  const [call] = await nativeCalls(page, 'play');
  expect(call!.args).toMatchObject({ itemId: episodes[0]!.id, startMs: 1_390_000 });
  await page.waitForTimeout(300);
  expect(page.url()).not.toMatch(/\/watch\//);
});
