// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { asLgApp } from '../mocks/webos.js';
import { expect, test } from '../fixtures.js';

/** The LG webOS TV app in a stand-in environment: webOS user agent + PalmSystem stub, a paired TV, the real built web app. */

/** a paired TV: /api/me reports a television session (TV mode) */
async function pairedTv(page: Page) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {}); // the TV's remote-control socket stays silent
}

/** a remote key as the LG TV sends it: only keyCode is meaningful, `key` is 'Unidentified' */
const press = (page: Page, keyCode: number, key = 'Unidentified') =>
  page.evaluate(([keyCode, key]) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { keyCode, key, bubbles: true, cancelable: true } as KeyboardEventInit)); }, [keyCode, key] as const);

/** the playback info mock: records each request body, offers one subtitle */
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
const time = (page: Page) => page.evaluate(() => document.querySelector('video')!.currentTime);
const isPaused = (page: Page) => page.evaluate(() => document.querySelector('video')!.paused);
const subShowing = (page: Page) => page.evaluate(() => [...document.querySelector('video')!.textTracks].some((t) => t.mode === 'showing'));

test.describe('LG app', () => {
  test.beforeEach(async ({ page }) => { await pairedTv(page); });

  test('Back on home leaves the app through PalmSystem, once', async ({ page, api: _api }) => {
    const lg = await asLgApp(page);
    await playerWithInfo(page); // the TV home warms the playback info of its hero title
    await page.goto('/?ff_app=webos');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    await press(page, 461);
    await expect.poll(lg.backCalls).toBe(1);
  });

  test('Back closes the open account dropdown first and does not leave', async ({ page, api: _api }) => {
    const lg = await asLgApp(page);
    await playerWithInfo(page); // the TV home warms the playback info of its hero title
    await page.goto('/?ff_app=webos');
    await page.waitForLoadState('networkidle');
    const avatar = page.locator('button.avatar');
    await avatar.click();
    await expect(avatar).toHaveAttribute('aria-expanded', 'true');
    await press(page, 461);
    await expect(avatar).toHaveAttribute('aria-expanded', 'false');
    expect(await lg.backCalls()).toBe(0);
  });

  test('remote keys control the player (key is Unidentified, keyCode decides)', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await expect.poll(() => isPaused(page)).toBe(false);
    await press(page, 19); // pause
    await expect.poll(() => isPaused(page)).toBe(true);
    await press(page, 415); // play
    await expect.poll(() => isPaused(page)).toBe(false);
    await press(page, 19);
    await expect.poll(() => isPaused(page)).toBe(true);
    const t0 = await time(page);
    await press(page, 417); // +30 s
    await expect.poll(() => time(page)).toBeGreaterThan(t0 + 29);
    const before = await subShowing(page);
    await press(page, 403); // subtitles
    await expect.poll(() => subShowing(page)).toBe(!before);
  });

  test('POST /api/playback/info carries the LG capability block', async ({ page, api: _api }) => {
    await asLgApp(page);
    const bodies = await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    expect(bodies[0]?.caps?.client).toBe('webos');
    expect(bodies[0]?.caps?.video.map((v: { codec: string }) => v.codec)).toContain('hevc');
  });
});

test('a normal browser sends no caps, even with ff_app=webos', async ({ page, api: _api }) => {
  await pairedTv(page);
  const bodies = await playerWithInfo(page);
  await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
  await videoReady(page);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies[0]).not.toHaveProperty('caps');
});
