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

/** the answer of the server to a cast that sent receiver caps: a Dolby Digital Plus 5.1 HEVC stream as fMP4 (Dunmoor S1 E5 "Wrenfield Pier") */
const wrenfield = (b: Record<string, unknown>) => (b.caps ? { hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4',
  delivery: { video: 'copy', videoCodec: 'hevc', audio: 'copy', audioCodec: 'eac3', channels: 6, why: ['hevc_device', 'surround_device'] } } : undefined);
const CONFIRMED = { hevc: true, hevc10: false, surround: ['eac3'] };

test('sender: what the receiver confirms (HEVC, Dolby) rides the cast request and the fMP4 answer is loaded as fMP4', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page, true, 'A1B2C3D4');
  const sdk = await fakeCastSdk(page, { caps: CONFIRMED });
  const { sessions } = await castSessions(page, { report: RT, deliver: wrenfield });
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wohnzimmer-TV');
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ itemId: MOVIE.id, receiver: true, caps: CONFIRMED });
  expect(await sdk.messages()).toContainEqual({ ns: 'urn:x-cast:com.friendflix.cast', msg: { t: 'caps?' } });
  expect((await sdk.loads())[0]).toMatchObject({ hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' });
});

test('sender: a TV that refuses the HEVC / Dolby stream gets one new cast without it, remembered for that TV (nothing else changes)', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page, true, 'A1B2C3D4');
  const sdk = await fakeCastSdk(page, { caps: CONFIRMED, refuseFmp4: true });
  const { sessions, deleted } = await castSessions(page, { report: RT, deliver: wrenfield });
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sdk.loads()).toHaveLength(2);
  expect(sessions).toHaveLength(2);
  expect(sessions[0]).toMatchObject({ receiver: true, caps: CONFIRMED });
  expect(sessions[1]).toMatchObject({ itemId: MOVIE.id, receiver: true, fellBack: 'both', prevPs: 'air-ps' });
  expect(sessions[1]).not.toHaveProperty('caps');
  expect((await sdk.loads()).map((l) => (l as { hlsSegmentFormat: string }).hlsSegmentFormat)).toEqual(['fmp4', 'ts']);
  expect(deleted).toContain('c'.repeat(32)); // the refused token was revoked
  await expect(page.locator('.castov')).toContainText('Wohnzimmer-TV');
  const avoid = await page.evaluate(() => JSON.parse(localStorage.getItem('ff-cast-avoid') ?? 'null') as Record<string, Record<string, number>>);
  expect(Object.keys(avoid)).toEqual(['Wohnzimmer-TV']);
  expect(Object.keys(avoid['Wohnzimmer-TV']!).sort()).toEqual(['hevc', 'surround']);
  await page.waitForTimeout(500);
  expect(sessions).toHaveLength(2); // one fallback, never a loop
});

test('sender: a receiver that never states its caps is asked for nothing special (the request goes out after a short wait)', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page, true, 'A1B2C3D4');
  const sdk = await fakeCastSdk(page, { caps: null });
  const { sessions } = await castSessions(page, { report: RT });
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sessions.length, { timeout: 8000 }).toBe(1);
  expect(sessions[0]).toMatchObject({ receiver: true });
  expect(sessions[0]).not.toHaveProperty('caps');
  await expect.poll(() => sdk.loads()).toHaveLength(1);
  expect((await sdk.loads())[0]).toMatchObject({ hlsSegmentFormat: 'ts', hlsVideoSegmentFormat: null });
});

test('receiver page: states what the TV confirms when a sender connects and when asked, and claims nothing without a positive probe', async ({ page, api: _api }) => {
  const caf = await fakeCaf(page, { canDisplay: ['hvc1.1', 'ec-3'] });
  await page.goto('/cast-receiver/');
  await expect.poll(() => caf.calls()).toContain('start');
  const sent = async () => (await caf.calls()).filter((c) => c.startsWith('sent:'));
  await caf.connect('sender-1');
  await expect.poll(sent).toEqual(['sent:{"t":"caps","v":1,"hevc":true,"hevc10":false,"surround":["eac3"]}']);
  expect(await caf.calls()).toContain('to:sender-1');
  // the questions: hvc1 Main and Main 10 at 1920x1080, then Dolby Digital Plus and Dolby Digital
  expect((await caf.calls()).filter((c) => c.startsWith('can:'))).toEqual(['can:video/mp4|hvc1.1.6.L123.B0|1920x1080', 'can:video/mp4|hvc1.2.4.L123.B0|1920x1080', 'can:audio/mp4|ec-3|x', 'can:audio/mp4|ac-3|x']);
  // a sender that joined before this page loaded asks: it is answered (and only it)
  await caf.message({ t: 'caps?' });
  await expect.poll(async () => (await sent()).length).toBe(2);
  expect(await caf.calls()).toContain('to:s1');
  // anything but the exact request is ignored
  await caf.message({ t: 'caps', v: 1, hevc: true });
  await caf.message({ t: 'caps?x' });
  await page.waitForTimeout(200);
  expect(await sent()).toHaveLength(2);
});

test('receiver page: a framework without canDisplayType (or a TV that confirms nothing) claims nothing', async ({ page, api: _api }) => {
  const caf = await fakeCaf(page, { canDisplay: null });
  await page.goto('/cast-receiver/');
  await expect.poll(() => caf.calls()).toContain('start');
  await caf.message({ t: 'caps?' });
  await expect.poll(async () => (await caf.calls()).filter((c) => c.startsWith('sent:'))).toEqual(['sent:{"t":"caps","v":1,"hevc":false,"hevc10":false,"surround":[]}']);
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
  // the reports arrive through a route handler: poll, do not check once
  await expect.poll(() => reports.map((r) => r.event)).toEqual(['start', 'stop', 'start', 'stop']);
});
