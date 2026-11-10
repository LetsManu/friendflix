// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { playOnButton, playOnSheet } from '../mocks/cast.js';
import { chromecastRemote, dunmoor, playOnPlayer, SHEET_SHOTS } from './cast-remote-setup.js';

/** The "Play on" sheet on desktop: a popover out of the player's button; the remote screen's device chip opens the same one. */
dunmoor();

const requests = async (sdk: Awaited<ReturnType<typeof playOnPlayer>>) => (await sdk.calls()).filter((c) => c === 'requestSession').length;

test('Play on opens a popover; the last TV row asks the browser', async ({ page, api: _api }) => {
  const sdk = await playOnPlayer(page);
  await page.locator('.stage').hover();
  const open = playOnButton(page);
  await expect(open).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' })).toHaveCount(0); // no separate AirPlay button any more
  await open.click();
  const dlg = playOnSheet(page);
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute('aria-modal', 'true');
  await expect(dlg).toContainText(/Dunmoor · S1:F4 ab \d+:\d\d/); // what will happen
  const last = dlg.getByRole('button', { name: /^Wohnzimmer-TV/ });
  await expect(last).toContainText('Chromecast · zuletzt verwendet');
  await expect(dlg.getByRole('button', { name: /^Anderer Fernseher …/ })).toBeVisible();
  await expect(dlg.getByRole('button', { name: /^AirPlay …/ })).toContainText('Apple TV und AirPlay-Fernseher');
  await expect(dlg.getByRole('button', { name: /^Dieser Computer/ })).toContainText('Läuft gerade hier');
  // Escape closes it and the focus is back on the button
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(open).toBeFocused();
  // the last TV row: the browser's own device list, once
  await open.click();
  await playOnSheet(page).getByRole('button', { name: /^Wohnzimmer-TV/ }).click();
  await expect.poll(() => requests(sdk)).toBe(1);
  await expect(playOnSheet(page)).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('the dialog traps Tab, arrows move between rows, and a tap outside closes it', async ({ page, api: _api }) => {
  await playOnPlayer(page);
  await page.locator('.stage').hover();
  await playOnButton(page).click();
  const dlg = playOnSheet(page);
  const rows = dlg.locator('.row');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows.first()).toBeFocused();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  const paused = await page.evaluate(() => document.querySelector('video')!.paused);
  await page.mouse.click(40, 200);
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(paused); // the click outside did not toggle playback
});

test('the player has one Play on button: no Chromecast item in More', async ({ page, api: _api }) => {
  await playOnPlayer(page);
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
  await expect(page.getByRole('button', { name: /Chromecast|Auf Wohnzimmer-TV abspielen/ })).toHaveCount(0);
});

test('without a remembered TV or an AirPlay target the sheet offers only another TV and this computer', async ({ page, api: _api }) => {
  await playOnPlayer(page, { remembered: false });
  await page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'not-available' })));
  await page.evaluate(() => new Promise((ok) => setTimeout(ok, 0)));
  // Cast devices are still around in this setup: the button stays; the sheet shows no AirPlay row
  await page.locator('.stage').hover();
  await playOnButton(page).click();
  await expect(playOnSheet(page).getByRole('button', { name: /^AirPlay …/ })).toHaveCount(0);
  await expect(playOnSheet(page).getByRole('button', { name: /^Wohnzimmer-TV/ })).toHaveCount(0); // nothing remembered
  await expect(playOnSheet(page).getByRole('button', { name: /^Anderer Fernseher …/ })).toBeVisible();
});

test('Continue here stops the cast and plays locally', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  let infos = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) infos++; });
  await page.getByRole('button', { name: 'Läuft auf Wohnzimmer-TV, Fernseher wechseln' }).click();
  const dlg = playOnSheet(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: /^Wohnzimmer-TV/ })).toHaveAttribute('aria-current', 'true');
  const here = dlg.getByRole('button', { name: /^Hier weiterschauen/ });
  await expect(here).toContainText('Dieser Computer');
  await here.click();
  await expect(page.getByTestId('cast-active')).toHaveCount(0);
  await expect.poll(() => infos).toBeGreaterThanOrEqual(1);
  expect(sdk.deleted).toHaveLength(1);
  expect(await sdk.calls()).toContain('endCurrentSession');
});

test('the chip of a running cast opens the sheet and Escape returns to the chip', async ({ page, api: _api }) => {
  await chromecastRemote(page);
  const chip = page.getByRole('button', { name: 'Läuft auf Wohnzimmer-TV, Fernseher wechseln' });
  await chip.click();
  await expect(playOnSheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(playOnSheet(page)).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(page.getByTestId('cast-active')).toBeVisible(); // Escape did not leave the remote
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test.use({ deviceScaleFactor: 1, reducedMotion: 'no-preference', viewport: { width: 1440, height: 900 } });
  test('desktop: list, searching and none found, casting', async ({ page, api: _api }) => {
    await playOnPlayer(page);
    await page.locator('.stage').hover();
    await playOnButton(page).click();
    await expect(playOnSheet(page)).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHEET_SHOTS}/desktop-list.png` });
    await page.keyboard.press('Escape');
  });
  test('desktop: only this computer', async ({ page, api: _api }) => {
    await playOnPlayer(page, { remembered: false });
    await page.locator('.stage').hover();
    await playOnButton(page).click();
    // the targets go away while the sheet is open (searching again / none found)
    await page.evaluate(() => document.querySelector('video')!.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'not-available' })));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHEET_SHOTS}/desktop-none.png` });
  });
  test('desktop: casting', async ({ page, api: _api }) => {
    await chromecastRemote(page);
    await page.getByRole('button', { name: 'Läuft auf Wohnzimmer-TV, Fernseher wechseln' }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHEET_SHOTS}/desktop-casting.png` });
  });
});
