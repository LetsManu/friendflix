// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { ME, MOVIE, episodes } from '../mocks/fixtures.js';
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

  test('a declined play does not navigate when the viewer already left the page', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await fakeNativeApp(page, { playResult: false, playDelayMs: 700 });
    await page.goto('/item/' + MOVIE.id);
    await page.getByRole('link', { name: 'Abspielen' }).first().click();
    await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
    await page.evaluate(() => history.pushState({}, '', '/somewhere-else'));
    await page.waitForTimeout(1200);
    await expect(page).toHaveURL(/\/somewhere-else$/);
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

  test('the settings page opens the app\'s own settings', async ({ page, api: _api }) => {
    await fakeNativeApp(page);
    await page.goto('/settings');
    const open = page.getByRole('button', { name: 'App-Einstellungen öffnen' });
    await expect(page.getByRole('heading', { name: 'App auf diesem Gerät' })).toBeVisible();
    await open.click();
    await expect.poll(async () => (await nativeCalls(page, 'openSettings')).length).toBe(1);
    expect((await nativeCalls(page, 'openSettings'))[0]!.args).toEqual({});
  });

  test('a kids profile does not get the app settings', async ({ page, api: _api }) => {
    const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await fakeNativeApp(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'App-Einstellungen öffnen' })).toHaveCount(0);
  });
});

test.describe('downloads page in the app', () => {
  test.use({ userAgent: APP_UA });
  const app = (over: Record<string, unknown>) => ({ itemId: MOVIE.id, progress: 1, bytes: 2e9, expiresAt: Date.now() + 5 * 864e5, profileId: 'p1', ...over });

  test('lists the app\'s downloads (not the browser\'s), plays through the app and removes an expired one', async ({ page, api: _api }) => {
    await mockDownloads(page);
    await mockPlayer(page);
    await fakeNativeApp(page, { downloads: [
      app({ licenseId: 'lic-1', state: 'done', title: MOVIE.name }),
      app({ licenseId: 'lic-old', itemId: episodes[1]!.id, state: 'expired', title: 'Alter Download', expiresAt: Date.now() - 864e5 }),
      app({ licenseId: 'lic-other', state: 'done', title: 'Anderes Profil', profileId: 'p2' }),
    ] });
    await page.goto('/downloads');
    const row = (name: string) => page.locator('li.item').filter({ hasText: name });
    await expect(row(MOVIE.name)).toContainText('Heruntergeladen');
    await expect(row('Alter Download')).toContainText('Abgelaufen');
    await expect(row('Anderes Profil')).toHaveCount(0); // another profile's download
    await expect(page.getByText('Gerätespeicher', { exact: false })).toHaveCount(0); // the browser's storage is not the app's

    await row(MOVIE.name).getByRole('link', { name: 'Abspielen' }).click();
    await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
    expect((await nativeCalls(page, 'play'))[0]!.args).toEqual({ itemId: MOVIE.id, profileId: 'p1' });
    await expect(page).toHaveURL(/\/downloads$/);

    await row('Alter Download').getByRole('button', { name: /Löschen: Alter Download/ }).click();
    await expect.poll(async () => (await nativeCalls(page, 'deleteDownload')).map((c) => c.args)).toEqual([{ licenseId: 'lic-old' }]);
    await expect(row('Alter Download')).toHaveCount(0);
    await expect(row(MOVIE.name)).toHaveCount(1);
  });
});

test.describe('watch links inside the page', () => {
  async function favouriteEpisode(page: Page) {
    await page.route(/\/api\/library\/items\?filter=favorites/, (r) => r.fulfill({ json: { items: [episodes[1]], total: 1 } }));
  }

  test.describe('in the app', () => {
    test.use({ userAgent: APP_UA });
    test('an episode card goes to the native player and the page stays', async ({ page, api: _api }) => {
      await favouriteEpisode(page);
      await mockPlayer(page);
      await fakeNativeApp(page);
      await page.goto('/favorites');
      await page.locator(`a.thumb[href="/watch/${episodes[1]!.id}"]`).click();
      await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
      expect((await nativeCalls(page, 'play'))[0]!.args).toEqual({ itemId: episodes[1]!.id, profileId: 'p1' });
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(/\/favorites$/);
    });
    test('declined: the web player opens, asked only once', async ({ page, api: _api }) => {
      await favouriteEpisode(page);
      await mockPlayer(page);
      await fakeNativeApp(page, { playResult: false });
      await page.goto('/favorites');
      await page.locator(`a.thumb[href="/watch/${episodes[1]!.id}"]`).click();
      await expect(page).toHaveURL(new RegExp('/watch/' + episodes[1]!.id));
      expect(await nativeCalls(page, 'play')).toHaveLength(1);
    });
  });

  test('in a browser the episode card opens the web player as before', async ({ page, api: _api }) => {
    await favouriteEpisode(page);
    await mockPlayer(page);
    await fakeNativeApp(page); // the object without the app's user agent is ignored
    await page.goto('/favorites');
    await page.locator(`a.thumb[href="/watch/${episodes[1]!.id}"]`).click();
    await expect(page).toHaveURL(new RegExp('/watch/' + episodes[1]!.id));
    expect(await nativeCalls(page)).toEqual([]);
  });
});

test.describe('outside the app', () => {
  test('the settings page has no app section in a browser', async ({ page, api: _api }) => {
    await fakeNativeApp(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'App-Einstellungen öffnen' })).toHaveCount(0);
  });

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
