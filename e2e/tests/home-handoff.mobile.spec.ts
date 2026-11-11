// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { dunmoor } from './cast-remote-setup.js';
import { offer } from '../mocks/handoff.js';

/** Device hand-off on the phone: the card sits under the header and the chips and scrolls with the page. */
dunmoor();

const region = (page: Page) => page.getByRole('region', { name: 'Auf einem anderen Gerät angefangen' });
const rowY = async (page: Page) => Math.round((await page.locator('section.row').first().boundingBox())!.y);

test('card under the header, full width, scrolls with the page', async ({ page, api }) => {
  api.handoff.home = offer();
  await page.route('**/api/handoff*', async (r) => { await new Promise((x) => setTimeout(x, 500)); await r.fallback(); });
  await page.goto('/');
  await expect(page.locator('section.row').first()).toBeVisible();
  const y = await rowY(page);
  const r = region(page);
  await expect(r).toBeVisible();
  await page.waitForTimeout(300);
  expect(await rowY(page)).toBe(y);
  const box = (await r.boundingBox())!;
  expect(Math.round(box.x)).toBe(16);
  expect(Math.round(box.width)).toBe(358);
  const nav = (await page.locator('header.nav').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
  await expect(r).toContainText('Dunmoor S1:F4 · The Lantern Road');
  expect(await r.getByRole('img').count()).toBe(0); // no thumbnail on the phone
  await page.evaluate(() => window.scrollBy(0, 200));
  await expect.poll(async () => Math.round((await r.boundingBox())!.y)).toBe(Math.round(box.y) - 200);
});
