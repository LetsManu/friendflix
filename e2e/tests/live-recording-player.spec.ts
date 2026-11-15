// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { mockRecording, type MockRecording } from '../mocks/livetv.js';

// A recording plays in the normal player (Phase 3 Task 9, spec §15.7) through the source seam: `POST …/play` gives a `/media/r/`
// token (the fake HLS stream of mocks/hls.ts: a VOD playlist when finished, a growing EVENT playlist while it records), progress
// goes to `…/progress`, the end to `DELETE /api/livetv/watch`. A growing recording is seekable from the start, its end follows the
// live edge, and the "Aufnahme läuft" chip (a reserved slot) jumps back there. A deleted recording (410) shows the gone state.
const video = (page: Page) => page.evaluate(() => { const v = document.querySelector('video'); return { t: v?.currentTime ?? 0, d: v?.duration ?? 0, paused: v?.paused ?? true }; });
let wiggle = 0;
/** a mouse move wakes the player's controls and its top bar */
const wake = async (page: Page) => { wiggle = (wiggle + 1) % 2; await page.mouse.move(400 + wiggle * 30, 300 + wiggle * 10); };

/** Meine Aufnahmen first, then the item's play button: Back from the player lands there again */
async function open(page: Page, api: MockState, r: MockRecording) {
  api.features = { livetv: true };
  api.livetv.recordings = [r];
  await mockLivePlayer(page);
  await page.goto('/live/recordings');
  await page.getByRole('button', { name: `Abspielen: ${r.title}` }).click();
  await expect(page).toHaveURL((u) => u.pathname === `/live/recordings/${r.id}`);
}

test.describe('recording playback', () => {
  test('a finished recording resumes at its saved position', async ({ page, api }) => {
    const r = mockRecording({ positionS: 12, durationS: 30 });
    await open(page, api, r);
    await expect.poll(async () => (await video(page)).t, { timeout: 15_000 }).toBeGreaterThan(12);
    expect((await video(page)).t).toBeLessThan(20);
    expect(api.livetv.recPlays).toEqual([{ id: r.id, via: '' }]);
    await expect(page.getByRole('button', { name: /Umgewandelt|Original/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Die Leuchtturmwärter' })).toHaveCount(1);
    // on a desktop the title stands once (the player's title block), not also in the top bar
    await wake(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Die Leuchtturmwärter' })).toBeVisible();
    await expect(page.locator('.top .ttl')).toBeHidden();
    // no film-only parts: no quality chip, no cast & info, no episodes
    await expect(page.getByRole('button', { name: 'Besetzung & Infos' })).toHaveCount(0);
    // a pause reports the position at once
    await page.evaluate(() => document.querySelector('video')!.pause());
    await expect.poll(() => api.livetv.recProgress.length).toBeGreaterThan(0);
    expect(api.livetv.recProgress.at(-1)!.id).toBe(r.id);
    expect(api.livetv.recProgress.at(-1)!.positionS).toBeGreaterThanOrEqual(12);
    // leaving ends the token
    await wake(page);
    await page.getByRole('button', { name: 'Zurück' }).first().click();
    await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
    await expect.poll(() => api.livetv.stops).toEqual([`rtok-${r.id.slice(-4)}`]);
    expect(api.log.filter((l) => l.includes('/api/playback/'))).toEqual([]);
  });

  test('a growing recording seeks back to the start and returns to the live edge', async ({ page, api }) => {
    const r = mockRecording({ state: 'recording', growing: true, durationS: 12, bytes: 1 });
    await open(page, api, r);
    const chip = page.getByRole('button', { name: 'Aufnahme läuft' });
    await expect(chip).toBeVisible();
    await expect.poll(async () => (await video(page)).t, { timeout: 15_000 }).toBeGreaterThan(1);
    // seekable from the start: the start of the timeline is the start of the recording
    await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 0.2; });
    await expect.poll(async () => (await video(page)).t, { timeout: 5000 }).toBeLessThan(3);
    const slot = (await page.locator('.recslot').boundingBox())!;
    // back to the live edge: the newest part of the growing playlist
    await wake(page);
    await chip.click({ timeout: 5000 });
    await expect.poll(async () => { const v = await video(page); return v.d - v.t; }, { timeout: 10_000 }).toBeLessThan(6);
    expect((await video(page)).t).toBeGreaterThan(5);
    const after = (await page.locator('.recslot').boundingBox())!;
    expect(after.width).toBeCloseTo(slot.width, 0);
  });

  test('a recording never asks for cast & info: no pause card, no I key, no peek (the e2e mock refuses rec: items)', async ({ page, api }) => {
    const r = mockRecording({ positionS: 4, durationS: 30 });
    await open(page, api, r);
    await expect.poll(async () => (await video(page)).t, { timeout: 15_000 }).toBeGreaterThan(4);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await page.waitForTimeout(1_800); // past the 1.2 s pause that loads cast & info for a film
    await expect(page.getByRole('button', { name: 'Besetzung & Infos' })).toHaveCount(0);
    await page.keyboard.press('i');
    await page.waitForTimeout(300);
    expect(api.unmocked.size).toBe(0);
  });

  test('replay after the end: the token stays 30 s; after that a fresh /play', async ({ page, api }) => {
    await page.clock.install();
    const r = mockRecording({ positionS: 24, durationS: 30 });
    await open(page, api, r);
    const ended = () => page.evaluate(() => document.querySelector('video')?.ended ?? false);
    await expect.poll(ended, { timeout: 20_000 }).toBe(true);
    expect(api.livetv.stops).toEqual([]);
    // played again at once: the same token still plays
    await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 1; v.play().catch(() => undefined); });
    await expect.poll(async () => (await video(page)).t, { timeout: 15_000 }).toBeGreaterThan(2);
    expect(api.livetv.recPlays).toHaveLength(1);
    // to the end again, then 30 s: the token ends
    await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 28; v.play().catch(() => undefined); });
    await expect.poll(ended, { timeout: 20_000 }).toBe(true);
    await page.clock.runFor(31_000);
    await expect.poll(() => api.livetv.stops).toHaveLength(1);
    // replay now asks for a fresh token (the old one is revoked: its media answers 410)
    await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 1; v.play().catch(() => undefined); });
    await expect.poll(() => api.livetv.recPlays.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(async () => (await video(page)).t, { timeout: 15_000 }).toBeGreaterThan(2);
    await expect(page.getByText('Aufnahme nicht mehr verfügbar')).toHaveCount(0);
  });

  test.describe('gone', () => {
    test.use({ allowedConsole: /status of 410/ });
    test('410 shows the gone state', async ({ page, api }) => {
      const r = mockRecording({});
      api.livetv.recMediaStatus = 410;
      api.features = { livetv: true };
      api.livetv.recordings = [r];
      await mockLivePlayer(page);
      await page.goto(`/live/recordings/${r.id}`);
      await expect(page.getByText('Aufnahme nicht mehr verfügbar')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
    });
  });
});
