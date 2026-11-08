// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { EP, NEXT, openEpisode, toChip } from '../mocks/credits.js';

/**
 * TV credits sequence (spec 2026-11-08 §4): the same three beats as on the desktop; Play takes the focus in the corner beat and
 * OK plays the next episode, Back backs out to full screen instead of leaving, a tripped frame guard crossfades the picture.
 */
async function setTv(page: Page) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
}
async function toCorner(page: Page, before?: () => Promise<void>) {
  await setTv(page);
  await openEpisode(page);
  await expect(page.locator('html.tv')).toHaveCount(1);
  if (before) await before();
  await toChip(page); // the page clock is paused from here: `runFor` drives the beats
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
}

test.describe('TV credits sequence', () => {
  test('OK on the focused Play plays the next episode', async ({ page, api: _api }) => {
    await toCorner(page);
    const play = page.locator('.cs .up .go');
    await expect(play).toBeFocused();
    await page.clock.resume();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/watch/${NEXT.id}$`));
  });

  test('Back shows the credits instead of leaving', async ({ page, api: _api }) => {
    await toCorner(page);
    await expect(page.locator('.cs .up .go')).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(page.locator('.stage.cred')).toHaveCount(0);
    await expect(page.locator('.cs')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/watch/${EP.id}$`));
  });

  test.describe('with motion', () => {
    // CI runs with reduced motion, where the picture moves instantly: the guard's crossfade needs motion on
    test.use({ reducedMotion: 'no-preference' });
    test.beforeEach(({ page }) => page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'))); // no brand intro over the player

    test('the picture glides on a spring', async ({ page, api: _api }) => {
      await toCorner(page);
      const video = page.locator('.stage.cred > video');
      expect(await video.evaluate((v) => getComputedStyle(v).transitionProperty)).toContain('transform');
    });

    test('a tripped frame guard crossfades into the corner and back', async ({ page, api: _api }) => {
      await toCorner(page, () => page.evaluate(() => document.documentElement.classList.add('tv-motion-reduced')));
      const video = page.locator('.stage.cred > video');
      expect(await video.evaluate((v) => getComputedStyle(v).transitionProperty)).not.toContain('transform');
      expect(await video.evaluate((v) => getComputedStyle(v).animationName)).toMatch(/ff-cred-fade$/);
      // Back: the picture fades back in at full size (`.credout` lasts 300 ms of the paused page clock)
      await page.keyboard.press('Backspace');
      const out = page.locator('.stage.credout > video');
      await expect(out).toHaveCount(1);
      expect(await out.evaluate((v) => getComputedStyle(v).animationName)).toMatch(/ff-cred-fade-out$/);
      expect(await out.evaluate((v) => getComputedStyle(v).transitionProperty)).not.toContain('transform');
    });
  });
});
