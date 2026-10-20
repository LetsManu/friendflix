// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer } from '../mocks/scenes.js';
import { APP_UA, fakeNativeApp, nativeCalls } from '../mocks/native.js';

/** Task 4 on a phone: the same hand-off from the phone layout (touch). */
test.use({ userAgent: APP_UA });

const LICENSE = {
  id: 'lic-1', itemId: MOVIE.id, status: 'pending', ready: false, prep: { status: 'queued', percent: 0, error: null }, fileUrl: '/api/downloads/lic-1/file', bytes: null,
  quality: 'hd', audioLang: '', subtitles: [], poster: null, backdrop: null, title: MOVIE.name, seriesName: null, seriesId: null, season: null, episode: null, runtimeTicks: null,
  profileId: 'p1', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z', validUntil: '2026-01-08T00:00:00Z',
};

test('Play goes to the native player and the page stays', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await fakeNativeApp(page);
  await page.goto('/item/' + MOVIE.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().tap();
  await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
  expect((await nativeCalls(page, 'play'))[0]!.args).toEqual({ itemId: MOVIE.id, profileId: 'p1' });
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp('/item/' + MOVIE.id));
});

test('the web player takes over when the app declines', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await fakeNativeApp(page, { playResult: false });
  await page.goto('/item/' + MOVIE.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().tap();
  await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
});

test('Download hands the licence to the app and shows its state', async ({ page, api: _api }) => {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } }));
  await page.route(/\/api\/downloads\/options\//, (r) => r.fulfill({ json: { allowed: true, qualities: [{ id: 'hd', label: 'HD', height: 1080, estBytes: 2e9 }], audio: [], subtitles: [], quota: { used: 0, max: 5 }, days: 30 } }));
  await page.route(/\/api\/downloads(\?.*)?$/, (r) => (r.request().method() === 'POST' ? r.fulfill({ json: { licenses: [LICENSE] } }) : r.fulfill({ json: { downloads: [] } })));
  await fakeNativeApp(page);
  await page.goto('/item/' + MOVIE.id);
  await page.getByRole('button', { name: 'Herunterladen', exact: true }).first().tap();
  const sheet = page.getByRole('dialog', { name: 'Herunterladen' });
  await sheet.getByRole('button', { name: 'Herunterladen' }).tap();
  await expect.poll(async () => (await nativeCalls(page, 'download')).length).toBe(1);
  expect((await nativeCalls(page, 'download'))[0]!.args).toEqual({ licenseId: 'lic-1', itemId: MOVIE.id, profileId: 'p1' });
  await page.evaluate((id) => (window as any).__nativePush({ event: 'download', detail: { licenseId: 'lic-1', itemId: id, state: 'done', progress: 1, bytes: 2000, expiresAt: Date.now() + 1e9 } }), MOVIE.id);
  await expect(page.getByRole('button', { name: /Download: Heruntergeladen/ })).toBeVisible();
});
