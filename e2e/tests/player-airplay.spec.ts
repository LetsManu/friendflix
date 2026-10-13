import { MOVIE } from '../mocks/fixtures.js';
import { HLS_INIT, HLS_PLAYLIST, HLS_SEGMENTS } from '../mocks/hls.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/**
 * AirPlay button (Safari API simulated): Chromium has no webkitShowPlaybackTargetPicker, so the spec stubs it on
 * HTMLMediaElement and fires Safari's events by hand. The real picker / receiver can only be checked on Apple hardware.
 * `pickTv`: the stubbed picker "chooses the TV" right away (Safari then reports the wireless target).
 */
async function stubAirPlay(page: Page, o: { pickTv?: boolean } = {}) {
  await page.addInitScript((pickTv) => {
    const w = window as unknown as { __picks: number; __wireless: boolean; __srcAtPick: string };
    w.__picks = 0; w.__wireless = false; w.__srcAtPick = '';
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', { configurable: true, value(this: HTMLMediaElement) {
      w.__picks++; w.__srcAtPick = this.src;
      if (pickTv) { w.__wireless = true; this.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged')); }
    } });
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, get: () => w.__wireless });
  }, Boolean(o.pickTv));
}
/** /api/cast/config enabled (the AirPlay button's gate); the Chromecast SDK Chromium then asks for is answered empty */
async function castOn(page: Page, enabled = true) {
  await page.route('**/api/cast/config', (r) => r.fulfill({ json: { enabled } }));
  await page.route('https://www.gstatic.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
}
/** the player plays a real HLS stream through hls.js (like Safari normally does) */
async function mockHls(page: Page, segTypes: string[] = []) {
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
    resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', roleMaxBitrate: 20_000_000, subtitles: [], audioTracks: [],
    hlsUrl: '/media/hls/4000000/out.m3u8', maxBitrate: 4_000_000, transcodeReason: 'network',
  } }));
  await page.route('**/media/hls/**', (r) => {
    const file = new URL(r.request().url()).pathname.split('/').pop()!;
    const seg = /^s(\d+)\.m4s$/.exec(file);
    if (file === 'out.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: HLS_PLAYLIST });
    if (file === 'init.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_INIT });
    if (seg) segTypes.push(r.request().resourceType());
    if (seg) return r.fulfill({ contentType: 'video/mp4', body: HLS_SEGMENTS[Number(seg[1])]! }).catch(() => undefined);
    return r.fulfill({ status: 404 });
  });
}
const available = (page: Page) => page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' })));
const wireless = (page: Page, on: boolean) => page.evaluate((on) => {
  (window as unknown as { __wireless: boolean }).__wireless = on;
  document.querySelector('video')!.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
}, on);
const src = (page: Page) => page.evaluate(() => document.querySelector('video')!.src);
const hlsPlaying = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
};

test('AirPlay: the button appears once Safari reports a receiver and opens the system picker', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  const btn = page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' });
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBe('allow');
  await expect(btn).toHaveCount(0); // no receiver yet
  await available(page);
  await page.locator('.stage').hover();
  await expect(btn).toBeVisible();
  await btn.click();
  expect(await page.evaluate(() => (window as unknown as { __picks: number }).__picks)).toBe(1);
});

test('AirPlay: no button while the server has casting off (same gate as Chromecast)', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, false);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(page.getByTestId('airplay')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBeNull();
});

test('Safari-like playback keeps hls.js (MSE + bandwidth samples) until the AirPlay button is used', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  const segTypes: string[] = [];
  await mockHls(page, segTypes);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  expect(await src(page)).toMatch(/^blob:/); // hls.js (MSE), not native HLS
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 3);
  // every fragment came through hls.js' loader (fetch/xhr -> FRAG_LOADED feeds the bandwidth estimate), none as a native media load
  expect(segTypes.length).toBeGreaterThan(2);
  expect(segTypes.every((t) => t === 'xhr' || t === 'fetch')).toBe(true);
  // the AirPlay button is there, but nothing switched away from hls.js on its own
  await page.locator('.stage').hover();
  await expect(page.getByTestId('airplay')).toBeVisible();
  expect(await src(page)).toMatch(/^blob:/);
});

test('AirPlay: tap -> native HLS + picker in the click; TV -> cast token stream at the same time; end -> token revoked, hls.js again', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const sessions: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  await page.route('**/api/cast/session', (r) => {
    sessions.push(r.request().postDataJSON());
    return r.fulfill({ json: {
      castId: 'c'.repeat(32), expiresAt: Date.now() + 3 * 3600_000, playSessionId: 'air-ps', mediaSourceId: 'ms', startTime: 0,
      contentUrl: `${new URL(page.url()).origin}/media/p1test.webm#airplay`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
    } });
  });
  await page.route('**/api/cast/session/*', (r) => { deleted.push(r.request().url().split('/').pop()!); return r.fulfill({ json: { ok: true } }); });
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  expect(await src(page)).toMatch(/^blob:/);
  await page.evaluate(() => { document.querySelector('video')!.currentTime = 12; });
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
  // the picker opened while the element already had the native HLS URL (an MSE stream cannot be AirPlayed)
  expect(await page.evaluate(() => (window as unknown as { __srcAtPick: string }).__srcAtPick)).toMatch(/\/media\/hls\/4000000\/out\.m3u8$/);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await expect.poll(() => src(page)).toContain('#airplay');
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.via).toBe('airplay');
  expect(Math.round(Number(sessions[0]!.startTicks) / 10_000_000)).toBe(12); // the phone's position
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBeNull();

  await wireless(page, false);
  await expect(page.getByTestId('airplay-active')).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => src(page)).toMatch(/^blob:/); // hls.js again
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBe('use-credentials');
});

test.describe('AirPlay token failure', () => {
  test.use({ allowedConsole: /status of 429/ });
test('AirPlay: token request fails while the TV is the target -> error with Retry, no fallback to the cookie stream', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  let fail = true;
  await page.route('**/api/cast/session', (r) => fail
    ? r.fulfill({ status: 429, json: { error: 'max_streams', max: 1 } })
    : r.fulfill({ json: {
      castId: 'e'.repeat(32), expiresAt: Date.now() + 3 * 3600_000, playSessionId: 'air-ps', mediaSourceId: 'ms', startTime: 0,
      contentUrl: `${new URL(page.url()).origin}/media/p1test.webm#airplay`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Film', subtitles: [],
    } }));
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
  const box = page.getByTestId('airplay-active');
  await expect(box).toContainText('Übertragung per AirPlay fehlgeschlagen.');
  await expect(box).toContainText('dieses Gerät wählen');
  expect(await src(page)).not.toMatch(/^blob:/); // no hls.js / cookie stream comes back while the TV is the target
  fail = false;
  await box.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(box).toContainText('Läuft über AirPlay');
  await expect.poll(() => src(page)).toContain('#airplay');
});
});

test('Chromium without the AirPlay API: no AirPlay button', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(page.getByTestId('airplay')).toHaveCount(0);
});
