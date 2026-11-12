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
    await expect(cell(page, /^Gast, Altersfreigabe: ab 16/)).toBeVisible();
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

  test('grid keyboard', async ({ page }) => {
    await page.goto('/admin/roles');
    // one tab stop: the first cell
    await expect(grid(page).locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
    await expect(cell(page, 'Admin, Bibliotheken: alle')).toHaveAttribute('tabindex', '0');
    await cell(page, 'Gast, Altersfreigabe: ab 12').focus();
    await page.keyboard.press('ArrowDown');
    await expect(cell(page, 'Gast, Gleichzeitige Streams: 1')).toBeFocused();
    await page.keyboard.press('ArrowRight');
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
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, geändert')).toBeFocused();
    // Space opens it too
    await page.keyboard.press(' ');
    await expect(pop).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, geändert')).toBeFocused();
  });

  test('admin switches are locked', async ({ page }) => {
    await page.goto('/admin/roles');
    const locked = cell(page, 'Admin, Watch-Partys: erlaubt');
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toHaveAttribute('title', 'Admins dürfen immer alles');
    await expect(locked.locator('.lock')).toBeVisible();
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
    await expect(cell(page, 'Gast, Altersfreigabe: ab 16, geändert')).toHaveClass(/staged/);
    await expect(cell(page, 'Freund, Watch-Partys: nicht erlaubt, geändert')).toHaveClass(/staged/);
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
