// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { auid } from '../mocks/admin.js';

const ANNA = auid(2);

test.describe('admin user detail (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('tabs scroll and cards render', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}`);
    const list = page.getByRole('tablist', { name: 'Bereiche von Anna Beispiel' });
    await expect(list).toBeVisible();
    // eight tabs do not fit 390px: the strip scrolls sideways, the page does not
    const strip = await list.evaluate((el) => ({ overflow: getComputedStyle(el).overflowX, scroll: el.scrollWidth, client: el.clientWidth }));
    expect(strip.overflow).toBe('auto');
    expect(strip.scroll).toBeGreaterThan(strip.client);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await list.getByRole('tab', { name: 'Audit-Log' }).click();
    await expect(page).toHaveURL(/\?tab=audit$/);
    await list.getByRole('tab', { name: 'Geräte' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Geräte' });
    const card = panel.getByRole('row', { name: /Chrome auf Windows/ });
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe('block');
    await expect(card.getByRole('button', { name: '„Chrome auf Windows“ freigeben' })).toBeVisible();
    await card.getByRole('button', { name: 'Aktionen für Chrome auf Windows' }).click();
    await expect(page.getByRole('dialog', { name: 'Chrome auf Windows' }).getByRole('button', { name: 'Entfernen' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await list.getByRole('tab', { name: 'Rechte' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await list.getByRole('tab', { name: 'Profile' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Profile' }).getByRole('row', { name: /„Kinder“/ })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Profile: switches and buttons are 44 px, the cards keep their height, the sheet fits the phone', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const card = panel.getByRole('row', { name: /„Kinder“/ });
    const sw = card.getByRole('switch', { name: 'Kinderprofil: „Kinder“' });
    for (const el of [sw, card.getByRole('combobox', { name: 'Altersgrenze von „Kinder“' }), card.getByRole('button', { name: 'Aktionen für Kinder' }), panel.getByRole('button', { name: 'Kinderprofil anlegen' })]) {
      const box = await el.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    const before = (await card.boundingBox())!.height;
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByRole('combobox')).toHaveCount(0);
    expect((await card.boundingBox())!.height).toBe(before);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await panel.getByRole('button', { name: 'Kinderprofil anlegen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Kinderprofil anlegen' });
    await expect(sheet).toBeVisible();
    await expect.poll(async () => {
      const b = await sheet.boundingBox();
      const w = page.viewportSize()!.width;
      return Boolean(b && b.x >= 0 && b.x + b.width <= w + 1);
    }).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('Profile: a toast glides above the Kinderprofil sheet, its fields and buttons stay free', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    await panel.getByRole('combobox', { name: 'Altersgrenze von „Kinder“' }).selectOption('12');
    const toast = page.getByRole('region', { name: 'Hinweise' }).getByRole('listitem').filter({ hasText: 'Altersgrenze von „Kinder“ gespeichert.' });
    await expect(toast).toBeVisible();
    await panel.getByRole('button', { name: 'Kinderprofil anlegen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Kinderprofil anlegen' });
    await expect(sheet).toBeVisible();
    await expect(toast).toBeVisible();
    // the whole sheet stays free: the toast sits above its top edge
    await expect.poll(async () => {
      const [a, b] = await Promise.all([toast.boundingBox(), sheet.boundingBox()]);
      return a && b ? Math.round(b.y - (a.y + a.height)) : -1;
    }).toBeGreaterThanOrEqual(0);
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Lena');
    await sheet.getByRole('button', { name: 'Anlegen' }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('Rechte: rows stack, segments are 44 px, nothing scrolls sideways', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    const panel = page.getByRole('tabpanel', { name: 'Rechte' });
    const group = panel.getByRole('radiogroup', { name: 'Auf Fernseher übertragen' });
    await expect(group).toBeVisible();
    const row = panel.getByRole('listitem').filter({ has: page.getByRole('radiogroup', { name: 'Auf Fernseher übertragen' }) });
    const label = row.locator('.lab');
    await expect.poll(async () => {
      const [l, g] = [await label.boundingBox(), await group.boundingBox()];
      return Boolean(l && g && g.y >= l.y + l.height - 1);
    }).toBe(true);
    for (const name of ['Wie Rolle', 'Erlauben', 'Verbieten']) {
      const seg = row.getByRole('radio', { name }).locator('..');
      const box = await seg.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    const rowBox = await row.boundingBox();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(391);
    await row.getByText('Verbieten', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Ungespeicherte Änderungen' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Sicht prüfen: chips and results fit 390px, targets are 44px', async ({ page }) => {
    await page.goto(`/admin/users/${auid(4)}?tab=check`);
    const panel = page.getByRole('tabpanel', { name: 'Sicht prüfen' });
    const chips = panel.getByRole('group', { name: 'Profil wählen' }).getByRole('button');
    await expect(chips).toHaveCount(2);
    for (const c of await chips.all()) expect((await c.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await panel.getByRole('searchbox', { name: 'Film oder Serie suchen' }).fill('Dunmoor');
    const rows = panel.getByRole('region', { name: 'Titel prüfen' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasNotText: 'Origins' })).toContainText('ausgeblendet · Freigabe FSK-16 über FSK 12');
    for (const r of await rows.all()) {
      const b = (await r.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(391);
    }
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
