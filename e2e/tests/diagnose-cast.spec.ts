// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { castOn, fakeCastSdk } from '../mocks/cast.js';
import { expect, test } from '../fixtures.js';
import { chromecastRemote, DIAG_SHOTS, dunmoor, leaveRemoteTo, RECEIVER, seedCastLog, type LogSeed } from './cast-remote-setup.js';

/** /diagnose, casting section: the test video, the two cards, the event log and the copied report (desktop; phone in diagnose-cast.mobile). */
dunmoor();

const T = Date.UTC(2026, 10, 9, 21, 14, 0);
const LOG: LogSeed[] = [
  { at: T, level: 'info', tag: 'session', text: 'session adopted · airplay · S1 E4' },
  { at: T + 60_000, level: 'info', tag: 'session', text: 'session adopted · airplay · S1 E5' },
  { at: T + 120_000, level: 'info', tag: 'session', text: 'session adopted · airplay · S1 E6' },
  { at: T + 180_000, level: 'info', tag: 'session', text: 'session started · Wohnzimmer-TV' },
  { at: T + 200_000, level: 'warn', tag: 'network', text: 'TV buffering for more than 2 s' },
  { at: T + 210_000, level: 'error', tag: 'load', text: 'token request refused · HTTP 429' },
];

test.describe('/diagnose casting', () => {
  test('test video reports the first frame', async ({ page, api: _api }) => {
    await castOn(page, true, RECEIVER);
    const sdk = await fakeCastSdk(page, { pick: true, playAfter: 1860 });
    await page.goto('/diagnose');
    await expect(page.getByRole('heading', { level: 2, name: 'Übertragung' })).toBeVisible();
    await page.getByRole('button', { name: 'Testvideo an den Fernseher senden' }).click();
    await expect(page.getByTestId('cast-test-result')).toHaveText('Testvideo lief auf Wohnzimmer-TV · erstes Bild nach 1,9 s');
    const loads = (await sdk.loads()) as Array<{ contentId: string }>;
    expect(loads).toHaveLength(1);
    expect(new URL(loads[0]!.contentId).pathname).toBe('/cast-test/clip.mp4');
    await expect(page.getByTestId('cast-events')).toContainText('test clip playing');
  });

  test('the clip is served and small', async ({ request }) => {
    const r = await request.get('/cast-test/clip.mp4');
    expect(r.ok()).toBe(true);
    expect((await r.body()).length).toBeLessThan(400_000);
  });

  test('copy report has no tokens, urls or device names', async ({ page, context, api: _api }) => {
    test.setTimeout(45_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await seedCastLog(page, [
      ...LOG,
      { at: T + 220_000, level: 'info', tag: 'load', text: `playing https://friend.example.com/media/c/${'A'.repeat(43)}/master.m3u8 for ${'ab12'.repeat(8)} from 192.0.2.7 on Wohnzimmer-TV` },
    ], ['Wohnzimmer-TV']);
    await chromecastRemote(page, { queue: true });
    await leaveRemoteTo(page, '/diagnose');
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Verbunden mit Wohnzimmer-TV');
    await page.getByRole('button', { name: 'Bericht kopieren' }).click();
    await expect(page.getByTestId('diagnose-cast').getByRole('status')).toContainText('Kopiert');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('TV 1');
    expect(text).toContain('Verbunden mit TV 1');
    expect(text).not.toContain('Wohnzimmer-TV');
    expect(text).not.toContain('/media/c/');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('192.0.2.7');
    expect(text).not.toMatch(/[0-9a-f]{32}/i);
  });

  test('levels are text, not colour alone', async ({ page, api: _api }) => {
    await castOn(page);
    await seedCastLog(page, LOG);
    await page.goto('/diagnose');
    const events = page.getByTestId('cast-events');
    await expect(events.getByRole('row', { name: /network/ })).toContainText('Warnung');
    await expect(events.getByRole('row', { name: /load/ })).toContainText('Fehler');
    await expect(events.getByRole('row', { name: /TV 1|session started/ })).toContainText('Info');
    await expect(events.getByRole('columnheader')).toHaveText(['Zeit', 'Stufe', 'Bereich', 'Ereignis']);
  });

  test('AirPlay card: not available in Chrome, last session from the log', async ({ page, api: _api }) => {
    await castOn(page);
    await seedCastLog(page, LOG);
    await page.goto('/diagnose');
    const card = page.getByTestId('diagnose-cast-ap');
    await expect(card).toContainText('Hier nicht verfügbar (AirPlay braucht Safari)');
    await expect(card).toContainText('3 Folgen, 0 Neuverbindungen');
    await expect(card).not.toContainText('Durchgehend');
  });

  test('Clear empties the log; a cast in progress disables the test video', async ({ page, api: _api }) => {
    test.setTimeout(45_000);
    await seedCastLog(page, LOG);
    await chromecastRemote(page);
    await leaveRemoteTo(page, '/diagnose');
    const send = page.getByRole('button', { name: 'Testvideo an den Fernseher senden' });
    await expect(send).toBeDisabled();
    await expect(page.getByText('Beende zuerst die Übertragung.')).toBeVisible();
    await expect(send).toHaveAccessibleDescription('Beende zuerst die Übertragung.');
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Gültig 2 h');
    await page.getByTestId('diagnose-cast').getByRole('button', { name: 'Leeren' }).click();
    await expect(page.getByTestId('cast-events-empty')).toHaveText('Noch keine Ereignisse.');
  });

  test('another tab controls the cast: says so instead of not connected', async ({ page, context, api: _api }) => {
    await castOn(page, true, RECEIVER);
    await fakeCastSdk(page);
    await page.goto('/diagnose');
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Nicht verbunden');
    const other = await context.newPage();
    await other.goto('/offline');
    await other.evaluate(() => { void navigator.locks.request('ff-cast-engine', () => new Promise(() => undefined)); });
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Wird von einem anderen Tab gesteuert', { timeout: 6000 });
    await expect(page.getByTestId('diagnose-cast-cc')).not.toContainText('Nicht verbunden');
    await other.close();
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Nicht verbunden', { timeout: 6000 });
  });

  test('not a Chromium browser or cast off on the server', async ({ page, api: _api }) => {
    await castOn(page, false);
    await page.goto('/diagnose');
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Auf diesem Server aus');
    await expect(page.getByRole('button', { name: 'Testvideo an den Fernseher senden' })).toBeDisabled();
  });
});

test.describe('screenshots', () => {
  test('desktop 1440', async ({ page, api: _api }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await seedCastLog(page, LOG, ['Wohnzimmer-TV']);
    await chromecastRemote(page, { queue: true });
    await leaveRemoteTo(page, '/diagnose');
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Gültig');
    await page.waitForTimeout(500);
    await page.getByTestId('diagnose-cast').screenshot({ path: `${DIAG_SHOTS}/desktop-1440.png` });
  });
});
