// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { HLS_INIT, HLS_PLAYLIST, HLS_SEGMENTS } from '../mocks/hls.js';
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
    await expect(page.locator('button.avatar')).toBeEnabled(); // the profile is loaded: the shell listens
    await press(page, 461);
    await expect.poll(lg.backCalls).toBe(1);
  });

  test('Back closes the open account dropdown first and does not leave', async ({ page, api: _api }) => {
    const lg = await asLgApp(page);
    await playerWithInfo(page); // the TV home warms the playback info of its hero title
    await page.goto('/?ff_app=webos');
    const avatar = page.locator('button.avatar');
    await expect(avatar).toBeEnabled(); // the profile is loaded: the shell listens
    await avatar.click();
    await expect(avatar).toHaveAttribute('aria-expanded', 'true');
    await press(page, 461);
    await expect(avatar).toHaveAttribute('aria-expanded', 'false');
    // the dropdown is closed and nothing left yet; a second Back (now nothing else wants it) leaves exactly once
    expect(await lg.backCalls()).toBe(0);
    await press(page, 461);
    await expect.poll(lg.backCalls).toBe(1);
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

  test('green key opens the audio and subtitle menu', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await press(page, 404);
    await expect(page.getByRole('dialog', { name: 'Audio und Untertitel' })).toBeVisible();
  });

  test('a direct stream without a picture switches to the converted stream and keeps playing', async ({ page, api: _api }) => {
    await asLgApp(page);
    await mockPlayer(page);
    await page.addInitScript(() => { (window as unknown as { __ffFirstFrameMs: number }).__ffFirstFrameMs = 1500; }); // the 10 s deadline, shortened
    const bodies: Array<Record<string, any>> = [];
    await page.route('**/api/playback/info', (r) => {
      bodies.push(r.request().postDataJSON());
      return r.fulfill({ json: {
        directUrl: '/media/never.mp4', hlsUrl: '/media/hls/4000000/out.m3u8', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: `ps${bodies.length}`,
        maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [],
      } });
    });
    await page.route('**/media/never.mp4', () => { /* the original never answers: no picture, no error */ });
    await page.route('**/media/hls/**', (r) => {
      const file = new URL(r.request().url()).pathname.split('/').pop()!;
      const seg = /^s(\d+)\.m4s$/.exec(file);
      if (file === 'out.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: HLS_PLAYLIST });
      if (file === 'init.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_INIT });
      if (seg) return r.fulfill({ contentType: 'video/mp4', body: HLS_SEGMENTS[Number(seg[1])]! }).catch(() => undefined);
      return r.fulfill({ status: 404 });
    });
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await expect.poll(() => page.evaluate(() => document.querySelector('video')?.src ?? '')).toMatch(/never\.mp4$/);
    // the watcher gives up on the original: the converted stream (hls.js, a blob: source) plays without a key press
    await expect.poll(() => page.evaluate(() => document.querySelector('video')?.src ?? ''), { timeout: 10_000 }).toMatch(/^blob:/);
    await expect.poll(() => isPaused(page), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => time(page), { timeout: 10_000 }).toBeGreaterThan(0.5);
    expect(bodies.length).toBe(2);
  });

  test('Stop leaves the player', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/');
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await press(page, 413);
    await expect(page).not.toHaveURL(/\/watch\//);
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

test('LG app, unpaired: Back on the pairing page goes back to the start page', async ({ page, api: _api }) => {
  await asLgApp(page);
  await page.route('**/api/tv/code', (r) => r.fulfill({ json: { code: 'ABCD12', pollToken: 'p', expiresIn: 600 } }));
  await page.route('**/api/tv/claim', (r) => r.fulfill({ json: { status: 'pending' } }));
  await page.goto('data:text/html,<title>start</title><p>start page</p>'); // stands in for the app's local file:// start page
  await page.goto('/tv?ff_app=webos');
  await expect(page.locator('main.pair')).toBeVisible();
  await press(page, 461);
  await expect(page).toHaveURL(/^data:text\/html/);
});

test('a plain browser on the unpaired pairing page ignores the LG Back key', async ({ page, api: _api }) => {
  await page.route('**/api/tv/code', (r) => r.fulfill({ json: { code: 'ABCD12', pollToken: 'p', expiresIn: 600 } }));
  await page.route('**/api/tv/claim', (r) => r.fulfill({ json: { status: 'pending' } }));
  await page.goto('data:text/html,<title>start</title><p>start page</p>');
  await page.goto('/tv?ff_app=webos');
  await expect(page.locator('main.pair')).toBeVisible();
  await press(page, 461);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/tv\?ff_app=webos$/);
});

test('a normal browser sends no caps, even with ff_app=webos', async ({ page, api: _api }) => {
  await pairedTv(page);
  const bodies = await playerWithInfo(page);
  await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
  await videoReady(page);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies[0]).not.toHaveProperty('caps');
});

test('a plain desktop browser (no ff_app, no PalmSystem) sends no caps', async ({ page, api: _api }) => {
  const bodies = await playerWithInfo(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies[0]).not.toHaveProperty('caps');
});
