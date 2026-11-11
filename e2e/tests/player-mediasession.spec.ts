// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, hex, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { callMediaSession, mediaSessionLog, stubMediaSession } from '../mocks/mediasession.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, playOnAirPlay, stubAirPlay } from '../mocks/cast.js';
import { expect, test } from '../fixtures.js';

/** the watch page through a client-side link click (the history keeps the page the viewer came from) */
async function enterInApp(page: Page, id: string) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate((p) => { const a = document.createElement('a'); a.href = p; document.body.appendChild(a); a.click(); a.remove(); }, '/watch/' + id);
  await expect(page).toHaveURL((u) => u.pathname === '/watch/' + id);
}

/** The player binds the Media Session while it plays locally (lock screen, Control Center, media keys). */
async function open(page: Page, id: string, inApp = false) {
  await stubMediaSession(page);
  await mockPlayer(page);
  // the episode after the current one, as the watch page asks for it
  await page.route('**/api/items/*/next', (r) => {
    const i = episodes.findIndex((e) => r.request().url().includes(`/items/${e.id}/next`));
    return r.fulfill({ json: { item: i >= 0 ? episodes[i + 1] ?? null : null } });
  });
  if (inApp) await enterInApp(page, id); else await page.goto('/watch/' + id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.2);
}

test('local playback fills the media session', async ({ page, api: _api }) => {
  await open(page, episodes[1]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe('Folge 2');
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toEqual(['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto']);
  const log = await mediaSessionLog(page);
  expect(log.metadata!.artist).toBe('Bright Valley · S1:F2');
  expect(log.metadata!.artwork.map((a) => a.src).join(' ')).not.toContain('/media/c/');
  expect(log.metadata!.artwork).toHaveLength(2);
  expect(log.metadata!.artwork[0]!.src).toContain(episodes[1]!.id);
  expect(log.metadata!.artwork[1]!.src).toContain(episodes[1]!.seriesId!);
  expect(log.playbackState).toBe('playing');
  expect(log.positionState?.duration ?? 0).toBeGreaterThan(500);
});

test('the first episode has no previous-track button, a film has no track buttons', async ({ page, api: _api }) => {
  await open(page, episodes[0]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toEqual(['nexttrack', 'pause', 'play', 'seekbackward', 'seekforward', 'seekto']);
});

test('a film: title, year, one artwork, no track buttons', async ({ page, api: _api }) => {
  await open(page, MOVIE.id);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe(MOVIE.name);
  const log = await mediaSessionLog(page);
  expect(log.metadata!.artist).toBe(String(MOVIE.year));
  expect(log.metadata!.artwork).toHaveLength(1);
  expect(log.handlers).toEqual(['pause', 'play', 'seekbackward', 'seekforward', 'seekto']);
});

test('a lock-screen pause pauses the player', async ({ page, api: _api }) => {
  await open(page, episodes[1]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toContain('pause');
  await callMediaSession(page, 'pause');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
  await callMediaSession(page, 'play');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
  await callMediaSession(page, 'seekto', { seekTime: 120 });
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(119);
});

test('previous track opens the previous episode', async ({ page, api: _api }) => {
  await open(page, episodes[1]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toContain('previoustrack');
  await callMediaSession(page, 'previoustrack');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/watch/' + episodes[0]!.id);
});

test('leaving the player clears it', async ({ page, api: _api }) => {
  await open(page, episodes[1]!.id, true);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata).not.toBeNull();
  await page.getByRole('button', { name: 'Zurück', exact: true }).first().click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/'); // still the same document: the stub keeps what the player left
  await expect.poll(async () => (await mediaSessionLog(page)).metadata).toBeNull();
  expect((await mediaSessionLog(page)).handlers).toEqual([]);
});

test('the previous episode is looked up in the episode\'s own season', async ({ page, api: _api }) => {
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/episodes?')) asked.push(new URL(r.url()).search); });
  await open(page, episodes[1]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toContain('previoustrack');
  expect(asked).toEqual([`?seasonId=${episodes[1]!.seasonId}`]);
});

test('an episode without a season number shows only its episode code on the lock screen', async ({ page, api: _api }) => {
  const e = { ...episodes[1]!, id: hex(220), name: 'Folge 9', parentIndexNumber: undefined, indexNumber: 9 };
  await page.route(`**/api/items/${e.id}`, (r) => r.fulfill({ json: { item: e } }));
  await open(page, e.id);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe('Folge 9');
  expect((await mediaSessionLog(page)).metadata!.artist).toBe('Bright Valley · F9');
});

test('the first episode of season 2 has no previous-track button', async ({ page, api: _api }) => {
  const s2 = [hex(210), hex(211)].map((id, i) => ({ ...episodes[0]!, id, name: `Folge ${7 + i}`, seasonId: hex(201), parentIndexNumber: 2, indexNumber: i + 1, positionTicks: 0 }));
  await page.route('**/api/items/*/episodes?*', (r) => r.fulfill({ json: { items: new URL(r.request().url()).searchParams.get('seasonId') === hex(201) ? s2 : [] } }));
  for (const e of s2) await page.route(`**/api/items/${e.id}`, (r) => r.fulfill({ json: { item: e } }));
  const listed = page.waitForResponse((x) => x.url().includes('/episodes?seasonId=' + hex(201)));
  await open(page, s2[0]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe('Folge 7');
  // the episode list answered: still no previous button
  await listed;
  expect((await mediaSessionLog(page)).handlers).toEqual(['pause', 'play', 'seekbackward', 'seekforward', 'seekto']);
});

test('a lock-screen play while the title moves to the TV does not restart local playback', async ({ page, api: _api }) => {
  await stubMediaSession(page);
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  await castSessions(page);
  let release = () => undefined as void;
  const gate = new Promise<void>((ok) => { release = ok; });
  await page.route('**/api/cast/session', async (r) => { if (r.request().method() === 'POST') await gate; await r.fallback(); });
  await enterInApp(page, MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toContain('play');
  await sdk.start();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true); // the cast request is held
  await callMediaSession(page, 'play');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
  release();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
});

test('the lock screen never goes blank across a Chromecast hand-over', async ({ page, api: _api }) => {
  await stubMediaSession(page);
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  await castSessions(page);
  await enterInApp(page, MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe(MOVIE.name);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await page.waitForTimeout(300);
  const log = await mediaSessionLog(page);
  expect(log.nulls).toBe(0);
  expect(log.metadata).not.toBeNull();
});

test('the lock screen never goes blank across an AirPlay hand-over', async ({ page, api: _api }) => {
  await stubMediaSession(page);
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  await castSessions(page);
  await enterInApp(page, MOVIE.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe(MOVIE.name);
  await available(page);
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await page.waitForTimeout(300);
  const log = await mediaSessionLog(page);
  expect(log.nulls).toBe(0);
  expect(log.metadata).not.toBeNull();
});
