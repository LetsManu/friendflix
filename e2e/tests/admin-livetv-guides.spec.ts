// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ltvFileGuideMock, ltvGuideMock } from '../mocks/admin.js';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Quellen, extra programme guides (extra-guides plan Task 3): the kind *Programmführer* in the add sheet, *Gilt für*,
// Prüfen before Speichern, the guide cards between the lists and the own streams, and their order.
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const writes = (api: MockState, m: string, p: RegExp) => api.admin.livetv.area.calls.filter((c) => c.m === m && p.test(c.p));
const GUIDE_URL = 'https://epg.example.com/guide.xml.gz?token=geheim456';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function openGuideSheet(page: Page) {
  await page.goto('/admin/livetv');
  await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
  const list = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
  await expect(list.getByRole('radiogroup', { name: 'Art der Quelle' }).getByRole('radio')).toHaveText(['Anbieterliste', 'Programmführer', 'Eigene Streams']);
  await list.getByRole('radio', { name: 'Programmführer', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Programmführer hinzufügen' });
  await expect(dlg.getByRole('radio', { name: 'Programmführer', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(list).toHaveCount(0);
  return dlg;
}

test.describe('admin: Live-TV, Programmführer (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); });

  test('add a guide: Prüfen then Speichern sends kind guide and its scope', async ({ page, api }) => {
    const dlg = await openGuideSheet(page);
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Sternwarte Guide');
    const url = dlg.getByLabel('Programmführer (XMLTV-Adresse)');
    await expect(url).toHaveAttribute('type', 'password');
    await url.fill(GUIDE_URL);
    const save = dlg.getByRole('button', { name: 'Speichern' });
    await expect(save).toBeDisabled();
    await expect(dlg).toContainText('Erst prüfen, dann speichern.');
    // Alle Sender by default; the checklist is there but off
    await expect(dlg.getByRole('radio', { name: 'Alle Sender' })).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.getByRole('checkbox', { name: 'Nordlicht Paket' })).toBeDisabled();
    await dlg.getByRole('button', { name: 'Prüfen' }).click();
    await expect(dlg.locator('[data-test-result]')).toHaveText('2.140 Sender im Programmführer');
    // up to eight names
    await expect(dlg).toContainText('Zum Beispiel: Nordlicht TV, Hafenkanal, Sternwarte 24, Kanal Wolkenlos, Bergblick Sport, Wetterkanal Küste, Kids Insel, Regionalkanal 12');
    await expect(dlg).not.toContainText('Regionalkanal 13');
    expect(writes(api, 'POST', /\/sources\/test$/)[0]!.body).toEqual({ kind: 'guide', epgUrl: GUIDE_URL, allowLan: false });
    // the checklist keeps its height: choosing a scope moves nothing below it
    // (its place in the form, not on screen: the click may scroll the form)
    const placeOf = () => dlg.locator('[data-test-result]').evaluate((el) => (el as HTMLElement).offsetTop);
    const before = await placeOf();
    await dlg.getByRole('radio', { name: 'Nur diese Quellen' }).click();
    expect(await placeOf()).toBe(before);
    await dlg.getByRole('checkbox', { name: 'Nordlicht Paket' }).check();
    await expect(dlg.getByRole('checkbox', { name: 'Eigene Streams' })).not.toBeChecked();
    await save.click();
    await expect(dlg).toHaveCount(0);
    await expect(toasts(page).getByText('Quelle hinzugefügt.')).toBeVisible();
    const post = writes(api, 'POST', /\/sources$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toEqual({ kind: 'guide', name: 'Sternwarte Guide', epgUrl: GUIDE_URL, userAgent: null, allowLan: false, refresh: '24h', epgShiftMin: 0, guideScope: ['src-nordlicht'], enabled: true });
    const c = card(page, 'Sternwarte Guide');
    await expect(c).toContainText('Programmführer');
    await expect(c).toContainText('https://epg.example.com/…');
    await expect(c.locator('[data-scope]')).toHaveText('Gilt für: Nordlicht Paket');
    await expect(page.getByText('geheim456')).toHaveCount(0);
    // after the lists, before the own streams
    const top = async (name: string) => (await card(page, name).boundingBox())!.y;
    expect(await top('Nordlicht Paket')).toBeLessThan(await top('Sternwarte Guide'));
    expect(await top('Sternwarte Guide')).toBeLessThan(await top('Eigene Streams'));
  });

  test('Gilt für Nur diese Quellen needs one checked', async ({ page, api }) => {
    const dlg = await openGuideSheet(page);
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Guide');
    await dlg.getByLabel('Programmführer (XMLTV-Adresse)').fill(GUIDE_URL);
    await dlg.getByRole('radio', { name: 'Nur diese Quellen' }).click();
    await dlg.getByRole('button', { name: 'Prüfen' }).click();
    await expect(dlg.locator('[data-test-result]')).toBeVisible();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Wähle mindestens eine Quelle.');
    expect(writes(api, 'POST', /\/sources$/)).toHaveLength(0);
    await dlg.getByRole('checkbox', { name: 'Eigene Streams' }).check();
    await expect(dlg.getByText('Wähle mindestens eine Quelle.')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'POST', /\/sources$/)[0]!.body.guideScope).toEqual(['src-feeds']);
    await expect(card(page, 'Hafen Guide').locator('[data-scope]')).toHaveText('Gilt für: Eigene Streams');
  });

  test('the guide card shows its scope and served channels', async ({ page, api }) => {
    const a = api.admin.livetv.area;
    a.sources.push(
      ltvGuideMock({
        id: 'g-welt', name: 'Weltempfang', position: 2, servedChannels: 37,
        state: { lastRefreshAt: null, lastOkAt: null, lastError: null, counts: null, epg: { lastRefreshAt: ago(5), lastOkAt: ago(5), lastError: null, programmes: 2140 } },
      }),
      ltvGuideMock({ id: 'g-hafen', name: 'Hafen Guide', position: 3, guideScope: ['src-nordlicht', 'src-feeds'], servedChannels: 1 }),
      ltvGuideMock({ id: 'g-alt', name: 'Alter Guide', position: 4, guideScope: [], enabled: false }),
    );
    await page.goto('/admin/livetv');
    const w = card(page, 'Weltempfang');
    await expect(w.locator('[data-scope]')).toHaveText('Gilt für: Alle Sender');
    await expect(w.locator('[data-state]')).toContainText('Programm: 2.140 Sendungen');
    await expect(w.locator('[data-served]')).toHaveText('versorgt 37 Sender');
    await expect(w.getByLabel('Aktualisieren', { exact: true })).toHaveValue('24h');
    const h = card(page, 'Hafen Guide');
    await expect(h.locator('[data-scope]')).toHaveText('Gilt für: Nordlicht Paket, Eigene Streams');
    await expect(h.locator('[data-served]')).toHaveText('versorgt 1 Sender');
    await expect(h.locator('[data-state]')).toHaveText('Noch nicht aktualisiert');
    const old = card(page, 'Alter Guide');
    await expect(old.locator('[data-scope]')).toHaveText('Gilt für keine Quelle mehr');
    await expect(old).toContainText('Deaktiviert');

    // Jetzt aktualisieren: the guide's own import, its result in a toast
    await w.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await expect(toasts(page).getByText('Programm aktualisiert: 2.140 Sendungen')).toBeVisible();
    expect(writes(api, 'POST', /\/sources\/g-welt\/refresh$/)).toHaveLength(1);

    // edit: the stored link stays unless typed; a new scope goes out alone
    await w.getByRole('button', { name: 'Aktionen für Weltempfang' }).click();
    await page.getByRole('dialog', { name: 'Weltempfang' }).getByRole('button', { name: 'Bearbeiten' }).click();
    const dlg = page.getByRole('dialog', { name: 'Programmführer bearbeiten' });
    await expect(dlg.getByLabel('Programmführer (XMLTV-Adresse)')).toHaveValue('');
    await expect(dlg).toContainText('Gespeichert: https://epg.example.com/…');
    await dlg.getByRole('radio', { name: 'Nur diese Quellen' }).click();
    await dlg.getByRole('checkbox', { name: 'Nordlicht Paket' }).check();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'PATCH', /\/sources\/g-welt$/).at(-1)!.body).toEqual({ guideScope: ['src-nordlicht'] });
    await expect(w.locator('[data-scope]')).toHaveText('Gilt für: Nordlicht Paket');

    // deleting a guide names the channels it serves
    await h.getByRole('button', { name: 'Aktionen für Hafen Guide' }).click();
    await page.getByRole('dialog', { name: 'Hafen Guide' }).getByRole('button', { name: 'Löschen' }).click();
    const ask = page.getByRole('alertdialog', { name: '„Hafen Guide“ löschen?' });
    await expect(ask).toContainText('Er versorgt gerade 1 Sender.');
    await ask.getByRole('button', { name: 'Löschen' }).click();
    await expect(h).toHaveCount(0);
    expect(writes(api, 'DELETE', /\/sources\/g-hafen$/)).toHaveLength(1);
  });

  test('a guide left without a scope is turned on with a new scope', async ({ page, api }) => {
    api.admin.livetv.area.sources.push(ltvGuideMock({ id: 'g-alt', name: 'Alter Guide', position: 2, guideScope: [], enabled: false }));
    await page.goto('/admin/livetv');
    const c = card(page, 'Alter Guide');
    await expect(c.locator('[data-scope]')).toHaveText('Gilt für keine Quelle mehr');
    await c.getByRole('button', { name: 'Aktionen für Alter Guide' }).click();
    await page.getByRole('dialog', { name: 'Alter Guide' }).getByRole('button', { name: 'Aktivieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Programmführer bearbeiten' });
    await expect(dlg.getByRole('radio', { name: 'Nur diese Quellen' })).toHaveAttribute('aria-checked', 'true');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Wähle mindestens eine Quelle.');
    await dlg.getByRole('checkbox', { name: 'Nordlicht Paket' }).check();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'PATCH', /\/sources\/g-alt$/)).toEqual([expect.objectContaining({ body: { guideScope: ['src-nordlicht'], enabled: true } })]);
    await expect(c.locator('[data-scope]')).toHaveText('Gilt für: Nordlicht Paket');
    await expect(c).not.toContainText('Deaktiviert');
  });

  test('moving a guide up sends its new position', async ({ page, api }) => {
    const a = api.admin.livetv.area;
    a.sources.push(ltvGuideMock({ id: 'g-a', name: 'Weltempfang', position: 2 }), ltvGuideMock({ id: 'g-b', name: 'Hafen Guide', position: 3 }));
    await page.goto('/admin/livetv');
    const guides = page.locator('[data-guide]');
    await expect(guides).toHaveCount(2);
    await expect(guides.nth(0)).toHaveAttribute('data-guide', 'g-a');
    // the first cannot go up, the last cannot go down
    await expect(page.getByRole('button', { name: '„Weltempfang“ nach oben' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '„Hafen Guide“ nach unten' })).toBeDisabled();
    const up = page.getByRole('button', { name: '„Hafen Guide“ nach oben' });
    expect((await up.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await up.click();
    await expect(toasts(page).getByText('Reihenfolge gespeichert.')).toBeVisible();
    await expect(guides.nth(0)).toHaveAttribute('data-guide', 'g-b');
    // one PATCH with the previous guide's position: the backend swaps the two
    const patches = writes(api, 'PATCH', /\/sources\/g-[ab]$/);
    expect(patches.map((c) => [c.p.split('/').at(-1), c.body])).toEqual([['g-b', { position: 2 }]]);
    expect(api.admin.livetv.area.sources.filter((x) => x.kind === 'guide').map((x) => [x.id, x.position])).toEqual([['g-a', 3], ['g-b', 2]]);
  });

  test('arrow keys move between the three kinds', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const list = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    await list.getByRole('radio', { name: 'Anbieterliste' }).focus();
    await page.keyboard.press('ArrowRight');
    const dlg = page.getByRole('dialog', { name: 'Programmführer hinzufügen' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('radio', { name: 'Programmführer', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('dialog', { name: 'Quelle hinzufügen' })).toBeVisible();
    await expect(dlg).toHaveCount(0);
  });
});

// Stage 2: a guide from an uploaded XMLTV file
const XML = Buffer.from('<?xml version="1.0"?><tv><channel id="a"/></tv>');
test.describe('admin: Live-TV, Programmführer aus Datei (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); });

  async function fileSheet(page: Page) {
    const dlg = await openGuideSheet(page);
    await dlg.getByRole('radio', { name: 'Datei', exact: true }).click();
    await expect(dlg.getByLabel('Programmführer (XMLTV-Adresse)')).toHaveCount(0);
    await expect(dlg.getByLabel('Aktualisieren', { exact: true })).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Prüfen' })).toHaveCount(0);
    await expect(dlg.locator('[data-file-input]')).toHaveAttribute('accept', '.xml,.xml.gz,.gz');
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('UK Guide');
    return dlg;
  }

  test('add a file guide: create, then PUT the file body', async ({ page, api }) => {
    const dlg = await fileSheet(page);
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.locator('[data-file-error]')).toHaveText('Wähle eine Datei.');
    expect(writes(api, 'POST', /\/sources$/)).toHaveLength(0);
    await dlg.locator('[data-file-input]').setInputFiles({ name: 'guide-uk.xml', mimeType: 'application/xml', buffer: XML });
    await expect(dlg.locator('[data-file-name]')).toHaveText(/^guide-uk\.xml · /);
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    const post = writes(api, 'POST', /\/sources$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toEqual({ kind: 'guide', guideProvider: 'xmltv_file', name: 'UK Guide', guideScope: null, epgShiftMin: 0, enabled: true });
    const a = api.admin.livetv.area;
    expect(a.filePuts).toEqual([{ id: post.length ? a.sources.at(-1)!.id : '', type: 'application/xml', bytes: XML.length }]);
    await expect(card(page, 'UK Guide').locator('[data-file-line]')).toContainText('guide-uk.xml · ');
    await expect(card(page, 'UK Guide').getByRole('button', { name: 'Neue Datei hochladen' })).toBeVisible();
  });

  test.use({ allowedConsole: /status of (413|409)/ });
  test('too big: the 413 copy, the guide stays and the retry only uploads', async ({ page, api }) => {
    const a = api.admin.livetv.area;
    const dlg = await fileSheet(page);
    await dlg.locator('[data-file-input]').setInputFiles({ name: 'huge.xml.gz', mimeType: 'application/gzip', buffer: XML });
    a.fileAnswer = { status: 413, error: 'too_large' };
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.locator('[data-file-error]')).toHaveText('Die Datei ist größer als 300 MB.');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'POST', /\/sources$/)).toHaveLength(1);
    expect(a.filePuts).toHaveLength(2);
    expect(a.filePuts[0]!.type).toBe('application/gzip');
  });

  test('an import already running: the 409 copy', async ({ page, api }) => {
    const dlg = await fileSheet(page);
    await dlg.locator('[data-file-input]').setInputFiles({ name: 'g.xml', mimeType: 'application/xml', buffer: XML });
    api.admin.livetv.area.fileAnswer = { status: 409, error: 'import_running' };
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg.locator('[data-file-error]')).toHaveText('Der Programmführer wird gerade eingelesen – versuche es gleich noch einmal.');
  });

  test('the card shows file name and size; Neue Datei hochladen sends a PUT', async ({ page, api }) => {
    const a = api.admin.livetv.area;
    a.sources.push(ltvFileGuideMock({ id: 'g-file', name: 'UK Guide', position: 2 }));
    await page.goto('/admin/livetv');
    const c = card(page, 'UK Guide');
    await expect(c.locator('[data-file-line]')).toHaveText('guide-uk.xml.gz · 48 MB');
    await expect(c.getByLabel('Aktualisieren', { exact: true })).toHaveCount(0);
    await c.locator('input[type=file]').setInputFiles({ name: 'neu.xml', mimeType: 'application/xml', buffer: XML });
    await expect(toasts(page).getByText('Datei hochgeladen. Der Programmführer wird eingelesen.')).toBeVisible();
    expect(a.filePuts).toEqual([{ id: 'g-file', type: 'application/xml', bytes: XML.length }]);
    await expect(c.locator('[data-file-line]')).toHaveText(/^upload\.xml · /); // the mock's own name; the page re-reads the list
  });
});
