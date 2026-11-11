// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { APP_UA, fakeNativeApp, nativeCalls } from '../mocks/native.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { episodes, ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { offer } from '../mocks/handoff.js';
import { mockPlayer } from '../mocks/scenes.js';
import { dunmoor } from './cast-remote-setup.js';

/** Device hand-off, the title page's hint (spec device hand-off 2.5): desktop page and TV. */
dunmoor(); // Dunmoor, S1 E4 "The Lantern Road" (position 25:00 of 45:00 on this device)

/** the series page: the next episode is E4 */
const seriesPage = async (page: Page) => {
  await page.route('**/api/library/nextup*', (r) => r.fulfill({ json: { items: [episodes[0]] } }));
  await page.goto('/item/' + SERIES.id);
};
const filmPage = async (page: Page, positionTicks = 9_000_000_000) => {
  await page.route(new RegExp(`/api/items/${MOVIE.id}$`), (r) => r.fulfill({ json: { item: { ...MOVIE, positionTicks }, inWatchlist: false, thumb: 0 } }));
  await page.goto('/item/' + MOVIE.id);
};
const filmOffer = () => offer({ id: 'hd-2', itemId: MOVIE.id, type: 'Movie', title: MOVIE.name, year: 2010, seriesName: undefined, season: undefined, episode: undefined, imageId: MOVIE.id });
const play = (page: Page) => page.locator('.dd a.play');
const line = (page: Page) => page.locator('.dd p.resume');

test('series page shows the hand-off line', async ({ page, api }) => {
  await seriesPage(page);
  await expect(play(page)).toBeVisible();
  await expect(line(page)).toHaveText(/Noch/); // without an offer: the normal remaining time
  const before = (await play(page).boundingBox())!;
  const lineBefore = (await line(page).boundingBox())!;
  api.handoff.byItem[SERIES.id] = offer();
  await page.reload();
  await expect(line(page)).toHaveText('S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
  await expect(play(page)).toHaveAttribute('href', /[?&]t=1390$/);
  await expect(play(page)).toHaveAccessibleName('Weiter S1·F4, weiter ab 23:10, zuletzt auf LG-Fernseher');
  const after = (await play(page).boundingBox())!;
  expect(after.width).toBe(before.width);
  expect(after.y).toBe(before.y);
  expect((await line(page).boundingBox())!.y).toBe(lineBefore.y);
});

test('film page shows it without the episode code', async ({ page, api }) => {
  api.handoff.byItem[MOVIE.id] = filmOffer();
  await filmPage(page);
  await expect(line(page)).toHaveText('Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
  await expect(play(page)).toHaveAttribute('href', `/watch/${MOVIE.id}?t=1390`);
  await expect(play(page)).toHaveAccessibleName('Fortsetzen, weiter ab 23:10, zuletzt auf LG-Fernseher');
});

test('nothing for this device\'s own playback', async ({ page, api }) => {
  api.handoff.byItem[MOVIE.id] = null;
  await filmPage(page);
  await expect(line(page)).toContainText('Noch');
  await expect(line(page)).not.toContainText('zuletzt auf');
  await expect(play(page)).toHaveAttribute('href', `/watch/${MOVIE.id}`);
  await expect(play(page)).toHaveAccessibleName(/^Fortsetzen$/);
});

test('an offer for another episode is not shown', async ({ page, api }) => {
  api.handoff.byItem[SERIES.id] = offer({ itemId: episodes[3]!.id });
  await seriesPage(page);
  await expect(line(page)).toContainText('Noch');
  await expect(play(page)).not.toHaveAttribute('href', /t=/);
});

test('no resume line: nothing is added, the link still starts at the position', async ({ page, api }) => {
  api.handoff.byItem[MOVIE.id] = filmOffer();
  await filmPage(page, 0);
  await expect(play(page)).toHaveAttribute('href', `/watch/${MOVIE.id}?t=1390`);
  await expect(play(page)).toHaveAccessibleName('Abspielen, weiter ab 23:10, zuletzt auf LG-Fernseher');
  await expect(page.locator('.dd p.resume')).toHaveCount(0);
});

test.describe('TV', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test('the resume line carries the hint', async ({ page, api }) => {
    api.handoff.byItem[SERIES.id] = offer();
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await mockPlayer(page);
    await seriesPage(page);
    await expect(page.locator('.tv-meta.resume')).toHaveText('S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
    await expect(page.locator('a.tv-btn.play')).toHaveAttribute('href', /[?&]t=1390$/);
    await expect(page.locator('a.tv-btn.play')).toHaveAccessibleName('Fortsetzen, weiter ab 23:10, zuletzt auf LG-Fernseher');
  });
});

// ---- a late answer moves nothing, however long the device name ----
/** the longest line: 1:23:20 in, sent by Safari on an iPhone through AirPlay (spec 2.6) */
const longOffer = () => offer({ positionTicks: 50_000_000_000, device: { kind: 'web', name: 'Safari auf iPhone', via: 'airplay' } });
const LONG = 'Weiter ab 1:23:20 (zuletzt auf AirPlay (Safari auf iPhone))';
/** hold GET /api/handoff back; the returned function lets it through */
async function holdHandoff(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((ok) => { release = ok; });
  await page.route('**/api/handoff*', async (r) => { await gate; await r.fallback(); });
  return release;
}
/** where each element starts and how tall it is (the line itself may grow sideways: nothing else depends on that) */
const boxes = (page: Page, sels: string[]) => Promise.all(sels.map(async (s) => { const b = (await page.locator(s).first().boundingBox())!; return { x: b.x, y: b.y, h: b.height }; }));

for (const vp of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }]) {
  test(`desktop ${vp.width}: the late long hint moves nothing`, async ({ page, api }) => {
    await page.setViewportSize(vp);
    api.handoff.byItem[SERIES.id] = longOffer();
    const release = await holdHandoff(page);
    await seriesPage(page);
    await expect(line(page)).toContainText('Noch');
    await page.waitForTimeout(600);
    const sels = ['.dd h1', '.dd a.play', '.dd p.resume', '.dd .acts', '.dd .syn', '[role=tablist]'];
    const before = await boxes(page, sels);
    release();
    await expect(line(page)).toContainText('Weiter ab 1:23:20');
    await page.waitForTimeout(300);
    expect(await boxes(page, sels)).toEqual(before);
    expect(await line(page).evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
    await expect(play(page)).toHaveAccessibleName(/zuletzt auf AirPlay \(Safari auf iPhone\)$/);
    expect(await line(page).textContent()).toBe(`S1:F4 · ${LONG}`);
  });
}

test('the desktop progress bar names the hint\'s position', async ({ page, api }) => {
  api.handoff.byItem[SERIES.id] = offer(); // 23:10 of 45:00 (this device: 25:00)
  await seriesPage(page);
  await expect(line(page)).toContainText('Weiter ab 23:10');
  const scale = await line(page).locator('.bar span').evaluate((e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).a);
  expect(scale).toBeCloseTo(1390 / 2700, 2);
});

test.describe('TV late answer', () => {
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    test(`TV ${vp.height}p: the late long hint moves nothing`, async ({ page, api }) => {
      await page.setViewportSize(vp);
      api.handoff.byItem[SERIES.id] = longOffer();
      await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
      await page.routeWebSocket(/\/ws\/remote/, () => {});
      await mockPlayer(page);
      const release = await holdHandoff(page);
      await seriesPage(page);
      const res = page.locator('.tv-meta.resume');
      await expect(res).toContainText('Noch');
      await page.waitForTimeout(600);
      const sels = ['.tvd .btns', 'a.tv-btn.play', '.tv-meta.resume', '.tv-body.ov'];
      const before = await boxes(page, sels);
      release();
      await expect(res).toContainText('Weiter ab 1:23:20');
      await page.waitForTimeout(300);
      expect(await boxes(page, sels)).toEqual(before);
    });
  }
});

