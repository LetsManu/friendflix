// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rollen & Rechte on the phone (roles redesign §5.1, §5.5): the role list with its menu, *Vergleichen* (one right, every role, read-only) (mocked API). */
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
    const pick = page.getByRole('combobox', { name: /^Wer |je Rolle$|^Welche / });
    const values = await pick.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) {
      await pick.selectOption(v);
      const name = (await pick.evaluate((el) => (el as HTMLSelectElement).labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? '')).trim();
      expect(name, v).not.toMatch(/Wer darf (Darf|Auf|Mehr|Downloads|Kommentare)|erlaubt\?$/);
    }
  });

  test('Vergleich rows link to the role page', async ({ page, api }) => {
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.cast = true;
    await page.goto('/admin/roles');
    const tabs = page.getByRole('tablist', { name: 'Ansicht' });
    await expect(tabs.getByRole('tab', { name: 'Rollen' })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: 'Vergleichen' }).click();
    await expect(tabs.getByRole('tab', { name: 'Vergleichen' })).toHaveAttribute('aria-selected', 'true');
    await expect(roleList(page)).toHaveCount(0);
    const pick = page.getByRole('combobox', { name: /^Wer |je Rolle$|^Welche / });
    await pick.selectOption('cast');
    await expect(pick).toHaveAccessibleName('Wer darf auf Fernseher übertragen?');
    // read-only: each role's value in words and a 44 px link to its page at that right; no control to change it here
    const rows = page.getByRole('list', { name: 'Wer darf auf Fernseher übertragen?' });
    await expect(rows.getByRole('listitem').filter({ hasText: 'Gast' })).toContainText('erlaubt');
    await expect(rows.getByRole('listitem').filter({ hasText: 'Freund' })).toContainText('erlaubt');
    await expect(page.getByRole('switch')).toHaveCount(0);
    // the link names the role, the right and its value
    const edit = rows.getByRole('link', { name: 'Gast, Auf Fernseher übertragen: erlaubt, bearbeiten' });
    await expect(edit).toHaveText('Bearbeiten');
    await expect(edit).toHaveAttribute('href', '/admin/roles/guest?field=cast');
    const box = (await edit.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    // the admin's switches are locked: said so, no link
    await expect(rows.getByRole('link', { name: /^Admin,/ })).toHaveCount(0);
    await expect(rows.getByText('Admins dürfen immer alles')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await edit.click();
    await expect(page).toHaveURL(/\/admin\/roles\/guest\?field=cast$/);
    await expect(page.getByRole('switch', { name: 'Auf Fernseher übertragen' })).toBeFocused();
  });

  test('Vergleich on the phone has the Bereiche and the Kanalgruppen too, like the desktop matrix', async ({ page, api }) => {
    api.admin.matrix.features.livetv = true;
    await page.goto('/admin/roles?view=compare');
    const pick = page.getByRole('combobox', { name: /^Wer |je Rolle$|^Welche / });
    // the areas come first
    await expect(pick).toHaveAccessibleName('Wer hat den Bereich „Mediathek“?');
    const values = await pick.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
    expect(values.slice(0, 5)).toEqual(['area:library', 'area:livetv', 'area:requests', 'area:together', 'area:downloads']);
    expect(values).toContain('livetvGroups');
    await pick.selectOption('area:downloads');
    const rows = page.getByRole('list', { name: 'Wer hat den Bereich „Downloads“?' });
    await expect(rows.getByRole('listitem').filter({ hasText: 'Freund' })).toContainText('nicht erlaubt');
    await expect(rows.getByRole('link', { name: 'Freund, Downloads: nicht erlaubt, bearbeiten' })).toHaveAttribute('href', '/admin/roles/friend?field=area%3Adownloads');
    await pick.selectOption('livetvGroups');
    await expect(pick).toHaveAccessibleName('Welche Kanalgruppen sieht jede Rolle?');
    await expect(page.getByRole('list', { name: 'Welche Kanalgruppen sieht jede Rolle?' }).getByRole('listitem').filter({ hasText: 'Familie' })).toContainText('Sport, Nachrichten +2');
  });

  test('a numeric field compares too (streams); a value set in the role says what the default is', async ({ page, api }) => {
    const guest = api.admin.matrix.roles.find((r) => r.key === 'guest')!;
    guest.values.maxStreams = 3;
    guest.sources.maxStreams = 'role';
    await page.goto('/admin/roles?view=compare');
    await page.getByRole('combobox', { name: /^Wer |je Rolle$|^Welche / }).selectOption('maxStreams');
    await expect(page.getByRole('combobox', { name: 'Gleichzeitige Streams je Rolle' })).toBeVisible();
    const gast = page.getByRole('list', { name: 'Gleichzeitige Streams je Rolle' }).getByRole('listitem').filter({ hasText: 'Gast' });
    await expect(gast).toContainText('3');
    await expect(gast).toContainText('geändert (Standard: 1)');
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(gast.getByRole('link', { name: 'Gast, Gleichzeitige Streams: 3, geändert, bearbeiten' })).toHaveAttribute('href', '/admin/roles/guest?field=maxStreams');
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
    const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Oma & Opa');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ angelegt.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/roles\/oma-opa$/); // the copy's page
    await page.getByRole('link', { name: 'Rollen', exact: true }).click();
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
    await page.getByRole('columnheader', { name: /Gast/ }).getByRole('link', { name: 'Rolle „Gast“ bearbeiten' }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('combobox', { name: /^Wer |je Rolle$|^Welche / })).toBeVisible();
  });

  test('the admin nav says Rollen & Rechte', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: /Rollen & Rechte/ })).toBeVisible();
  });

  test('an env-only role row: Bearbeiten opens its page; no Umbenennen, no Löschen', async ({ page, api }) => {
    api.admin.matrix.roles.push(envOnlyRole());
    await page.goto('/admin/roles');
    const m = await menu(page, 'Kombüse');
    await expect(m.getByRole('link', { name: 'Bearbeiten' })).toHaveAttribute('href', `/admin/roles/${encodeURIComponent('Küche Crew')}`);
    await expect(m.getByRole('button', { name: 'Umbenennen' })).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
  });

  test('Neue Rolle on a phone: the options fit, nothing overflows, the dialog scrolls inside itself; one-line area lines', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'Neue Rolle' }).click();
    const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
    await expect(dlg.getByRole('radio')).toHaveCount(5);
    for (const o of await dlg.locator('.opt').all()) expect((await o.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const box = (await page.locator('.dlg').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    // a long area line never widens the dialog past the screen (it ends in "…")
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    // each area line is one line (the dialog mockup); a long one ends in "…" on screen and stays whole as the radio's description
    for (const d of await dlg.locator('.opt .de').all()) expect((await d.boundingBox())!.height).toBeLessThan(24);
    await expect(dlg.getByRole('radio', { name: 'Familie' })).toHaveAccessibleDescription('Mediathek · Wünsche · Gemeinsam · Downloads');
    await dlg.getByRole('radio', { name: 'Kopie von …' }).check();
    const wide = (await page.locator('.dlg').boundingBox())!;
    expect(wide.x + wide.width).toBeLessThanOrEqual(360);
    // the select that appears is scrolled into view
    await expect(dlg.getByRole('combobox', { name: 'Rolle zum Kopieren' })).toBeInViewport({ ratio: 1 });
    await dlg.getByRole('button', { name: 'Anlegen' }).scrollIntoViewIfNeeded();
    await expect(dlg.getByRole('button', { name: 'Anlegen' })).toBeInViewport();
  });
});
