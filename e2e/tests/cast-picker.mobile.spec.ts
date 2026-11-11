// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { available, castOn, castSessions, mockHls, picks, playOnButton, playOnSheet, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer } from '../mocks/scenes.js';
import { MOVIE } from '../mocks/fixtures.js';
import { dunmoor, playOnPlayer, SHEET_SHOTS } from './cast-remote-setup.js';
import type { Page } from '@playwright/test';

/** The "Play on" sheet on the phone: a bottom sheet out of the player's top bar. */
dunmoor();

/** the phone player's controls are up (a tap on the picture) */
async function controlsUp(page: Page) {
  if (await page.locator('.ovl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
}

test('AirPlay row runs the token-then-picker flow', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions } = await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  await controlsUp(page);
  const before = await picks(page);
  await playOnButton(page).tap();
  const dlg = playOnSheet(page);
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: /^AirPlay …/ }).tap();
  await expect.poll(() => picks(page)).toBe(before + 1);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ via: 'airplay' });
  await expect(dlg).toHaveCount(0);
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('sheet opens and closes with motion and has a 44 px close button', async ({ page, api: _api }) => {
    await playOnPlayer(page);
    await controlsUp(page);
    const sample = () => page.evaluate(() => { const d = document.querySelector('[role=dialog]'); return d ? getComputedStyle(d).transform : null; });
    await playOnButton(page).tap();
    const dlg = playOnSheet(page);
    const seen: Array<string | null> = [];
    for (let i = 0; i < 14; i++) { seen.push(await sample()); await page.waitForTimeout(30); }
    expect(new Set(seen).size).toBeGreaterThan(2); // it slid: transform changed while opening
    await expect(dlg).toBeVisible();
    await page.waitForTimeout(500);
    const box = (await dlg.getByRole('button', { name: 'Schließen' }).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const sheet = (await dlg.boundingBox())!;
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await dlg.getByRole('button', { name: 'Schließen' }).tap();
    const out: Array<string | null> = [];
    for (let i = 0; i < 6; i++) { out.push(await sample()); await page.waitForTimeout(25); }
    expect(new Set(out.filter(Boolean)).size).toBeGreaterThan(1); // and slid back down
    await expect(dlg).toHaveCount(0);
    await expect(playOnButton(page)).toBeFocused();
  });
});

test('every target of the sheet is 44 px and nothing overflows', async ({ page, api: _api }) => {
  await playOnPlayer(page);
  await controlsUp(page);
  await playOnButton(page).tap();
  const dlg = playOnSheet(page);
  await expect(dlg).toBeVisible();
  await page.waitForTimeout(500);
  const small = await dlg.evaluate((d) => [...d.querySelectorAll<HTMLElement>('button')].map((b) => b.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length);
  expect(small).toBe(0);
  const r = (await dlg.boundingBox())!;
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(dlg.getByRole('button', { name: /^Dieses Handy/ })).toContainText('Läuft gerade hier');
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test.use({ deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  test('phone: list and none found', async ({ page, api: _api }) => {
    await playOnPlayer(page);
    await controlsUp(page);
    await playOnButton(page).tap();
    await expect(playOnSheet(page)).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHEET_SHOTS}/phone-list.png` });
    await page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'not-available' })));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHEET_SHOTS}/phone-searching.png` });
  });
});
