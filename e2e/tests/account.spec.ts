// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

/** Block 23 self-service: /me/account (profile, security, sessions & devices) */
test.describe('account page (/me/account)', () => {
  test('account page shows profile, 2FA state and sessions', async ({ page }) => {
    await page.goto('/me/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Konto' })).toBeVisible();
    // profile: name, colour picker, e-mail read-only
    const profile = page.getByRole('region', { name: 'Profil' });
    await expect(profile.getByLabel('Name')).toHaveValue('Tester');
    await expect(profile.getByRole('button', { name: 'Blau' })).toHaveAttribute('aria-pressed', 'true');
    await expect(profile.getByText('tester@example.com')).toBeVisible();
    await expect(profile.getByRole('textbox', { name: 'E-Mail' })).toHaveCount(0);
    // security: three chips, the manage link, no password/2FA actions
    const security = page.getByRole('region', { name: 'Sicherheit' });
    await expect(security.getByRole('list', { name: 'Zwei-Faktor-Anmeldung' }).getByRole('listitem')).toHaveText(['Authenticator-App an', 'Passkey aus', 'Wiederherstellungscodes an']);
    const manage = security.getByRole('link', { name: /Auf der Anmeldeseite verwalten/ });
    await expect(manage).toHaveAttribute('href', 'https://login.example.com/if/user/#/settings');
    await expect(manage).toHaveAttribute('target', '_blank');
    await expect(manage).toHaveAttribute('rel', /noopener/);
    await expect(security.getByText('Passwort und Zwei-Faktor-Anmeldung direkt in FriendFlix ändern – das kommt noch.')).toBeVisible();
    await expect(security.getByRole('button')).toHaveCount(0);
    // sessions: this device without a sign-out button, the other one with
    const sessions = page.getByRole('region', { name: 'Sitzungen & Geräte' });
    const rows = sessions.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Chrome auf Linux');
    await expect(rows.nth(0)).toContainText('Dieses Gerät');
    await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
    await expect(rows.nth(1)).toContainText('Safari auf iOS');
    await expect(rows.nth(1)).toContainText(/zuletzt gesehen/);
    await expect(sessions.getByRole('link', { name: 'Unter Geräte freigeben' })).toHaveCount(0);
    // privacy note (F18)
    await expect(page.getByText(/Admins können sehen, welche Titel du zuletzt geschaut hast/)).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('/me has an Account row for the owner profile', async ({ page }) => {
    await page.goto('/me');
    await page.getByRole('link', { name: 'Konto', exact: true }).click();
    await expect(page).toHaveURL(/\/me\/account$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Konto' })).toBeVisible();
  });

  test('saving the name sends PATCH and updates the header', async ({ page, api }) => {
    await page.goto('/me/account');
    await expect(page.getByRole('button', { name: 'Profilmenü (Tester)' })).toBeVisible();
    const profile = page.getByRole('region', { name: 'Profil' });
    const save = profile.getByRole('button', { name: 'Speichern' });
    await expect(save).toBeDisabled(); // nothing changed yet
    await profile.getByLabel('Name').fill('Tessa');
    await save.click();
    await expect(page.getByText('Profil gespeichert.')).toBeVisible();
    expect(api.log).toContain('PATCH /api/account/profile {"name":"Tessa"} -> 200');
    await expect(page.getByRole('button', { name: 'Profilmenü (Tessa)' })).toBeVisible();
    // the avatar alone
    await profile.getByRole('button', { name: 'Grün' }).click();
    await save.click();
    await expect.poll(() => api.log).toContain('PATCH /api/account/profile {"avatar":"green"} -> 200');
  });

  test('sign-out of another device asks first and keeps the device', async ({ page, api }) => {
    await page.goto('/me/account');
    const sessions = page.getByRole('region', { name: 'Sitzungen & Geräte' });
    await sessions.getByRole('button', { name: 'Safari auf iOS abmelden' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('„Safari auf iOS“ abmelden?');
    await expect(dlg).toContainText('Es bleibt freigegeben.');
    await dlg.getByRole('button', { name: 'Abmelden' }).click();
    await expect(page.getByText('„Safari auf iOS“ abgemeldet.')).toBeVisible();
    expect(api.log).toContain('POST /api/devices/dev-phone-00000000002/sign-out  -> 200');
    expect(api.log.some((l) => l.startsWith('DELETE '))).toBe(false);
    await expect(sessions.getByRole('listitem')).toHaveCount(2);
  });

  test('remove forgets the device after its own confirm, focus goes to the heading', async ({ page, api }) => {
    await page.goto('/me/account');
    const sessions = page.getByRole('region', { name: 'Sitzungen & Geräte' });
    await sessions.getByRole('button', { name: 'Safari auf iOS entfernen' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('„Safari auf iOS“ entfernen?');
    await expect(dlg).toContainText('neu freigegeben werden');
    await dlg.getByRole('button', { name: 'Entfernen' }).click();
    await expect(sessions.getByRole('listitem')).toHaveCount(1);
    expect(api.log.some((l) => l.startsWith('DELETE /api/devices/dev-phone-00000000002'))).toBe(true);
    await expect(sessions.getByRole('heading', { level: 2, name: 'Sitzungen & Geräte' })).toBeFocused();
  });

  test('sign out all others shows the count', async ({ page, api }) => {
    let listLoads = 0;
    page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/devices') listLoads++; });
    await page.goto('/me/account');
    await expect(page.getByText('Safari auf iOS')).toBeVisible();
    await page.getByRole('button', { name: 'Alle anderen Geräte abmelden' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Alle anderen Geräte abmelden?');
    // cancel sends nothing
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(api.log.filter((l) => l.includes('revoke-others'))).toEqual([]);
    await page.getByRole('button', { name: 'Alle anderen Geräte abmelden' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Abmelden' }).click();
    await expect(page.getByText('2 andere Sitzungen beendet.')).toBeVisible();
    expect(api.log.filter((l) => l.includes('revoke-others'))).toHaveLength(1);
    await expect.poll(() => listLoads).toBe(2); // the list is read again
  });

  test('waiting devices link to the approval page', async ({ page, api }) => {
    api.devices.push({ id: 'dev-new-0000000000003', label: 'Firefox auf Windows', approved: false, current: false, created_at: '2026-10-14T08:00:00Z', last_seen: '2026-10-14T08:00:00Z' });
    await page.goto('/me/account');
    const sessions = page.getByRole('region', { name: 'Sitzungen & Geräte' });
    await expect(sessions.getByText('1 Gerät wartet auf Freigabe.')).toBeVisible();
    await expect(sessions.getByRole('link', { name: 'Unter Geräte freigeben' })).toHaveAttribute('href', '/devices');
  });

  test('manage link hidden when manageUrl is null', async ({ page, api }) => {
    api.account = { ...api.account, manageUrl: null };
    await page.goto('/me/account');
    await expect(page.getByRole('region', { name: 'Sicherheit' }).getByRole('list', { name: 'Zwei-Faktor-Anmeldung' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Anmeldeseite/ })).toHaveCount(0);
  });

  test('mfa null shows not available', async ({ page, api }) => {
    api.account = { ...api.account, mfa: null };
    await page.goto('/me/account');
    const security = page.getByRole('region', { name: 'Sicherheit' });
    await expect(security.getByText('Nicht verfügbar')).toBeVisible();
    await expect(security.getByRole('list', { name: 'Zwei-Faktor-Anmeldung' })).toHaveCount(0);
    await expect(security.getByRole('link', { name: /Auf der Anmeldeseite verwalten/ })).toBeVisible();
  });

  test('?reauth=failed shows an alert', async ({ page }) => {
    await page.goto('/me/account?reauth=failed');
    await expect(page.getByRole('alert')).toHaveText('Diese Anmeldung passte nicht zu deinem Konto.');
  });

  test('a11y: sections have headings, chips have names', async ({ page }) => {
    await page.goto('/me/account');
    for (const name of ['Profil', 'Sicherheit', 'Sitzungen & Geräte']) {
      const region = page.getByRole('region', { name });
      await expect(region).toBeVisible();
      await expect(region.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    // every chip carries its text (state never by colour alone)
    const chips = page.getByRole('list', { name: 'Zwei-Faktor-Anmeldung' }).getByRole('listitem');
    for (const text of await chips.allInnerTexts()) expect(text).toMatch(/\S\s+(an|aus)$/);
    await expect(page.getByRole('region', { name: 'Sitzungen & Geräte' }).getByText('Dieses Gerät')).toBeVisible();
    // the colour swatches are named buttons in a labelled group
    await expect(page.getByRole('group', { name: 'Farbe' }).getByRole('button')).toHaveCount(8);
  });
});

test.describe('owner profile only', () => {
  const KID = { ...ME, profile: { id: 'p2', name: 'Anna', avatar: 'a2', isOwner: false } };
  test('/me has no Account row on another profile', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.goto('/me');
    await expect(page.getByRole('heading', { level: 2, name: 'Konto & Einstellungen' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Konto', exact: true })).toHaveCount(0);
  });
  test.describe('refused', () => {
    test.use({ allowedConsole: /status of 403/ });
    test('/me/account answering 403 shows the hint, no cards and no device list', async ({ page }) => {
      let devices = 0;
      page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/devices') devices++; });
      await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
      await page.route('**/api/account', (r) => r.fulfill({ status: 403, json: { error: 'owner_required' } }));
      await page.goto('/me/account');
      await expect(page.getByText('Dein Konto verwaltest du im Hauptprofil.')).toBeVisible();
      await expect(page.locator('main').getByRole('region')).toHaveCount(0);
      expect(devices).toBe(0);
    });
  });
});

test.describe('account page errors', () => {
  test.use({ allowedConsole: /status of 409/ });
  test('a taken name shows a hint and keeps the field', async ({ page }) => {
    await page.route('**/api/account/profile', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"name_taken"}' }));
    await page.goto('/me/account');
    const profile = page.getByRole('region', { name: 'Profil' });
    await profile.getByLabel('Name').fill('Anna');
    await profile.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText('Ein anderes Profil deines Kontos heißt schon so.')).toBeVisible();
    await expect(profile.getByLabel('Name')).toHaveValue('Anna');
    await expect(page.getByRole('button', { name: 'Profilmenü (Tester)' })).toBeVisible();
  });
});
