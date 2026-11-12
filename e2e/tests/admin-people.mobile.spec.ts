// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const SHOTS = process.env.B18_SHOTS;
const logged = (api: { log: string[] }, re: RegExp) => api.log.some((l) => re.test(l));

test.describe('admin people (phone)', () => {
  test.use({ allowedConsole: /status of (500|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  for (const [path, h1, probe] of [['users', 'Nutzer', /Anna Beispiel/], ['roles', 'Rollen', /3 Personen/], ['devices', 'Geräte', /Chrome auf Windows/], ['users?tab=invites', 'Nutzer', /Für Annas Bruder/], ['audit', 'Audit-Log', /Emma Schneider gesperrt/]] as const) {
    test(`${path}: cards instead of a table, nothing overflows at 390px`, async ({ page }) => {
      await page.goto(`/admin/${path}`);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      if (probe) await expect(page.getByText(probe).first()).toBeVisible();
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      if (SHOTS) {
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/${path.replace('?tab=', '-')}-phone.png`, fullPage: true });
      }
    });
  }

  test('users: role select and action menu work in the card layout', async ({ page, api }) => {
    await page.goto('/admin/users');
    const card = page.getByRole('row', { name: /Ben Test/ });
    await card.getByRole('combobox', { name: 'Rolle von Ben Test' }).selectOption('guest');
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Ben Test ist jetzt Gast.')).toBeVisible();
    await card.getByRole('button', { name: 'Aktionen für Ben Test' }).click();
    await expect(page.getByRole('dialog', { name: 'Ben Test' }).getByRole('button', { name: 'Überall abmelden' })).toBeVisible();
    expect(api.log.some((l) => l.includes('"role":"guest"'))).toBe(true);
  });

  test('bulk lock two users asks and calls the bulk API', async ({ page, api }) => {
    await page.goto('/admin/users');
    await page.getByRole('checkbox', { name: 'Ben Test auswählen' }).check();
    await page.getByRole('checkbox', { name: 'Clara Fischer auswählen' }).check();
    const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
    await bar.getByRole('button', { name: 'Sperren', exact: true }).click();
    await page.getByRole('alertdialog', { name: '2 Nutzer sperren?' }).getByRole('button', { name: 'Sperren' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('2 Konten geändert.')).toBeVisible();
    expect(api.log.some((l) => l.startsWith('POST /api/admin/users/bulk ') && l.includes('"action":"lock"'))).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('filter chip row scrolls inside itself, the page does not, chips are 44 px tall', async ({ page }) => {
    await page.goto('/admin/users');
    const row = page.getByRole('group', { name: 'Filter' });
    await expect(row.getByRole('button', { name: 'Mit Ausnahmen' })).toBeVisible();
    await expect.poll(() => row.evaluate((el) => el.scrollWidth > el.clientWidth + 8)).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const box = await row.getByRole('button', { name: 'Mit Ausnahmen' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    // the last chip can be reached by scrolling and works there
    await row.getByRole('button', { name: 'Ohne 2FA' }).click();
    await expect(row.getByRole('button', { name: 'Ohne 2FA' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('summary tiles fit and the bulk rights bar wraps without overflow', async ({ page, api }) => {
    await page.goto('/admin/users');
    await expect(page.getByRole('region', { name: 'Überblick' }).getByRole('link', { name: /Warten auf Freigabe/ })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await page.getByRole('checkbox', { name: 'Anna Beispiel auswählen' }).check();
    await page.getByRole('checkbox', { name: 'Ben Test auswählen' }).check();
    const bar = page.getByRole('region', { name: 'Aktionen für die Auswahl' });
    await bar.getByRole('combobox', { name: 'Recht setzen …' }).selectOption('cast');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    for (const n of ['Erlauben', 'Verbieten', 'Wie Rolle', 'Richtlinien neu anwenden']) {
      const b = await bar.getByRole('button', { name: n }).boundingBox();
      expect(b!.height, n).toBeGreaterThanOrEqual(44);
    }
    await bar.getByRole('button', { name: 'Verbieten' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Übernehmen' }).click();
    await expect.poll(() => logged(api, /POST \/api\/admin\/users\/bulk .*"action":"perm","perm":"cast","value":false/)).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('approval tab approves with role', async ({ page, api }) => {
    await page.goto('/admin/users?tab=approvals');
    const card = page.getByRole('region', { name: 'Mia Neu' });
    await card.getByRole('combobox', { name: 'Rolle' }).selectOption('guest');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await card.getByRole('button', { name: 'Freigeben' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Mia Neu freigegeben.')).toBeVisible();
    expect(api.log.some((l) => l.startsWith('POST /api/admin/approvals/') && l.includes('"role":"guest"'))).toBe(true);
  });

  test('invites tab creates a 3-use invite and shows 0/3', async ({ page, api }) => {
    await page.goto('/admin/users?tab=invites');
    const form = page.getByRole('region', { name: 'Neue Einladung' });
    await form.getByRole('spinbutton', { name: 'Max. Nutzungen' }).fill('3');
    await form.getByRole('textbox', { name: 'Notiz' }).fill('Lesekreis');
    await form.getByRole('button', { name: 'Einladung erstellen' }).click();
    await expect(page.getByRole('row', { name: /Lesekreis/ })).toContainText('0/3');
    expect(api.log.some((l) => l.startsWith('POST /api/admin/invites ') && l.includes('"maxUses":3'))).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('old /admin/invites redirects', async ({ page }) => {
    await page.goto('/admin/invites');
    await expect(page).toHaveURL(/\/admin\/users\?tab=invites$/);
    await expect(page.getByText('Für Annas Bruder')).toBeVisible();
  });

  test('devices: approve button inside the card', async ({ page, api }) => {
    await page.goto('/admin/devices');
    await page.getByRole('button', { name: '„Chrome auf Windows“ von Anna Beispiel freigeben' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('„Chrome auf Windows“ von Anna Beispiel freigegeben.')).toBeVisible();
    await expect.poll(() => api.log.some((l) => l.startsWith('POST /api/admin/devices/approve'))).toBe(true);
  });

  test('invites: form + link + QR fit', async ({ page }) => {
    await page.goto('/admin/users?tab=invites');
    await page.getByRole('button', { name: 'Einladung erstellen' }).click();
    const res = page.getByRole('region', { name: 'Dein Einladungs-Link' });
    await res.getByRole('button', { name: 'QR-Code zeigen' }).click();
    await expect(res.getByRole('img', { name: 'QR-Code' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
