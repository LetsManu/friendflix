// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Live-Status and Programmführer (/admin/livetv?tab=status | guide), Task 26: the budget card, the system tiles, the
// running channels with Stoppen (confirmed) and Neu starten, the events in words, the pushed streams (only with push feeds), the
// guide counts and the off dialog.
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };

async function menu(page: Page, channel: string, item: string) {
  await page.getByRole('button', { name: `Aktionen für ${channel}` }).click();
  await page.getByRole('dialog', { name: channel }).getByRole('button', { name: item }).click();
}

test.describe('admin: Live-TV, Live-Status (desktop)', () => {
  // a failing stop and a failing summary are mocked 503s: the browser logs them
  test.use({ allowedConsole: /Failed to load resource: the server responded with a status of 503/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('tiles, events and the GPU message', async ({ page, api }) => {
    api.admin.livetv.advice = { level: 'warn', key: 'needsOverlay' };
    await page.goto('/admin/livetv?tab=status');
    const tiles = page.getByRole('group', { name: 'Übersicht' });
    await expect(tiles).toContainText('Laufende Sender');
    await expect(tiles.getByText('Laufende Sender').locator('xpath=..')).toContainText('2');
    await expect(tiles.getByText('Zuschauer').locator('xpath=..')).toContainText('4');
    await expect(tiles.getByText('CPU').locator('xpath=..')).toContainText('17 %');
    // no GPU load known: a dash
    await expect(tiles.getByText('GPU').locator('xpath=..')).toContainText('–');
    await expect(tiles.getByText('DVR-Speicher').locator('xpath=..')).toContainText('3,1 von 6 GB');
    // the budget card, read-only, with the link to the full card
    const budget = card(page, 'Umwandlungen');
    await expect(budget.getByRole('link', { name: 'Zum Wiedergabe-Check' })).toHaveAttribute('href', '/admin/playback');
    await expect(budget.getByRole('button', { name: 'Neu messen' })).toHaveCount(0);

    // the running channels
    const run = card(page, 'Laufende Sender');
    await expect(run.getByRole('row', { name: /Nordlicht TV/ })).toContainText('Umgepackt');
    await expect(run.getByRole('row', { name: /Nordlicht TV/ })).toContainText('4,2 Mbit/s');
    await expect(run.getByRole('row', { name: /Nordlicht TV/ }).locator('[data-input]')).toHaveText('läuft');
    await expect(run.getByRole('row', { name: /Hafenkanal/ }).locator('[data-input]')).toHaveText('verbinde neu (3)');

    // the events: icon + word + the sentence of the code
    const ev = card(page, 'Ereignisse');
    const lost = ev.getByRole('row', { name: /Eingang verloren/ });
    await expect(lost).toContainText('Warnung');
    await expect(lost).toContainText('Hafenkanal');
    await expect(lost.locator('[data-code]')).toHaveText('Eingang verloren · 12 s bis zur Wiederverbindung');
    await expect(ev.locator('[data-code="start_refused_full"]')).toHaveText('Start abgelehnt: alle Plätze belegt');
    const failed = ev.getByRole('row', { name: /Aktualisierung fehlgeschlagen/ });
    await expect(failed).toContainText('Fehler');
    await expect(failed.locator('[data-code]')).toHaveText('Quelle Nordlicht Paket: Aktualisierung fehlgeschlagen (Zeitüberschreitung)');
    await expect(lost.locator('svg').first()).toBeVisible();

    // the GPU message and the version of livetv
    await expect(page.locator('[data-gpu="needsOverlay"]')).toContainText('Jellyfin nutzt die Grafikeinheit, Live-TV noch nicht.');
    await expect(card(page, 'Live-TV').locator('code')).toHaveText('1.0.0');
    await expect(page.getByText('Live-TV läuft.')).toBeVisible();
    // the whole answer carries no address
    await expect(page.locator('body')).not.toContainText(/https?:\/\//);
  });

  test('push table only with push feeds', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    await expect(card(page, 'Laufende Sender')).toBeVisible();
    await expect(card(page, 'Ereignisse')).toBeVisible();
    await expect(card(page, 'Gesendete Streams')).toHaveCount(0);

    api.admin.livetv.status.ingest = [
      { channelId: 'ch-wolkenlos', name: 'Kanal Wolkenlos', port: 9001, state: 'receiving', since: Date.now() - 20 * 60_000, bitrate: 2_000_000, rejected1h: 2 },
      { channelId: 'ch-sternwarte', name: 'Sternwarte 24', port: 9002, state: 'idle', since: null, bitrate: null, rejected1h: 0 },
    ];
    await page.reload();
    const push = card(page, 'Gesendete Streams');
    const on = push.getByRole('row', { name: /Kanal Wolkenlos/ });
    await expect(on).toContainText('9001');
    await expect(on.locator('[data-feed="receiving"]')).toContainText('Sendet seit heute');
    await expect(on).toContainText('2 Mbit/s');
    await expect(on.getByRole('cell').last()).toHaveText('2');
    const idle = push.getByRole('row', { name: /Sternwarte 24/ });
    await expect(idle.locator('[data-feed="idle"]')).toHaveText('Keine Übertragung');
  });

  test('Stoppen confirms, Neu starten does not', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    const run = card(page, 'Laufende Sender');
    await expect(run.getByRole('row', { name: /Hafenkanal/ })).toBeVisible();

    // cancelling leaves the channel running
    await menu(page, 'Hafenkanal', 'Stoppen');
    const ask = page.getByRole('alertdialog', { name: '„Hafenkanal“ stoppen?' });
    await expect(ask).toContainText('Wer gerade zuschaut, verliert das Bild.');
    await ask.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(ask).toHaveCount(0);
    expect(api.admin.livetv.status.stops).toEqual([]);

    // confirming stops it: the row goes, the event says so
    await menu(page, 'Hafenkanal', 'Stoppen');
    await page.getByRole('alertdialog', { name: '„Hafenkanal“ stoppen?' }).getByRole('button', { name: 'Stoppen' }).click();
    await expect(toasts(page).getByText('„Hafenkanal“ gestoppt.')).toBeVisible();
    await expect(run.getByRole('row', { name: /Hafenkanal/ })).toHaveCount(0);
    const stoppedEv = card(page, 'Ereignisse').getByRole('row', { name: /Von einem Admin gestoppt/ });
    await expect(stoppedEv.locator('[data-code="stopped_by_admin"]')).toHaveText('Von einem Admin gestoppt');
    // the channel is no longer running, and its event still names it
    await expect(stoppedEv).toContainText('Hafenkanal');
    expect(api.admin.livetv.status.stops).toEqual(['ch-hafenkanal']);

    // Neu starten: no question
    await menu(page, 'Nordlicht TV', 'Neu starten');
    await expect(toasts(page).getByText('„Nordlicht TV“ gestoppt – startet beim nächsten Zuschauen neu.')).toBeVisible();
    expect(api.admin.livetv.status.stops).toEqual(['ch-hafenkanal', 'ch-nordlicht']);
    await expect(run.getByText('Gerade läuft kein Sender.')).toBeVisible();
  });

  test('a stop livetv does not answer says so and keeps the row', async ({ page, api }) => {
    api.admin.livetv.status.stopFails = true;
    await page.goto('/admin/livetv?tab=status');
    await menu(page, 'Nordlicht TV', 'Neu starten');
    await expect(toasts(page).getByText('Der Sender ließ sich nicht stoppen: Live-TV antwortet nicht.')).toBeVisible();
    await expect(card(page, 'Laufende Sender').getByRole('row', { name: /Nordlicht TV/ })).toBeVisible();
  });

  test('guide counts', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=guide');
    await expect(page.getByRole('tab', { name: 'Programmführer' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-guide-counts]')).toHaveText('398 von 412 Sendern mit Programm · 14 ohne');
    // a failing summary says so and offers a retry
    api.admin.livetv.status.summary = null;
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('Die Zahlen ließen sich nicht laden.');
    api.admin.livetv.status.summary = { matched: 3, total: 3, unmatched: 0 };
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.locator('[data-guide-counts]')).toHaveText('3 von 3 Sendern mit Programm · 0 ohne');
  });

  test('off dialog from the status tab', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    await page.getByRole('button', { name: 'Live-TV ausschalten …' }).click();
    const dlg = page.getByRole('dialog', { name: 'Live-TV ausschalten?' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText('Aufnahmen bleiben erhalten.')).toBeVisible();
    await dlg.getByRole('button', { name: 'Ausschalten' }).click();
    await expect(dlg).toHaveCount(0);
    expect(api.admin.livetv.posts).toEqual([{ path: 'disable', body: { removeImage: false, removeCache: false } }]);
  });

  test('nothing moves when the first answer arrives', async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/livetv/status', async (route) => { await gate; await route.fallback(); });
    await page.goto('/admin/livetv?tab=status');
    const tiles = page.getByRole('group', { name: 'Übersicht' });
    await expect(tiles).toBeVisible();
    const before = await tiles.boundingBox();
    const run = await card(page, 'Laufende Sender').boundingBox();
    release();
    await expect(card(page, 'Laufende Sender').getByRole('row', { name: /Nordlicht TV/ })).toBeVisible();
    const after = await tiles.boundingBox();
    expect(after?.y).toBe(before?.y);
    expect(after?.height).toBe(before?.height);
    // the table card keeps at least the height it reserved
    expect((await card(page, 'Laufende Sender').boundingBox())!.y).toBe(run!.y);
  });

  test('nothing moves when the first answer fails and then arrives', async ({ page, api }) => {
    api.admin.livetv.status.failFirst = true;
    await page.goto('/admin/livetv?tab=status');
    const tiles = page.getByRole('group', { name: 'Übersicht' });
    const run = card(page, 'Laufende Sender');
    // the error sits in the table's own slot: it is there, and the tiles and the cards are where the skeleton had them
    const alert = run.getByRole('alert');
    await expect(alert).toContainText('Der Live-Status ließ sich nicht laden.');
    // the budget card above has loaded too, and the page is measured from its top (the retry button may scroll)
    await expect(card(page, 'Umwandlungen').getByRole('link', { name: 'Zum Wiedergabe-Check' })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    const tilesFailed = await tiles.boundingBox();
    const runFailed = await run.boundingBox();
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(run.getByRole('row', { name: /Nordlicht TV/ })).toBeVisible();
    await expect(alert).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    const tilesOk = await tiles.boundingBox();
    expect(tilesOk?.y).toBe(tilesFailed?.y);
    expect(tilesOk?.height).toBe(tilesFailed?.height);
    expect((await run.boundingBox())!.y).toBe(runFailed!.y);
  });
});
