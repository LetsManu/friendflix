// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Kanäle (/admin/livetv?tab=channels), Task 23: the server-paged list with filters, inline rename, group select,
// visibility, the bulk bar (selection across pages), the stream test (facts, never a player), the logo sheet and the EPG offset sheet.
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const area = (api: MockState) => api.admin.livetv.area;
const writes = (api: MockState, m: string, p: RegExp) => area(api).calls.filter((c) => c.m === m && p.test(c.p));
const table = (page: Page) => page.getByRole('table', { name: 'Kanäle' });
const rowOf = (page: Page, name: string): Locator => table(page).getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
const last = (api: MockState) => area(api).chQueries[area(api).chQueries.length - 1] ?? '';
const open = async (page: Page) => { await page.goto('/admin/livetv?tab=channels'); await expect(rowOf(page, 'Nordlicht TV')).toBeVisible(); };
async function menu(page: Page, channel: string, item: string) {
  await page.getByRole('button', { name: `Aktionen für ${channel}` }).click();
  await page.getByRole('dialog', { name: channel }).getByRole('button', { name: item }).click();
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test.describe('admin: Live-TV, Kanäle (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('the list opens on the first 100 channels with count, chips and the columns of the spec', async ({ page, api }) => {
    await open(page);
    expect(area(api).chQueries[0]).toBe('sort=number&dir=asc&limit=100&offset=0');
    await expect(page.locator('[data-count]')).toHaveText('232 Sender');
    await expect(table(page).getByRole('row')).toHaveCount(101); // header + 100
    // the sortable headers add their sort state for screen readers
    const heads = async () => (await table(page).getByRole('columnheader').allTextContents()).map((h) => h.replace(/\(.*?sortiert\)/, '').trim());
    await expect.poll(heads).toEqual(['Auswahl', 'Logo', 'Nr.', 'Name', 'Gruppe', 'Quelle', 'Art', 'Modus', 'Programm', 'Sichtbar', 'Aktionen']);
    await expect(table(page).getByRole('columnheader', { name: /^Nr\./ })).toHaveAttribute('aria-sort', 'ascending');
    const nordlicht = rowOf(page, 'Nordlicht TV');
    await expect(nordlicht).toContainText('Nordlicht Paket');
    await expect(nordlicht).toContainText('HLS');
    await expect(nordlicht).toContainText('Programm');
    await expect(nordlicht.locator('img')).toHaveCount(1);
    // no logo: the number sits in the tile
    await expect(rowOf(page, 'Wetterkanal Küste').locator('[data-logo]')).toHaveText('2');
    await expect(rowOf(page, 'Sternwarte 24')).toContainText('Kein Programm');
    await expect(rowOf(page, 'Bergblick Sport')).toContainText('Durchgereicht');
    await expect(rowOf(page, 'Kids Insel')).toHaveCount(0);
    await expect(rowOf(page, 'Kinderinsel')).toContainText('Umverpackt');
    await expect(rowOf(page, 'Regionalkanal 8')).toContainText('Fehlt');
    await expect(rowOf(page, 'Regionalkanal 9')).toContainText('Fehler');
    // the changed dot says what the import had
    await expect(rowOf(page, 'Kinderinsel').locator('[data-changed]')).toHaveText('geändert (Import: Kids Insel)');
    await expect(nordlicht.locator('[data-changed]')).toHaveCount(0);
  });

  test('search sends q', async ({ page, api }) => {
    await open(page);
    await page.getByRole('searchbox').fill('Nordlicht');
    await expect.poll(() => last(api)).toBe('q=Nordlicht&sort=number&dir=asc&limit=100&offset=0');
    await expect(page.locator('[data-count]')).toHaveText('1 Sender');
    await expect(table(page).getByRole('row')).toHaveCount(2);
    await page.getByRole('searchbox').fill('802');
    await expect.poll(() => last(api)).toContain('q=802');
    await expect(rowOf(page, 'Kanal Wolkenlos')).toBeVisible();
  });

  test('filter chips and paging', async ({ page, api }) => {
    await open(page);
    const chip = (n: string) => page.getByRole('button', { name: n, exact: true });
    await chip('Ausgeblendet').click();
    await expect(chip('Ausgeblendet')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => last(api)).toBe('state=hidden&sort=number&dir=asc&limit=100&offset=0');
    await expect(page.locator('[data-count]')).toHaveText('1 Sender');
    await expect(rowOf(page, 'Regionalkanal 7')).toBeVisible();
    await chip('Ausgeblendet').click(); // a second press clears it
    await expect(chip('Ausgeblendet')).toHaveAttribute('aria-pressed', 'false');
    await chip('Fehlt').click();
    await expect.poll(() => last(api)).toContain('state=missing');
    await chip('Fehlt').click();
    await chip('Mit Fehler').click();
    await expect.poll(() => last(api)).toContain('error=1');
    await expect(rowOf(page, 'Regionalkanal 9')).toBeVisible();
    await chip('Mit Fehler').click();
    await chip('Ohne Programm').click();
    await expect.poll(() => last(api)).toContain('epg=no');
    await chip('Ohne Programm').click();
    await page.getByLabel('Quelle', { exact: true }).selectOption({ label: 'Eigene Streams' });
    await expect.poll(() => last(api)).toContain('source=src-feeds');
    await expect(page.locator('[data-count]')).toHaveText('2 Sender');
    await expect(rowOf(page, 'Kanal Wolkenlos')).toContainText('SRT empfangen');
    await expect(rowOf(page, 'Hafenkanal')).toContainText('Eigene Streams');
    await page.getByLabel('Quelle', { exact: true }).selectOption({ label: 'Alle Quellen' });
    await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Sport' });
    await expect.poll(() => last(api)).toContain('group=g-sport');
    await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Ohne Gruppe' });
    await expect.poll(() => last(api)).toContain('group=none');
    await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Alle Gruppen' });
    // paging: 100 per page, the offset goes to the server, a filter starts at page 1 again
    await expect(page.locator('[data-count]')).toHaveText('232 Sender');
    await page.getByRole('button', { name: 'Nächste Seite' }).click();
    await expect.poll(() => last(api)).toBe('sort=number&dir=asc&limit=100&offset=100');
    await expect(rowOf(page, 'Regionalkanal 150')).toBeVisible();
    await expect(page.getByText('101–200 von 232')).toBeVisible();
    await chip('Sichtbar').click();
    await expect.poll(() => last(api)).toBe('state=visible&sort=number&dir=asc&limit=100&offset=0');
  });

  test('sorting by name goes to the server', async ({ page, api }) => {
    await open(page);
    await table(page).getByRole('button', { name: 'Name' }).click();
    await expect.poll(() => last(api)).toBe('sort=name&dir=asc&limit=100&offset=0');
  });

  test('inline rename sends PATCH name (double click and Enter; Escape cancels)', async ({ page, api }) => {
    await open(page);
    await rowOf(page, 'Wetterkanal Küste').getByRole('button', { name: 'Wetterkanal Küste', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: 'Name von „Wetterkanal Küste“' });
    await expect(input).toBeFocused();
    await input.fill('Küstenwetter');
    await input.press('Enter');
    await expect(toasts(page).getByText('Gespeichert.')).toBeVisible();
    const patch = writes(api, 'PATCH', /\/channels\/ch-2$/);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body).toEqual({ name: 'Küstenwetter' });
    const row = rowOf(page, 'Küstenwetter');
    await expect(row.locator('[data-changed]')).toHaveText('geändert (Import: Wetterkanal Küste)');
    // the keyboard: focus the name, Enter edits, Escape leaves it as it was
    const btn = row.getByRole('button', { name: 'Küstenwetter', exact: true });
    await btn.focus();
    await btn.press('Enter');
    const again = page.getByRole('textbox', { name: 'Name von „Küstenwetter“' });
    await again.fill('Etwas anderes');
    await again.press('Escape');
    await expect(rowOf(page, 'Küstenwetter')).toBeVisible();
    expect(writes(api, 'PATCH', /\/channels\/ch-2$/)).toHaveLength(1);
    // an empty name goes back to the import's
    await row.getByRole('button', { name: 'Küstenwetter', exact: true }).dblclick();
    await page.getByRole('textbox', { name: 'Name von „Küstenwetter“' }).fill('');
    await page.keyboard.press('Enter');
    await expect(rowOf(page, 'Wetterkanal Küste')).toBeVisible();
    expect(writes(api, 'PATCH', /\/channels\/ch-2$/)[1]!.body).toEqual({ name: null });
  });

  test('group select sends PATCH groupId', async ({ page, api }) => {
    await open(page);
    const sel = page.getByLabel('Gruppe von „Nordlicht TV“');
    await expect(sel).toHaveValue('g-regional');
    await sel.selectOption({ label: 'Sport' });
    await expect(rowOf(page, 'Nordlicht TV').locator('[data-changed]')).toHaveText('geändert (Import: Regional)');
    expect(writes(api, 'PATCH', /\/channels\/ch-1$/)[0]!.body).toEqual({ groupId: 'g-sport' });
    await expect(sel).toHaveValue('g-sport');
    // back to the import's group
    await sel.selectOption({ label: 'Gruppe aus dem Import' });
    expect(writes(api, 'PATCH', /\/channels\/ch-1$/)[1]!.body).toEqual({ groupId: null });
    await expect(sel).toHaveValue('g-regional');
  });

  test('visibility toggle sends PATCH hidden', async ({ page, api }) => {
    await open(page);
    const sw = rowOf(page, 'Bergblick Sport').getByRole('switch', { name: 'Sichtbar: Bergblick Sport' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => writes(api, 'PATCH', /\/channels\/ch-3$/).length).toBe(1);
    expect(writes(api, 'PATCH', /\/channels\/ch-3$/)[0]!.body).toEqual({ hidden: true });
    await expect(toasts(page).getByText('Sender ausgeblendet.')).toBeVisible();
    const hiddenOne = rowOf(page, 'Regionalkanal 7').getByRole('switch');
    await expect(hiddenOne).toHaveAttribute('aria-checked', 'false');
    await hiddenOne.click();
    expect(writes(api, 'PATCH', /\/channels\/ch-7$/)[0]!.body).toEqual({ hidden: false });
  });

  test('bulk hide keeps the selection across pages', async ({ page, api }) => {
    await open(page);
    const box = (n: string) => page.getByRole('checkbox', { name: `Sender „${n}“ auswählen` });
    await expect(page.getByRole('group', { name: 'Aktionen für die Auswahl' })).toHaveCount(0);
    await box('Nordlicht TV').check();
    const bar = page.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await expect(bar.locator('[data-selected]')).toHaveText('1 ausgewählt');
    await page.getByRole('button', { name: 'Nächste Seite' }).click();
    await expect(rowOf(page, 'Regionalkanal 150')).toBeVisible();
    await box('Regionalkanal 150').check();
    await expect(bar.locator('[data-selected]')).toHaveText('2 ausgewählt');
    await page.getByRole('button', { name: 'Vorherige Seite' }).click();
    await expect(box('Nordlicht TV')).toBeChecked();
    await bar.getByRole('button', { name: 'Ausblenden' }).click();
    await expect(toasts(page).getByText('2 Sender geändert.')).toBeVisible();
    const post = writes(api, 'POST', /\/channels\/bulk$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.body.action).toBe('hide');
    expect([...post[0]!.body.ids].sort()).toEqual(['ch-1', 'ch-150']);
    await expect(rowOf(page, 'Nordlicht TV').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(bar).toHaveCount(0); // done: the selection is cleared
  });

  test('select the page, clear, and Einblenden / Zurücksetzen / Gruppe ändern', async ({ page, api }) => {
    await open(page);
    await page.getByRole('checkbox', { name: 'Diese Seite auswählen' }).check();
    const bar = page.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await expect(bar.locator('[data-selected]')).toHaveText('100 ausgewählt');
    await bar.getByRole('button', { name: 'Auswahl aufheben' }).click();
    await expect(bar).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Sender „Regionalkanal 7“ auswählen' }).check();
    await bar.getByRole('button', { name: 'Einblenden' }).click();
    await expect(toasts(page).getByText('1 Sender geändert.')).toBeVisible();
    expect(writes(api, 'POST', /\/channels\/bulk$/)[0]!.body).toEqual({ ids: ['ch-7'], action: 'show' });
    await page.getByRole('checkbox', { name: 'Sender „Nordlicht TV“ auswählen' }).check();
    await page.getByRole('checkbox', { name: 'Sender „Bergblick Sport“ auswählen' }).check();
    await bar.getByRole('button', { name: 'Gruppe ändern…' }).click();
    const grp = bar.getByRole('group', { name: 'Gruppe ändern…' });
    await grp.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Sport' });
    await grp.getByRole('button', { name: 'Anwenden' }).click();
    await expect(toasts(page).getByText('2 Sender geändert.')).toBeVisible();
    expect(writes(api, 'POST', /\/channels\/bulk$/)[1]!.body).toMatchObject({ action: 'group', groupId: 'g-sport' });
    await page.getByRole('checkbox', { name: 'Sender „Nordlicht TV“ auswählen' }).check();
    await bar.getByRole('button', { name: 'Überschreibungen zurücksetzen' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Überschreibungen zurücksetzen?' });
    await expect(ask).toContainText('Das Programm wird wieder automatisch zugeordnet');
    await ask.getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect(toasts(page).getByText('1 Sender geändert.').last()).toBeVisible();
    expect(writes(api, 'POST', /\/channels\/bulk$/)[2]!.body).toEqual({ ids: ['ch-1'], action: 'reset' });
  });

  test('renumber from 100', async ({ page, api }) => {
    await open(page);
    await page.getByRole('checkbox', { name: 'Sender „Wetterkanal Küste“ auswählen' }).check();
    await page.getByRole('checkbox', { name: 'Sender „Bergblick Sport“ auswählen' }).check();
    const bar = page.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await bar.getByRole('button', { name: 'Ab Nummer … durchnummerieren' }).click();
    const grp = bar.getByRole('group', { name: 'Ab Nummer … durchnummerieren' });
    await grp.getByRole('spinbutton', { name: 'Erste Nummer' }).fill('100');
    await grp.getByRole('button', { name: 'Anwenden' }).click();
    await expect(toasts(page).getByText('2 Sender geändert.')).toBeVisible();
    const post = writes(api, 'POST', /\/channels\/bulk$/);
    expect(post).toHaveLength(1);
    expect([...post[0]!.body.ids].sort()).toEqual(['ch-2', 'ch-3']);
    expect(post[0]!.body).toMatchObject({ action: 'renumber', from: 100 });
    // the list was loaded again: the two now have the numbers 100 and 101
    await expect(rowOf(page, 'Wetterkanal Küste').locator('[data-number]')).toHaveText('100');
  });

  test('test sheet shows the facts, and never a player', async ({ page, api }) => {
    await open(page);
    await menu(page, 'Nordlicht TV', 'Testen');
    const dlg = page.getByRole('dialog', { name: 'Stream testen: Nordlicht TV' });
    await expect(dlg.locator('[data-facts]')).toHaveText('H.264 1920×1080 25 fps · AAC 2.0 · wird umverpackt');
    await expect(dlg.locator('video, audio')).toHaveCount(0);
    expect(writes(api, 'POST', /\/channels\/ch-1\/test$/)).toHaveLength(1);
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    await expect(dlg).toHaveCount(0);
    await expect(rowOf(page, 'Nordlicht TV')).toContainText('Umverpackt');
    // the focus is back on the row's menu button
    await expect(page.getByRole('button', { name: 'Aktionen für Nordlicht TV' })).toBeFocused();
  });

  test('bulk test: at most 20, results with the names in a sheet', async ({ page, api }) => {
    await open(page);
    await page.getByRole('checkbox', { name: 'Sender „Nordlicht TV“ auswählen' }).check();
    await page.getByRole('checkbox', { name: 'Sender „Bergblick Sport“ auswählen' }).check();
    area(api).chTest = { ok: false, error: 'timeout' };
    const bar = page.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await bar.getByRole('button', { name: 'Testen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Test von 2 Sendern' });
    await expect(dlg.getByRole('listitem')).toHaveCount(2);
    await expect(dlg.getByRole('listitem').filter({ hasText: 'Nordlicht TV' })).toContainText('Zeitüberschreitung');
    expect(writes(api, 'POST', /\/channels\/bulk$/)[0]!.body).toMatchObject({ action: 'test' });
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    // the 21st channel is refused before anything is sent
    await page.getByRole('checkbox', { name: 'Diese Seite auswählen' }).check();
    await expect(bar.locator('[data-selected]')).toHaveText('100 ausgewählt');
    const btn = bar.getByRole('button', { name: 'Testen' });
    await expect(btn).toBeDisabled();
    await expect(bar).toContainText('Höchstens 20 Sender auf einmal testen');
  });

  test('the offset sheet saves epgShiftMin and Zurücksetzen sends null', async ({ page, api }) => {
    await open(page);
    await menu(page, 'Nordlicht TV', 'Programm-Zeit verschieben…');
    const dlg = page.getByRole('dialog', { name: 'Programm-Zeit: Nordlicht TV' });
    await expect(dlg.locator('[data-from]')).toHaveText('+1 Std. · aus der Senderliste (tvg-shift)');
    await expect(dlg.locator('[data-now]')).toHaveText('Wetter am Hafen · 19:45–20:15');
    const reset = dlg.getByRole('button', { name: 'Zurücksetzen' });
    await expect(reset).toBeDisabled(); // nothing of its own to drop
    const before = await dlg.boundingBox();
    const nowBox = await dlg.locator('[data-now]').boundingBox();
    await dlg.getByRole('button', { name: 'Um 30 Minuten später' }).click();
    await expect(dlg.locator('[data-value]')).toHaveText('+1,5 Std.');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.locator('[data-now]')).toHaveText('Die Leuchtturmwärter · 20:15–21:00');
    await expect(dlg.locator('[data-from]')).toHaveText('+1,5 Std. · für diesen Sender festgelegt');
    expect(writes(api, 'PATCH', /\/channels\/ch-1$/)[0]!.body).toEqual({ epgShiftMin: 90 });
    // nothing moved: the sheet and the line kept their box
    expect(await dlg.boundingBox()).toEqual(before);
    expect((await dlg.locator('[data-now]').boundingBox())!.height).toBe(nowBox!.height);
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect(dlg.locator('[data-from]')).toHaveText('+1 Std. · aus der Senderliste (tvg-shift)');
    await expect(dlg.locator('[data-now]')).toHaveText('Wetter am Hafen · 19:45–20:15');
    expect(writes(api, 'PATCH', /\/channels\/ch-1$/)[1]!.body).toEqual({ epgShiftMin: null });
    // no programme at this offset
    await dlg.getByRole('button', { name: 'Um 30 Minuten später' }).click();
    await dlg.getByRole('button', { name: 'Um 30 Minuten später' }).click();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.locator('[data-now]')).toHaveText('Kein Programm verfügbar');
    expect((await dlg.locator('[data-now]').boundingBox())!.height).toBe(nowBox!.height);
  });

  test('the offset stepper stops at −12 and +14 hours', async ({ page }) => {
    await open(page);
    await menu(page, 'Nordlicht TV', 'Programm-Zeit verschieben…');
    const dlg = page.getByRole('dialog', { name: 'Programm-Zeit: Nordlicht TV' });
    const later = dlg.getByRole('button', { name: 'Um 30 Minuten später' }), earlier = dlg.getByRole('button', { name: 'Um 30 Minuten früher' });
    // from +1 h: 26 steps up to +14 h, 52 down to −12 h (a click on a disabled button does nothing)
    await later.evaluate((b) => { for (let i = 0; i < 30; i++) (b as HTMLButtonElement).click(); });
    await expect(dlg.locator('[data-value]')).toHaveText('+14 Std.');
    await expect(later).toBeDisabled();
    await earlier.evaluate((b) => { for (let i = 0; i < 60; i++) (b as HTMLButtonElement).click(); });
    await expect(dlg.locator('[data-value]')).toHaveText('−12 Std.');
    await expect(earlier).toBeDisabled();
  });

  test('logo upload refuses SVG and more than 512 KB before anything is sent', async ({ page, api }) => {
    await open(page);
    await menu(page, 'Nordlicht TV', 'Logo ändern');
    const dlg = page.getByRole('dialog', { name: 'Logo: Nordlicht TV' });
    await expect(dlg.locator('[data-size]')).toHaveCount(3);
    const file = dlg.locator('input[type=file]');
    await file.setInputFiles({ name: 'nordlicht.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(dlg.getByRole('alert')).toHaveText('SVG-Bilder werden nicht angenommen. Nimm PNG, JPEG oder WebP.');
    await file.setInputFiles({ name: 'gross.png', mimeType: 'image/png', buffer: Buffer.alloc(512 * 1024 + 1) });
    await expect(dlg.getByRole('alert')).toHaveText('Das Bild ist größer als 512 KB.');
    expect(area(api).logoPuts).toEqual([]);
    // a good PNG goes up as the raw body with its own type
    await file.setInputFiles({ name: 'nordlicht.png', mimeType: 'image/png', buffer: PNG });
    await expect(toasts(page).getByText('Logo gespeichert.')).toBeVisible();
    expect(area(api).logoPuts).toEqual([{ id: 'ch-1', type: 'image/png', bytes: PNG.length }]);
    await expect(dlg.getByRole('alert')).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Eigenes Logo entfernen' })).toBeEnabled();
    await dlg.getByRole('button', { name: 'Eigenes Logo entfernen' }).click();
    await expect(toasts(page).getByText('Eigenes Logo entfernt.')).toBeVisible();
    expect(writes(api, 'DELETE', /\/channels\/ch-1\/logo$/)).toHaveLength(1);
  });

  test('the row menu resets the overrides of one channel', async ({ page, api }) => {
    await open(page);
    await menu(page, 'Kinderinsel', 'Zurücksetzen');
    await expect(toasts(page).getByText('Änderungen zurückgesetzt.')).toBeVisible();
    expect(writes(api, 'POST', /\/channels\/bulk$/)[0]!.body).toEqual({ ids: ['ch-4'], action: 'reset' });
    await expect(rowOf(page, 'Kids Insel')).toBeVisible();
  });

  test('an own feed has no import to compare with', async ({ page }) => {
    await page.goto('/admin/livetv?tab=channels');
    await expect(rowOf(page, 'Nordlicht TV')).toBeVisible();
    await page.getByLabel('Quelle', { exact: true }).selectOption({ label: 'Eigene Streams' });
    await expect(rowOf(page, 'Hafenkanal')).toBeVisible();
    await rowOf(page, 'Hafenkanal').getByRole('button', { name: 'Hafenkanal', exact: true }).dblclick();
    await page.getByRole('textbox', { name: 'Name von „Hafenkanal“' }).fill('Hafenkanal Nord');
    await page.keyboard.press('Enter');
    await expect(rowOf(page, 'Hafenkanal Nord')).toBeVisible();
    await expect(rowOf(page, 'Hafenkanal Nord').locator('[data-changed]')).toHaveCount(0);
  });
});

// the refusals the server answers on purpose show up as failed requests in the browser's console: allowed here, and only here
test.describe('admin: Live-TV, Kanäle (refusals)', () => {
  test.use({ allowedConsole: /Failed to load resource: the server responded with a status of (409|413|415|422|500|503)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('a failed test says why, in words', async ({ page, api }) => {
    await open(page);
    const run = async (name: string) => { await menu(page, name, 'Testen'); return page.getByRole('dialog', { name: `Stream testen: ${name}` }); };
    area(api).chTest = { ok: false, error: 'timeout' };
    let dlg = await run('Nordlicht TV');
    await expect(dlg.locator('[data-failure]')).toHaveText('Zeitüberschreitung: Der Stream hat nicht rechtzeitig geantwortet.');
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    await expect(rowOf(page, 'Nordlicht TV')).toContainText('Fehler');
    for (const [status, error, text] of [
      [409, 'no_stream_url', 'Für diesen Sender ist keine Stream-Adresse gespeichert.'],
      [409, 'livetv_off', 'Live-TV ist ausgeschaltet.'],
      [503, 'livetv_unreachable', 'Der Live-TV-Dienst ist nicht erreichbar.'],
      [422, 'address_refused', 'Diese Adresse ist nicht erlaubt (internes Netz).'],
    ] as const) {
      area(api).chTest = { status, error };
      dlg = await run('Bergblick Sport');
      await expect(dlg.locator('[data-failure]')).toHaveText(text);
      await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    }
    area(api).chTest = { ok: true };
    area(api).chTestBusy = true;
    dlg = await run('Kinderinsel');
    await expect(dlg.locator('[data-failure]')).toHaveText('Es läuft schon ein Stream-Test. Warte, bis er fertig ist.');
    await dlg.getByRole('button', { name: 'Erneut testen' }).click();
    await expect(dlg.locator('[data-facts]')).toHaveText('H.264 1920×1080 25 fps · AAC 2.0 · wird umverpackt');
  });

  test('a server refusal of the logo is worded', async ({ page }) => {
    await page.route('**/api/admin/livetv/channels/ch-2/logo', (r) => r.fulfill({ status: 415, contentType: 'application/json', body: JSON.stringify({ error: 'unsupported_type' }) }));
    await open(page);
    await menu(page, 'Wetterkanal Küste', 'Logo ändern');
    const dlg = page.getByRole('dialog', { name: 'Logo: Wetterkanal Küste' });
    await dlg.locator('input[type=file]').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: PNG });
    await expect(dlg.getByRole('alert')).toHaveText('Dieses Bildformat wird nicht angenommen. Nimm PNG, JPEG oder WebP.');
  });

  test('a 413 too_large logo answer is worded', async ({ page }) => {
    await page.route('**/api/admin/livetv/channels/ch-2/logo', (r) => r.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'too_large' }) }));
    await open(page);
    await menu(page, 'Wetterkanal Küste', 'Logo ändern');
    const dlg = page.getByRole('dialog', { name: 'Logo: Wetterkanal Küste' });
    await dlg.locator('input[type=file]').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: PNG });
    await expect(dlg.getByRole('alert')).toHaveText('Das Bild ist größer als 512 KB.');
  });

  test('a failed load says so and retries', async ({ page, api }) => {
    let fail = true;
    await page.route('**/api/admin/livetv/channels?**', async (r) => {
      if (fail && new URL(r.request().url()).searchParams.get('limit') !== '200') { fail = false; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }); }
      return r.fallback();
    });
    await page.goto('/admin/livetv?tab=channels');
    await expect(page.getByRole('alert')).toContainText('Die Kanäle ließen sich nicht laden.');
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(rowOf(page, 'Nordlicht TV')).toBeVisible();
    expect(area(api).chQueries.length).toBeGreaterThan(0);
  });
});
