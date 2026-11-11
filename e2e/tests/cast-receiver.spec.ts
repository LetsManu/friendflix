// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { DUNMOOR, WRENFIELD, fakeCaf, ui } from '../mocks/castReceiver.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import type { Page } from '@playwright/test';
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
  expect(sessions[1]).toMatchObject({ itemId: MOVIE.id, receiver: true, fellBack: 'both', prevPs: 'a'.repeat(32) });
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
  await caf.message(ui({ sub: { size: 'l', color: 'yellow', background: 'solid', font: 'sans' } }));
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
  await expect(card).toContainText('S1:E2 · Zwei');
  await expect(card.locator('#card-title')).toHaveText(/^Als Nächstes in \d+ s$/);
  await page.keyboard.press('Enter'); // OK on the remote: plays the queued one now
  await expect.poll(() => caf.calls()).toContain('jump:1');
  await expect(card).toBeHidden();

  // the queued episode waits for "still watching?" and plays only after an answer (here: PLAY from the remote / phone)
  await caf.message({ t: 'tok', castId: B, rt: RT });
  await caf.media(B, 1800);
  await caf.message({ t: 'item', castId: B, episode: true, segs: [], next: { castId: 'c'.repeat(32), label: 'S1:E3 · Drei', auto: true, ask: true } });
  await caf.time(1780);
  await expect(card).toContainText('Noch da?');
  await expect(card.locator('#card-hint')).toHaveText('OK schaut weiter');
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

/**
 * The restyled receiver (Task 17): solid panels, up next card, pause and loading screens, the sender pill, keys. 1280x720 like a TV
 * at 720p (`--u` = 1 px); the 1080p run checks that everything scales.
 */
