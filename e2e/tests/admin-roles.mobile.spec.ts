// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rollen & Rechte on the phone (roles redesign §5.1): the role list with its menu, *Vergleichen* (one right, every role), the leave guard (mocked API). */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { envOnlyRole } from '../mocks/admin.js';

const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const roleList = (page: Page) => page.getByRole('list', { name: 'Rollen' });
const card = (page: Page, role: string) => roleList(page).getByRole('listitem').filter({ has: page.getByRole('link', { name: role, exact: true }) });
const compare = (page: Page) => page.getByRole('tablist', { name: 'Ansicht' }).getByRole('tab', { name: 'Vergleichen' });
const menu = async (page: Page, role: string) => {
  await page.getByRole('button', { name: `Aktionen für ${role}` }).click();
  return page.getByRole('dialog', { name: role });
};

test.describe('Rollen & Rechte (phone)', () => {
  test.use({ allowedConsole: /status of (409|500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('rows show name, areas and people; nothing overflows at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/admin/roles');
    await expect(page.getByRole('heading', { level: 1, name: 'Rollen & Rechte' })).toBeVisible();
    const gast = card(page, 'Gast');
    await expect(gast).toContainText('Gast');
    await expect(gast.getByRole('link', { name: '3 Personen · 2 Kinderprofile' })).toBeVisible();
    await expect(gast).toContainText('Nur Mediathek');
    await expect(card(page, 'Familie')).toContainText('Mediathek · Wünsche · Gemeinsam · Downloads');
    await expect(card(page, 'Crew')).toContainText('aus .env');
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(page.getByRole('form')).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('rows are ≥ 64 px, the ⋯ button is 44 px and outside the row link', async ({ page }) => {
    await page.goto('/admin/roles');
    for (const name of ['Admin', 'Familie', 'Freund', 'Gast', 'Crew']) {
      const row = card(page, name);
      expect((await row.boundingBox())!.height, name).toBeGreaterThanOrEqual(64);
      const more = row.getByRole('button', { name: `Aktionen für ${name}` });
      const box = (await more.boundingBox())!;
      expect([box.width, box.height], name).toEqual([44, 44]);
      // the menu button is not inside the link, and a press on it opens the menu, not the role page
      expect(await more.evaluate((el) => el.closest('a') === null), name).toBe(true);
      const people = (await row.getByRole('link', { name: /Person/ }).boundingBox())!;
      expect(people.height, name).toBeGreaterThanOrEqual(44);
    }
    await card(page, 'Gast').getByRole('button', { name: 'Aktionen für Gast' }).click();
    await expect(page.getByRole('dialog', { name: 'Gast' })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    // the row's link covers the row: a tap on the summary opens the role page
    await page.keyboard.press('Escape');
    await expect(card(page, 'Gast').getByRole('link', { name: 'Gast', exact: true })).toHaveAttribute('href', '/admin/roles/guest');
    const hit = await card(page, 'Gast').locator('.sum').evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + 4, r.y + r.height / 2)?.closest('a')?.getAttribute('href'); });
    expect(hit).toBe('/admin/roles/guest');
  });

  test('Vergleich: no question repeats the label ("Wer darf Darf …")', async ({ page }) => {
    await page.goto('/admin/roles');
    await compare(page).click();
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
    await tabs.getByRole('tab', { name: 'Vergleichen' }).click();
    await expect(tabs.getByRole('tab', { name: 'Vergleichen' })).toHaveAttribute('aria-selected', 'true');
    await expect(roleList(page)).toHaveCount(0);
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
    // the staged edit stays while the list is shown
    await tabs.getByRole('tab', { name: 'Rollen' }).click();
    await expect(roleList(page)).toBeVisible();
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
    await page.goto('/admin/roles?view=compare');
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
    await expect(card(page, 'Oma & Opa').getByRole('link', { name: 'Oma & Opa', exact: true })).toBeFocused();
    const names = () => roleList(page).locator('li > .main > .head > a.name').allTextContents();
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

  test('the list is the same at every width: crossing 900 px keeps it and the focus', async ({ page }) => {
    await page.goto('/admin/roles');
    await card(page, 'Gast').getByRole('button', { name: 'Aktionen für Gast' }).focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(card(page, 'Gast').getByRole('button', { name: 'Aktionen für Gast' })).toBeFocused();
    // the compare view swaps the matrix and the phone's one-right view and keeps the role
    await compare(page).click();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.getByRole('columnheader', { name: /Gast/ }).getByRole('button', { name: 'Aktionen für Gast' }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ })).toBeVisible();
  });

  test('leaving with unsaved changes asks first, at any width; no changes: no question', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await page.getByRole('link', { name: 'Zurück zur Admin-Übersicht' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.cast = true;
    await page.goto('/admin/roles');
    await compare(page).click();
    await page.getByRole('combobox', { name: /^Wer darf|je Rolle$/ }).selectOption('cast');
    await page.getByRole('switch', { name: 'Gast' }).click();
    // switching the view keeps the page: no question
    await page.getByRole('tab', { name: 'Rollen' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(roleList(page)).toBeVisible();
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
    await page.goto('/admin/roles?view=compare');
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
    await page.goto('/admin/roles?view=compare');
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

  test('an env-only role row: Bearbeiten opens its page; no Umbenennen, no Löschen', async ({ page, api }) => {
    api.admin.matrix.roles.push(envOnlyRole());
    await page.goto('/admin/roles');
    const m = await menu(page, 'Kombüse');
    await expect(m.getByRole('link', { name: 'Bearbeiten' })).toHaveAttribute('href', `/admin/roles/${encodeURIComponent('Küche Crew')}`);
    await expect(m.getByRole('button', { name: 'Umbenennen' })).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
  });
});
