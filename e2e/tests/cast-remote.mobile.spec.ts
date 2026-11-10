// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noHorizontalOverflow } from '../helpers.js';
import { expect, test } from '../fixtures.js';
import { runSettled } from '../mocks/phone.js';
import { airplayRemote, chromecastRemote, dunmoor, rowFits, SHOTS, targetsOk } from './cast-remote-setup.js';

/** The watch page as the TV's remote on a phone: one column, one device row, the controls in reach; no volume on AirPlay. */
dunmoor();

test.describe('320 px', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('airplay: no horizontal overflow, the device row stays one line, the volume hint, no fullscreen', async ({ page, api: _api }) => {
    await airplayRemote(page);
    const screen = page.getByTestId('airplay-active');
    await expect(screen.getByRole('button', { name: 'Läuft über AirPlay, Fernseher wechseln' })).toContainText('AirPlay');
    await expect(screen.getByRole('button', { name: 'Übertragung beenden' })).toBeVisible();
    await rowFits(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await expect(screen.getByText('Lautstärke: Tasten am iPhone oder TV-Fernbedienung')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
    await targetsOk(page);
  });

  test('chromecast: the receiver\'s name in the chip; the TV volume stays; Stop keeps its name as an icon', async ({ page, api: _api }) => {
    await chromecastRemote(page);
    const screen = page.getByTestId('cast-active');
    await expect(screen.getByRole('button', { name: 'Läuft auf Wohnzimmer-TV, Fernseher wechseln' })).toContainText('Wohnzimmer-TV');
    await rowFits(page);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await expect(screen.getByRole('slider', { name: 'Fernseher-Lautstärke' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Übertragung beenden' })).toBeVisible();
    await targetsOk(page);
  });
});

test('phone remote centres Pause and keeps 44 px targets', async ({ page, api: _api }) => {
  await chromecastRemote(page);
  const pause = (await page.getByRole('button', { name: 'Pause', exact: true }).boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(Math.abs(pause.x + pause.width / 2 - vw / 2)).toBeLessThanOrEqual(2);
  expect(pause.width).toBeGreaterThanOrEqual(76);
  await targetsOk(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Dunmoor' })).toBeVisible();
  await expect(page.getByTestId('cast-active')).toContainText('S1:F4 · The Lantern Road');
});

test('AirPlay remote shows the volume hint and no volume slider', async ({ page, api: _api }) => {
  await airplayRemote(page);
  const screen = page.getByTestId('airplay-active');
  await expect(screen.getByText('Lautstärke: Tasten am iPhone oder TV-Fernbedienung')).toBeVisible();
  await expect(screen.getByRole('slider', { name: 'Fernseher-Lautstärke' })).toHaveCount(0);
  const pause = (await screen.getByRole('button', { name: 'Pause', exact: true }).boundingBox())!;
  expect(Math.abs(pause.x + pause.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(2); // the empty slot keeps Pause centred
});

test('nothing moves on the phone when the card fills, or while the chips wait for a switch', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page, { queue: true, tracks: true });
  const card = page.getByRole('region', { name: 'Als Nächstes' });
  await expect(card).toContainText('Startet von selbst');
  const panel = page.getByRole('group', { name: 'Wiedergabesteuerung' });
  const y0 = (await panel.boundingBox())!.y;
  await sdk.nearEnd();
  await expect(card).toContainText(/Startet in \d+ s/);
  expect((await panel.boundingBox())!.y).toBe(y0);
  await page.route('**/api/cast/session', async (r) => { await new Promise((ok) => setTimeout(ok, 60_000)); await r.fallback(); }); // the switch's token never comes
  await page.getByRole('button', { name: 'Nächste Folge', exact: true }).click();
  await expect(page.getByTestId('cast-active')).toContainText('Verbinde mit Wohnzimmer-TV');
  expect((await panel.boundingBox())!.y).toBe(y0);
  await expect(page.getByRole('button', { name: /^Audio:/ })).toHaveAttribute('aria-disabled', 'true');
});

test('Play now never wraps', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  await sdk.nearEnd();
  const card = page.getByRole('region', { name: 'Als Nächstes' });
  const go = card.getByRole('button', { name: 'Jetzt abspielen' });
  await expect(go).toBeVisible();
  expect((await go.boundingBox())!.height).toBeLessThanOrEqual(44);
  await expect(card.locator('.unt')).toHaveCSS('text-overflow', 'ellipsis');
  await expect(card.getByRole('switch', { name: 'Nächste Folge automatisch abspielen' })).toBeVisible();
  await targetsOk(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('the chips share one row; their menus stay inside the screen', async ({ page, api: _api }) => {
  await chromecastRemote(page, { tracks: true });
  const vw = page.viewportSize()!.width;
  const subs = page.getByRole('button', { name: 'Untertitel: Aus' });
  await subs.click();
  const box = (await page.getByRole('menu', { name: 'Untertitel' }).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  await targetsOk(page);
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test.use({ deviceScaleFactor: 1 });
  test('phone: playing, paused, up next', async ({ page, api: _api }) => {
    const sdk = await chromecastRemote(page, { tracks: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/phone-playing.png` });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Abspielen', exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/phone-paused.png` });
    await page.getByRole('button', { name: 'Audio: Deutsch' }).click();
    await expect(page.getByRole('menu', { name: 'Audio' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/phone-menu.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Abspielen', exact: true }).click();
    await sdk.nearEnd();
    await expect(page.getByRole('region', { name: 'Als Nächstes' })).toContainText(/Startet in \d+ s/);
    await page.screenshot({ path: `${SHOTS}/phone-upnext.png` });
  });
  test('phone: connecting', async ({ page, api: _api }) => {
    await chromecastRemote(page);
    await page.route('**/api/cast/session', async (r) => { await new Promise((ok) => setTimeout(ok, 60_000)); await r.fallback(); }); // the switch's token never comes
    await page.getByRole('button', { name: 'Nächste Folge', exact: true }).click();
    await expect(page.getByTestId('cast-active')).toContainText('Verbinde mit Wohnzimmer-TV');
    await page.screenshot({ path: `${SHOTS}/phone-connecting.png` });
  });
  test('phone: AirPlay', async ({ page, api: _api }) => {
    await airplayRemote(page, { tracks: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/phone-airplay.png` });
  });
});

test('no pause screen while casting', async ({ page, api: _api }) => {
  await page.clock.install();
  await chromecastRemote(page);
  await expect(page.locator('.stage.pui')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Abspielen', exact: true })).toBeVisible();
  await runSettled(page, 8000); // resolves once the Player has rendered what the 8 s changed
  await expect(page.locator('.stage.ppause')).toHaveCount(0);
  await expect(page.locator('.pps')).toHaveCount(0);
});
