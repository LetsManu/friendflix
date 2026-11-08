// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, ME, MOVIE } from '../mocks/fixtures.js';
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

test('narrow desktop window: every tool stays inside the stage (series episode, all tools)', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 760, height: 700 });
  await mockPlayer(page);
  await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: episodes[1] } })); // "next episode" button shown
  await page.goto('/watch/' + episodes[0]!.id);
  await videoReady(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.stage.desk')).toBeVisible();
  await expect(page.locator('.stage.desk .pill').getByRole('button', { name: 'Nächste Folge', exact: true })).toBeVisible();
  await expect(page.locator('.stage.desk .pill').getByRole('button', { name: 'Folgen', exact: true })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const stage = (await page.locator('.stage.desk').boundingBox())!;
  const boxes = await page.locator('.stage.desk .pill button.ic').evaluateAll((els) => els
    .filter((e) => (e as HTMLElement).offsetParent !== null)
    .map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, n: e.getAttribute('aria-label') }; }));
  expect(boxes.length).toBeGreaterThanOrEqual(9);
  for (const b of boxes) {
    expect(b.l, `${b.n} left`).toBeGreaterThanOrEqual(stage.x - 0.5);
    expect(b.r, `${b.n} right`).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
    expect(b.t, `${b.n} top`).toBeGreaterThanOrEqual(stage.y - 0.5);
    expect(b.b, `${b.n} bottom`).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
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

/** §3 pause screen: pause with the clock installed, so 5 s can pass without waiting */
async function pauseFor(page: Page) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); document.querySelector('video')!.pause(); });
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
}

test('after 5 s paused the pause screen shows; movement brings the bar back', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(5200);
  await expect(page.locator('.dps')).toBeVisible();
  await expect(page.locator('.dps')).toContainText(MOVIE.name);
  await expect(page.locator('.dps')).toContainText('Du siehst gerade');
  await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/);
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 3);
  await expect(page.locator('.dps')).toHaveCount(0);
  await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
});

test('no pause screen while a panel is open', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
  await expect(page.locator('.menu.tracks')).toBeVisible();
  await page.clock.runFor(8000);
  await expect(page.locator('.dps')).toHaveCount(0);
});

test('no automatic cast & info panel on desktop', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(8000);
  await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toHaveCount(0);
  await expect(page.locator('.dps')).toBeVisible();
  await page.locator('.dps').getByRole('button', { name: 'Besetzung & Infos', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toBeVisible();
  await expect(page.locator('.dps')).toHaveCount(0);
});

test('Space resumes from the pause screen', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(5200);
  await expect(page.locator('.dps')).toBeVisible();
  await page.keyboard.press(' ');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
});
