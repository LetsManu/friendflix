// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, ME, MOVIE } from '../mocks/fixtures.js';
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
async function playerWithInfo(page: Page, audioTracks: Array<Record<string, unknown>> = []) {
  await mockPlayer(page);
  const bodies: Array<Record<string, any>> = [];
  await page.route('**/api/playback/info', (r) => {
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ json: {
      directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000,
      audioTracks, subtitles: [{ index: 7, title: 'Deutsch', language: 'deu', codec: 'subrip', url: '/media/sub.vtt' }],
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

  test('Back on home opens the rail first, the second Back leaves the app through PalmSystem, once', async ({ page, api: _api }) => {
    const lg = await asLgApp(page);
    await playerWithInfo(page); // the TV home warms the playback info of its hero title
    await page.goto('/?ff_app=webos');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const rail = page.locator('nav.rail');
    await expect(rail.locator('a.who')).toBeVisible(); // the profile is loaded: the shell listens
    // the TV home puts the focus on its first control once it has loaded; a Back before that races the focus move, which closes the rail
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
    await press(page, 461);
    await expect(rail).toHaveClass(/open/);
    expect(await lg.backCalls()).toBe(0);
    await press(page, 461);
    await expect.poll(lg.backCalls).toBe(1);
    await expect(rail).not.toHaveClass(/open/);
  });

  test('Back with the rail open on a sub page closes it and does not leave', async ({ page, api: _api }) => {
    const lg = await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watchlist?ff_app=webos');
    const rail = page.locator('nav.rail');
    await expect(rail.locator('a.who')).toBeVisible();
    await press(page, 461);
    await expect(rail).toHaveClass(/open/);
    await press(page, 461);
    await expect(rail).not.toHaveClass(/open/);
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

  // spec 4: an arrow now brings the controls with the focus on the progress bar (not on play/pause); Down goes to the labelled
  // button row. The rest is the old guarantee: once the bar hid (5 s) the focus is dropped and OK plays / pauses.
  test('OK after the control bar hid plays/pauses instead of pressing the last focused button', async ({ page, api: _api }) => {
    test.setTimeout(30_000);
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await expect.poll(() => isPaused(page)).toBe(false);
    await page.keyboard.press('ArrowDown'); // the controls, focus on the progress bar
    await expect(page.locator('.ctl [data-tvtrack]')).toBeFocused();
    await page.keyboard.press('ArrowDown'); // the button row: "Audio und Untertitel" (a film: no episodes / next)
    const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    await expect.poll(focusedLabel).toBe('Audio und Untertitel');
    // moving along the controls keeps them shown; idle, they hide after 5 s on the TV and drop the focus
    await expect(page.locator('.ctl')).not.toHaveClass(/hide/);
    await expect(page.locator('.ctl')).toHaveClass(/hide/, { timeout: 8000 });
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
    const t0 = await time(page);
    await page.keyboard.press('Enter'); // OK: pause, not the tracks overlay
    await expect.poll(() => isPaused(page)).toBe(true);
    expect(await time(page)).toBeGreaterThanOrEqual(t0);
    await expect(page.locator('.tvov')).toHaveCount(0);
  });

  test('seek preview: left/right move a marker without seeking; Back cancels, OK commits', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await expect.poll(() => time(page)).toBeGreaterThan(0.5); // the start seek is over
    await page.evaluate(() => new Promise<void>((res) => { const v = document.querySelector('video')!; v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = 300; }));
    const bar = page.locator('.ctl [data-tvtrack]'), marker = page.getByTestId('seek-preview');
    await page.keyboard.press('ArrowLeft'); // hidden controls: they show, the bar has the focus, nothing seeks
    await expect(page.locator('.ctl')).not.toHaveClass(/hide/);
    await expect(bar).toBeFocused();
    await expect(marker).toHaveCount(0);
    await page.keyboard.press('ArrowLeft'); // the preview: marker + target time, the video keeps its position
    await expect(marker).toBeVisible();
    await expect(marker).toContainText('4:50');
    expect(await time(page)).toBeGreaterThan(299);
    await page.keyboard.press('Backspace'); // Back: the preview ends, the position stays, the controls stay
    await expect(marker).toHaveCount(0);
    await expect(bar).toBeFocused();
    await page.waitForTimeout(1200); // the commit timer would have fired by now
    expect(await time(page)).toBeGreaterThan(299);
    await page.keyboard.press('ArrowLeft');
    await expect(marker).toBeVisible();
    await page.keyboard.press('Enter'); // OK: seek there
    await expect(marker).toHaveCount(0);
    await expect.poll(() => time(page)).toBeLessThan(295);
    expect(await time(page)).toBeGreaterThan(288);
  });

  test('a preview commits by itself after 1 s without a key; held keys step faster', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await expect.poll(() => time(page)).toBeGreaterThan(0.5);
    await page.keyboard.press('ArrowRight'); // controls
    await page.keyboard.press('ArrowRight'); // +10 s marker
    await expect(page.getByTestId('seek-preview')).toBeVisible();
    await expect(page.getByTestId('seek-preview')).toHaveCount(0, { timeout: 3000 }); // committed
    await expect.poll(() => time(page)).toBeGreaterThan(9);
    // holding: repeats keep the preview alive and step 30 s after the first second (10 -> 30 -> 60 s, #229)
    const bar = page.locator('.ctl [data-tvtrack]');
    await expect(bar).toBeFocused();
    const start = Number(await bar.getAttribute('aria-valuenow'));
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 7; i++) { await page.waitForTimeout(200); await page.keyboard.down('ArrowRight'); } // repeat: true
    await page.keyboard.up('ArrowRight');
    const target = Number(await bar.getAttribute('aria-valuenow'));
    expect(target - start).toBeGreaterThanOrEqual(10 * 5 + 30 * 2); // ~1.4 s held: 30 s steps after the first second
  });

  test('button row, tracks overlay and the Back order: overlay -> controls -> hidden -> leave', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/');
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    const back = () => press(page, 461);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.ctl [data-tvtrack]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const tracksBtn = page.locator('.ctl button[aria-label="Audio und Untertitel"]');
    await expect(tracksBtn).toBeFocused();
    await expect(page.locator('.ctl .btns button')).toHaveText(['Audio und Untertitel', 'Tempo', 'Qualität']);
    await page.keyboard.press('Enter');
    const overlay = page.getByRole('dialog', { name: 'Audio und Untertitel' });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('menuitemradio', { name: 'Aus' })).toBeFocused(); // subtitles off is the current choice
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter'); // "Deutsch": on at once, the overlay stays
    await expect.poll(() => subShowing(page)).toBe(true);
    await expect(overlay).toBeVisible();
    await back();
    await expect(overlay).toHaveCount(0);
    await expect(tracksBtn).toBeFocused(); // back on the button that opened it
    await back();
    await expect(page.locator('.ctl')).toHaveClass(/hide/);
    await expect(page).toHaveURL(/\/watch\//);
    await back();
    await expect(page).not.toHaveURL(/\/watch\//);
  });

  test('an episode: Episodes · Next episode in the row; the episodes overlay opens on the playing one and OK plays another', async ({ page, api: _api }) => {
    const EP = episodes[1]!, NEXT = episodes[2]!;
    await asLgApp(page);
    await playerWithInfo(page);
    await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: NEXT } }));
    await page.goto('/watch/' + EP.id + '?ff_app=webos');
    await videoReady(page);
    await expect(page.locator('.ctl .head h2')).toHaveText(EP.seriesName!);
    await expect(page.locator('.ctl .head .tv-meta')).toHaveText('S1 F2 · ' + EP.name);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.ctl .btns button')).toHaveText(['Folgen', 'Nächste Folge', 'Audio und Untertitel', 'Tempo', 'Qualität']);
    await expect(page.locator('.ctl button[aria-label="Folgen"]')).toBeFocused();
    await page.keyboard.press('Enter');
    const overlay = page.getByRole('dialog', { name: 'Folgen' });
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(`[data-ep="${EP.id}"]`)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(overlay.locator(`[data-ep="${NEXT.id}"]`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp('/watch/' + NEXT.id));
  });

  test('Speed opens a small list above its button; a pick applies and returns to the button', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    const speedBtn = page.locator('.ctl button[aria-label="Tempo"]');
    await expect(speedBtn).toBeFocused();
    await page.keyboard.press('Enter');
    const list = page.getByRole('dialog', { name: 'Wiedergabetempo' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('menuitemradio', { checked: true })).toBeFocused();
    expect((await list.boundingBox())!.y + 2).toBeLessThan((await speedBtn.boundingBox())!.y);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(speedBtn).toBeFocused();
    expect(await page.evaluate(() => document.querySelector('video')!.playbackRate)).toBe(1.25);
  });

  test('pause screen after 8 s paused without a key; a key brings the controls back', async ({ page, api: _api }) => {
    await page.clock.install();
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await expect.poll(() => isPaused(page)).toBe(false);
    await press(page, 19); // pause
    await expect.poll(() => isPaused(page)).toBe(true);
    const screen = page.getByTestId('pause-screen');
    await page.clock.fastForward(7000);
    await expect(screen).toHaveCount(0);
    await page.clock.fastForward(1500);
    await expect(screen).toBeVisible();
    await expect(screen).toContainText('Du schaust');
    await expect(screen).toContainText(MOVIE.name);
    await expect(page.locator('.ctl')).toHaveClass(/hide/); // the picture is free, the controls wait
    await page.keyboard.press('ArrowLeft'); // any key: the screen goes, the controls come back (no seek)
    await expect(screen).toHaveCount(0);
    await expect(page.locator('.ctl [data-tvtrack]')).toBeFocused();
    await expect(page.getByTestId('seek-preview')).toHaveCount(0);
    expect(await isPaused(page)).toBe(true);
  });

  test('Magic Remote wheel over the picture seeks 10 s per notch; channel up has no next episode on a movie', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await press(page, 19); // pause: the position stays put
    await expect.poll(() => isPaused(page)).toBe(true);
    const t0 = await time(page);
    const box = (await page.locator('video').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.wheel(0, 100); // one notch down = forward
    await expect.poll(() => time(page)).toBeGreaterThan(t0 + 9);
    const t1 = await time(page);
    await page.waitForTimeout(250); // a new burst
    await page.mouse.wheel(0, -100);
    await expect.poll(() => time(page)).toBeLessThan(t1 - 9);
    await page.keyboard.press('PageUp'); // a movie: nothing follows
    await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
  });

  test('cards on the TV: no small overlay buttons; OK held opens the actions, Back closes them, a short OK opens the title', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page); // the TV home warms the playback info of its hero title
    await page.goto('/?ff_app=webos');
    const thumb = page.locator('.card .thumb').first();
    await expect(thumb).toBeVisible();
    await expect(page.locator('.card .rm, .card .mb').filter({ visible: true })).toHaveCount(0);
    await thumb.focus();
    await page.keyboard.down('Enter'); await page.waitForTimeout(800); await page.keyboard.up('Enter');
    const sheet = page.locator('.sheet.tvsheet');
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(/\/\?ff_app=webos$/); // held: nothing opened
    await page.evaluate(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, key: 'Unidentified', bubbles: true, cancelable: true } as KeyboardEventInit)); }); // Back, at the focused action as on the TV
    await expect(sheet).toHaveCount(0);
    await thumb.focus();
    const href = await thumb.getAttribute('href');
    await page.keyboard.press('Enter'); // short: the title
    await expect.poll(() => { const u = new URL(page.url()); return u.pathname + u.search; }).toBe(href);
  });

  // spec 4: on the TV the green key opens the Audio & subtitles overlay (two lists on a sheet), not the desktop popup
  test('green key opens the audio and subtitle overlay', async ({ page, api: _api }) => {
    await asLgApp(page);
    await playerWithInfo(page);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    await press(page, 404);
    const overlay = page.getByRole('dialog', { name: 'Audio und Untertitel' });
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveClass(/tvov/);
    await expect(page.locator('.menu.tracks')).toHaveCount(0);
    await expect(overlay.getByRole('menuitemradio', { name: 'Aus' })).toBeFocused();
  });

  test('the Surround sound switch shows when the TV claims eac3 (the TV block, not the browser guess)', async ({ page, api: _api }) => {
    await asLgApp(page);
    await page.addInitScript(() => { MediaSource.isTypeSupported = () => true; });
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, features: { requests: true, postplay: false, surround: true } } }));
    const bodies = await playerWithInfo(page, [{ index: 1, title: 'Deutsch 5.1', language: 'ger', isDefault: true }]);
    await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
    await videoReady(page);
    expect(bodies[0]?.caps).toMatchObject({ audioChannels: 6, hls: { surround: ['eac3', 'ac3'] } });
    await press(page, 404);
    await expect(page.getByRole('dialog', { name: 'Audio und Untertitel' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Audio und Untertitel' }).getByTestId('surround-switch')).toHaveAttribute('aria-checked', 'true');
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

test('a normal browser sends its own probed caps (client web), never the LG block, even with ff_app=webos', async ({ page, api: _api }) => {
  await pairedTv(page);
  const bodies = await playerWithInfo(page);
  await page.goto('/watch/' + MOVIE.id + '?ff_app=webos');
  await videoReady(page);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies[0]?.caps?.client).toBe('web');
});

test('a plain desktop browser (no ff_app, no PalmSystem) sends its own probed caps (client web)', async ({ page, api: _api }) => {
  const bodies = await playerWithInfo(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies[0]?.caps?.client).toBe('web');
});
