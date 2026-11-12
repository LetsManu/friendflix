// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { auid, envOnlyRole } from '../mocks/admin.js';

// Admin → Live-TV → Gruppen & Rechte (/admin/livetv?tab=groups), Task 25: the release of groups an import created, the list with its
// switches and menu, the matrix by role with the people who have exceptions, merge, delete, the order, and Live TV in the people pages
// (the role matrix and sheet, a person's Rechte tab, Sicht prüfen).
const ANNA = auid(2);
const CLARA = auid(4);
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const writes = (api: MockState, m: string, p: RegExp) => api.admin.livetv.area.calls.filter((c) => c.m === m && p.test(c.p));
const rows = (page: Page) => page.locator('ul.list > li');
const row = (page: Page, id: string) => page.locator(`li[data-gid="${id}"]`);
const notice = (page: Page) => page.getByRole('status').filter({ hasText: 'auf Freigabe' });
const bulk = (page: Page) => page.getByRole('group', { name: 'Ausgewählte Gruppen' });
const view = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });

async function menu(page: Page, group: string, item: string) {
  await page.getByRole('button', { name: `Aktionen für ${group}` }).click();
  await page.getByRole('dialog', { name: group }).getByRole('button', { name: item }).click();
}

test.describe('admin: Live-TV, Gruppen & Rechte (desktop)', () => {
  test.use({ allowedConsole: /status of (400|409)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('unreleased groups come first with the chip and the notice', async ({ page }) => {
    await page.goto('/admin/livetv?tab=groups');
    await expect(page.getByRole('tab', { name: 'Gruppen & Rechte' })).toHaveAttribute('aria-selected', 'true');
    await expect(rows(page)).toHaveCount(7);
    await expect(rows(page).nth(0)).toContainText('Kinofilme');
    await expect(rows(page).nth(1)).toContainText('Musik & Konzert');
    for (const i of [0, 1]) {
      await expect(rows(page).nth(i)).toContainText('Nicht freigegeben');
      await expect(rows(page).nth(i)).toContainText('Für niemanden sichtbar');
      await expect(rows(page).nth(i).getByRole('button', { name: 'Freigeben …' })).toBeVisible();
      // an unreleased group has no role chips and no Kinderfreundlich switch yet
      await expect(rows(page).nth(i).getByRole('switch')).toHaveCount(0);
    }
    await expect(notice(page)).toContainText('2 neue Gruppen warten auf Freigabe');
    await expect(notice(page).getByRole('button', { name: 'Nur diese zeigen' })).toBeVisible();
    // the released ones follow by position, with count, provider groups, switch and role chips
    await expect(rows(page).nth(2)).toContainText('Sport');
    await expect(rows(page).nth(2)).toContainText('Sender: 34');
    await expect(rows(page).nth(2)).toContainText('aus: DE | Sport, DE | Sport HD');
    await expect(rows(page).nth(2)).not.toContainText('Nicht freigegeben');
    await expect(row(page, 'g-sport').getByRole('button', { name: 'Familie' })).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, 'g-sport').getByRole('button', { name: 'Gast' })).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 'g-kinder').getByRole('switch', { name: 'Kinderfreundlich: Kinderinsel' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Kinderprofile sehen: Kinderinsel, Natur & Tiere (23 Sender)')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('release two groups for family', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    const release = bulk(page).getByRole('button', { name: 'Freigeben …' });
    await expect(release).toBeDisabled();
    await rows(page).nth(0).getByRole('checkbox', { name: 'Kinofilme auswählen' }).check();
    await rows(page).nth(1).getByRole('checkbox', { name: 'Musik & Konzert auswählen' }).check();
    await expect(bulk(page)).toContainText('Ausgewählt: 2');
    await release.click();
    const dlg = page.getByRole('dialog', { name: 'Gruppen freigeben' });
    // no role preselected, Kinderfreundlich off, the line carries the channel count of both groups
    await expect(dlg.getByRole('checkbox')).toHaveCount(4);
    for (const c of await dlg.getByRole('checkbox').all()) await expect(c).not.toBeChecked();
    await expect(dlg.getByRole('switch', { name: 'Kinderfreundlich' })).toHaveAttribute('aria-checked', 'false');
    await expect(dlg).toContainText('Danach sehen Personen mit diesen Rollen die 68 Sender der Gruppe.');
    await expect(dlg).toContainText('Ohne Rolle sehen die Gruppen nur Admins und Personen mit einer Ausnahme.');
    await dlg.getByRole('checkbox', { name: 'Familie' }).check();
    await dlg.getByRole('button', { name: 'Freigeben', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await expect(toasts(page).getByText('Freigegeben.')).toBeVisible();
    expect(writes(api, 'POST', /\/groups\/release$/)).toHaveLength(1);
    expect(writes(api, 'POST', /\/groups\/release$/)[0]!.body).toEqual({ ids: ['g-kino', 'g-musik'], roles: ['family'], kidFriendly: false });
    // the chips and the notice are gone, the groups stand in the list by position with their role chip
    await expect(page.getByText('Nicht freigegeben')).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    await expect(row(page, 'g-kino').getByRole('button', { name: 'Familie' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a single group is released from its row, with Kinderfreundlich', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await row(page, 'g-kino').getByRole('button', { name: 'Freigeben …' }).click();
    const dlg = page.getByRole('dialog', { name: 'Gruppen freigeben' });
    await expect(dlg).toContainText('Danach sehen Personen mit diesen Rollen die 41 Sender der Gruppe.');
    await dlg.getByRole('switch', { name: 'Kinderfreundlich' }).click();
    await dlg.getByRole('button', { name: 'Freigeben', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'POST', /\/groups\/release$/)[0]!.body).toEqual({ ids: ['g-kino'], roles: [], kidFriendly: true });
    await expect(notice(page)).toContainText('1 neue Gruppe wartet auf Freigabe');
  });

  test('withdraw a release confirms and PATCHes released false', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await menu(page, 'Sport', 'Freigabe zurücknehmen');
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('„Sport“ nicht mehr freigeben?');
    expect(writes(api, 'PATCH', /groups\/g-sport$/)).toHaveLength(0);
    await ask.getByRole('button', { name: 'Freigabe zurücknehmen' }).click();
    await expect(toasts(page).getByText('Freigabe zurückgenommen.')).toBeVisible();
    expect(writes(api, 'PATCH', /groups\/g-sport$/)[0]!.body).toEqual({ released: false });
    await expect(rows(page).nth(0)).toContainText('Sport');
    await expect(rows(page).nth(0)).toContainText('Nicht freigegeben');
    await expect(notice(page)).toContainText('3 neue Gruppen warten auf Freigabe');
    // the roles stay: a new release finds them again only through the sheet (none preselected), the backend keeps them
    expect(api.admin.livetv.area.groups.find((g) => g.id === 'g-sport')!.roles).toEqual(['family', 'friend']);
  });

  test('?pending=1 shows only the waiting groups', async ({ page }) => {
    await page.goto('/admin/livetv?tab=groups&pending=1');
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0)).toContainText('Kinofilme');
    await expect(rows(page).nth(1)).toContainText('Musik & Konzert');
    await expect(notice(page).getByRole('button', { name: 'Nur diese zeigen' })).toHaveCount(0);
    await notice(page).getByRole('button', { name: 'Alle zeigen' }).click();
    await expect(rows(page)).toHaveCount(7);
    await expect(page).toHaveURL(/\?tab=groups$/);
    await notice(page).getByRole('button', { name: 'Nur diese zeigen' }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(page).toHaveURL(/pending=1/);
  });

  test('drag order of groups saves through PUT /groups/order', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await view(page, 'Reihenfolge').click();
    const list = page.getByRole('list').filter({ has: page.getByRole('button', { name: 'Sport', exact: true }) });
    await expect(list.getByRole('listitem')).toHaveCount(7);
    const grip = list.getByRole('button', { name: 'Sport', exact: true });
    await grip.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Gespeichert', { exact: true })).toBeVisible();
    const put = writes(api, 'PUT', /\/groups\/order$/);
    expect(put).toHaveLength(1);
    expect(put[0]!.body).toEqual({ ids: ['g-nachrichten', 'g-sport', 'g-kinder', 'g-natur', 'g-regional', 'g-kino', 'g-musik'] });
    // the groups' order never touches the channels' (F22)
    expect(api.admin.livetv.area.calls.some((c) => /\/channels\/order/.test(c.p))).toBe(false);
  });

  test('create a group, mark it kid-friendly, grant family', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await page.getByRole('button', { name: 'Gruppe anlegen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Neue Gruppe' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Dokumentation');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(toasts(page).getByText('Gruppe angelegt.')).toBeVisible();
    expect(writes(api, 'POST', /\/groups$/)[0]!.body).toEqual({ name: 'Dokumentation' });
    // a manual group starts released (ruling 39): no chip, switch and chips there
    const g = row(page, 'g-new-1');
    await expect(g).toContainText('Dokumentation');
    await expect(g).not.toContainText('Nicht freigegeben');
    await g.getByRole('switch', { name: 'Kinderfreundlich: Dokumentation' }).click();
    await expect(g.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await g.getByRole('button', { name: 'Familie' }).click();
    await expect(g.getByRole('button', { name: 'Familie' })).toHaveAttribute('aria-pressed', 'true');
    const patches = writes(api, 'PATCH', /groups\/g-new-1$/);
    expect(patches.map((c) => c.body)).toEqual([{ kidFriendly: true }, { roles: ['family'] }]);
  });

  test('rename, and a taken name says so', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await menu(page, 'Regional', 'Umbenennen');
    const dlg = page.getByRole('dialog', { name: '„Regional“ umbenennen' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('sport');
    await dlg.getByRole('button', { name: 'Umbenennen' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Diesen Namen gibt es schon.');
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Nordküste');
    await dlg.getByRole('button', { name: 'Umbenennen' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(row(page, 'g-regional')).toContainText('Nordküste');
    expect(writes(api, 'PATCH', /groups\/g-regional$/).map((c) => c.body)).toEqual([{ name: 'sport' }, { name: 'Nordküste' }]);
  });

  test('matrix switch saves the group\'s roles', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await view(page, 'Nach Rolle').click();
    const grid = page.getByRole('table', { name: 'Gruppen nach Rolle' });
    await expect(grid.getByRole('columnheader')).toHaveText(['Gruppen & Rechte', 'Familie', 'Freund', 'Gast', 'Crew']);
    const sw = grid.getByRole('switch', { name: 'Sport für Gast' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(grid.getByRole('switch', { name: 'Sport für Familie' })).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(writes(api, 'PATCH', /groups\/g-sport$/)[0]!.body).toEqual({ roles: ['family', 'friend', 'guest'] });
    await grid.getByRole('switch', { name: 'Sport für Familie' }).click();
    expect(writes(api, 'PATCH', /groups\/g-sport$/)[1]!.body).toEqual({ roles: ['friend', 'guest'] });
    // an unreleased group has no working switches (it is released first)
    await expect(grid.getByRole('switch', { name: 'Kinofilme für Familie' })).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled: Playwright would wait for it to enable, so the click is forced
    await grid.getByRole('switch', { name: 'Kinofilme für Familie' }).click({ force: true });
    expect(writes(api, 'PATCH', /groups\/g-kino$/)).toHaveLength(0);
    await expect(page.getByText('Admins sehen alle freigegebenen Gruppen.')).toBeVisible();
  });

  test('a role defined only in .env is read-only', async ({ page, api }) => {
    api.admin.matrix.roles.push(envOnlyRole());
    await page.goto('/admin/livetv?tab=groups');
    await expect(row(page, 'g-sport').getByRole('button', { name: 'Kombüse' })).toHaveAttribute('aria-disabled', 'true');
    await row(page, 'g-sport').getByRole('button', { name: 'Kombüse' }).click({ force: true });
    await view(page, 'Nach Rolle').click();
    const sw = page.getByRole('switch', { name: 'Sport für Kombüse' });
    await expect(sw).toHaveAttribute('aria-disabled', 'true');
    await sw.click({ force: true });
    expect(writes(api, 'PATCH', /groups\//)).toHaveLength(0);
    // the release sheet shows it, but it cannot be ticked
    await view(page, 'Liste').click();
    await row(page, 'g-kino').getByRole('button', { name: 'Freigeben …' }).click();
    await expect(page.getByRole('dialog', { name: 'Gruppen freigeben' }).getByRole('checkbox', { name: 'Kombüse' })).toBeDisabled();
  });

  test('merge dialog warns that the channels become visible at once', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    const merge = bulk(page).getByRole('button', { name: 'Zusammenführen …' });
    await row(page, 'g-sport').getByRole('checkbox').check();
    await expect(merge).toBeDisabled();
    await row(page, 'g-nachrichten').getByRole('checkbox').check();
    await merge.click();
    const dlg = page.getByRole('alertdialog', { name: 'Gruppen zusammenführen' });
    // the group with the most channels is the first guess
    await expect(dlg.getByLabel('Zusammenführen in')).toHaveValue('g-sport');
    await expect(dlg).toContainText('Die Anbietergruppen und Sender von Nachrichten gehen in „Sport“ über, die anderen Gruppen werden gelöscht.');
    await expect(dlg).toContainText('Die Sender sind sofort für alle sichtbar, die „Sport“ sehen dürfen.');
    await dlg.getByLabel('Zusammenführen in').selectOption('g-nachrichten');
    await expect(dlg).toContainText('Die Sender sind sofort für alle sichtbar, die „Nachrichten“ sehen dürfen.');
    await dlg.getByRole('button', { name: 'Zusammenführen', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await expect(toasts(page).getByText('Gruppen zusammengeführt.')).toBeVisible();
    expect(writes(api, 'POST', /\/groups\/merge$/)[0]!.body).toEqual({ ids: ['g-sport'], into: 'g-nachrichten' });
    await expect(row(page, 'g-sport')).toHaveCount(0);
    await expect(row(page, 'g-nachrichten')).toContainText('Sender: 52');
    await expect(row(page, 'g-nachrichten')).toContainText('aus: DE | News, DE | Sport, DE | Sport HD');
  });

  test('delete confirm', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=groups');
    await menu(page, 'Regional', 'Löschen');
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('„Regional“ löschen?');
    await expect(ask).toContainText('Die 9 Sender landen unter „Ohne Gruppe“, die nur Admins sehen.');
    expect(writes(api, 'DELETE', /groups\//)).toHaveLength(0);
    await ask.getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Gruppe gelöscht.')).toBeVisible();
    expect(writes(api, 'DELETE', /groups\/g-regional$/)).toHaveLength(1);
    await expect(row(page, 'g-regional')).toHaveCount(0);
  });

  test('exceptions list links to the person', async ({ page, api }) => {
    api.admin.livetv.area.exceptions = { [ANNA]: { allow: ['g-regional'], deny: [] }, [CLARA]: { allow: [], deny: ['g-nachrichten'] } };
    await page.goto('/admin/livetv?tab=groups');
    await view(page, 'Nach Rolle').click();
    const people = page.getByRole('region', { name: 'Personen mit Ausnahmen' });
    const items = people.getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: 'Anna Beispiel' })).toContainText('+ Regional');
    await expect(items.filter({ hasText: 'Clara Fischer' })).toContainText('− Nachrichten');
    await expect(people.getByRole('link', { name: 'Anna Beispiel' })).toHaveAttribute('href', `/admin/users/${ANNA}?tab=rights`);
    await people.getByRole('link', { name: 'Anna Beispiel' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${ANNA}\\?tab=rights$`));
  });

  test('without exceptions the list says so', async ({ page }) => {
    await page.goto('/admin/livetv?tab=groups');
    await view(page, 'Nach Rolle').click();
    await expect(page.getByRole('region', { name: 'Personen mit Ausnahmen' })).toContainText('Noch keine Ausnahmen.');
  });
});

test.describe('admin: Live TV in the people pages (desktop)', () => {
  test.use({ allowedConsole: /status of (400|409)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); api.admin.matrix.features.livetv = true; });

  test('role matrix shows the Kanalgruppen row only with Live TV', async ({ page, api }) => {
    api.admin.matrix.features.livetv = false;
    await page.goto('/admin/roles');
    await expect(page.getByRole('grid', { name: 'Rechte der Rollen' })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: 'Kanalgruppen' })).toHaveCount(0);
    await expect(page.getByRole('rowheader', { name: 'Live-TV', exact: true })).toHaveCount(0);
    api.admin.matrix.features.livetv = true;
    await page.reload();
    await expect(page.getByRole('rowheader', { name: 'Kanalgruppen' })).toBeVisible();
    const link = (name: string) => page.getByRole('link', { name });
    await expect(link('Sport, Nachrichten +2')).toHaveAttribute('href', '/admin/livetv?tab=groups');
    await expect(link('Sport, Nachrichten +3')).toBeVisible();
    await expect(page.getByRole('row', { name: /Kanalgruppen/ })).toContainText('Keine');
    await link('Sport, Nachrichten +2').click();
    await expect(page).toHaveURL(/\/admin\/livetv\?tab=groups$/);
  });

  test('role sheet lists the role\'s channel groups as chips', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await page.locator('button.rn', { hasText: 'Familie' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolle „Familie“' });
    const sec = sheet.getByRole('region', { name: 'Kanalgruppen' });
    await expect(sec.getByRole('listitem')).toHaveText(['Sport', 'Nachrichten', 'Kinderinsel', 'Natur & Tiere']);
    await expect(sec.getByRole('link', { name: 'Unter „Gruppen & Rechte“ ändern' })).toHaveAttribute('href', '/admin/livetv?tab=groups');
    await page.keyboard.press('Escape');
    // without Live TV the section is not there
    api.admin.matrix.features.livetv = false;
    await page.reload();
    await page.locator('button.rn', { hasText: 'Familie' }).click();
    await expect(page.getByRole('dialog', { name: 'Rolle „Familie“' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Kanalgruppen' })).toHaveCount(0);
  });

  test('Rechte tab adds Sport for a guest', async ({ page, api }) => {
    await page.goto(`/admin/users/${CLARA}?tab=rights`);
    const sec = page.getByRole('region', { name: 'Kanalgruppen-Ausnahmen' });
    await expect(sec).toContainText('Gilt sofort.');
    const plus = sec.getByRole('group', { name: 'Sieht zusätzlich' });
    // only released groups the guest's role does not see are offered for +; unreleased ones never
    const pick = plus.getByLabel('Gruppe hinzufügen (+)');
    await expect(pick.locator('option')).toHaveText(['Gruppe wählen …', 'Sport', 'Kinderinsel', 'Natur & Tiere', 'Regional']);
    await pick.selectOption({ label: 'Sport' });
    await expect(toasts(page).getByText('Ausnahmen von Clara Fischer gespeichert.')).toBeVisible();
    expect(writes(api, 'PUT', /\/livetv-groups$/)[0]!.body).toEqual({ allow: ['g-sport'], deny: [] });
    await expect(plus.getByRole('button', { name: 'Ausnahme für Sport aufheben' })).toBeVisible();
    // − takes away a group the role sees
    const minus = sec.getByRole('group', { name: 'Sieht nicht' });
    await expect(minus.getByLabel('Gruppe entziehen (−)').locator('option')).toHaveText(['Gruppe wählen …', 'Nachrichten']);
    await minus.getByLabel('Gruppe entziehen (−)').selectOption({ label: 'Nachrichten' });
    await expect.poll(() => writes(api, 'PUT', /\/livetv-groups$/).length).toBe(2);
    expect(writes(api, 'PUT', /\/livetv-groups$/)[1]!.body).toEqual({ allow: ['g-sport'], deny: ['g-nachrichten'] });
    // cancelling one exception keeps the other
    await plus.getByRole('button', { name: 'Ausnahme für Sport aufheben' }).click();
    await expect.poll(() => writes(api, 'PUT', /\/livetv-groups$/).length).toBe(3);
    expect(writes(api, 'PUT', /\/livetv-groups$/)[2]!.body).toEqual({ allow: [], deny: ['g-nachrichten'] });
    // saved at once: it is still there after a reload
    await page.reload();
    await expect(page.getByRole('region', { name: 'Kanalgruppen-Ausnahmen' }).getByRole('group', { name: 'Sieht nicht' }).getByRole('button', { name: 'Ausnahme für Nachrichten aufheben' })).toBeVisible();
  });

  test('an admin takes no group exceptions: none are offered, a refusal is shown', async ({ page, api }) => {
    await page.goto('/admin/users/u1?tab=rights');
    const sec = page.getByRole('region', { name: 'Kanalgruppen-Ausnahmen' });
    await expect(sec).toContainText('Admins sehen alle freigegebenen Gruppen.');
    await expect(sec.getByRole('combobox')).toHaveCount(0);
    // a role change elsewhere meanwhile: the person became an admin, the backend refuses and the page says why
    await page.goto(`/admin/users/${CLARA}?tab=rights`);
    await expect(page.getByRole('region', { name: 'Kanalgruppen-Ausnahmen' }).getByLabel('Gruppe hinzufügen (+)')).toBeVisible();
    api.admin.users.find((u) => u.id === CLARA)!.role = 'admin';
    await page.getByLabel('Gruppe hinzufügen (+)').selectOption({ label: 'Sport' });
    await expect(toasts(page).getByText('Admin-Konten bekommen keine Gruppen-Ausnahmen: Sie sehen alle freigegebenen Gruppen.')).toBeVisible();
  });

  test('without Live TV the Rechte tab has no group section', async ({ page, api }) => {
    api.admin.matrix.features.livetv = false;
    await page.goto(`/admin/users/${CLARA}?tab=rights`);
    await expect(page.getByLabel('Notiz')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Kanalgruppen-Ausnahmen' })).toHaveCount(0);
  });

  test('Sicht prüfen explains a hidden group', async ({ page, api }) => {
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.liveTv = true;
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const live = page.getByRole('region', { name: 'Live-TV' });
    const item = (name: string) => live.getByRole('listitem').filter({ hasText: name });
    await expect(live).toContainText('Sender: 18');
    await expect(item('Nachrichten')).toContainText('sichtbar');
    await expect(item('Sport')).toContainText('Sport · für Gast nicht freigegeben');
    await expect(item('Kinofilme')).toContainText('Kinofilme · Gruppe noch nicht freigegeben');
    // the kids profile: the grown-up group is hidden as not kid-friendly, no channel is left
    await page.getByRole('group', { name: 'Profil wählen' }).getByRole('button', { name: /^Kinder/ }).click();
    await expect(item('Nachrichten')).toContainText('Nachrichten · nicht kinderfreundlich');
    await expect(live).toContainText('Sender: 0');
    await expect(item('Kinderinsel')).not.toContainText('nicht kinderfreundlich');
  });

  test('Sicht prüfen names a blocked group', async ({ page, api }) => {
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.liveTv = true;
    api.admin.livetv.area.exceptions = { [CLARA]: { allow: ['g-sport'], deny: ['g-nachrichten'] } };
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const live = page.getByRole('region', { name: 'Live-TV' });
    await expect(live.getByRole('listitem').filter({ hasText: 'Nachrichten' })).toContainText('für diese Person gesperrt');
    await expect(live.getByRole('listitem').filter({ hasText: 'Sport' })).not.toContainText('nicht freigegeben');
    await expect(live).toContainText('Sender: 34');
  });

  test('Sicht prüfen shows nothing about Live TV when it is not installed or not allowed', async ({ page, api }) => {
    // installed, but the guest role has no Live TV right: the answer is null
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    await expect(page.getByRole('region', { name: 'Kurzfassung' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Live-TV' })).toHaveCount(0);
    // the right is there, the container is not
    api.admin.matrix.roles.find((r) => r.key === 'guest')!.values.liveTv = true;
    api.admin.livetv.installed = false;
    await page.reload();
    await expect(page.getByRole('region', { name: 'Kurzfassung' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Live-TV' })).toHaveCount(0);
  });
});
