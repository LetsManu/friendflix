// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Live-TV → Kanäle on a phone (375 px), Task 23: the rows become cards, every target is at least 44 px, the bulk bar and the
// sheets fit.
const W = 375;
async function fits(l: Locator, what: string, minH = 0) {
  const b = await l.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b!.x >= -0.5 && b!.x + b!.width <= W + 0.5, `${what} inside 375 px`).toBe(true);
  if (minH) expect(b!.height, `${what} height`).toBeGreaterThanOrEqual(minH);
}
const table = (page: Page) => page.getByRole('table', { name: 'Kanäle' });
const card = (page: Page, name: string): Locator => table(page).getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });

test.describe('admin: Live-TV, Kanäle (phone, 375 px)', () => {
  test.beforeEach(({ api, page }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    return page.setViewportSize({ width: W, height: 812 });
  });

  test('rows become cards that fit 375 px', async ({ page }) => {
    await page.goto('/admin/livetv?tab=channels');
    const c = card(page, 'Nordlicht TV');
    await expect(c).toBeVisible();
    // a card: the table's rows are blocks, the header row is hidden
    expect(await c.evaluate((el) => getComputedStyle(el).display)).not.toBe('table-row');
    expect(await table(page).locator('thead').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await fits(c, 'channel card');
    // the name is the card's title: it sits above the checkbox although the checkbox comes first in the markup
    await expect(c.locator('td.primary')).toContainText('Nordlicht TV');
    expect((await c.locator('td.primary').boundingBox())!.y).toBeLessThan((await c.locator('label.ck').boundingBox())!.y);
    // each cell carries its label (the card shows it before the value)
    for (const l of ['Gruppe', 'Quelle', 'Art', 'Modus', 'Programm', 'Sichtbar']) await expect(c.locator(`td[data-label="${l}"]`), l).toHaveCount(1);
    await fits(c.locator('label.ck'), 'checkbox target', 44);
    await fits(c.getByRole('button', { name: 'Nordlicht TV', exact: true }), 'name', 44);
    await fits(c.getByRole('switch'), 'visibility switch', 44);
    await fits(c.getByLabel('Gruppe von „Nordlicht TV“'), 'group select', 44);
    await fits(page.getByRole('button', { name: 'Aktionen für Nordlicht TV' }), 'row menu', 44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    // filters and paging fit as well
    for (const n of ['Sichtbar', 'Ausgeblendet', 'Fehlt', 'Ohne Programm', 'Mit Fehler']) await fits(page.getByRole('button', { name: n, exact: true }), n, 44);
    await fits(page.getByLabel('Quelle', { exact: true }), 'source filter', 44);
    await fits(page.getByLabel('Gruppe', { exact: true }), 'group filter', 44);
    await fits(page.getByRole('button', { name: 'Nächste Seite' }), 'next page', 44);
  });

  test('the bulk bar and its prompt fit the phone', async ({ page }) => {
    await page.goto('/admin/livetv?tab=channels');
    await page.getByRole('checkbox', { name: 'Sender „Nordlicht TV“ auswählen' }).check();
    const bar = page.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await expect(bar).toBeVisible();
    await fits(bar, 'bulk bar');
    for (const n of ['Ausblenden', 'Einblenden', 'Gruppe ändern…', 'Ab Nummer … durchnummerieren', 'Überschreibungen zurücksetzen', 'Testen', 'Auswahl aufheben']) await fits(bar.getByRole('button', { name: n }), n, 44);
    await bar.getByRole('button', { name: 'Ab Nummer … durchnummerieren' }).click();
    const grp = bar.getByRole('group', { name: 'Ab Nummer … durchnummerieren' });
    await fits(grp, 'renumber prompt');
    await fits(grp.getByRole('spinbutton', { name: 'Erste Nummer' }), 'number field', 44);
    await fits(grp.getByRole('button', { name: 'Anwenden' }), 'Anwenden', 44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('with a selection the bulk bar never covers the pager: Nächste Seite is the tap target and pages on', async ({ page }) => {
    await page.goto('/admin/livetv?tab=channels');
    await page.getByRole('checkbox', { name: 'Sender „Nordlicht TV“ auswählen' }).check();
    const bar = page.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await expect(bar).toBeVisible();
    const next = page.getByRole('button', { name: 'Nächste Seite' });
    await next.scrollIntoViewIfNeeded();
    await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
    const gap = async () => { const n = (await next.boundingBox())!, b = (await bar.boundingBox())!; return b.y - (n.y + n.height); };
    await expect.poll(gap).toBeGreaterThanOrEqual(0); // the pager ends above the bar
    const hit = await next.evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return t === el || el.contains(t); });
    expect(hit).toBe(true);
    await next.click();
    await expect(page.getByRole('button', { name: 'Vorherige Seite' })).toBeEnabled();
    await expect(page.locator('[data-selected]')).toContainText('1');
  });

  test('the sheets fit the phone', async ({ page }) => {
    await page.goto('/admin/livetv?tab=channels');
    const open = async (item: string, title: string) => {
      await page.getByRole('button', { name: 'Aktionen für Nordlicht TV' }).click();
      await page.getByRole('dialog', { name: 'Nordlicht TV' }).getByRole('button', { name: item }).click();
      const dlg = page.getByRole('dialog', { name: title });
      await expect(dlg).toBeVisible();
      return dlg;
    };
    let dlg = await open('Testen', 'Stream testen: Nordlicht TV');
    await expect(dlg.locator('[data-facts]')).toBeVisible();
    await fits(dlg, 'test sheet');
    for (const b of await dlg.getByRole('button').all()) await fits(b, 'test sheet button', 44);
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    dlg = await open('Logo ändern', 'Logo: Nordlicht TV');
    await fits(dlg, 'logo sheet');
    await fits(dlg.getByRole('button', { name: 'Eigenes Logo hochladen' }), 'upload', 44);
    await dlg.getByRole('button', { name: 'Schließen' }).first().click();
    dlg = await open('Programm-Zeit verschieben…', 'Programm-Zeit: Nordlicht TV');
    await fits(dlg, 'offset sheet');
    for (const n of ['Um 30 Minuten früher', 'Um 30 Minuten später', 'Speichern', 'Zurücksetzen']) await fits(dlg.getByRole('button', { name: n }), n, 44);
    await expect(dlg.locator('[data-now]')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
