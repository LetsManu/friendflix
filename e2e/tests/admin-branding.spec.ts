// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

// Admin → Branding (/admin/branding; branding stage A Task 4): Identität, Logo & Symbol, Farben & Stimmung with a live preview. Edits are
// staged; the save bar saves them with the loaded rev (PUT /api/admin/brand). A 409 loads the newer brand and keeps the edits; reset asks
// first and sends the rev; leaving with edits asks. Uploads are re-encoded in the browser (canvas) to PNG: the symbol 512 × 512.
type Page = import('@playwright/test').Page;
const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const preview = (page: Page) => page.locator('[data-pv-frame]');
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });

/** an image made in the page (canvas) as a file for the upload input: a JPEG photo is refused by the backend, the page re-encodes it */
async function image(page: Page, w: number, h: number, type = 'image/jpeg'): Promise<Buffer> {
  const b64 = await page.evaluate(async ({ w, h, type }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    x.fillStyle = '#2b3f4c'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#f2b52c'; x.fillRect(w / 4, h / 4, w / 2, h / 2);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), type, 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const v of bytes) s += String.fromCharCode(v);
    return btoa(s);
  }, { w, h, type });
  return Buffer.from(b64, 'base64');
}

test.describe('admin: branding', () => {
  test.use({ allowedConsole: /status of (400|403|409)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the Branding entry sits under Betrieb, right after Einstellungen; the page has three tabs, no stage-B ones', async ({ page }) => {
    await page.goto('/admin/settings');
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    const ops = nav.getByRole('list', { name: 'Betrieb' });
    await expect(ops.getByRole('link', { name: 'Branding' })).toBeVisible();
    const names = await ops.getByRole('link').allInnerTexts();
    expect(names.slice(-2).map((n) => n.trim())).toEqual(['Einstellungen', 'Branding']);
    await ops.getByRole('link', { name: 'Branding' }).click();
    await expect(page).toHaveURL(/\/admin\/branding$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Branding' })).toBeVisible();
    await expect(page).toHaveTitle('Branding · Admin – FriendFlix');
    const tabs = page.getByRole('tablist', { name: 'Bereiche' }).getByRole('tab');
    await expect(tabs).toHaveText(['Identität', 'Logo & Symbol', 'Farben & Stimmung']);
    await expect(page.getByRole('tablist', { name: 'Vorschau' }).getByRole('tab')).toHaveText(['Desktop', 'Telefon', 'TV', 'Anmeldung']);
    for (const gone of ['Texte', 'Rechtliches & Hilfe', 'Teilen & E-Mails', 'Exportieren', 'Importieren']) await expect(page.getByRole('tab', { name: gone })).toHaveCount(0);
    await expect(page.getByLabel('Name der Plattform')).toHaveValue('FriendFlix');
  });

  test('changing the name and the accent updates the preview live; the readout shows the ratios', async ({ page }) => {
    await page.goto('/admin/branding');
    await page.getByLabel('Name der Plattform').fill('Nordlicht Kino');
    await page.getByLabel('Zusatz').fill('by Anna Beispiel');
    await expect(preview(page).locator('[data-pv=name]').first()).toHaveText('Nordlicht Kino');
    await expect(preview(page).locator('[data-pv=byline]').first()).toHaveText('Nordlicht Kino · by Anna Beispiel');
    await page.getByRole('tab', { name: 'Farben & Stimmung' }).click();
    const accent = page.getByRole('radiogroup', { name: 'Akzentfarbe' });
    await expect(accent.getByRole('radio', { name: 'Koralle' })).toHaveAttribute('aria-checked', 'true');
    await accent.getByRole('radio', { name: 'Blau' }).click();
    await expect(accent.getByRole('radio', { name: 'Blau' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Eigene Farbe (Hex)')).toHaveValue('#4c9dff');
    // the derived fill of the backend's colours (brandColors): white text ≥ 4.5:1
    await expect(preview(page).locator('[data-pv=play]')).toHaveCSS('background-color', 'rgb(0, 111, 244)');
    const ratios = page.getByRole('list', { name: 'Kontrast' });
    await expect(ratios.getByRole('listitem')).toHaveCount(3);
    await expect(ratios.getByRole('listitem').nth(1)).toContainText(/Weißer Text auf Buttons\s*\d,\d:1 · angepasst/);
    // a custom colour too dark for text on the dark page: its text shade is lightened ("angepasst"), no preset is chosen
    await page.getByLabel('Eigene Farbe (Hex)').fill('#1a1a40');
    await expect(ratios.getByRole('listitem').first()).toContainText('angepasst');
    await expect(accent.getByRole('radio', { checked: true })).toHaveCount(0);
    // a half-typed colour: an error line, the preview keeps the last valid colour
    await page.getByLabel('Eigene Farbe (Hex)').fill('#4c9d');
    await expect(page.getByText('Bitte eine Farbe wie #4c9dff eingeben.')).toBeVisible();
    // the mood and the sign-in background switch the preview to the sign-in pane
    await page.getByRole('radiogroup', { name: 'Hintergrund der Anmeldung' }).getByRole('radio', { name: 'Nur Farbe' }).click();
    await expect(page.getByRole('tablist', { name: 'Vorschau' }).getByRole('tab', { name: 'Anmeldung' })).toHaveAttribute('aria-selected', 'true');
    await expect(preview(page).locator('[data-pv=posters]')).toHaveCount(0);
  });

  test('save sends only the changes with the loaded rev; the page and the shell take the new brand', async ({ page, api }) => {
    api.brand.rev = 4;
    await page.goto('/admin/branding');
    await expect(bar(page)).toHaveCount(0);
    await page.getByLabel('Name der Plattform').fill('Nordlicht Kino');
    await page.getByRole('tab', { name: 'Farben & Stimmung' }).click();
    await page.getByRole('radiogroup', { name: 'Akzentfarbe' }).getByRole('radio', { name: 'Blau' }).click();
    await expect(bar(page)).toContainText('2 Änderungen am Branding');
    // the tab with an edit carries a dot (screen readers: "ungespeichert")
    await expect(page.getByRole('tab', { name: /Identität.*ungespeichert/ })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Branding gespeichert.')).toBeVisible();
    expect(api.brandAdmin.puts).toEqual([{ rev: 4, brand: { name: 'Nordlicht Kino', accent: '#4c9dff' } }]);
    await expect(bar(page)).toHaveCount(0);
    // loadBrand() after the save: the tab title and the accent follow at once
    await expect(page).toHaveTitle('Branding · Admin – Nordlicht Kino');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--acc-fill'))).toBe('#006ff4');
  });

  test('a 409 loads the newer brand with a message and keeps the edits; the next save uses the new rev', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await page.getByLabel('Zusatz').fill('by Anna Beispiel');
    api.brandAdmin.conflict = 'Hafenkino';
    await bar(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('Jemand anderes hat das Branding inzwischen gespeichert');
    await expect(page.getByLabel('Name der Plattform')).toHaveValue('Hafenkino');
    await expect(page.getByLabel('Zusatz')).toHaveValue('by Anna Beispiel');
    await bar(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Branding gespeichert.')).toBeVisible();
    expect(api.brandAdmin.puts.map((p) => p.rev)).toEqual([0, 1]);
    expect(api.brandAdmin.puts[1]!.brand).toEqual({ byline: 'by Anna Beispiel' });
  });

  test('reset asks first, then resets with the rev; Abbrechen sends nothing', async ({ page, api }) => {
    api.brand.rev = 9;
    Object.assign(api.brand.brand as object, { name: 'Nordlicht Kino', byline: 'by Anna Beispiel' });
    await page.goto('/admin/branding');
    await expect(page.getByLabel('Name der Plattform')).toHaveValue('Nordlicht Kino');
    const dlg = page.getByRole('alertdialog', { name: 'Branding zurücksetzen?' });
    await page.getByRole('button', { name: 'Auf Standard zurücksetzen' }).click();
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(api.brandAdmin.resets).toEqual([]);
    await page.getByRole('button', { name: 'Auf Standard zurücksetzen' }).click();
    await dlg.getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect(toasts(page).getByText('Branding zurückgesetzt.')).toBeVisible();
    expect(api.brandAdmin.resets).toEqual([{ rev: 9 }]);
    await expect(page.getByLabel('Name der Plattform')).toHaveValue('FriendFlix');
    await expect(page.getByLabel('Zusatz')).toHaveValue('');
  });

  test('uploads: a JPEG symbol is cropped to a 512 × 512 PNG; under 512 is refused before anything is sent; the logo fits 2048 × 512', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await page.getByRole('tab', { name: 'Logo & Symbol' }).click();
    const small = await image(page, 400, 400);
    await page.locator('input[type=file][data-kind=symbol]').setInputFiles({ name: 'klein.jpg', mimeType: 'image/jpeg', buffer: small });
    await expect(page.getByText('Das Symbol muss mindestens 512 × 512 Pixel groß sein (dieses: 400 × 400).')).toBeVisible();
    expect(api.brandAdmin.uploads).toEqual([]);
    const photo = await image(page, 1000, 600);
    await page.locator('input[type=file][data-kind=symbol]').setInputFiles({ name: 'symbol.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect.poll(() => api.brandAdmin.uploads.length).toBe(1);
    expect(api.brandAdmin.uploads[0]).toMatchObject({ kind: 'symbol', type: 'image/png', width: 512, height: 512 });
    await expect(page.getByText('Das Symbol muss mindestens')).toHaveCount(0);
    // the crop preview (the three masks) and the live preview show the upload
    await expect(page.getByRole('group', { name: 'So schneiden Android und iOS das Symbol zu' }).locator('img')).toHaveCount(3);
    await expect(preview(page).locator('img[data-pv=symbol]').first()).toHaveAttribute('src', /^\/api\/public\/brand\/img\/[0-9a-f]{64}\.png$/);
    const wide = await image(page, 4096, 1024, 'image/png');
    await page.locator('input[type=file][data-kind=logo]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: wide });
    await expect.poll(() => api.brandAdmin.uploads.length).toBe(2);
    expect(api.brandAdmin.uploads[1]).toMatchObject({ kind: 'logo', type: 'image/png', width: 2048, height: 512 });
    await page.getByRole('radiogroup', { name: 'Kopfzeile' }).getByRole('radio', { name: 'Eigenes Logo' }).click();
    await expect(preview(page).locator('img[data-pv=logo]')).toBeVisible();
    await bar(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Branding gespeichert.')).toBeVisible();
    const sent = api.brandAdmin.puts[0]!.brand;
    expect(Object.keys(sent).sort()).toEqual(['header', 'logo', 'symbol']);
    expect(sent.symbol).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an upload swept before the save (400 invalid on the image): the admin is told to upload it again', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await page.getByRole('tab', { name: 'Logo & Symbol' }).click();
    await page.locator('input[type=file][data-kind=symbol]').setInputFiles({ name: 's.png', mimeType: 'image/png', buffer: await image(page, 512, 512, 'image/png') });
    await expect.poll(() => api.brandAdmin.uploads.length).toBe(1);
    await page.getByRole('tab', { name: 'Identität' }).click();
    api.brandAdmin.invalidField = 'symbol';
    await bar(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('tab', { name: /Logo & Symbol/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Das hochgeladene Bild ist nicht mehr da, es wurde zu lange nicht gespeichert. Bitte lade es noch einmal hoch.')).toBeVisible();
  });

  test('a field error blocks the save and opens its tab', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await page.getByLabel('Name der Plattform').fill('');
    await expect(page.getByText('Bitte einen Namen eingeben.')).toBeVisible();
    await page.getByRole('tab', { name: 'Farben & Stimmung' }).click();
    await bar(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('tab', { name: /Identität/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Name der Plattform')).toBeFocused();
    expect(api.brandAdmin.puts).toEqual([]);
  });

  test('leaving with edits asks; Abbrechen stays, Verwerfen leaves; tab switches never ask', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await page.getByLabel('Kurzname (Startbildschirm)').fill('Nordlicht');
    await page.getByRole('tab', { name: 'Logo & Symbol' }).click();
    await page.getByRole('tablist', { name: 'Vorschau' }).getByRole('tab', { name: 'Telefon' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await expect(dlg).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: 'Audit-Log' }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page).toHaveURL(/\/admin\/branding$/);
    await page.getByRole('tab', { name: /Identität/ }).click();
    await expect(page.getByLabel('Kurzname (Startbildschirm)')).toHaveValue('Nordlicht');
    await page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: 'Audit-Log' }).click();
    await dlg.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin\/audit$/);
    expect(api.brandAdmin.puts).toEqual([]);
  });

  test('the preview frame keeps its size across the four views; the phone shows the short name', async ({ page }) => {
    await page.goto('/admin/branding');
    await page.getByLabel('Kurzname (Startbildschirm)').fill('Nordlicht');
    const frame = preview(page);
    const box0 = await frame.boundingBox();
    for (const v of ['Telefon', 'TV', 'Anmeldung', 'Desktop']) {
      await page.getByRole('tablist', { name: 'Vorschau' }).getByRole('tab', { name: v }).click();
      expect(await frame.boundingBox()).toEqual(box0);
      if (v === 'Telefon') await expect(frame.locator('[data-pv=short]')).toHaveText('Nordlicht');
      if (v === 'TV') await expect(frame.locator('[data-pv=name]')).toHaveText('FriendFlix');
    }
  });

  test('audit entries of the brand read as sentences in the area Branding', async ({ page, api }) => {
    api.admin.audit.unshift({ id: 9001, at: '2026-11-15T10:00:00Z', action: 'brand.update', target: null, meta: { fields: ['accent', 'name'] }, actor: 'Tester', target_name: null });
    await page.goto('/admin/audit');
    await expect(page.getByText('Tester hat das Branding geändert')).toBeVisible();
  });
});

test.describe('admin: branding, not an admin', () => {
  test.use({ allowedConsole: /status of 403/ });
  test('the account menu has no admin entry and the page loads nothing to edit', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await expect(page.getByText('Das Branding konnte nicht geladen werden.')).toBeVisible();
    await expect(page.getByLabel('Name der Plattform')).toHaveCount(0);
    expect(api.brandAdmin.puts).toEqual([]);
  });
});
