// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME, episodes } from '../mocks/fixtures.js';
import { APP_UA, fakeNativeApp, nativeCalls, pushCast, type NativeCastSnap } from '../mocks/native.js';
import { dunmoor } from './cast-remote-setup.js';
import { noHorizontalOverflow } from '../helpers.js';
import type { Page } from '@playwright/test';

/** Task 31 on a phone: inside the Android app the web UI shows the cast bar for the app's own Chromecast session while browsing. */
test.use({ userAgent: APP_UA });
dunmoor(); // Dunmoor, S1 E4 "The Lantern Road" / S1 E5 "Wrenfield Pier"

const SNAP: NativeCastSnap = {
  kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: episodes[0]!.id, title: 'Dunmoor', subtitle: 'The Lantern Road', posterId: episodes[0]!.id, isEpisode: true,
  positionMs: 120_000, durationMs: 1_800_000, paused: false, state: 'playing', next: { itemId: episodes[1]!.id, label: 'F5 · Wrenfield Pier' },
};
const { next: _queued, ...LAST } = SNAP; // the last episode: nothing queued
const APP2 = { api: 2, caps: { play: true, download: true, cast: true, castBar: true } };
const bar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
const asked = async (page: Page, method: string) => (await nativeCalls(page, method)).map((c) => c.args);

test('Android shell shows the bar from native cast events', async ({ page, api: _api }) => {
  await fakeNativeApp(page, APP2);
  await page.goto('/');
  await expect(page.locator('nav.tabbar')).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await pushCast(page, SNAP);
  const b = bar(page);
  await expect(b).toBeVisible();
  await expect(b).toContainText('Dunmoor · S1:F4');
  await expect(b).toContainText('Auf Wohnzimmer-TV');
  await page.waitForTimeout(400); // risen in
  const box = (await b.boundingBox())!;
  const tabbar = (await page.locator('nav.tabbar').boundingBox())!;
  expect(Math.abs(tabbar.y - (box.y + box.height) - 8)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--castbar-h').trim())).toBe('76px');
  expect(await noHorizontalOverflow(page)).toBe(true);

  await b.getByRole('button', { name: 'Pause' }).tap();
  await expect.poll(async () => (await asked(page, 'castControl')).length).toBe(1);
  expect((await asked(page, 'castControl'))[0]).toEqual({ action: 'playPause' });
  await expect(b.getByRole('button', { name: 'Abspielen' })).toBeVisible(); // the app's event flipped it

  await b.getByRole('button', { name: 'Übertragung beenden' }).tap();
  await page.getByRole('alertdialog').getByRole('button', { name: /beenden/ }).tap();
  await expect.poll(async () => (await asked(page, 'castControl')).map((a) => a.action)).toEqual(['playPause', 'stop']);
  await expect(b).toHaveCount(0); // the app's null event ended it
});

test('the running cast is pulled once on load (events are not replayed)', async ({ page, api: _api }) => {
  await fakeNativeApp(page, { ...APP2, cast: SNAP });
  await page.goto('/');
  await expect(bar(page)).toContainText('Auf Wohnzimmer-TV');
  expect(await nativeCalls(page, 'castState')).toHaveLength(1);
});

test('a cast that ended before the page loaded shows no bar', async ({ page, api: _api }) => {
  await fakeNativeApp(page, { ...APP2, cast: null });
  await page.goto('/');
  await expect(page.locator('nav.tabbar')).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'castState')).length).toBe(1);
  await expect(bar(page)).toHaveCount(0);
});

test('Next shows with a queued episode and goes to castControl next', async ({ page, api: _api }) => {
  await fakeNativeApp(page, { ...APP2, cast: SNAP });
  await page.goto('/');
  const next = bar(page).getByRole('button', { name: 'Nächste Folge' });
  await expect(next).toBeVisible();
  expect((await next.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await next.tap();
  await expect.poll(async () => (await asked(page, 'castControl')).map((a) => a.action)).toEqual(['next']);
});

test('Next is hidden without a queued episode', async ({ page, api: _api }) => {
  await fakeNativeApp(page, { ...APP2, cast: LAST });
  await page.goto('/');
  await expect(bar(page).getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: 'Nächste Folge' })).toHaveCount(0);
  await pushCast(page, SNAP); // an episode gets queued
  await expect(bar(page).getByRole('button', { name: 'Nächste Folge' })).toBeVisible();
});

