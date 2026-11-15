// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';

// The programme's detail sheet (RecordSheet, Phase 3 Task 7) on a 375 px phone: a bottom sheet that fits the width, every button at
// least 44 px high, the conflict slot reserved. A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const bar = (page: Page) => page.getByRole('group', { name: 'Wiedergabesteuerung' });

test.use({ viewport: { width: 375, height: 740 } });

test('sheet fits 375 px, buttons ≥ 44 px', async ({ page, api }) => {
  api.features = { livetv: true };
  await mockLivePlayer(page);
  await page.clock.install({ time: NOW });
  await page.goto('/live/watch/ch-nord?f=all');
  await expect(page.locator('[data-live-state]')).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
  const panel = page.getByRole('dialog', { name: 'Programm' });
  // one step: the bar hides itself after 3 s, so wake it, see it shown and tap at once; a tap that came too late is tried again
  await expect(async () => {
    if (await bar(page).evaluate((e) => e.classList.contains('hide'))) await page.locator('.lstage').tap();
    await expect(bar(page)).not.toHaveClass(/hide/, { timeout: 1000 });
    await bar(page).getByRole('button', { name: 'Programm' }).tap({ timeout: 1500 });
    await expect(panel).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await panel.getByRole('button', { name: 'Aufnehmen' }).first().tap();
  const s = page.getByRole('dialog', { name: 'Die Leuchtturmwärter' });
  await expect(s).toBeVisible();
  await s.getByRole('button', { name: 'Mehr', exact: true }).tap();
  const box = (await s.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const buttons = s.getByRole('button');
  const n = await buttons.count();
  expect(n).toBeGreaterThan(6);
  for (let i = 0; i < n; i++) {
    const b = (await buttons.nth(i).boundingBox())!;
    expect(b.height, await buttons.nth(i).getAttribute('aria-label') ?? await buttons.nth(i).innerText()).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(375.5);
  }
  const sw = (await s.getByRole('switch', { name: 'Nur neue Folgen' }).boundingBox())!;
  expect(sw.height).toBeGreaterThanOrEqual(44);
});
