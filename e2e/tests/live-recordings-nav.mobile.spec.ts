// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { mockRecording } from '../mocks/livetv.js';

// Finding the recordings on a phone (DVR follow-ups): *Mein Bereich* (the phone's more page behind the avatar) lists *Aufnahmen*
// under *Meine Sachen*, and /live's heading carries an *Aufnahmen* link in view without scrolling. Only with Live TV.
// A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();

async function arm(page: Page, api: MockState) {
  api.features = { livetv: true };
  api.livetv.recordings = [mockRecording({ start: at(11, 20), end: at(11, 21) })];
  await mockLivePlayer(page);
  await page.clock.install({ time: NOW });
}

test('Mein Bereich lists Aufnahmen and opens Meine Aufnahmen', async ({ page, api }) => {
  await arm(page, api);
  await page.goto('/');
  await page.getByRole('link', { name: 'Mein Bereich' }).click();
  await expect(page).toHaveURL((u) => u.pathname === '/me');
  const link = page.getByRole('main').getByRole('link', { name: 'Aufnahmen', exact: true });
  await expect(link).toBeVisible();
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await link.click();
  await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
  await expect(page.getByRole('heading', { level: 1, name: 'Meine Aufnahmen' })).toBeVisible();
});

test('/live: the Aufnahmen link is in view without scrolling, 44 px, inside the screen', async ({ page, api }) => {
  await arm(page, api);
  await page.goto('/live');
  const link = page.getByRole('main').getByRole('link', { name: 'Aufnahmen', exact: true });
  await expect(link).toBeVisible();
  const b = (await link.boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.x + b.width).toBeLessThanOrEqual(390.5);
  expect(b.y + b.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await link.tap();
  await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
});