// ---- cast and native plays start at the hint ----
test('while casting, Play starts the TV at the hint position', async ({ page, api }) => {
  api.handoff.byItem[SERIES.id] = offer();
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions } = await castSessions(page);
  await page.route('**/api/library/nextup*', (r) => r.fulfill({ json: { items: [episodes[0]] } }));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const nav = async (path: string) => { await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path); await expect(page).toHaveURL((u) => u.pathname === path); };
  await nav('/watch/' + episodes[2]!.id);
  await videoReady(page);
  await sdk.start();
  await expect.poll(() => sessions.length).toBe(1);
  await nav('/item/' + SERIES.id);
  await expect(play(page)).toHaveAttribute('href', /t=1390/);
  await play(page).click();
  await expect.poll(() => sessions.length).toBe(2);
  expect(sessions[1]).toMatchObject({ itemId: episodes[0]!.id, startTicks: 13_900_000_000 });
});

test.describe('Android app', () => {
  test.use({ userAgent: APP_UA });
  test('Play hands the native player the hint position', async ({ page, api }) => {
    api.handoff.byItem[SERIES.id] = offer();
    await mockPlayer(page);
    await fakeNativeApp(page, { api: 2, caps: { play: true, download: true, cast: true, castBar: true } });
    await seriesPage(page);
    await expect(play(page)).toHaveAttribute('href', /t=1390/);
    await play(page).click();
    await expect.poll(async () => (await nativeCalls(page, 'play')).length).toBe(1);
    const [call] = await nativeCalls(page, 'play');
    expect(call!.args).toMatchObject({ itemId: episodes[0]!.id, startMs: 1_390_000 });
  });
});
