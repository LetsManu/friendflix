import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/**
 * AirPlay button (Safari API simulated): Chromium has no webkitShowPlaybackTargetPicker, so the spec stubs it on
 * HTMLMediaElement and fires Safari's events by hand. The real picker / receiver can only be checked on Apple hardware.
 */
async function stubAirPlay(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __picks: number; __wireless: boolean };
    w.__picks = 0; w.__wireless = false;
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', { configurable: true, value() { w.__picks++; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, get: () => w.__wireless });
  });
}
const fire = (page: Page, what: 'available' | 'wireless-on' | 'wireless-off') => page.evaluate((what) => {
  const v = document.querySelector('video')!;
  if (what === 'available') v.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' }));
  else {
    (window as unknown as { __wireless: boolean }).__wireless = what === 'wireless-on';
    v.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
  }
}, what);

test('AirPlay: the button appears once Safari reports a receiver and opens the system picker', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  const btn = page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' });
  await expect(btn).toHaveCount(0); // no receiver yet
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBe('allow');
  await fire(page, 'available');
  await page.locator('.stage').hover();
  await expect(btn).toBeVisible();
  await btn.click();
  expect(await page.evaluate(() => (window as unknown as { __picks: number }).__picks)).toBe(1);
});

test('AirPlay: wireless on switches to a cast token stream at the same time; off revokes it and restores the stream', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
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
  await videoReady(page);
  await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 300; });
  await fire(page, 'available');
  await fire(page, 'wireless-on');
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.src)).toContain('#airplay');
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.via).toBe('airplay');
  expect(Math.round(Number(sessions[0]!.startTicks) / 10_000_000)).toBe(300); // the phone's position
  await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('video')!.currentTime))).toBe(300);
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBeNull();

  await fire(page, 'wireless-off');
  await expect(page.getByTestId('airplay-active')).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.src)).not.toContain('#airplay');
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBe('use-credentials');
});

test('Chromium without the AirPlay API: no AirPlay button', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' })));
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(page.getByTestId('airplay')).toHaveCount(0);
});
