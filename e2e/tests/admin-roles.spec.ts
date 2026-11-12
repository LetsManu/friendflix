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
