// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { mockServerBusy } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Live TV 1a: the conversion budget is full (spec §5.5). A copyable title plays as a copy ("Server ausgelastet"), the rest gets 503 and an honest, quiet state. */
const BUSY = 'Server gerade ausgelastet. Versuch es gleich noch einmal.';
const playing = (page: Page) => page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
const openQuality = async (page: Page) => {
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('button', { name: 'Einstellungen' }).click();
};

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
      st.refuse = 1; // the switch's request is refused, the reload of the old quality is not
      const before = st.calls;
      await openQuality(page);
      await page.getByRole('button', { name: '1080p' }).click();
      await expect(page.locator('.toast', { hasText: 'Server ausgelastet – Qualität bleibt bei 720p' })).toBeVisible();
      await expect.poll(() => st.calls).toBe(before + 2);
      expect(st.bodies[before + 1]!.maxBitrate).toBe(st.bodies[0]!.maxBitrate); // the old rung, at the position
      expect(st.bodies[before + 1]!.startTicks).toBeGreaterThanOrEqual(0);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Umgewandelt · 720p/ })).toBeVisible();
      await playing(page);
    });

    test('a quality switch into two 503s ends in the busy state and stays quiet', async ({ page, api: _api }) => {
      const st = await mockServerBusy(page, 'ok');
      await page.goto('/watch/' + MOVIE.id);
      await playing(page);
      st.refuse = 2;
      const before = st.calls;
      await openQuality(page);
      await page.getByRole('button', { name: '1080p' }).click();
      const box = page.getByRole('alertdialog');
      await expect(box).toContainText(BUSY);
      await expect.poll(() => st.calls).toBe(before + 2);
      // the dead old stream never starts a silent retry
      await page.waitForTimeout(5000);
      expect(st.calls).toBe(before + 2);
      await expect(box).toContainText(BUSY);
      await expect(page.locator('.spin')).toHaveCount(0);
    });
  });
});
