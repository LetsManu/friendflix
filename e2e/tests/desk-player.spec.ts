// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/** Desktop player bar (spec 2026-11-08 §1–2): title block, timeline row with both times, two glass pills, labels, panels. */
async function open(page: Page) {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => { const v = document.querySelector('video')!; return v.play().catch(() => undefined); });
}

test('desktop bar: title block, both pills, times on the timeline row', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await open(page);
  for (const size of [{ width: 1024, height: 700 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.locator('.stage').hover();
    await expect(page.locator('.stage.desk')).toBeVisible();
    await expect(page.locator('.stage.desk .ttlblock')).toContainText(MOVIE.name);
    await expect(page.locator('.stage.desk .pill')).toHaveCount(2);
    await expect(page.locator('.stage.desk .tlrow .el')).toBeVisible();
    await expect(page.locator('.stage.desk .tlrow .rem')).toBeVisible();
    await expect(page.locator('.stage.desk .tlrow .el')).toHaveText(/^(\d+:)?\d+:\d\d$/);
    await expect(page.locator('.stage.desk .tlrow .rem')).toHaveText(/^−(\d+:)?\d+:\d\d$/);
    await expect(page.locator('.ctl .mid')).toHaveCount(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
  }
});

test('a label rises above a tool on hover', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  const more = page.getByRole('button', { name: 'Mehr', exact: true });
  await expect(more).toHaveAttribute('data-label', 'Mehr');
  expect(await more.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('0');
  await more.hover();
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1');
});

test('the bar fades after 3 s idle and returns on movement', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(3500);
  await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/);
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
});

test('a panel opens from its button; Esc closes it and focus returns', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  const opener = page.getByRole('button', { name: 'Audio und Untertitel' });
  await opener.click();
  await expect(page.locator('.menu.tracks')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu.tracks')).toBeHidden();
  await expect(opener).toBeFocused();
});

test('Tab reaches both pills', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  await page.locator('.stage.desk .pill .ic.big').focus();
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Vollbild');
  }
  expect(reached).toBe(true);
  await expect(page.getByRole('button', { name: 'Vollbild', exact: true })).toBeFocused();
});

test('phone and TV keep their bars', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } })); // a paired television (as tv-layout.spec.ts sets it)
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.goto('/watch/' + MOVIE.id);
  await expect(page.locator('html.tv')).toHaveCount(1);
  await expect(page.locator('.stage')).toBeAttached();
  await expect(page.locator('.stage.desk')).toHaveCount(0);
  await expect(page.locator('.stage .pill')).toHaveCount(0);
});
