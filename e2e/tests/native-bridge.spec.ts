// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer } from '../mocks/scenes.js';
import { APP_UA, fakeNativeApp, nativeCalls } from '../mocks/native.js';
import type { Page } from '@playwright/test';

/** Task 4: inside the Android app Play and Download go through the native bridge; any "no" from the app leaves the web paths intact. */

const OPTIONS = { allowed: true, qualities: [{ id: 'hd', label: 'HD', height: 1080, estBytes: 2e9 }], audio: [], subtitles: [], quota: { used: 0, max: 5 }, days: 30 };
const LICENSE = {
  id: 'lic-1', itemId: MOVIE.id, status: 'pending', ready: false, prep: { status: 'queued', percent: 0, error: null }, fileUrl: '/api/downloads/lic-1/file', bytes: null,
  quality: 'hd', audioLang: '', subtitles: [], poster: null, backdrop: null, title: MOVIE.name, seriesName: null, seriesId: null, season: null, episode: null, runtimeTicks: null,
  profileId: 'p1', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-02-01T00:00:00Z', validUntil: '2026-01-08T00:00:00Z',
};

async function mockDownloads(page: Page) {
  const posted: unknown[] = [];
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } }));
  await page.route(/\/api\/downloads\/options\//, (r) => r.fulfill({ json: OPTIONS }));
  await page.route('**/api/downloads/check', (r) => r.fulfill({ json: { valid: [], revoked: [] } }));
  await page.route(/\/api\/downloads(\?.*)?$/, async (r) => {
    if (r.request().method() === 'POST') { posted.push(r.request().postDataJSON()); return r.fulfill({ json: { licenses: [LICENSE] } }); }
    return r.fulfill({ json: { downloads: posted.length ? [LICENSE] : [] } });
  });
  return posted;
}

test.describe('in the app', () => {
  test.use({ userAgent: APP_UA });

  test('Play goes to the native player and the page stays', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await fakeNativeApp(page);
    await page.goto('/item/' + MOVIE.id);
    await page.getByRole('link', { name: 'Abspielen' }).first().click();
    await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
    const [call] = await nativeCalls(page, 'play');
    expect(call!.args).toEqual({ itemId: MOVIE.id, profileId: 'p1' });
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp('/item/' + MOVIE.id));
  });

  test('the web player takes over when the app declines', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await fakeNativeApp(page, { playResult: false });
    await page.goto('/item/' + MOVIE.id);
    await page.getByRole('link', { name: 'Abspielen' }).first().click();
    await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
  });

  test('no play capability: the app is not even asked', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await fakeNativeApp(page, { caps: { play: false, download: false } });
    await page.goto('/item/' + MOVIE.id);
    await page.getByRole('link', { name: 'Abspielen' }).first().click();
    await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
    expect(await nativeCalls(page, 'play')).toEqual([]);
  });

  test('Download creates the licence, then hands it to the app; app events update the state', async ({ page, api: _api }) => {
    const posted = await mockDownloads(page);
    await fakeNativeApp(page);
    await page.goto('/item/' + MOVIE.id);
    await openDownloadSheet(page);
    await page.getByRole('dialog', { name: 'Herunterladen' }).getByRole('button', { name: 'Herunterladen' }).click();
    await expect.poll(async () => (await nativeCalls(page, 'download')).length).toBe(1);
    expect(posted).toHaveLength(1);
    const [call] = await nativeCalls(page, 'download');
    expect(call!.args).toEqual({ licenseId: 'lic-1', itemId: MOVIE.id, profileId: 'p1' });
    await expect(page.getByRole('dialog', { name: 'Herunterladen' })).toBeHidden();
    // the licence was handed to the app only: nothing was started in the page
    expect(await storedDownloads(page)).toBe(0);

    const push = (state: string, progress: number) => page.evaluate(([id, st, pr]) => (window as any).__nativePush({ event: 'download', detail: { licenseId: 'lic-1', itemId: id, state: st, progress: pr, bytes: 1000 * (pr as number), expiresAt: Date.now() + 1e9 } }), [MOVIE.id, state, progress]);
    await push('downloading', 0.5);
    await expectDownloadState(page, 'Lädt 50 %');
    await push('done', 1);
    await expectDownloadState(page, 'Heruntergeladen');
  });

  test('declined download falls back to the browser downloader', async ({ page, api: _api }) => {
    const posted = await mockDownloads(page);
    await fakeNativeApp(page, { downloadResult: false });
    await page.goto('/item/' + MOVIE.id);
    await openDownloadSheet(page);
    await page.getByRole('dialog', { name: 'Herunterladen' }).getByRole('button', { name: 'Herunterladen' }).click();
    await expect.poll(async () => (await nativeCalls(page, 'download')).length).toBe(1);
    expect(posted).toHaveLength(1); // one licence, not a second request
    await expect(page.getByRole('dialog', { name: 'Herunterladen' })).toBeHidden();
    await expect.poll(() => storedDownloads(page)).toBe(1); // adopted by the page's own downloader
  });
});

test.describe('outside the app', () => {
  test('a page with the object but a normal browser UA ignores the bridge', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await fakeNativeApp(page);
    await page.goto('/item/' + MOVIE.id);
    await page.getByRole('link', { name: 'Abspielen' }).first().click();
    await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
    expect(await nativeCalls(page)).toEqual([]);
  });
});

/** desktop: "⋯ Mehr" -> Herunterladen; phone: the block button on the detail page */
async function openDownloadSheet(page: Page) {
  const more = page.getByRole('button', { name: 'Mehr', exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: 'Herunterladen', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Herunterladen' })).toBeVisible();
}
/** the download button (also the "⋯ Mehr" entry) carries the state in its name */
const expectDownloadState = (page: Page, text: string) =>
  expect(page.getByRole('button', { name: new RegExp('Download: ' + text) })).not.toHaveCount(0);

/** records in the page's own (OPFS downloader) IndexedDB store */
const storedDownloads = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  const open = indexedDB.open('ff-offline');
  open.onerror = () => resolve(0);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('downloads')) { db.close(); return resolve(0); }
    const c = db.transaction('downloads').objectStore('downloads').count();
    c.onsuccess = () => { db.close(); resolve(c.result); };
    c.onerror = () => { db.close(); resolve(0); };
  };
}));
