// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Phone: casting to FriendFlix's own receiver (fake app ID) looks and works like casting to the Default Media Receiver. */
const RT = 'eyJ2IjoxLCJjIjoiYWJjIn0.' + 'S'.repeat(43);

test('phone: the own receiver gets the title and its report token; the cast overlay is the same', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page, true, 'A1B2C3D4');
  const sdk = await fakeCastSdk(page);
  const { sessions } = await castSessions(page, { report: RT });
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await expect.poll(() => sessions.length).toBeGreaterThan(0);
  expect(sessions[0]).toMatchObject({ receiver: true });
  await expect.poll(() => sdk.messages()).toContainEqual({ ns: 'urn:x-cast:com.friendflix.cast', msg: { t: 'tok', castId: 'c'.repeat(32), rt: RT } });
});
