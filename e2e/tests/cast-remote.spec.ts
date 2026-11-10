// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { noHorizontalOverflow } from '../helpers.js';
import { expect, test } from '../fixtures.js';
import { airplayRemote, chromecastRemote, dunmoor, rowFits, SHOTS, targetsOk } from './cast-remote-setup.js';

/** The watch page as the TV's remote on desktop (Dunmoor S1 E4 on Wohnzimmer-TV). */
dunmoor();

const slider = (page: import('@playwright/test').Page) => page.getByRole('slider', { name: 'Position auf dem Fernseher' });
const seekCalls = async (sdk: Awaited<ReturnType<typeof chromecastRemote>>) => (await sdk.calls()).filter((c) => c.startsWith('seek:')).map((c) => Number(c.slice(5)));

test('remote screen shows title panel, scrubber and transport', async ({ page, api: _api }) => {
  await chromecastRemote(page);
  const screen = page.getByTestId('cast-active');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dunmoor'); // the page's one h1
  await expect(screen).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await expect(screen).toContainText('Staffel 1 · Folge 4 · The Lantern Road');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', / von /);
  for (const name of ['10 Sekunden zurück', 'Pause', '10 Sekunden vor', 'Nächste Folge']) await expect(screen.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(screen.getByRole('group', { name: 'Wiedergabesteuerung' })).toBeVisible();
  await rowFits(page);
  await targetsOk(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('Close remote goes back; the Player\'s own controls are gone', async ({ page, api: _api }) => {
  await chromecastRemote(page);
  await expect(page.getByRole('toolbar')).toHaveCount(0); // the player's own control bar
  await page.getByRole('button', { name: 'Fernbedienung schließen' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('Pause drives the TV and shows Play', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Abspielen', exact: true })).toBeVisible();
  expect(await sdk.calls()).toContain('playOrPause');
});

test('keyboard on the scrubber seeks the TV', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  const s = slider(page);
  await expect.poll(async () => Number(await s.getAttribute('aria-valuemax'))).toBeGreaterThan(100);
  const before = Number(await s.getAttribute('aria-valuenow'));
  await s.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await seekCalls(sdk)).length).toBe(1); // once: the player's own seek keys stay out of it
  const to = (await seekCalls(sdk))[0]!;
  expect(to).toBeGreaterThanOrEqual(before + 9);
  expect(to).toBeLessThanOrEqual(before + 16);
});

test('volume drives the TV', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  const vol = page.getByRole('slider', { name: 'Fernseher-Lautstärke' });
  await vol.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await sdk.calls()).some((c) => c.startsWith('volume:'))).toBe(true);
  expect((await seekCalls(sdk)).length).toBe(0); // the arrow only changed the volume
  await page.getByRole('button', { name: 'Fernseher stumm' }).click();
  expect(await sdk.calls()).toContain('muteOrUnmute');
  await expect(page.getByRole('button', { name: 'Ton am Fernseher an' })).toBeVisible();
});

test.describe('failures', () => {
  test.use({ allowedConsole: /status of 429/ });
  test('connection lost shows Reconnect', async ({ page, api: _api }) => {
    let fail = false;
    await chromecastRemote(page, { fail: () => fail });
    fail = true;
    await page.getByRole('button', { name: 'Nächste Folge', exact: true }).click(); // the switch's token request fails
    const screen = page.getByTestId('cast-active');
    await expect(screen.getByRole('status').filter({ hasText: 'Verbindung verloren' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Neu verbinden' })).toBeVisible();
  });
});

test('could not play shows Play here', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  await sdk.failLoads();
  await page.getByRole('button', { name: 'Nächste Folge', exact: true }).click();
  const screen = page.getByTestId('cast-active');
  await expect(screen.getByRole('status').filter({ hasText: 'Konnte auf dem Fernseher nicht abspielen' })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Hier abspielen' })).toBeVisible();
});

test('Stop asks first', async ({ page, api: _api }) => {
  const sdk = await chromecastRemote(page);
  await page.getByRole('button', { name: 'Übertragung beenden' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('Wiedergabe auf Wohnzimmer-TV beenden?');
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  expect(await sdk.calls()).not.toContain('endCurrentSession');
  await page.getByRole('button', { name: 'Übertragung beenden' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Wiedergabe auf Wohnzimmer-TV beenden', exact: true }).click();
  await expect.poll(async () => (await sdk.calls()).includes('endCurrentSession')).toBe(true);
});

test.describe('1024 px', () => {
  test.use({ viewport: { width: 1024, height: 800 } });
  test('stacked layout at 1024 px has no overlap and no horizontal scroll', async ({ page, api: _api }) => {
    const sdk = await chromecastRemote(page);
    await sdk.nearEnd();
    const up = page.getByRole('region', { name: 'Als Nächstes' });
    await expect(up).toContainText('Wrenfield Pier');
    expect(await noHorizontalOverflow(page)).toBe(true);
    const now = (await page.getByRole('region', { name: 'Dunmoor' }).boundingBox())!;
    const next = (await up.boundingBox())!;
    expect(next.y).toBeGreaterThanOrEqual(now.y + now.height);
    const panel = (await page.getByRole('group', { name: 'Wiedergabesteuerung' }).boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(next.y + next.height);
    await targetsOk(page);
  });
});

test('airplay: "AirPlay" in the chip, no volume slider', async ({ page, api: _api }) => {
  await airplayRemote(page);
  const screen = page.getByTestId('airplay-active');
  await expect(screen.getByRole('button', { name: 'Läuft über AirPlay, Fernseher wechseln' })).toContainText('AirPlay');
  await expect(screen).toContainText('Läuft über AirPlay');
  await expect(screen.getByText('Lautstärke: Tasten am iPhone oder TV-Fernbedienung')).toBeVisible();
  await expect(screen.getByRole('slider', { name: 'Fernseher-Lautstärke' })).toHaveCount(0);
  await expect(screen.getByRole('button', { name: /stumm/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
});

test.describe('screenshots', () => {
  test.skip(!process.env.CAST_SHOTS, 'only with CAST_SHOTS=1');
  test.use({ viewport: { width: 1440, height: 900 } });
  test('desktop: playing, paused, connecting, AirPlay, up next', async ({ page, api: _api }) => {
    const sdk = await chromecastRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/desktop-playing.png` });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Abspielen', exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/desktop-paused.png` });
    await page.getByRole('button', { name: 'Abspielen', exact: true }).click();
    await sdk.nearEnd();
    await expect(page.getByRole('region', { name: 'Als Nächstes' })).toContainText(/Startet in \d+ s/);
    await page.screenshot({ path: `${SHOTS}/desktop-upnext.png` });
  });
  test('desktop: connecting', async ({ page, api: _api }) => {
    await chromecastRemote(page, { fail: () => false });
    await page.route('**/api/cast/session', async (r) => { await new Promise((ok) => setTimeout(ok, 60_000)); await r.fallback(); }); // the switch's token never comes
    await page.getByRole('button', { name: 'Nächste Folge', exact: true }).click();
    await expect(page.getByTestId('cast-active')).toContainText('Verbinde mit Wohnzimmer-TV');
    await page.screenshot({ path: `${SHOTS}/desktop-connecting.png` });
  });
  test('desktop: AirPlay', async ({ page, api: _api }) => {
    await airplayRemote(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/desktop-airplay.png` });
  });
});
