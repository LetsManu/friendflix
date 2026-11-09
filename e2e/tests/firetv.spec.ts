// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { asFireTvApp, fireKey, stubFireTvPort } from '../mocks/firetv.js';
import { expect, test } from '../fixtures.js';

/** The Fire TV app in a stand-in environment: its user agent marker + a recording `window.FriendFlixTv`, the real built web app. */

/** a paired TV: /api/me reports a television session (TV mode) */
async function pairedTv(page: Page) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {}); // the TV's remote-control socket stays silent
}

/** the playback info mock: records each request body */
async function playerWithInfo(page: Page) {
  await mockPlayer(page);
  const bodies: Array<Record<string, any>> = [];
  await page.route('**/api/playback/info', (r) => {
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ json: {
      directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000,
      audioTracks: [], subtitles: [{ index: 7, title: 'Deutsch', language: 'deu', codec: 'subrip', url: '/media/sub.vtt' }],
    } });
  });
  await page.route('**/media/sub.vtt', (r) => r.fulfill({ status: 200, contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nHallo\n' }));
  return bodies;
}
const isPaused = (page: Page) => page.evaluate(() => document.querySelector('video')!.paused);
const viewport = (page: Page) => page.locator('meta[name=viewport]').getAttribute('content');

test('Fire TV app, unpaired: the pairing code shows, Back asks the app for its server screen', async ({ page, api: _api }) => {
  const ftv = await asFireTvApp(page);
  await page.route('**/api/tv/code', (r) => r.fulfill({ json: { code: 'ABCD12', pollToken: 'p', expiresIn: 600 } }));
  await page.route('**/api/tv/claim', (r) => r.fulfill({ json: { status: 'pending' } }));
  await page.goto('/tv?ff_app=firetv');
  await expect(page.locator('main.pair .code')).toHaveText('ABCD12');
  await expect(page.locator('nav.rail')).toHaveCount(0); // not paired: no TV shell yet (the pairing page styles itself as html.tv)
  await fireKey(page, 'GoBack');
  await expect.poll(ftv.messages).toEqual(['changeServer']);
  await expect(page).toHaveURL(/\/tv\?ff_app=firetv$/);
});

test.describe('Fire TV app, paired', () => {
  test.beforeEach(async ({ page }) => { await pairedTv(page); });

  test('opens in TV mode with the side rail and a 1920 px wide layout', async ({ page, api: _api }) => {
    await asFireTvApp(page);
    await playerWithInfo(page); // the TV home warms the playback info of its hero title
    await page.goto('/?ff_app=firetv');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(page.locator('nav.rail')).toHaveCount(1);
    await expect.poll(() => viewport(page)).toBe('width=1920');
  });

  test('Back on home opens the rail first, the second Back posts exit once', async ({ page, api: _api }) => {
    const ftv = await asFireTvApp(page);
    await playerWithInfo(page);
    await page.goto('/?ff_app=firetv');
    const rail = page.locator('nav.rail');
    await expect(rail.locator('a.who')).toBeVisible(); // the profile is loaded: the shell listens
    // the TV home puts the focus on its first control once it has loaded; a Back before that races the focus move, which closes the rail
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
    await fireKey(page, 'GoBack');
    await expect(rail).toHaveClass(/open/);
    expect(await ftv.messages()).toEqual([]);
    await fireKey(page, 'GoBack');
    await expect.poll(ftv.messages).toEqual(['exit']);
    await page.waitForTimeout(300);
    expect(await ftv.messages()).toEqual(['exit']);
  });

  test('Account: Change server posts changeServer', async ({ page, api: _api }) => {
    const ftv = await asFireTvApp(page);
    await page.goto('/me?ff_app=firetv');
    const btn = page.locator('button.srv');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(ftv.messages).toEqual(['changeServer']);
  });

  test('the player sends the Fire TV caps and keeps the screen awake only while playing', async ({ page, api: _api }) => {
    const ftv = await asFireTvApp(page);
    const bodies = await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=firetv');
    await videoReady(page);
    expect(bodies[0]?.caps?.client).toBe('firetv');
    expect(bodies[0]?.caps?.video.length).toBeGreaterThan(0);
    expect(bodies[0]?.caps?.video.every((v: { maxHeight?: number }) => v.maxHeight === 1080)).toBe(true);
    await expect.poll(() => isPaused(page)).toBe(false);
    await expect.poll(ftv.messages).toContain('keepAwake:1');
    await fireKey(page, 'MediaPlayPause');
    await expect.poll(() => isPaused(page)).toBe(true);
    await expect.poll(async () => (await ftv.messages()).at(-1)).toBe('keepAwake:0');
  });

  test('Home hides the page: the player pauses (the WebView alone may keep the sound)', async ({ page, api: _api }) => {
    const ftv = await asFireTvApp(page);
    await playerWithInfo(page);
    const progress: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/playback/progress')) progress.push(r.url()); });
    await page.goto('/watch/' + MOVIE.id + '?ff_app=firetv');
    await videoReady(page);
    await expect.poll(() => isPaused(page)).toBe(false);
    await page.waitForTimeout(300); // reports of the start (seek, first progress) are over
    progress.length = 0;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => isPaused(page)).toBe(true);
    await expect.poll(async () => (await ftv.messages()).at(-1)).toBe('keepAwake:0');
    await page.waitForTimeout(300);
    expect(progress).toHaveLength(1); // the visibility report only, not a second one for the pause it caused
  });

  test.describe('error screen', () => {
    test.use({ allowedConsole: /status of 403 \(Forbidden\)/ }); // the mocked playback info refusal
    test('an error screen lets the screen sleep', async ({ page, api: _api }) => {
      const ftv = await asFireTvApp(page);
      await mockPlayer(page);
      await page.route('**/api/playback/info', (r) => r.fulfill({ status: 403, json: { error: 'forbidden' } }));
      await page.goto('/watch/' + MOVIE.id + '?ff_app=firetv');
      await expect(page.locator('.errbox')).toBeVisible();
      await expect.poll(ftv.messages).toContain('keepAwake:0');
      expect(await ftv.messages()).not.toContain('keepAwake:1');
    });
  });
});

test('a plain browser keeps playing when the page is hidden (only the Fire TV app pauses)', async ({ page, api: _api }) => {
  await pairedTv(page);
  await playerWithInfo(page);
  await page.goto('/watch/' + MOVIE.id + '?ff_app=firetv');
  await videoReady(page);
  await expect.poll(() => isPaused(page)).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  expect(await isPaused(page)).toBe(false);
});

test('a plain browser with ff_app=firetv and a FriendFlixTv object stays a browser', async ({ page, api: _api }) => {
  await pairedTv(page);
  const port = await stubFireTvPort(page);
  await playerWithInfo(page);
  await page.goto('/?ff_app=firetv');
  await expect(page.locator('nav.rail a.who')).toBeVisible();
  await fireKey(page, 'GoBack');
  await fireKey(page, 'GoBack');
  await page.waitForTimeout(300);
  expect(await port.messages()).toEqual([]);
  expect(await viewport(page)).toBe('width=device-width, initial-scale=1, viewport-fit=cover');
});
