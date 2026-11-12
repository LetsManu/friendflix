// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rollen & Rechte on the desktop (spec §6.1): the role matrix, staged edits, the save bar and the review sheet (mocked API). */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import type { MatrixMockRole } from '../mocks/admin.js';

const grid = (page: Page) => page.getByRole('grid', { name: 'Rechte der Rollen' });
const cell = (page: Page, name: string | RegExp) => grid(page).getByRole('gridcell', { name, exact: typeof name === 'string' ? true : undefined });
const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });

/** guest: Altersfreigabe ab 12 → ab 16 through the cell's popover */
async function stageGuestRating(page: Page): Promise<void> {
  await cell(page, 'Gast, Altersfreigabe: ab 12').click();
  const pop = page.getByRole('dialog', { name: 'Gast · Altersfreigabe' });
  await pop.getByRole('combobox', { name: 'Altersfreigabe' }).selectOption('16');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
}

test.describe('Rollen & Rechte: role matrix (desktop)', () => {
  test.use({ allowedConsole: /status of 502/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('edit → review → save', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await expect(grid(page).getByRole('columnheader', { name: /Gast/ })).toContainText('3 Personen · 2 Kinderprofile');
    await stageGuestRating(page);
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle · betrifft 3 Personen');
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Änderungen prüfen' });
    await expect(sheet.getByText('Gast · Altersfreigabe: ab 12 → ab 16')).toBeVisible();
    await expect(sheet).toContainText('Die Freigaben von 3 Personen und 5 Profilen werden auf dem Medienserver aktualisiert.');
    // hold the write: the bar shows the progress meanwhile
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/roles/guest', async (r) => { if (r.request().method() === 'PUT') await held; await r.fallback(); });
    await sheet.getByRole('button', { name: 'Speichern' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(bar(page)).toContainText('Aktualisiere 1 von 1 …');
    release();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { maxParentalRating: 16 } }]);
    await expect(bar(page)).toHaveCount(0);
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, geändert')).toBeVisible();
  });

  test('partial failure offers retry', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto('/admin/roles');
    await stageGuestRating(page);
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    // the settings are stored either way: the cell shows the new value, nothing is staged any more
    await expect(cell(page, /^Gast, Altersfreigabe: ab 16/)).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Änderungen prüfen' })).toHaveCount(0);
    api.admin.matrix.policyPartial = false;
    await bar(page).getByRole('button', { name: 'Erneut anwenden' }).click();
    await expect(bar(page)).toHaveCount(0);
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { maxParentalRating: 16 } }, { role: 'guest', body: { maxParentalRating: 16 } }]);
  });

  test('retry sends only the failed role\'s last body, not newer edits', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto('/admin/roles');
    await stageGuestRating(page);
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    // a new edit while the failure stands
    await cell(page, 'Freund, Watch-Partys: erlaubt').click();
    await page.getByRole('dialog', { name: 'Freund · Watch-Partys' }).getByRole('switch', { name: 'Watch-Partys' }).click();
    await page.keyboard.press('Escape');
    api.admin.matrix.policyPartial = false;
    await bar(page).getByRole('button', { name: 'Erneut anwenden' }).click();
    await expect(bar(page)).not.toContainText('Konten konnten nicht');
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle · betrifft 7 Personen');
    // the newer edit is still staged: not "Änderungen gespeichert."
    await expect(toasts(page).getByText('1 fehlgeschlagene Rolle gespeichert.')).toBeVisible();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toHaveCount(0);
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { maxParentalRating: 16 } }, { role: 'guest', body: { maxParentalRating: 16 } }]);
    await expect(cell(page, 'Freund, Watch-Partys: nicht erlaubt, nicht gespeichert')).toHaveClass(/staged/);
  });

  test('libraries: the last ticked one cannot be unticked (a role keeps at least one)', async ({ page }) => {
    await page.goto('/admin/roles');
    await cell(page, 'Familie, Bibliotheken: alle').click();
    const pop = page.getByRole('dialog', { name: 'Familie · Bibliotheken' });
    await pop.getByRole('checkbox', { name: 'Alle Bibliotheken' }).uncheck();
    const before = await pop.boundingBox();
    await pop.getByRole('checkbox', { name: 'Filme' }).uncheck();
    await pop.getByRole('checkbox', { name: 'Serien' }).uncheck();
    const last = pop.getByRole('checkbox', { name: 'Musik' });
    await expect(last).toBeChecked();
    await expect(last).toBeDisabled();
    await expect(pop.getByText('Mindestens eine Bibliothek bleibt freigegeben.')).toBeVisible();
    expect(await pop.boundingBox()).toEqual(before); // the hint's room was there: the popover does not grow
    await page.keyboard.press('Escape');
    await expect(cell(page, 'Familie, Bibliotheken: 1 Bibliothek, nicht gespeichert')).toBeVisible();
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle');
  });

  test('grid keyboard', async ({ page }) => {
    await page.goto('/admin/roles');
    // one tab stop: the first cell
    await expect(grid(page).locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
    await expect(cell(page, 'Admin, Bibliotheken: alle')).toHaveAttribute('tabindex', '0');
    await cell(page, 'Gast, Altersfreigabe: ab 12').focus();
    await page.keyboard.press('ArrowDown');
    await expect(cell(page, 'Gast, Gleichzeitige Streams: 1')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(cell(page, 'Freund, Gleichzeitige Streams: 2')).toBeFocused();
    await page.keyboard.press('End');
    await expect(cell(page, 'Crew, Gleichzeitige Streams: 3')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(cell(page, 'Crew, Gleichzeitige Streams: 3')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(cell(page, 'Admin, Gleichzeitige Streams: 4')).toBeFocused();
    await page.keyboard.press('Control+Home');
    await expect(cell(page, 'Admin, Bibliotheken: alle')).toBeFocused();
    await expect(cell(page, 'Admin, Bibliotheken: alle')).toHaveAttribute('tabindex', '0');
    // Enter opens the editor, Escape closes it and gives the focus back to the cell
    const rating = cell(page, 'Gast, Altersfreigabe: ab 12');
    await rating.focus();
    await page.keyboard.press('Enter');
    const pop = page.getByRole('dialog', { name: 'Gast · Altersfreigabe' });
    const select = pop.getByRole('combobox', { name: 'Altersfreigabe' });
    await expect(select).toBeFocused();
    await select.selectOption('16');
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, nicht gespeichert')).toBeFocused();
    // Space opens it too
    await page.keyboard.press(' ');
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, nicht gespeichert')).toBeFocused();
  });

  test('admin switches are locked', async ({ page }) => {
    await page.goto('/admin/roles');
    const locked = cell(page, 'Admin, Watch-Partys: erlaubt');
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toHaveAttribute('title', 'Admins dürfen immer alles');
    await expect(locked.locator('.lk')).toBeVisible();
    // a locked cell is a table cell like the others: same row box, same row line
    const plain = cell(page, 'Familie, Watch-Partys: erlaubt');
    expect(await locked.evaluate((el) => getComputedStyle(el).display)).toBe('table-cell');
    const [a, b] = [(await locked.boundingBox())!, (await plain.boundingBox())!];
    expect([a.y, a.height]).toEqual([b.y, b.height]);
    expect(a.width).toBeGreaterThan(100);
    const line = (el: Element) => { const c = getComputedStyle(el); return `${c.borderBottomWidth} ${c.borderBottomStyle} ${c.borderBottomColor}`; };
    expect(await locked.evaluate(line)).toBe(await plain.evaluate(line));
    await locked.click({ force: true }); // aria-disabled: a press does nothing
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await locked.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // the guest's switch is editable; the admin's numbers too
    await expect(cell(page, 'Gast, Watch-Partys: nicht erlaubt')).not.toHaveAttribute('aria-disabled', 'true');
    await cell(page, 'Admin, Gleichzeitige Streams: 4').click();
    await expect(page.getByRole('dialog', { name: 'Admin · Gleichzeitige Streams' })).toBeVisible();
  });

  test('discard clears the outlines', async ({ page }) => {
    await page.goto('/admin/roles');
    await stageGuestRating(page);
    await cell(page, 'Freund, Watch-Partys: erlaubt').click();
    const pop = page.getByRole('dialog', { name: 'Freund · Watch-Partys' });
    await pop.getByRole('switch', { name: 'Watch-Partys' }).click();
    await page.keyboard.press('Escape');
    await expect(bar(page)).toContainText('2 Änderungen in 2 Rollen · betrifft 10 Personen');
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, nicht gespeichert')).toHaveClass(/staged/);
    await expect(cell(page, 'Freund, Watch-Partys: nicht erlaubt, nicht gespeichert')).toHaveClass(/staged/);
    await expect(grid(page).locator('.staged')).toHaveCount(2);
    await bar(page).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect(grid(page).locator('.staged')).toHaveCount(0);
    await expect(cell(page, 'Gast, Altersfreigabe: ab 12')).toBeVisible();
    await expect(cell(page, 'Freund, Watch-Partys: erlaubt')).toBeVisible();
  });

  test('the page does not move when the bar appears', async ({ page }) => {
    await page.goto('/admin/roles');
    const head = grid(page).getByRole('columnheader', { name: /Gast/ });
    await expect(head).toBeVisible();
    const before = await head.boundingBox();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--savebar-h'))).toBe('');
    await stageGuestRating(page);
    await expect(bar(page)).toBeVisible();
    expect(await head.boundingBox()).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--savebar-h'))).not.toBe('');
    // the room is reserved: page and panel scrolled to their ends, the last row sits above the bar
    await page.locator('.matrix-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const last = await grid(page).getByRole('row').last().boundingBox();
    const box = await bar(page).boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(box!.y);
    await bar(page).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--savebar-h'))).toBe('');
  });

  test('more than five roles scroll inside the panel, not the page', async ({ page, api }) => {
    const base = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    const extra = ['Oma', 'Opa', 'Nachbarn'].map((label, i): MatrixMockRole => ({ ...base, key: `extra-${i}`, label, builtinLabel: false, origin: 'admin', values: { ...base.values } }));
    api.admin.matrix.roles.splice(4, 0, ...extra);
    await page.goto('/admin/roles');
    await expect(grid(page).getByRole('columnheader', { name: /Nachbarn/ })).toBeAttached();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const scroller = page.locator('.matrix-scroll');
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // the first column stays in place while the panel scrolls
    const rowHead = grid(page).getByRole('rowheader', { name: 'Altersfreigabe' });
    const x0 = (await rowHead.boundingBox())!.x;
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(async () => (await rowHead.boundingBox())!.x).toBe(x0);
  });

  test('leaving with staged changes asks first; without, it does not', async ({ page }) => {
    await page.goto('/admin/roles');
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await stageGuestRating(page);
    await nav.getByRole('link', { name: 'Nutzer' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await expect(dlg).toContainText('1 Rolle hat ungespeicherte Änderungen');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await bar(page).getByRole('button', { name: 'Verwerfen' }).click();
    await nav.getByRole('link', { name: 'Nutzer' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
  });
});

const head = (page: Page, name: string | RegExp) => grid(page).getByRole('columnheader', { name });
const headNames = async (page: Page) => { await expect(grid(page).locator('thead th.rh').first()).toBeVisible(); return grid(page).locator('thead th.rh .rn').allTextContents(); };
const menu = async (page: Page, role: string) => {
  await page.getByRole('button', { name: `Aktionen für ${role}` }).click();
  return page.getByRole('dialog', { name: role });
};

/** column menu: duplicate, delete with a move, order, history; the role sheet (spec §6.1) */
test.describe('Rollen & Rechte: role menu and sheet', () => {
  test.use({ allowedConsole: /status of (409|500)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('duplicate Familie as Oma & Opa', async ({ page, api }) => {
    await page.goto('/admin/roles');
    expect(await headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    await (await menu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Oma & Opa');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    // the new column follows the last stored role (the env role stays at the end); the focus is on its head
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ angelegt.')).toBeVisible();
    expect(await headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Oma & Opa', 'Crew']);
    await expect(head(page, /Oma & Opa/).getByRole('button', { name: 'Rolle „Oma & Opa“ bearbeiten' })).toBeFocused();
    await expect(head(page, /Oma & Opa/)).toContainText('0 Personen');
    await expect(cell(page, /^Oma & Opa, Gleichzeitige Streams: 4/)).toBeVisible();
    expect(api.admin.audit[0]).toMatchObject({ action: 'role.create', meta: { from: 'family', label: 'Oma & Opa' } });
  });

  test('a name that is too long or empty is not sent', async ({ page }) => {
    await page.goto('/admin/roles');
    await (await menu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dlg.getByText('Bitte einen Namen mit 1 bis 30 Zeichen eingeben.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Aktionen für Familie' })).toBeFocused();
  });

  test('delete with move', async ({ page, api }) => {
    const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    api.admin.matrix.roles.splice(4, 0, { ...family, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 2, profiles: 3, kidsProfiles: 0, invites: 1, values: { ...family.values } });
    await page.goto('/admin/roles');
    await expect(head(page, /Oma/)).toContainText('2 Personen');
    await (await menu(page, 'Oma')).getByRole('button', { name: 'Löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Rolle „Oma“ löschen?' });
    await expect(dlg).toContainText('2 Personen und 1 offene Einladung bekommen die Rolle:');
    // admin and the role itself are no targets; nothing is picked yet
    const to = dlg.getByRole('combobox', { name: 'Neue Rolle' });
    expect(await to.locator('option').allTextContents()).toEqual(['Rolle wählen …', 'Familie', 'Freund', 'Gast', 'Crew']);
    await expect(dlg.getByRole('button', { name: 'Löschen' })).toBeDisabled();
    await to.selectOption({ label: 'Freund' });
    await dlg.getByRole('button', { name: 'Löschen' }).click();
    await expect(dlg).toHaveCount(0);
    expect(await headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    await expect(head(page, /Freund/)).toContainText('9 Personen');
    // a plain toast: no undo
    const t = toasts(page).getByText('Rolle „Oma“ gelöscht.');
    await expect(t).toBeVisible();
    await expect(toasts(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
    expect(api.admin.matrix.deletes).toEqual([{ role: 'oma', moveTo: 'friend' }]);
  });

  test('delete of a role nobody holds asks once; built-in and env roles have no Löschen, an env role that left .env has', async ({ page, api }) => {
    const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    api.admin.matrix.roles.splice(4, 0, { ...family, key: 'leer', label: 'Leer', builtinLabel: false, origin: 'admin', accounts: 0, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...family.values } });
    await page.goto('/admin/roles');
    for (const r of ['Familie', 'Crew']) {
      await (await menu(page, r)).getByRole('button', { name: 'Bearbeiten' }).waitFor();
      await expect(page.getByRole('dialog', { name: r }).getByRole('button', { name: 'Löschen' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    await (await menu(page, 'Leer')).getByRole('button', { name: 'Löschen' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Rolle „Leer“ löschen?' });
    await expect(ask).toContainText('Die Rolle wird entfernt.');
    await ask.getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Leer“ gelöscht.')).toBeVisible();
    expect(await headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    expect(api.admin.matrix.deletes).toEqual([{ role: 'leer', moveTo: null }]);
  });

  test('an env role: "aus .env", and "nicht mehr in .env" once it left', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await expect(head(page, /Crew/)).toContainText('aus .env');
    api.admin.matrix.roles.find((r) => r.key === 'crew')!.envGone = true;
    await page.reload();
    await expect(head(page, /Crew/)).toContainText('nicht mehr in .env');
    await (await menu(page, 'Crew')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog', { name: 'Rolle „Crew“ löschen?' }).getByRole('combobox', { name: 'Neue Rolle' }).selectOption({ label: 'Gast' });
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Crew“ gelöscht.')).toBeVisible();
    expect(api.admin.matrix.deletes).toEqual([{ role: 'crew', moveTo: 'guest' }]);
  });

  test('move right reorders and sends PUT /order', async ({ page, api }) => {
    await page.goto('/admin/roles');
    const left = page.getByRole('button', { name: 'Aktionen für Admin' });
    await left.click();
    await expect(page.getByRole('dialog', { name: 'Admin' }).getByRole('button', { name: 'Nach links' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await (await menu(page, 'Familie')).getByRole('button', { name: 'Nach rechts' }).click();
    expect(await headNames(page)).toEqual(['Admin', 'Freund', 'Familie', 'Gast', 'Crew']);
    await expect.poll(() => api.admin.matrix.orders.length).toBe(1);
    expect(api.admin.matrix.orders[0]).toEqual(['admin', 'friend', 'family', 'guest', 'crew']);
    // announced, and the focus stays on the moved column's menu button
    await expect(page.getByText('Rolle „Familie“ steht jetzt an Position 3 von 5.')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Aktionen für Familie' })).toBeFocused();
    expect(await headNames(page)).toEqual(['Admin', 'Freund', 'Familie', 'Gast', 'Crew']); // read back: unchanged
    // the cells moved with their column
    await expect(cell(page, 'Familie, Gleichzeitige Streams: 4')).toBeVisible();
  });

  test('a failed order write is reported and the order is read back', async ({ page }) => {
    await page.route('**/api/admin/roles/order', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await page.goto('/admin/roles');
    await (await menu(page, 'Gast')).getByRole('button', { name: 'Nach links' }).click();
    await expect(toasts(page).getByText('Die Reihenfolge konnte nicht gespeichert werden.')).toBeVisible();
    await expect.poll(() => headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
  });

  test('the drag handle moves a column by transform and sends PUT /order', async ({ page, api }) => {
    await page.goto('/admin/roles');
    const fam = head(page, /Familie/);
    const grip = fam.locator('.grip');
    const w = (await fam.boundingBox())!.width;
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + w * 0.6, g.y + g.height / 2, { steps: 6 });
    // mid-drag: the layout is untouched (same order, same boxes); the column and its cells are shifted by transform only
    expect(await headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    expect(await fam.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
    expect(await cell(page, /^Familie, Gleichzeitige Streams/).evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
    expect(await head(page, /Freund/).evaluate((el) => getComputedStyle(el).transform)).not.toBe('none'); // stepped aside
    expect(await head(page, /Gast/).evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    await page.mouse.up();
    await expect.poll(() => api.admin.matrix.orders.length).toBe(1);
    expect(api.admin.matrix.orders[0]).toEqual(['admin', 'friend', 'family', 'guest', 'crew']);
    expect(await headNames(page)).toEqual(['Admin', 'Freund', 'Familie', 'Gast', 'Crew']);
    await expect.poll(() => fam.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  });

  test('history sheet lists the role\'s entries', async ({ page, api }) => {
    await page.goto('/admin/roles');
    // an entry of this session first: a role.update with from → to chips
    await stageGuestRating(page);
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await (await menu(page, 'Gast')).getByRole('button', { name: 'Verlauf' }).click();
    const sheet = page.getByRole('dialog', { name: 'Verlauf · Gast' });
    await expect(sheet.getByText('Tester hat die Rolle Gast geändert')).toBeVisible();
    await expect(sheet.getByText('Altersfreigabe: ab 12 → ab 16')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Aktionen für Gast' })).toBeFocused();
    // Familie: the old role.playback entry reads as a sentence, no raw key
    await (await menu(page, 'Familie')).getByRole('button', { name: 'Verlauf' }).click();
    const fam = page.getByRole('dialog', { name: 'Verlauf · Familie' });
    await expect(fam.getByText('Tester hat „Wiedergabe“ der Rolle Familie geändert')).toBeVisible();
    await expect(fam).not.toContainText('role.playback');
    await expect(fam.getByText(/Gast/)).toHaveCount(0); // only this role's entries
    await fam.getByRole('button', { name: 'Schließen' }).first().click();
    // a role without entries
    await (await menu(page, 'Freund')).getByRole('button', { name: 'Verlauf' }).click();
    await expect(page.getByRole('dialog', { name: 'Verlauf · Freund' })).toContainText('Noch keine Einträge zu dieser Rolle.');
    expect(api.admin.audit.some((e) => e.action === 'role.update' && e.target === 'guest')).toBe(true);
  });

  test('role sheet edits stage into the save bar', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await head(page, /Gast/).getByRole('button', { name: 'Rolle „Gast“ bearbeiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Gast“' });
    await expect(sheet.getByRole('textbox', { name: 'Name' })).toHaveValue('Gast');
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Besucher');
    await sheet.getByRole('switch', { name: 'Für Einladungen wählbar' }).click();
    await sheet.getByRole('switch', { name: 'Watch-Partys' }).click();
    await sheet.getByRole('combobox', { name: 'Altersfreigabe' }).selectOption('16');
    await expect(bar(page)).toContainText('4 Änderungen in 1 Rolle · betrifft 3 Personen');
    // the matrix behind it shows the staged cells and the new name
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(head(page, /Besucher/)).toBeVisible();
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, nicht gespeichert')).toHaveClass(/staged/);
    await expect(cell(page, 'Gast, Watch-Partys: erlaubt, nicht gespeichert')).toHaveClass(/staged/);
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    const review = page.getByRole('dialog', { name: 'Änderungen prüfen' });
    await expect(review.getByText('Gast · Name: Gast → Besucher')).toBeVisible();
    await expect(review.getByText('Gast · Für Einladungen wählbar: erlaubt → nicht erlaubt')).toBeVisible();
    await review.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { label: 'Besucher', invitable: false, maxParentalRating: 16, perms: { party: true } } }]);
    await expect(head(page, /Besucher/)).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
  });

  test('rename opens the sheet with the name focused; a bad name is not staged; the admin sheet has no invitable switch', async ({ page }) => {
    await page.goto('/admin/roles');
    await (await menu(page, 'Freund')).getByRole('button', { name: 'Umbenennen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Freund“' });
    const name = sheet.getByRole('textbox', { name: 'Name' });
    await expect(name).toBeFocused();
    await name.fill('');
    await expect(sheet.getByText('Bitte einen Namen mit 1 bis 30 Zeichen eingeben.')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await name.fill('Kumpel');
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle');
    await name.fill('Freund'); // typed back: nothing left to save
    await expect(bar(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Aktionen für Freund' })).toBeFocused();
    await head(page, /Admin/).getByRole('button', { name: 'Rolle „Admin“ bearbeiten' }).click();
    const admin = page.getByRole('dialog', { name: 'Rolle „Admin“' });
    await expect(admin.getByRole('switch', { name: 'Für Einladungen wählbar' })).toHaveCount(0);
    await expect(admin.getByRole('switch', { name: 'Watch-Partys' })).toHaveCount(0); // locked
    await expect(admin.getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toBeVisible();
  });

  test('a saved value that differs from its default says so in the tooltip', async ({ page }) => {
    await page.goto('/admin/roles');
    await stageGuestRating(page);
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, geändert')).toHaveAttribute('title', 'geändert (Standard: ab 12)');
    // set back to the default: still set in the role, nothing to name
    await cell(page, 'Gast, Altersfreigabe: ab 16, geändert').click();
    await page.getByRole('dialog', { name: 'Gast · Altersfreigabe' }).getByRole('combobox', { name: 'Altersfreigabe' }).selectOption('12');
    await page.keyboard.press('Escape');
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.').last()).toBeVisible();
    await expect(cell(page, 'Gast, Altersfreigabe: ab 12, geändert')).toHaveAttribute('title', 'in dieser Rolle geändert');
  });
});

/** Fix round 1: audit names, reload errors, 44 px targets, env-only roles stay last, busy state, copy */
test.describe('Rollen & Rechte: role menu fixes', () => {
  test.use({ allowedConsole: /status of (409|500)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the history names roles, never a key: a copy of a copy, then the source deleted', async ({ page }) => {
    await page.goto('/admin/roles');
    const dupAs = async (from: string, name: string) => {
      await (await menu(page, from)).getByRole('button', { name: 'Duplizieren' }).click();
      const dlg = page.getByRole('dialog', { name: `Rolle „${from}“ duplizieren` });
      await dlg.getByRole('textbox', { name: 'Name' }).fill(name);
      await dlg.getByRole('button', { name: 'Anlegen' }).click();
      await expect(toasts(page).getByText(`Rolle „${name}“ angelegt.`)).toBeVisible();
    };
    await dupAs('Familie', 'Oma & Opa');
    await dupAs('Oma & Opa', 'Nachbarn');
    await (await menu(page, 'Nachbarn')).getByRole('button', { name: 'Verlauf' }).click();
    const sheet = page.getByRole('dialog', { name: 'Verlauf · Nachbarn' });
    await expect(sheet).toContainText('Tester hat die Rolle Nachbarn als Kopie von Oma & Opa angelegt');
    await expect(sheet).not.toContainText(/oma-opa/);
    await page.keyboard.press('Escape');
    // the source is deleted (nobody holds it): the history says so without the key
    await (await menu(page, 'Oma & Opa')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ gelöscht.')).toBeVisible();
    await (await menu(page, 'Nachbarn')).getByRole('button', { name: 'Verlauf' }).click();
    const again = page.getByRole('dialog', { name: 'Verlauf · Nachbarn' });
    await expect(again).toContainText('Kopie von „gelöschte Rolle“');
    await expect(again).not.toContainText(/oma-opa/);
  });

  test('history shows a rename and the invitable switch as from → to', async ({ page }) => {
    await page.goto('/admin/roles');
    await head(page, /Gast/).getByRole('button', { name: 'Rolle „Gast“ bearbeiten' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Gast“' });
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Besucher');
    await sheet.getByRole('switch', { name: 'Für Einladungen wählbar' }).click();
    await page.keyboard.press('Escape');
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await (await menu(page, 'Besucher')).getByRole('button', { name: 'Verlauf' }).click();
    const h = page.getByRole('dialog', { name: 'Verlauf · Besucher' });
    await expect(h.getByText('Name: Gast → Besucher')).toBeVisible();
    await expect(h.getByText('Für Einladungen wählbar: erlaubt → nicht erlaubt')).toBeVisible();
  });

  test('a failed reload after a write keeps the success and says so (duplicate, delete)', async ({ page, api }) => {
    const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    api.admin.matrix.roles.splice(4, 0, { ...family, key: 'leer', label: 'Leer', builtinLabel: false, origin: 'admin', accounts: 0, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...family.values } });
    await page.goto('/admin/roles');
    await expect(head(page, /Leer/)).toBeVisible();
    await page.route('**/api/admin/roles', async (r) => { if (r.request().method() === 'GET') await r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }); else await r.fallback(); });
    await (await menu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Zwei');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(toasts(page).getByText('Rolle „Zwei“ angelegt.')).toBeVisible();
    await expect(toasts(page).getByText('Das ließ sich nicht laden. Prüfe die Verbindung und versuche es erneut.')).toBeVisible();
    await expect(dlg).toHaveCount(0);
    expect(api.admin.matrix.roles.some((r) => r.label === 'Zwei')).toBe(true);
    // delete: the success is a success, the failed read an extra note
    await (await menu(page, 'Leer')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Leer“ gelöscht.')).toBeVisible();
    expect(api.admin.matrix.deletes).toEqual([{ role: 'leer', moveTo: null }]);
  });

  test('target sizes: the name is a 44 px button, the heads keep their height, the people line does not split a count', async ({ page }) => {
    await page.goto('/admin/roles');
    const gast = head(page, /Gast/);
    await expect(gast).toBeVisible();
    const h0 = (await gast.boundingBox())!.height;
    const rn = (await gast.locator('.rn').boundingBox())!;
    expect(rn.height).toBeGreaterThanOrEqual(44);
    expect(rn.width).toBeGreaterThanOrEqual(44);
    const g = await gast.locator('.grip').evaluate((el) => { const r = getComputedStyle(el, '::after'); return [parseFloat(r.width), parseFloat(r.height)]; });
    expect(g[0]).toBeGreaterThanOrEqual(44);
    expect(g[1]).toBeGreaterThanOrEqual(44);
    for (const seg of await head(page, /Admin/).locator('.rp .seg').all()) expect((await seg.boundingBox())!.height).toBeLessThan(22);
    expect(await head(page, /Admin/).locator('.rp').textContent()).toBe('1 Person · 0 Kinderprofile');
    expect(h0).toBeGreaterThan(0);
  });

  test('env-only roles stay last: no move into or across them, the drag stops before them', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await (await menu(page, 'Gast')).getByRole('button', { name: 'Nach rechts' }).waitFor();
    await expect(page.getByRole('dialog', { name: 'Gast' }).getByRole('button', { name: 'Nach rechts' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await (await menu(page, 'Crew')).getByRole('button', { name: 'Nach links' }).waitFor();
    const crew = page.getByRole('dialog', { name: 'Crew' });
    await expect(crew.getByRole('button', { name: 'Nach links' })).toBeDisabled();
    await expect(crew.getByRole('button', { name: 'Nach rechts' })).toBeDisabled();
    await page.keyboard.press('Escape');
    // dragging Gast past Crew: the column stops at the last stored place, and nothing is written
    const gast = head(page, /Gast/);
    const w = (await gast.boundingBox())!.width;
    const g = (await gast.locator('.grip').boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + w * 2, g.y + g.height / 2, { steps: 6 });
    const rest = /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/; // at its own place (a clamped drag is an identity transform)
    expect(await gast.evaluate((el) => getComputedStyle(el).transform)).toMatch(rest);
    expect(await head(page, /Crew/).evaluate((el) => getComputedStyle(el).transform)).toMatch(rest);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(api.admin.matrix.orders).toEqual([]);
    // Crew's grip does nothing
    const cg = (await head(page, /Crew/).locator('.grip').boundingBox())!;
    await page.mouse.move(cg.x + cg.width / 2, cg.y + cg.height / 2);
    await page.mouse.down();
    await page.mouse.move(cg.x - w, cg.y + cg.height / 2, { steps: 4 });
    expect(await head(page, /Crew/).evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    await page.mouse.up();
    expect(await headNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
  });

  test('while a save runs the menu cannot open the sheet, duplicate or delete', async ({ page }) => {
    await page.goto('/admin/roles');
    await stageGuestRating(page);
    await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/roles/guest', async (r) => { if (r.request().method() === 'PUT') await held; await r.fallback(); });
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('Aktualisiere 1 von 1 …');
    await expect(head(page, /Familie/).locator('.rn')).toBeDisabled();
    const m = await menu(page, 'Familie');
    for (const n of ['Bearbeiten', 'Duplizieren', 'Umbenennen', 'Nach links', 'Nach rechts']) await expect(m.getByRole('button', { name: n })).toBeDisabled();
    await expect(m.getByRole('button', { name: 'Verlauf' })).toBeEnabled();
    await page.keyboard.press('Escape');
    release();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await expect(head(page, /Familie/).locator('.rn')).toBeEnabled();
  });

  test('copy: only the parts that are not zero; a role with open invites and nobody else', async ({ page, api }) => {
    const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    const mk = (key: string, label: string, accounts: number, invites: number) => ({ ...family, key, label, builtinLabel: false, origin: 'admin' as const, accounts, profiles: 0, kidsProfiles: 0, invites, values: { ...family.values } });
    api.admin.matrix.roles.splice(4, 0, mk('leute', 'Leute', 3, 0), mk('einl', 'Einl', 0, 2));
    await page.goto('/admin/roles');
    await (await menu(page, 'Leute')).getByRole('button', { name: 'Löschen' }).click();
    const a = page.getByRole('alertdialog', { name: 'Rolle „Leute“ löschen?' });
    await expect(a).toContainText('3 Personen bekommen die Rolle:');
    await expect(a).not.toContainText('Einladung');
    await a.getByRole('button', { name: 'Abbrechen' }).click();
    await (await menu(page, 'Einl')).getByRole('button', { name: 'Löschen' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Rolle „Einl“ löschen?' });
    await expect(ask).not.toContainText('Niemand');
    await expect(ask).toContainText('offene Einladungen');
    await ask.getByRole('button', { name: 'Löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Rolle „Einl“ löschen?' });
    await expect(dlg).toContainText('2 offene Einladungen bekommen die Rolle:');
    await expect(dlg).not.toContainText('Personen');
  });
});

/** toasts are lifted above the save bar by a transform that glides; without a bar they stand still */
test.describe('Rollen & Rechte: toasts and the save bar', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  /** the bottom edge of the toast area, every frame while a toast shows (until n samples) */
  async function sampleToasts(page: Page, n: number): Promise<void> {
    await page.evaluate((count) => {
      const w = window as unknown as { __toastY: Array<[number, number]> };
      w.__toastY = [];
      const loop = () => {
        const host = document.querySelector('.toasts');
        if (host?.querySelector('li')) w.__toastY.push([performance.now(), host.getBoundingClientRect().bottom]);
        if (w.__toastY.length < count) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }, n);
  }
  const samples = (page: Page) => page.evaluate(() => (window as unknown as { __toastY: Array<[number, number]> }).__toastY);

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('the success toast glides down as the bar leaves (no snap)', async ({ page }) => {
      await page.goto('/admin/roles');
      await stageGuestRating(page);
      await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
      await sampleToasts(page, 60);
      await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
      await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
      await expect.poll(async () => (await samples(page)).length, { timeout: 5000 }).toBe(60);
      const ys = await samples(page);
      const vh = await page.evaluate(() => window.innerHeight);
      // starts lifted above the bar's room (96 px), ends at its own place (36 px up), monotonic in between
      expect(ys[0]![1]).toBeCloseTo(vh - 36 - 96, 0);
      expect(ys.at(-1)![1]).toBeCloseTo(vh - 36, 0);
      const between = ys.filter(([, y]) => y > ys[0]![1] + 1 && y < ys.at(-1)![1] - 1);
      expect(between.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < ys.length; i++) {
        const [t0, y0] = ys[i - 1]!, [t1, y1] = ys[i]!;
        expect(y1).toBeGreaterThanOrEqual(y0 - 0.5);
        expect((y1 - y0) / Math.max(1, (t1 - t0) / 16)).toBeLessThan(40);
      }
    });
  });

  test('without a bar the toast stands still (cards below 900 px)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto('/admin/roles');
    const card = page.getByRole('form', { name: 'Freund' });
    await card.getByRole('switch', { name: 'Umwandeln erlaubt' }).click();
    await card.getByRole('button', { name: 'Speichern' }).click();
    const t = toasts(page).getByText('Rolle „Freund“ gespeichert.');
    await expect(t).toBeVisible();
    const a = await toasts(page).boundingBox();
    await page.waitForTimeout(350);
    expect(await toasts(page).boundingBox()).toEqual(a);
  });
});
