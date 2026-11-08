// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { CREDITS_AT, EP, NEXT, openEpisode, seekPlaying } from '../mocks/credits.js';

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
  await seekPlaying(page, CREDITS_AT + 5);
  await expect(page.locator('.cs .chip')).toBeVisible();
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
}

test.describe('TV credits sequence', () => {
  test('OK on the focused Play plays the next episode', async ({ page, api: _api }) => {
    await toCorner(page);
    const play = page.locator('.cs .up .go');
    await expect(play).toBeFocused();
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

  test('a tripped frame guard crossfades', async ({ page, api: _api }) => {
    await toCorner(page, () => page.evaluate(() => document.documentElement.classList.add('tv-motion-reduced')));
    const prop = await page.locator('.stage.cred > video').evaluate((v) => getComputedStyle(v).transitionProperty);
    expect(prop).not.toContain('transform');
  });
});