test('tapping the bar opens the app player, the page stays', async ({ page, api: _api }) => {
  await fakeNativeApp(page, { ...APP2, cast: SNAP });
  await page.goto('/');
  await bar(page).getByRole('button', { name: /Fernbedienung|öffnen/ }).first().tap();
  await expect.poll(async () => (await asked(page, 'castControl')).map((a) => a.action)).toEqual(['open']);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/$/);
});

test('an app without the cast bar (API 1) keeps working: no cast calls, no bar', async ({ page, api: _api }) => {
  await fakeNativeApp(page, { api: 1, caps: { play: true, download: true, cast: true } });
  await page.goto('/');
  await expect(page.locator('nav.tabbar')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await nativeCalls(page, 'castState')).toHaveLength(0);
  await expect(bar(page)).toHaveCount(0);
});

const multi = { ...ME, profileCount: 3, profileChosen: true };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); };

test('a profile switch inside the shell tells the app the new profile', async ({ page, api }) => {
  await page.route('**/api/me', (r) => r.fulfill({ json: multi }));
  await page.addInitScript(noIntro);
  await fakeNativeApp(page, APP2);
  await page.goto('/profiles');
  await page.getByRole('button', { name: 'Anna' }).tap();
  await expect(page).not.toHaveURL(/\/profiles/);
  expect(api.log.some((l) => l.startsWith('POST /api/profiles/p2/select'))).toBe(true);
  expect(await asked(page, 'sessionChanged')).toEqual([{ profileId: 'p2' }]);
});

test('a profile switch with an API 1 app sends nothing unknown', async ({ page, api }) => {
  await page.route('**/api/me', (r) => r.fulfill({ json: multi }));
  await page.addInitScript(noIntro);
  await fakeNativeApp(page, { api: 1, caps: { play: true, download: true, cast: true } });
  await page.goto('/profiles');
  await page.getByRole('button', { name: 'Anna' }).tap();
  await expect(page).not.toHaveURL(/\/profiles/);
  expect(api.log.some((l) => l.startsWith('POST /api/profiles/p2/select'))).toBe(true);
  expect(await nativeCalls(page, 'sessionChanged')).toHaveLength(0);
});

test('sign-out waits for the app\'s answer before it ends the session', async ({ page, api: _api }) => {
  let loggedOutAt = 0;
  await page.route('**/auth/logout', (r) => { loggedOutAt = Date.now(); return r.fulfill({ status: 204 }); });
  await page.route('**/auth/login**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>login</title>' }));
  await fakeNativeApp(page, { ...APP2, sessionDelayMs: 900 });
  await page.goto('/me');
  await page.getByRole('button', { name: 'Abmelden' }).tap();
  await expect.poll(() => loggedOutAt).toBeGreaterThan(0);
  const [call] = await nativeCalls(page, 'sessionChanged');
  expect(call!.args).toEqual({ profileId: null });
  expect(loggedOutAt - call!.at).toBeGreaterThanOrEqual(850); // the answer came first
});

test('sign-out with an API 1 app does not send sessionChanged', async ({ page, api: _api }) => {
  let out = false;
  await page.route('**/auth/logout', (r) => { out = true; return r.fulfill({ status: 204 }); });
  await page.route('**/auth/login**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>login</title>' }));
  await fakeNativeApp(page, { api: 1, caps: { play: true, download: true, cast: true } });
  await page.goto('/me');
  await page.getByRole('button', { name: 'Abmelden' }).tap();
  await expect.poll(() => out).toBe(true);
  expect(await nativeCalls(page, 'sessionChanged')).toHaveLength(0);
});
