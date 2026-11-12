// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rollen & Rechte on the phone (spec §6.1): one card per role, the full-screen role sheet, *Vergleich*, the menu, the leave guard (mocked API). */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { envOnlyRole } from '../mocks/admin.js';

const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const card = (page: Page, role: string) => page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Rolle „${role}“ bearbeiten` }) });
const menu = async (page: Page, role: string) => {
  await page.getByRole('button', { name: `Aktionen für ${role}` }).click();
  return page.getByRole('dialog', { name: role });
};

test.describe('Rollen & Rechte (phone)', () => {
  test.use({ allowedConsole: /status of (409|500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('cards show name, people and summary; nothing overflows at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/admin/roles');
    await expect(page.getByRole('heading', { level: 1, name: 'Rollen & Rechte' })).toBeVisible();
    const gast = card(page, 'Gast');
    await expect(gast).toContainText('Gast');
    await expect(gast).toContainText('3 Personen · 2 Kinderprofile');
    await expect(gast).toContainText(/\d+ Streams? · [\d,]+ Mbit\/s · ab 12 · Downloads (an|aus)/);
    await expect(card(page, 'Crew')).toContainText('aus .env');
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(page.getByRole('form')).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('tap opens the sheet full-screen and stages; the save bar counts it at once', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await card(page, 'Gast').getByRole('button', { name: 'Rolle „Gast“ bearbeiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Gast“' });
    await expect(sheet).toBeVisible();
    const vp = page.viewportSize()!;
    await expect.poll(async () => (await sheet.boundingBox())?.width).toBe(vp.width);
    await sheet.getByRole('combobox', { name: 'Altersfreigabe' }).selectOption('16');
    await sheet.getByRole('button', { name: 'Schließen' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(card(page, 'Gast')).toContainText('ab 16');
    await expect(card(page, 'Gast')).toContainText('Nicht gespeichert');
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle · betrifft 3 Personen');
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { maxParentalRating: 16 } }]);
    await expect(card(page, 'Gast')).not.toContainText('Nicht gespeichert');
    // the toast stands above the save bar's room, not under it
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Vergleich: no question repeats the label ("Wer darf Darf …")', async ({ page }) => {
    await page.goto('/admin/roles');
    await page.getByRole('tablist', { name: 'Ansicht' }).getByRole('tab', { name: 'Vergleich' }).click();
    const pick = page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ });
    const values = await pick.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) {
      await pick.selectOption(v);
      const name = (await pick.evaluate((el) => (el as HTMLSelectElement).labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? '')).trim();
      expect(name, v).not.toMatch(/Wer darf (Darf|Auf|Mehr|Downloads|Kommentare)|erlaubt\?$/);
    }
  });

  test('Vergleich: who may cast', async ({ page, api }) => {
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.cast = true;
    await page.goto('/admin/roles');
    const tabs = page.getByRole('tablist', { name: 'Ansicht' });
    await expect(tabs.getByRole('tab', { name: 'Rollen' })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: 'Vergleich' }).click();
    await expect(tabs.getByRole('tab', { name: 'Vergleich' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /bearbeiten/ }) })).toHaveCount(0);
    const pick = page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ });
    await pick.selectOption('cast');
    await expect(pick).toHaveAccessibleName('Wer darf auf Fernseher übertragen?');
    const guest = page.getByRole('switch', { name: 'Gast' });
    await expect(guest).toBeChecked();
    await guest.click();
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle');
    await expect(guest).not.toBeChecked();
    // the admin's switches are locked
    await expect(page.getByRole('switch', { name: 'Admin' })).toHaveCount(0);
    await expect(page.getByText('Admins dürfen immer alles').first()).toBeVisible();
    // the staged edit shows on the cards too
    await tabs.getByRole('tab', { name: 'Rollen' }).click();
    await expect(bar(page)).toContainText('1 Änderung');
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { perms: { cast: false } } }]);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('a numeric field compares too (streams); a value set in the role says what the default is', async ({ page, api }) => {
    const guest = api.admin.matrix.roles.find((r) => r.key === 'guest')!;
    guest.values.maxStreams = 3;
    guest.sources.maxStreams = 'role';
    await page.goto('/admin/roles');
    await page.getByRole('tab', { name: 'Vergleich' }).click();
    await page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ }).selectOption('maxStreams');
    await expect(page.getByText('geändert (Standard: 1)')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Gleichzeitige Streams je Rolle' })).toBeVisible();
    await page.getByRole('spinbutton', { name: 'Gast' }).fill('5');
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle');
  });

  test('the menu: edit, duplicate, history, delete; env-only roles stay last without move actions', async ({ page, api }) => {
    api.admin.matrix.roles.push(envOnlyRole());
    await page.goto('/admin/roles');
    const only = await menu(page, 'Kombüse');
    await expect(only.getByRole('button', { name: 'Nach oben' })).toBeDisabled();
    await expect(only.getByRole('button', { name: 'Nach unten' })).toBeDisabled();
    await page.keyboard.press('Escape');
    // Crew has a row: the last place to move to
    const crew = await menu(page, 'Crew');
    await expect(crew.getByRole('button', { name: 'Nach unten' })).toBeDisabled();
    await expect(crew.getByRole('button', { name: 'Nach oben' })).toBeEnabled();
    await page.keyboard.press('Escape');
    const gast = await menu(page, 'Gast');
    await expect(gast.getByRole('button', { name: 'Nach unten' })).toBeEnabled();
    await expect(gast.getByRole('button', { name: 'Nach oben' })).toBeEnabled();
    await gast.getByRole('button', { name: 'Verlauf' }).click();
    await expect(page.getByRole('dialog', { name: 'Verlauf · Gast' })).toBeVisible();
    await page.keyboard.press('Escape');
    await (await menu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Oma & Opa');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ angelegt.')).toBeVisible();
    await expect(card(page, 'Oma & Opa').getByRole('button', { name: 'Rolle „Oma & Opa“ bearbeiten' })).toBeFocused();
    const names = () => page.getByRole('listitem').filter({ has: page.getByRole('button', { name: /bearbeiten/ }) }).locator('.rn').allTextContents();
    await expect.poll(names).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew', 'Oma & Opa', 'Kombüse']);
    // up, then delete the empty role (asks once)
    await (await menu(page, 'Oma & Opa')).getByRole('button', { name: 'Nach oben' }).click();
    await expect.poll(() => api.admin.matrix.orders.at(-1)).toEqual(['admin', 'family', 'friend', 'guest', 'oma-opa', 'crew', 'Küche Crew']);
    await (await menu(page, 'Oma & Opa')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog', { name: 'Rolle „Oma & Opa“ löschen?' }).getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ gelöscht.')).toBeVisible();
    await expect(card(page, 'Oma & Opa')).toHaveCount(0);
  });

  test('the card menu button is a 44 px target', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/roles');
    const box = await page.getByRole('button', { name: 'Aktionen für Gast' }).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('crossing 900 px keeps the focus on the same role', async ({ page }) => {
    await page.goto('/admin/roles');
    await card(page, 'Gast').getByRole('button', { name: 'Aktionen für Gast' }).focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('grid')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Gast/ }).getByRole('button', { name: 'Aktionen für Gast' })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card(page, 'Gast').getByRole('button', { name: 'Aktionen für Gast' })).toBeFocused();
  });

  test('the sheet opens from the menu (Umbenennen) and a rename stages', async ({ page }) => {
    await page.goto('/admin/roles');
    await (await menu(page, 'Freund')).getByRole('button', { name: 'Umbenennen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Freund“' });
    await expect(sheet.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Bekannte');
    await sheet.getByRole('button', { name: 'Schließen' }).click();
    await expect(card(page, 'Bekannte')).toBeVisible();
  });

  test('leaving with unsaved changes asks first, at any width; no changes: no question', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await page.getByRole('link', { name: 'Zurück zur Admin-Übersicht' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.cast = true;
    await page.goto('/admin/roles');
    await page.getByRole('tab', { name: 'Vergleich' }).click();
    await page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ }).selectOption('cast');
    await page.getByRole('switch', { name: 'Gast' }).click();
    const back = page.getByRole('link', { name: 'Zurück zur Admin-Übersicht' });
    await back.click();
    const dlg = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await expect(dlg).toContainText('1 Rolle hat ungespeicherte Änderungen');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await back.click();
    await dlg.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('a failed save keeps the edit and offers retry', async ({ page }) => {
    await page.route('**/api/admin/roles/guest', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
    await page.goto('/admin/roles');
    await page.getByRole('tab', { name: 'Vergleich' }).click();
    await page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ }).selectOption('download');
    await page.getByRole('switch', { name: 'Gast' }).click();
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page).getByRole('button', { name: 'Erneut anwenden' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Gast' })).toBeChecked();
  });

  test('the admin nav says Rollen & Rechte', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: /Rollen & Rechte/ })).toBeVisible();
  });

  test('Vergleich: the controls lock while a save runs', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/roles/guest', async (r) => { if (r.request().method() === 'PUT') await held; await r.fallback(); });
    await page.goto('/admin/roles');
    await page.getByRole('tab', { name: 'Vergleich' }).click();
    const pick = page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ });
    await pick.selectOption('download');
    await page.getByRole('switch', { name: 'Gast' }).click();
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('Aktualisiere 1 von 1 …');
    await expect(pick).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Gast' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Freund' })).toBeDisabled();
    release();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await expect(pick).toBeEnabled();
    await expect(page.getByRole('switch', { name: 'Freund' })).toBeEnabled();
  });

  test('an env-only role card: no Umbenennen, the sheet has no name or invitable switch', async ({ page, api }) => {
    api.admin.matrix.roles.push(envOnlyRole());
    await page.goto('/admin/roles');
    const m = await menu(page, 'Kombüse');
    await expect(m.getByRole('button', { name: 'Bearbeiten' })).toBeEnabled();
    await expect(m.getByRole('button', { name: 'Umbenennen' })).toHaveCount(0);
    await m.getByRole('button', { name: 'Bearbeiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Kombüse“' });
    await expect(sheet.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
    await expect(sheet.getByRole('switch', { name: 'Für Einladungen wählbar' })).toHaveCount(0);
  });
});
