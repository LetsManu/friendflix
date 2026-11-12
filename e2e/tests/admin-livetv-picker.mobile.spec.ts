// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Live-TV → Quellen on a phone (375 px), Task 22: the sheet with 40 provider groups fits, every target is at least 44 px and the
// sheet's buttons stay where they are while groups are ticked, searched and the result arrives.
const W = 375;
const LIST_URL = 'https://iptv.example.com/get.php?username=anna&password=geheim123&type=m3u_plus';
async function fits(l: Locator, what: string, minH = 0) {
  const b = await l.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b!.x >= 0 && b!.x + b!.width <= W + 0.5, `${what} inside 375 px`).toBe(true);
  if (minH) expect(b!.height, `${what} height`).toBeGreaterThanOrEqual(minH);
}
const GROUPS = Array.from({ length: 40 }, (_, i) => ({ name: `${i % 2 ? 'AT' : 'DE'} | Hafenkanal Gruppe mit einem langen Namen ${String(i + 1).padStart(2, '0')}`, channels: 10 }));

test.describe('admin: Live-TV, Gruppenauswahl (phone, 375 px)', () => {
  test.beforeEach(({ api, page }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    api.admin.livetv.area.test = { channels: 400, groups: GROUPS, samples: ['Nordlicht TV', 'Hafenkanal'], epgChannels: 398, epgError: null };
    return page.setViewportSize({ width: W, height: 812 });
  });

  test('40 groups fit the sheet; the buttons stay put while ticking', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    const save = dlg.getByRole('button', { name: 'Speichern' });
    const check = dlg.getByRole('button', { name: 'Prüfen' });
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
    await dlg.getByLabel('Senderliste (M3U-Adresse)').fill(LIST_URL);
    const before = { save: await save.boundingBox(), check: await check.boundingBox() };
    await check.click();
    const picker = dlg.locator('[data-picker]');
    await expect(picker).toBeVisible();
    // the result and the picker arrive inside the scrolling form: the buttons do not move
    expect(await save.boundingBox()).toEqual(before.save);
    expect(await check.boundingBox()).toEqual(before.check);
    await expect(picker.getByRole('heading', { name: '40 Gruppen gefunden – welche übernehmen?' })).toBeVisible();
    await expect(picker.getByRole('checkbox')).toHaveCount(40);
    await picker.scrollIntoViewIfNeeded();
    await fits(dlg, 'source sheet');
    await fits(picker, 'picker');
    await fits(picker.locator('[data-picker-list]'), 'group list');
    const list = picker.locator('[data-picker-list]');
    const listH = (await list.boundingBox())!.height;
    for (const r of await picker.locator('label.row').all().then((a) => a.slice(0, 4))) await fits(r, 'group row', 44);
    for (const n of ['Alle', 'Keine']) await fits(picker.getByRole('button', { name: n, exact: true }), n, 44);
    await fits(picker.getByRole('searchbox', { name: 'Gruppe suchen' }), 'search field', 44);
    for (const n of ['Prüfen', 'Speichern', 'Schließen']) await fits(dlg.getByRole('button', { name: n }), n, 44);

    // ticking, searching and Keine / Alle never move the list or the buttons
    await picker.getByRole('checkbox').nth(3).uncheck();
    await picker.getByRole('checkbox').nth(7).uncheck();
    await expect(picker.locator('[data-picker-total]')).toHaveText('380 von 400 Sendern werden übernommen');
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('gruppe mit einem langen namen 3');
    await picker.getByRole('button', { name: 'Keine', exact: true }).click();
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('zzzz');
    await expect(picker).toContainText('Keine Gruppe passt.');
    expect((await list.boundingBox())!.height).toBe(listH);
    expect(await save.boundingBox()).toEqual(before.save);
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the import options fit and their targets are 44 px', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    const imp = dlg.getByRole('region', { name: 'Import' });
    await imp.scrollIntoViewIfNeeded();
    await fits(imp, 'import section');
    for (const r of await imp.getByRole('radio').all()) await fits(r, 'segment', 44);
    await imp.getByRole('radio', { name: 'Nach Reihenfolge ab' }).click();
    await fits(imp.getByRole('spinbutton', { name: 'Erste Nummer' }), 'first number', 44);
    await fits(imp.getByRole('button', { name: 'Um 30 Minuten verringern' }), 'less', 44);
    await fits(imp.getByRole('button', { name: 'Um 30 Minuten erhöhen' }), 'more', 44);
    const b = await imp.getByRole('button', { name: 'Um 30 Minuten erhöhen' }).boundingBox();
    expect(b!.width).toBeGreaterThanOrEqual(44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
