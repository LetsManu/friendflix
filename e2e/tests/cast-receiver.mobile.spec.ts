// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { DUNMOOR, WRENFIELD, fakeCaf, ui } from '../mocks/castReceiver.js';
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

/** A Nest Hub (1024x600, touch) is a receiver too: a tap shows Play now and Stop here instead of the key hint. */
test.describe('receiver on a touch display', () => {
  test.use({ viewport: { width: 1024, height: 600 }, isMobile: false, deviceScaleFactor: 1 });

  test('touch shows Play now and Stop here; Stop here tells the phone', async ({ page, api: _api }) => {
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui());
    await caf.message({ t: 'tok', castId: 'a'.repeat(32), rt: RT });
    await caf.media('a'.repeat(32), 2640);
    await caf.message({ t: 'item', castId: 'a'.repeat(32), episode: true, segs: [], next: WRENFIELD, meta: DUNMOOR });
    await caf.time(2620);
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#card-buttons')).toBeHidden();
    await expect(page.locator('#card-hint')).toHaveText('Abbrechen am Handy');
    await page.touchscreen.tap(500, 200);
    const play = page.getByRole('button', { name: 'Nächste Folge' }), stop = page.getByRole('button', { name: 'Hier stoppen' });
    await expect(play).toBeVisible();
    await expect(stop).toBeVisible();
    await expect(page.locator('#card-hint')).toBeHidden();
    for (const b of [play, stop]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await stop.tap();
    await expect.poll(() => caf.calls()).toContain('sent:{"t":"cancel"}');
    await expect(page.locator('#card')).toBeHidden();
  });

  test('Play now on the card jumps to the queued episode', async ({ page, api: _api }) => {
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui());
    await caf.message({ t: 'tok', castId: 'a'.repeat(32), rt: RT });
    await caf.media('a'.repeat(32), 2640);
    await caf.message({ t: 'item', castId: 'a'.repeat(32), episode: true, segs: [], next: WRENFIELD, meta: DUNMOOR });
    await caf.time(2620);
    await page.touchscreen.tap(500, 200);
    await page.getByRole('button', { name: 'Nächste Folge' }).tap();
    await expect.poll(() => caf.calls()).toContain('jump:1');
  });
});
