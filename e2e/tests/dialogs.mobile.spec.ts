// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dialogs on a phone (390×844, menus glass stage 1, Task 4): under 420 px the button row stacks, every button full width and
 * the primary on top, the same in every dialog; the DOM order stays [secondary, primary]. Mocked API.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { dialogActs, noHorizontalOverflow } from '../helpers.js';
import type { MatrixMockRole } from '../mocks/admin.js';

const extraRole = (api: { admin: { matrix: { roles: MatrixMockRole[] } } }, key: string, label: string, accounts = 0, invites = 0): void => {
  const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
  api.admin.matrix.roles.splice(4, 0, { ...family, key, label, builtinLabel: false, origin: 'admin', accounts, profiles: accounts ? 3 : 0, kidsProfiles: 0, invites, values: { ...family.values } });
};
const rowMenu = async (page: Page, role: string) => {
  await page.getByRole('button', { name: `Aktionen für ${role}` }).click();
  return page.getByRole('dialog', { name: role });
};

/** stacked: primary above secondary, both as wide as the row; the panel inside the screen with its 24 px corners */
async function stacked(page: Page, dlg: Locator, names: [string, string]) {
  expect(await dlg.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px');
  const panel = (await dlg.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  expect(panel.y + panel.height).toBeLessThanOrEqual(844);
  const a = await dialogActs(dlg);
  expect(a.names).toEqual(names);
  const [sec, pri] = a.btns as [typeof a.btns[0], typeof a.btns[0]];
  expect(pri.y + pri.height).toBeLessThanOrEqual(sec.y);
  for (const b of a.btns) {
    expect(Math.abs(b.width - a.row.width)).toBeLessThan(1);
    expect(Math.abs(b.x - a.row.x)).toBeLessThan(1);
    expect(b.height).toBe(44);
    expect(b.radius).toBe('999px');
  }
  expect(sec.glass).toBe(true);
  expect(await noHorizontalOverflow(page)).toBe(true);
}

test.beforeEach(({ api }) => { api.asAdmin = true; });

test('Neue Rolle on a phone: Anlegen above Abbrechen, full width; no dead space; one focus ring; it fits the screen', async ({ page, api }) => {
  api.admin.matrix.features.livetv = true;
  await page.goto('/admin/roles');
  await page.getByRole('button', { name: 'Neue Rolle' }).click();
  const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
  const name = dlg.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  expect(await name.evaluate((el) => { const cs = getComputedStyle(el); return [cs.boxShadow, cs.outlineWidth, cs.outlineOffset]; })).toEqual(['none', '2px', '2px']);
  const last = (await dlg.locator('.opt').last().boundingBox())!;
  const acts = (await dlg.locator('.dlg-acts').boundingBox())!;
  expect(acts.y - (last.y + last.height)).toBeLessThanOrEqual(40);
  await stacked(page, dlg, ['Abbrechen', 'Anlegen']);
  // the whole dialog fits a 844 px phone without scrolling its panel
  expect(await dlg.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  // the copy's select appears inside its row: nothing moves, the row stays inside the panel
  const before = await dlg.boundingBox();
  await dlg.getByRole('radio', { name: 'Kopie von …' }).check();
  const sel = dlg.getByRole('combobox', { name: 'Rolle zum Kopieren' });
  await expect(sel).toBeVisible();
  expect(await dlg.boundingBox()).toEqual(before);
  const s = (await sel.boundingBox())!, row = (await dlg.locator('.opt').last().boundingBox())!;
  expect(s.x + s.width).toBeLessThanOrEqual(row.x + row.width);
  expect(s.y).toBeGreaterThanOrEqual(row.y);
  expect(s.y + s.height).toBeLessThanOrEqual(row.y + row.height);
});

test.describe('the delete dialogs', () => {
  test.use({ allowedConsole: /status of 409/ });

  test('Rolle löschen on a phone: Löschen above Abbrechen, full width', async ({ page, api }) => {
    extraRole(api, 'oma', 'Oma', 2, 1);
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Oma')).getByRole('button', { name: 'Löschen' }).click();
    await stacked(page, page.getByRole('alertdialog', { name: 'Rolle „Oma“ löschen?' }), ['Abbrechen', 'Löschen']);
  });

  test('the confirm dialog on a phone: Löschen above Abbrechen, full width', async ({ page, api }) => {
    extraRole(api, 'leer', 'Leer');
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Leer')).getByRole('button', { name: 'Löschen' }).click();
    await stacked(page, page.getByRole('alertdialog', { name: 'Rolle „Leer“ löschen?' }), ['Abbrechen', 'Löschen']);
  });
});
