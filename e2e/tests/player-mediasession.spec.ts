// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { callMediaSession, mediaSessionLog, stubMediaSession } from '../mocks/mediasession.js';
import { expect, test } from '../fixtures.js';

/** The player binds the Media Session while it plays locally (lock screen, Control Center, media keys). */
async function open(page: Page, id: string) {
  await stubMediaSession(page);
  await mockPlayer(page);
  // the episode after the current one, as the watch page asks for it
  await page.route('**/api/items/*/next', (r) => {
    const i = episodes.findIndex((e) => r.request().url().includes(`/items/${e.id}/next`));
    return r.fulfill({ json: { item: i >= 0 ? episodes[i + 1] ?? null : null } });
  });
  await page.goto('/watch/' + id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.2);
}

test('local playback fills the media session', async ({ page, api: _api }) => {
  await open(page, episodes[1]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata?.title).toBe('Folge 2');
  await expect.poll(async () => (await mediaSessionLog(page)).handlers).toEqual(['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto']);
  const log = await mediaSessionLog(page);
  expect(log.metadata!.artist).toBe('Bright Valley · S1:E2');
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
  await open(page, episodes[1]!.id);
  await expect.poll(async () => (await mediaSessionLog(page)).metadata).not.toBeNull();
  await page.getByRole('button', { name: 'Zurück', exact: true }).first().click();
  await expect.poll(async () => (await mediaSessionLog(page)).metadata).toBeNull();
  expect((await mediaSessionLog(page)).handlers).toEqual([]);
});
