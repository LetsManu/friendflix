// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noHorizontalOverflow } from '../helpers.js';
import { expect, test } from '../fixtures.js';
import { runSettled } from '../mocks/phone.js';
import { airplayRemote, chromecastRemote, rowFits, SHOTS, showControls } from './cast-remote-setup.js';

/** The watch page as the TV's remote on a phone: artwork, one device row, the card; no fullscreen, no volume on AirPlay. */

test.describe('320 px', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('airplay: no horizontal overflow, the device row stays one line, no fullscreen, no volume', async ({ page, api: _api }) => {
    await airplayRemote(page);
    const screen = page.locator('.remote');
    await expect(screen.getByRole('button', { name: 'AirPlay-Gerät wechseln' })).toContainText('AirPlay');
    await expect(screen.getByRole('button', { name: 'Übertragung beenden' })).toBeVisible();
    await rowFits(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await showControls(page);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    const more = page.getByRole('dialog', { name: 'Mehr' });
    await expect(more).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stumm' })).toHaveCount(0);
  });

  test('chromecast: the receiver\'s name in the chip; no fullscreen, the TV volume stays', async ({ page, api: _api }) => {
    await chromecastRemote(page);
    await expect(page.locator('.remote').getByRole('button', { name: 'Gerät wechseln' })).toContainText('Wohnzimmer-TV');
    await rowFits(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await showControls(page);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    const more = page.getByRole('dialog', { name: 'Mehr' });
    await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
    await expect(more.getByRole('button', { name: 'Stumm' })).toBeVisible();
  });
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test('phone: AirPlay, Chromecast, next up', async ({ page, api: _api }) => {
    await airplayRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/mobile-airplay.png` });
  });
  test('phone: Chromecast and next up', async ({ page, api: _api }) => {
    const sdk = await chromecastRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/mobile-chromecast.png` });
    await sdk.nearEnd();
    await expect(page.getByRole('group', { name: 'Nächste Folge' })).toContainText(/in \d+ s/);
    await page.screenshot({ path: `${SHOTS}/mobile-nextup.png` });
  });
});

test('no pause screen while casting', async ({ page, api: _api }) => {
  await page.clock.install();
  await chromecastRemote(page);
  await expect(page.locator('.stage.pui')).toHaveCount(1);
  await showControls(page);
  await page.locator('.pill.lp').getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.pill.lp').getByRole('button', { name: 'Abspielen', exact: true })).toBeVisible();
  await runSettled(page, 8000); // resolves once the Player has rendered what the 8 s changed
  await expect(page.locator('.stage.ppause')).toHaveCount(0);
  await expect(page.locator('.pps')).toHaveCount(0);
  await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
});
