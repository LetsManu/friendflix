// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, mockServerBusy } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Live TV 1a: the conversion budget is full (spec §5.5). A copyable title plays as a copy ("Server ausgelastet"), the rest gets 503 and an honest, quiet state. */
const BUSY = 'Server gerade ausgelastet. Versuch es gleich noch einmal.';
const playing = (page: Page) => page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
const openQuality = async (page: Page) => {
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Einstellungen' }).click();
};
/** records every text a toast shows from now on, so a toast that came and went is still caught */
const watchToasts = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __toasts: string[] };
  w.__toasts = [];
  const note = () => document.querySelectorAll('.toast').forEach((t) => { const s = t.textContent?.trim(); if (s && !w.__toasts.includes(s)) w.__toasts.push(s); });
  new MutationObserver(note).observe(document.body, { childList: true, subtree: true, characterData: true });
});
const toasts = (page: Page) => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
/** the desktop detail page's play link (hover prefetches the playback info after 150 ms) */
const playButton = (page: Page) => page.locator('.dv .acts').getByRole('link', { name: 'Abspielen' });

test.describe('player: server busy', () => {
  // the short test stream ends during these tests: the post-play screen would cover the controls (postplay.spec.ts)
  test.beforeEach(({ api }) => { api.features = { requests: true, postplay: false }; });

  test('copy fallback shows the chip reason', async ({ page, api: _api }) => {
    await mockServerBusy(page, 'copy');
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    const chip = page.getByRole('button', { name: /Kopiert · / }); // a copy, not a conversion
    await expect(chip).toBeVisible();
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Server ausgelastet' })).toBeVisible();
  });

  test.describe('503', () => {
    test.use({ allowedConsole: /status of 503/ }); // the browser logs the mocked refusal

    test('503 shows the message and retries only on request', async ({ page, api: _api }) => {
      const st = await mockServerBusy(page, 'busy');
      await page.goto('/watch/' + MOVIE.id);
      const box = page.getByRole('alertdialog');
      await expect(box).toContainText(BUSY);
      const retry = box.getByRole('button', { name: 'Erneut versuchen' });
      const back = box.getByRole('button', { name: 'Zurück' });
      await expect(retry).toBeVisible();
      for (const b of [retry, back]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator('.spin')).toHaveCount(0); // not a spinner, not "Verbindung unterbrochen"
      await expect(page.getByText('Verbindung unterbrochen')).toHaveCount(0);
      const asked = st.calls;
      expect(asked).toBeGreaterThan(0);
      // no automatic backoff: nothing is asked again for 5 s (a negative check: the wait is the point)
      await page.waitForTimeout(5000);
      expect(st.calls).toBe(asked);
      await expect(box).toContainText('Server gerade ausgelastet');
      // on request: asks again; still busy -> the same message; then free -> plays
      await retry.click();
      await expect.poll(() => st.calls).toBe(asked + 1);
      await expect(box).toContainText('Server gerade ausgelastet');
      st.mode = 'copy';
      await box.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await playing(page);
    });

    test('Zurück leaves the busy state', async ({ page, api: _api }) => {
      await mockServerBusy(page, 'busy');
      await page.goto('/watch/' + MOVIE.id);
      await page.getByRole('alertdialog').getByRole('button', { name: 'Zurück' }).click();
      await expect.poll(() => new URL(page.url()).pathname).not.toBe('/watch/' + MOVIE.id);
    });

    test('a quality switch into a 503 keeps playing at the old quality, with a toast', async ({ page, api: _api }) => {
      const st = await mockServerBusy(page, 'ok');
      await page.goto('/watch/' + MOVIE.id);
      await playing(page);
      await expect(page.getByRole('button', { name: /Umgewandelt · 720p/ })).toBeVisible();
      // at about 15 s (paused, so the position holds while the menu opens): both requests must carry it
      await page.evaluate(() => { const v = document.querySelector('video')!; v.pause(); v.currentTime = 15; });
      await page.waitForFunction(() => { const v = document.querySelector('video')!; return !v.seeking && Math.abs(v.currentTime - 15) < 0.5; });
      await watchToasts(page);
      st.refuse = 1; // the switch's request is refused, the reload of the old quality is not
      const before = st.calls;
      await openQuality(page);
      await page.getByRole('button', { name: '1080p' }).click();
      await expect(page.locator('.toast', { hasText: 'Server ausgelastet – Qualität bleibt bei 720p' })).toBeVisible();
      await expect.poll(() => st.calls).toBe(before + 2);
      expect(st.bodies[before]!.maxBitrate).toBeGreaterThan(st.bodies[0]!.maxBitrate!); // the refused pick
      expect(st.bodies[before + 1]!.maxBitrate).toBe(st.bodies[0]!.maxBitrate); // the old rung again
      for (const b of [st.bodies[before]!, st.bodies[before + 1]!]) expect(Math.abs((b.startTicks ?? -1e9) - 15e7)).toBeLessThanOrEqual(2e7); // ±2 s of 15 s
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Umgewandelt · 720p/ })).toBeVisible();
      await playing(page);
      // the refused pick never announced itself ("Qualität fest: 1080p" / "Qualität: 1080p")
      await expect.poll(() => toasts(page)).toContain('Server ausgelastet – Qualität bleibt bei 720p');
      expect((await toasts(page)).filter((t) => /Qualität(?: fest)?: 1080p/.test(t))).toEqual([]);
    });

    test('a quality switch into two 503s ends in the busy state and stays quiet', async ({ page, api: _api }) => {
      const st = await mockServerBusy(page, 'ok');
      await page.goto('/watch/' + MOVIE.id);
      await playing(page);
      await watchToasts(page);
      st.refuse = 2;
      const before = st.calls;
      await openQuality(page);
      await page.getByRole('button', { name: '1080p' }).click();
      const box = page.getByRole('alertdialog');
      await expect(box).toContainText(BUSY);
      await expect.poll(() => st.calls).toBe(before + 2);
      // the busy state alone: no "bleibt bei 720p" toast before it (the old quality never came back)
      expect((await toasts(page)).filter((t) => t.includes('bleibt bei'))).toEqual([]);
      // the dead old stream never starts a silent retry
      await page.waitForTimeout(5000);
      expect(st.calls).toBe(before + 2);
      await expect(box).toContainText(BUSY);
      await expect(page.locator('.spin')).toHaveCount(0);
      expect((await toasts(page)).filter((t) => t.includes('bleibt bei'))).toEqual([]);
    });

    test('a prefetch still on its way when Play is clicked: its 503 is not asked again (one call), busy state', async ({ page, api: _api }) => {
      await mockPlayer(page);
      let calls = 0;
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      await page.route('**/api/playback/info', async (r) => { calls++; await held; return r.fulfill({ status: 503, json: { error: 'server_busy' } }); });
      await page.goto('/item/' + MOVIE.id);
      await playButton(page).hover();
      await expect.poll(() => calls).toBe(1); // the hover prefetch, held back
      await playButton(page).click();
      await expect(page).toHaveURL(new RegExp(`/watch/${MOVIE.id}$`));
      release();
      await expect(page.getByRole('alertdialog')).toContainText(BUSY);
      await page.waitForTimeout(1500); // a negative check: the wait is the point
      expect(calls).toBe(1);
    });

    test('a prefetch that already got its 503: the player asks once more (two calls) and shows the busy state', async ({ page, api: _api }) => {
      await mockPlayer(page);
      let calls = 0;
      await page.route('**/api/playback/info', (r) => { calls++; return r.fulfill({ status: 503, json: { error: 'server_busy' } }); });
      await page.goto('/item/' + MOVIE.id);
      const answered = page.waitForResponse('**/api/playback/info');
      await playButton(page).hover();
      await answered;
      await page.waitForTimeout(300); // the refused prefetch has dropped its entry
      await playButton(page).click();
      await expect(page).toHaveURL(new RegExp(`/watch/${MOVIE.id}$`));
      await expect(page.getByRole('alertdialog')).toContainText(BUSY);
      await expect.poll(() => calls).toBe(2);
      await page.waitForTimeout(1500); // a negative check: no third request
      expect(calls).toBe(2);
    });
  });
});
