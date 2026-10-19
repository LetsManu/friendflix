// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { fakeCaf } from '../mocks/castReceiver.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/**
 * FriendFlix's own Cast receiver (CAST_RECEIVER_APP_ID). No real Cast SDK in CI: the sender runs against the fake sender SDK
 * with a fake app ID, the receiver page against a fake Cast Application Framework. What a real TV does (queue jump, key events,
 * subtitle styles, the CSP for Google's player libraries) is listed in docs/cast-receiver.md as hardware checks.
 */
const RT = 'eyJ2IjoxLCJjIjoiYWJjIn0.' + 'S'.repeat(43);
const A = 'a'.repeat(32), B = 'b'.repeat(32);

test('sender: a configured receiver app ID starts that receiver and hands it the report token on the private channel', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page, true, 'A1B2C3D4');
  const sdk = await fakeCastSdk(page);
  const { sessions } = await castSessions(page, { report: RT });
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wohnzimmer-TV');
  expect(await sdk.options()).toMatchObject({ receiverApplicationId: 'A1B2C3D4' });
  await expect.poll(() => sessions.length).toBeGreaterThan(0);
  expect(sessions[0]).toMatchObject({ itemId: MOVIE.id, receiver: true });
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  const load = (await sdk.loads())[0] as { customData: unknown };
  expect(load.customData).toEqual({ ff: { castId: 'c'.repeat(32) } });
  expect(JSON.stringify(load)).not.toContain(RT);
  await expect.poll(() => sdk.messages()).toContainEqual({ ns: 'urn:x-cast:com.friendflix.cast', msg: { t: 'tok', castId: 'c'.repeat(32), rt: RT } });
});

test('sender: without an app ID the Default Media Receiver as before (no receiver flag, no channel)', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions } = await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  expect(await sdk.options()).toMatchObject({ receiverApplicationId: 'CC1AD845' });
  expect(sessions[0]).not.toHaveProperty('receiver');
  expect(((await sdk.loads())[0] as { customData: unknown }).customData).toBeNull();
  expect(await sdk.messages()).toEqual([]);
  expect(await sdk.calls()).not.toContain('addMessageListener');
});

test('receiver page: own CSP, brand while idle, next-up countdown, still watching, skip, reports with the report token', async ({ page, api: _api }) => {
  const caf = await fakeCaf(page);
  const reports: Array<Record<string, unknown>> = [];
  await page.route('**/api/cast/report', (r) => { reports.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); });
  const res = await page.goto('/cast-receiver/');
  expect(res!.status()).toBe(200);
  expect(res!.headers()['content-security-policy']).toContain("script-src 'self' https://www.gstatic.com/cast/sdk/libs/");
  await expect(page.locator('.brand')).toBeVisible();
  await expect.poll(() => caf.calls()).toContain('start');

  // the sender's texts (German UI) and the user's subtitle style
  await caf.message({ t: 'ui', strings: { next: 'Nächste Folge', upNext: 'Als Nächstes: {label}', watchCredits: 'Abspann ansehen', startsIn: Array.from({ length: 10 }, (_, i) => `Nächste Folge in ${i + 1} s`),
    stillTitle: 'Noch da?', stillText: 'Automatische Wiedergabe pausiert. Als Nächstes: {ep}', keepWatching: 'Weiterschauen', skip: { intro: 'Intro überspringen', recap: 'Rückblick überspringen' } },
    sub: { size: 'l', color: 'yellow', background: 'solid', font: 'sans' }, countdown: 10 });
  expect((await caf.calls()).find((c) => c.startsWith('style:'))).toContain('"foregroundColor":"#FFEB3BFF"');
  await caf.message({ t: 'tok', castId: A, rt: RT });
  await caf.media(A, 1800);
  await caf.message({ t: 'item', castId: A, episode: true, segs: [{ type: 'intro', start: 10, end: 80 }], next: { castId: B, label: 'S1:E2 · Zwei', auto: true, ask: false } });
  await expect(page.locator('.brand')).toBeHidden();

  await caf.time(20);
  const skip = page.getByRole('button', { name: 'Intro überspringen' });
  await expect(skip).toBeVisible();
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toEqual({ rt: RT, event: 'start', positionTicks: 200_000_000, isPaused: false });
  await page.keyboard.press('Enter'); // OK on the remote
  await expect.poll(() => caf.calls()).toContain('seek:80');

  await caf.time(1780);
  const card = page.locator('#card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Als Nächstes: S1:E2 · Zwei');
  await expect(card).toContainText(/Nächste Folge in \d+ s/);
  await page.keyboard.press('Enter'); // "Next episode" has the focus: plays the queued one now
  await expect.poll(() => caf.calls()).toContain('jump:1');
  await expect(card).toBeHidden();

  // the queued episode waits for "still watching?" and plays only after an answer (here: PLAY from the remote / phone)
  await caf.message({ t: 'tok', castId: B, rt: RT });
  await caf.media(B, 1800);
  await caf.message({ t: 'item', castId: B, episode: true, segs: [], next: { castId: 'c'.repeat(32), label: 'S1:E3 · Drei', auto: true, ask: true } });
  await caf.time(1780);
  await expect(card).toContainText('Noch da?');
  await expect(card).toContainText('Weiterschauen');
  await caf.media('c'.repeat(32), 1800);
  const still = page.locator('#still');
  await expect(still).toBeVisible();
  await expect(still).toContainText('S1:E3 · Drei');
  expect(await caf.calls()).toContain('pause');
  await caf.play();
  await expect(still).toBeHidden();
  expect((await caf.calls()).filter((c) => c.startsWith('sent:'))).toContain('sent:{"t":"interaction"}');
  // the ended token's stop went out before the next one's start
  expect(reports.map((r) => r.event)).toEqual(['start', 'stop', 'start', 'stop']);
});
