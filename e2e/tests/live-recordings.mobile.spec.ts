// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { mockRecording } from '../mocks/livetv.js';

// *Meine Aufnahmen* and the *Aufnahmen* row on a phone (Phase 3 Task 8): nothing is wider than the screen, every button is at least
// 44 px, the row scrolls sideways. A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();
test.use({ viewport: { width: 375, height: 740 } });

async function arm(page: Page, api: import('../fixtures.js').MockState) {
  api.features = { livetv: true };
  api.livetv.recordings = [
    mockRecording({ subtitle: 'Nebelhorn', ruleId: 'rule-1', start: at(11, 20), end: at(11, 21), keep: true, positionS: 10 }),
    mockRecording({ subtitle: 'Flaute', ruleId: 'rule-1', start: at(10, 20), end: at(10, 21) }),
    mockRecording({ title: 'Sternstunde Physik mit einem sehr langen Titel, der umbrechen muss', seriesKey: 'x', start: at(9, 22), end: at(9, 23), state: 'partial', gaps: 2 }),
  ];
  await mockLivePlayer(page);
  await page.clock.install({ time: NOW });
}

test('Meine Aufnahmen fits 375 px with 44 px buttons', async ({ page, api }) => {
  await arm(page, api);
  await page.goto('/live/recordings');
  await expect(page.locator('li.ritem')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const buttons = page.locator('main li.ritem button, main .seg button, main .newrec');
  const n = await buttons.count();
  expect(n).toBeGreaterThan(9);
  for (let i = 0; i < n; i++) {
    const b = (await buttons.nth(i).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(375.5);
  }
  await expect(page.locator('li.ritem').nth(2)).toContainText('Unvollständig (2 Lücken)');
});

test('the row scrolls sideways inside the screen', async ({ page, api }) => {
  await arm(page, api);
  await page.goto('/live');
  const row = page.getByRole('region', { name: 'Aufnahmen' });
  await expect(row.getByRole('listitem')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const t = (await row.getByRole('listitem').first().boundingBox())!;
  expect(t.height).toBeGreaterThanOrEqual(44);
});

test('a list of finished recordings has no reserved Jetzt beenden slot: the actions fit one row', async ({ page, api }) => {
  await arm(page, api);
  await page.goto('/live/recordings');
  await expect(page.locator('li.ritem')).toHaveCount(3);
  await expect(page.locator('li.ritem button.stopb')).toHaveCount(0);
  // one row of 44 px buttons (Behalten, Teilen …, Löschen), no empty second line
  for (const h of await page.locator('li.ritem .acts').evaluateAll((l) => l.map((e) => e.getBoundingClientRect().height))) expect(h).toBeLessThan(60);
});

test('a recording that finishes while watched keeps its height', async ({ page, api }) => {
  await arm(page, api);
  api.livetv.recordings = [mockRecording({ title: 'Wetter am Hafen', seriesKey: 'wetter', state: 'recording', growing: true, start: at(12, 20), end: at(12, 21) }), ...api.livetv.recordings];
  await page.goto('/live/recordings');
  const it = page.locator('li.ritem').filter({ hasText: 'Wetter am Hafen' });
  const before = (await it.boundingBox())!;
  await it.getByRole('button', { name: 'Jetzt beenden' }).tap();
  await expect(it.getByText('Fertig', { exact: true })).toBeVisible();
  const after = (await it.boundingBox())!;
  expect(after.height).toBeCloseTo(before.height, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
});