test.describe('receiver screens', () => {
  test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: 'no-preference' });
  const fx = (page: Page, sel: string) => page.locator(sel);

  /** the receiver page with the German `ui` message, Dunmoor S1 E4 playing, E5 queued (the card shows once the credits begin) */
  async function boot(page: Page, o: { next?: (typeof WRENFIELD & { meta?: { title: string; line: string } }) | null; at?: number; ui?: Record<string, unknown>; poster?: string } = {}) {
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui(o.ui));
    await caf.message({ t: 'tok', castId: A, rt: RT });
    await caf.media(A, 2640, o.poster);
    await caf.message({ t: 'item', castId: A, episode: true, segs: [], next: o.next === undefined ? WRENFIELD : o.next, meta: DUNMOOR });
    await caf.time(o.at ?? 754);
    return caf;
  }
  /** the box of a panel once it has finished fading and rising in (its transform is gone) */
  /** the pill is the topmost thing at its centre (nothing, not the loading screen nor the hold backdrop, paints over it) */
  const pillOnTop = async (page: Page) => {
    await expect(page.locator('#who')).toBeVisible();
    const b = await box(page, '#who');
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.id, [b.x + b.width / 2, b.y + b.height / 2])).toBe('who');
  };
  const box = async (page: Page, sel: string) => {
    await expect.poll(() => page.locator(sel).evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    return (await page.locator(sel).boundingBox())!;
  };

  test('up next card: solid, inside the margins, countdown by transform', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    const card = fx(page, '#card');
    await expect(card).toBeVisible();
    await expect(page.locator('#card-title')).toHaveText(/^Als Nächstes in \d+ s$/);
    await expect(page.locator('#card-name')).toHaveText('S1:E5 · Wrenfield Pier');
    const css = await page.evaluate(() => [['card', '#card'], ['pause', '#pause'], ['who', '#who'], ['still', '#still .panel'], ['skip', '#skip'], ['load', '#load']].map(([id, sel]) => {
      const cs = getComputedStyle(document.querySelector(sel!)!);
      return [id, cs.backdropFilter, cs.backgroundColor];
    }));
    for (const [id, bf, bg] of css as string[][]) { expect(bf, id).toBe('none'); expect(bg, id).toMatch(/^rgb\(/); } // solid: no blur, no alpha
    expect(css.find(([id]) => id === 'card')![2]).toBe('rgb(28, 26, 33)');
    const b = await box(page, '#card');
    expect(b.x + b.width).toBeLessThanOrEqual(1280 - 64 + 1);
    expect(b.y + b.height).toBeLessThanOrEqual(720 - 64 + 1);
    expect(Math.round(b.width)).toBe(660);
    const bar = () => page.locator('#card .cbar i').evaluate((el) => getComputedStyle(el).transform);
    const t0 = await bar();
    await page.waitForTimeout(1000);
    expect(await bar()).not.toBe(t0);
    expect(await page.locator('#card .cbar i').evaluate((el) => getComputedStyle(el).width)).not.toBe('0px'); // full width, scaled, never resized
  });

  test('key hint only after a key', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    const hint = page.locator('#card-hint');
    await expect(hint).toHaveText('Abbrechen am Handy');
    await page.keyboard.press('ArrowLeft');
    await expect(hint).toHaveText('OK spielt sofort · Zurück stoppt hier');
    await expect(page.locator('#card-buttons')).toBeHidden(); // no buttons on a remote-driven TV
  });

  test('back stops here: the card closes and tells the phone; without a countdown it is titled "Als Nächstes"', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    await expect(page.locator('#card-title')).toHaveText(/^Als Nächstes in/);
    await page.keyboard.press('Escape');
    await expect.poll(() => caf.calls()).toContain('sent:{"t":"cancel"}');
    await expect(page.locator('#card')).toBeHidden();
    // the card withdraws; with autoplay off it shows without a countdown and its title stays "Als Nächstes" (spec §5)
    const caf2 = await boot(page, { next: { ...WRENFIELD, auto: false } });
    await caf2.time(2620);
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#card-title')).toHaveText('Als Nächstes');
  });

  test('pause screen after 1.5 s, gone on play; ←/→ seek 10 s', async ({ page, api: _api }) => {
    const caf = await boot(page);
    const pause = fx(page, '#pause');
    await expect(pause).toBeHidden();
    const t0 = Date.now();
    await caf.pause();
    await expect(pause).toBeVisible();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    await expect(page.locator('#pause-label')).toHaveText('Pausiert');
    await expect(page.locator('#pause-title')).toHaveText('Dunmoor');
    await expect(page.locator('#pause-line')).toHaveText('Staffel 1 · Folge 4 · The Lantern Road');
    await expect(page.locator('#pause-pos')).toHaveText('12:34');
    await expect(page.locator('#pause-dur')).toHaveText('44:00');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => caf.calls()).toContain('seek:764');
    await expect(page.locator('#pause-pos')).toHaveText('12:44');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => caf.calls()).toContain('seek:754');
    await caf.playing();
    await expect(pause).toBeHidden();
  });

  test('a quick pause and resume never flashes the pause screen', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.pause();
    await page.waitForTimeout(600);
    await caf.playing();
    await page.waitForTimeout(1200);
    await expect(fx(page, '#pause')).toBeHidden();
  });

  test('Play/Pause with the pause screen under an up-next card resumes; it does not jump to the next episode', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    await caf.pause();
    await expect(fx(page, '#pause')).toBeVisible();
    await expect(fx(page, '#card')).toBeVisible();
    await page.keyboard.press('MediaPlayPause');
    await expect.poll(() => caf.calls()).toContain('play');
    expect(await caf.calls()).not.toContain('jump:1');
    await expect(fx(page, '#pause')).toBeHidden();
    await expect(fx(page, '#card')).toBeVisible();
  });

  test('answering "Noch da?" shows no loading screen', async ({ page, api: _api }) => {
    const caf = await boot(page, { next: { ...WRENFIELD, ask: true } });
    await caf.time(2620);
    await caf.media(B, 2640);
    await expect(fx(page, '#still .panel')).toBeVisible();
    await caf.play(); // PLAY from the phone answers it
    await expect(fx(page, '#still .panel')).toBeHidden();
    await page.waitForTimeout(400);
    await expect(fx(page, '#load')).toBeHidden();
  });

  test('a paused re-load shows the pause screen, never "Wird vorbereitet …" for good', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.load();
    await caf.media(B, 2640, undefined, true); // loaded without autoplay (a token renewal while paused)
    await caf.message({ t: 'item', castId: B, episode: true, segs: [], next: null, meta: DUNMOOR });
    await expect(fx(page, '#load')).toBeHidden();
    await expect(fx(page, '#pause')).toBeVisible({ timeout: 2500 });
    await expect(page.locator('#pause-label')).toHaveText('Pausiert');
  });

  test('a LOAD does not show the previous title or poster; a failed LOAD ends the loading screen', async ({ page, api: _api }) => {
    await page.route('**/poster/old.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
    await page.route('**/poster/new.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
    const caf = await boot(page, { poster: '/poster/old.svg' });
    await caf.load('/poster/new.svg');
    await expect(fx(page, '#load')).toBeVisible();
    await expect(page.locator('#load-title')).toBeHidden(); // not "Dunmoor" of the item that played before
    await expect(page.locator('#load-art')).toHaveAttribute('src', /\/poster\/new\.svg$/);
    await caf.error();
    await expect(fx(page, '#load')).toBeHidden();
  });

  test('a queue advance shows the next episode\'s title and line even if the phone sleeps', async ({ page, api: _api }) => {
    const caf = await boot(page, { next: { ...WRENFIELD, meta: { title: 'Dunmoor', line: 'Staffel 1 · Folge 5 · Wrenfield Pier' } } });
    await caf.media(B, 2640); // the receiver moved on by itself: no item message yet
    await expect(fx(page, '#load')).toBeVisible();
    await expect(page.locator('#load-title')).toHaveText('Dunmoor');
    await expect(page.locator('#load-line')).toHaveText('Staffel 1 · Folge 5 · Wrenfield Pier');
  });

  test('Play/Pause right after a pause (before the pause screen) resumes, under the card too', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    await caf.pause();
    await page.keyboard.press('MediaPlayPause');
    await expect.poll(() => caf.calls()).toContain('play');
    expect(await caf.calls()).not.toContain('jump:1');
  });

  test('during an intro Play/Pause is left to the player (OK skips)', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.message({ t: 'item', castId: A, episode: true, segs: [{ type: 'intro', start: 10, end: 80 }], next: null, meta: DUNMOOR });
    await caf.time(20);
    await expect(page.getByRole('button', { name: 'Intro überspringen' })).toBeVisible();
    await page.keyboard.press('MediaPlayPause');
    await page.waitForTimeout(300);
    expect((await caf.calls()).filter((c) => c.startsWith('seek:'))).toEqual([]);
    await page.keyboard.press('Enter');
    await expect.poll(() => caf.calls()).toContain('seek:80');
  });

  test('OK on the pause screen plays', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.pause();
    await expect(fx(page, '#pause')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => caf.calls()).toContain('play');
    await expect(fx(page, '#pause')).toBeHidden();
  });

  test('a 3 s stall mid-playback shows the paused layout with "Lädt …"', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.buffering(true);
    await page.waitForTimeout(1500);
    await expect(fx(page, '#pause')).toBeHidden();
    await expect(fx(page, '#pause')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#pause-label')).toHaveText('Lädt …');
    await caf.buffering(false);
    await expect(fx(page, '#pause')).toBeHidden();
  });

  test('loading screen until the first frame, with the poster', async ({ page, api: _api }) => {
    await page.route('**/poster/dunmoor.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#2d4a5a"/></svg>' }));
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui());
    await caf.load();
    const load = fx(page, '#load');
    await expect(load).toBeVisible();
    await pillOnTop(page);
    await expect(page.locator('#load-label')).toHaveText('Wird vorbereitet …');
    await caf.message({ t: 'tok', castId: A, rt: RT });
    await caf.media(A, 2640, '/poster/dunmoor.svg');
    await caf.message({ t: 'item', castId: A, episode: true, segs: [], next: null, meta: DUNMOOR });
    await expect(page.locator('#load-title')).toHaveText('Dunmoor');
    await expect(page.locator('#load-line')).toHaveText('Staffel 1 · Folge 4 · The Lantern Road');
    await expect(page.locator('#load-art')).toHaveAttribute('src', 'http://127.0.0.1:' + new URL(page.url()).port + '/poster/dunmoor.svg');
    await expect(load).toBeVisible();
    await caf.playing(); // the first frame
    await expect(load).toBeHidden();
  });

  test('a poster from another origin is not loaded; none = a solid placeholder', async ({ page, api: _api }) => {
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui());
    await caf.message({ t: 'tok', castId: A, rt: RT });
    await caf.media(A, 2640, 'https://evil.example/p.png');
    await expect(fx(page, '#load')).toBeVisible();
    await expect(page.locator('#load-art')).toBeHidden();
    await expect(page.locator('#load-art')).not.toHaveAttribute('src', /.+/);
  });

  test('sender pill shows for 5 s after a load, and again with a panel', async ({ page, api: _api }) => {
    test.setTimeout(30_000);
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui());
    await caf.message({ t: 'tok', castId: A, rt: RT });
    await caf.load();
    await caf.media(A, 2640);
    await caf.message({ t: 'item', castId: A, episode: true, segs: [], next: null, meta: DUNMOOR });
    await caf.time(754);
    const who = page.locator('#who');
    await expect(who).toBeVisible();
    await expect(who).toHaveText('Vom Handy von Anna');
    const t0 = Date.now();
    await expect(who).toBeHidden({ timeout: 8000 });
    expect(Date.now() - t0).toBeGreaterThan(3000);
    await caf.pause();
    await expect(page.locator('#pause')).toBeVisible();
    await expect(who).toBeVisible();
  });

  test('closing animates: the card stays and fades out, then hides', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    const card = fx(page, '#card');
    await expect(card).toBeVisible();
    await expect.poll(() => card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1'); // faded in
    await page.evaluate(() => {
      const w = window as unknown as { __runs: string[] };
      w.__runs = [];
      document.getElementById('card')!.addEventListener('transitionrun', (e) => w.__runs.push(`${e.propertyName}:${e.elapsedTime}`));
    });
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __runs: string[] }).__runs.map((r) => r.split(':')[0]))).toContain('opacity');
    expect(await card.evaluate((el) => ({ attached: el.isConnected, on: el.classList.contains('on'), dur: getComputedStyle(el).transitionDuration }))).toEqual(
      { attached: true, on: false, dur: '0.2s, 0s, 0s' });
    await expect(card).toBeHidden();
    await expect(card).toBeAttached();
  });

  test('pause during the up next card: the two never overlap, at 720p and 1080p', async ({ page, api: _api }) => {
    const caf = await boot(page);
    await caf.time(2620);
    await caf.pause();
    await expect(fx(page, '#pause')).toBeVisible();
    await expect(fx(page, '#card')).toBeVisible();
    for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const margin = w * 0.05;
      const p = await box(page, '#pause'), c = await box(page, '#card');
      expect(p.x, `${w}`).toBeGreaterThanOrEqual(margin - 1);
      expect(p.y + p.height, `${w}`).toBeLessThanOrEqual(h - margin + 1);
      expect(c.x + c.width, `${w}`).toBeLessThanOrEqual(w - margin + 1);
      expect(p.x + p.width, `${w}: pause block ends before the card starts`).toBeLessThan(c.x);
    }
  });

  test('a long title and a long episode name stay inside the panels (2 lines, no overflow into the card)', async ({ page, api: _api }) => {
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    await caf.message(ui());
    await caf.message({ t: 'tok', castId: A, rt: RT });
    await caf.media(A, 2640);
    const longTitle = 'The Extraordinarily Long Chronicles of the Dunmoor Lighthouse Keepers and Their Many Wandering Lanterns';
    await caf.message({ t: 'item', castId: A, episode: true, segs: [], next: { castId: 'b'.repeat(32), label: 'E5 · ' + longTitle, auto: true, ask: false }, meta: { title: longTitle, line: DUNMOOR.line + ' · ' + longTitle } });
    await caf.time(2620);
    await caf.pause();
    await expect(fx(page, '#pause')).toBeVisible();
    await expect(fx(page, '#card')).toBeVisible();
    const p = await box(page, '#pause'), c = await box(page, '#card');
    expect(p.x + p.width).toBeLessThan(c.x);
    expect(p.y).toBeGreaterThan(0);
    expect(c.y).toBeGreaterThan(0);
  });

  test('still watching holds as the same solid card, centred; no pause or loading screen on top', async ({ page, api: _api }) => {
    const caf = await boot(page, { next: { ...WRENFIELD, ask: true } });
    await caf.time(2620);
    await expect(page.locator('#card-title')).toHaveText('Noch da?');
    await caf.media(B, 2640); // the queued episode started: it waits paused under the question
    const hold = fx(page, '#still .panel');
    await expect(hold).toBeVisible();
    await pillOnTop(page);
    await caf.pause(); // the TV paused it
    await page.waitForTimeout(1800);
    await expect(fx(page, '#pause')).toBeHidden();
    await expect(fx(page, '#load')).toBeHidden();
    await expect(page.locator('#still-hint')).toHaveText('OK schaut weiter');
    const b = await hold.boundingBox();
    expect(Math.abs(b!.x + b!.width / 2 - 640)).toBeLessThan(2);
    expect(await hold.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(28, 26, 33)');
  });

  test('calm mode: no transitions, no animation, solid panels', async ({ page, api: _api }) => {
    const caf = await boot(page, { ui: { motion: false } });
    await caf.time(2620);
    await expect(fx(page, '#card')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/\bstill\b/);
    const m = await page.evaluate(() => {
      const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      return { card: cs('#card').transitionDuration, bar: cs('#card .cbar i').transitionDuration, ind: cs('#load .ind i').animationName, cardT: cs('#card').transform, bf: cs('#card').backdropFilter };
    });
    expect(m).toEqual({ card: '0s', bar: '0s', ind: 'none', cardT: 'none', bf: 'none' });
    await page.keyboard.press('Escape');
    await expect(fx(page, '#card')).toBeHidden();
  });

  test('the TV\'s own reduced motion stops the motion, too', async ({ page, api: _api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const caf = await boot(page);
    await caf.time(2620);
    await expect(fx(page, '#card')).toBeVisible();
    const m = await page.evaluate(() => ({ card: getComputedStyle(document.getElementById('card')!).transitionDuration, ind: getComputedStyle(document.querySelector('#load .ind i')!).animationName }));
    expect(m).toEqual({ card: '0s', ind: 'none' });
  });

  test('texts from the sender are plain text, never HTML', async ({ page, api: _api }) => {
    const caf = await fakeCaf(page);
    await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
    await page.goto('/cast-receiver/');
    await expect.poll(() => caf.calls()).toContain('start');
    const evil = '<img src=x onerror="document.title=\'pwned\'"><b>x</b>';
    await caf.message(ui({ who: evil }));
    await caf.message({ t: 'tok', castId: A, rt: RT });
    await caf.media(A, 2640);
    await caf.message({ t: 'item', castId: A, episode: true, segs: [], next: { castId: 'b'.repeat(32), label: evil, auto: true, ask: false }, meta: { title: evil, line: evil } });
    await caf.time(2620);
    await caf.pause();
    await expect(page.locator('#pause')).toBeVisible();
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#who')).toHaveText(evil);
    await expect(page.locator('#pause-title')).toHaveText(evil);
    await expect(page.locator('#card-name')).toHaveText(evil);
    expect(await page.locator('#who img, #pause img[src="x"], #card-name img, #pause b, #card-name b').count()).toBe(0);
    expect(await page.title()).toBe('FriendFlix');
  });

  test.describe('screenshots', () => {
    test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
    const DIR = '/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/cast-shots/receiver';
    const POSTER = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2d4a5a"/><stop offset="1" stop-color="#d8895b"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><text x="200" y="330" font-family="Inter,sans-serif" font-size="52" font-weight="700" fill="#fff" text-anchor="middle">Dunmoor</text></svg>';
    for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
      test(`receiver at ${w}x${h}`, async ({ page, api: _api }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width: w, height: h });
        await page.route('**/poster/dunmoor.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: POSTER }));
        const shot = async (name: string, wait = '#card') => {
          if (wait) await box(page, wait);
          await page.waitForTimeout(350);
          await page.screenshot({ path: `${DIR}/${name}-${w}.png` });
        };
        const bright = () => page.evaluate(() => { document.getElementById('v')!.style.background = 'linear-gradient(135deg, #f4efe2, #cfe3ee)'; });
        const caf = await boot(page, { poster: '/poster/dunmoor.svg' });
        await bright();
        await page.waitForTimeout(300);
        await expect(page.locator('#who')).toBeVisible();
        await shot('playing-pill', '#who');
        await caf.pause();
        await expect(page.locator('#pause')).toBeVisible();
        await shot('pause', '#pause');
        await caf.playing();
        await caf.time(2620);
        await expect(page.locator('#card')).toBeVisible();
        await page.keyboard.press('ArrowLeft');
        await expect(page.locator('#card-hint')).toHaveText('OK spielt sofort · Zurück stoppt hier');
        await shot('upnext-keys');
        await caf.pause();
        await expect(page.locator('#pause')).toBeVisible();
        await shot('pause-during-upnext');
        await caf.playing();
        await page.touchscreen.tap(w / 2, h / 3).catch(() => undefined);
        await page.evaluate(() => document.dispatchEvent(new Event('touchstart')));
        await expect(page.locator('#card-buttons')).toBeVisible();
        await shot('upnext-touch');
      });
      test(`receiver loading and calm mode at ${w}x${h}`, async ({ page, api: _api }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width: w, height: h });
        await page.route('**/poster/dunmoor.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: POSTER }));
        const caf = await fakeCaf(page);
        await page.route('**/api/cast/report', (r) => r.fulfill({ json: { ok: true } }));
        await page.goto('/cast-receiver/');
        await expect.poll(() => caf.calls()).toContain('start');
        await caf.message(ui());
        await caf.message({ t: 'tok', castId: A, rt: RT });
        await caf.load();
        await caf.media(A, 2640, '/poster/dunmoor.svg');
        await caf.message({ t: 'item', castId: A, episode: true, segs: [], next: WRENFIELD, meta: DUNMOOR });
        await expect(page.locator('#load')).toBeVisible();
        await box(page, '#load');
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${DIR}/loading-${w}.png` });
        await caf.playing();
        await page.evaluate(() => { document.getElementById('v')!.style.background = 'linear-gradient(135deg, #f4efe2, #cfe3ee)'; });
        await caf.message(ui({ motion: false }));
        await caf.time(2620);
        await expect(page.locator('#card')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${DIR}/calm-upnext-${w}.png` });
      });
    }
  });
});
