// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { cardTopsRecorded, noHorizontalOverflow, recordCardTops } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';
import { done, installLogin, loginState, password } from '../mocks/login.js';

/** the classic sign-in mode: GET /auth/flow/config answers `authentik`, so a re-authentication goes through /auth/reauth */
const classicSignIn = (page: import('@playwright/test').Page) => page.route('**/auth/flow/config', (r) => r.fulfill({ json: { mode: 'authentik', recovery: false, enroll: false } }));

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
    // the e-mail is changed in the security section: the profile points to that row
    await expect(profile.getByText('Die E-Mail-Adresse änderst du unter „Sicherheit“.')).toBeVisible();
    await expect(profile.getByRole('link', { name: 'Zur E-Mail-Adresse' })).toHaveAttribute('href', '#sec-email');
    await expect(page.locator('#sec-email')).toBeAttached();
    // security: the rows (password, authenticator app, passkeys, recovery codes, e-mail) and the manage link
    const security = page.getByRole('region', { name: 'Sicherheit' });
    await expect(security.getByRole('button', { name: 'Passwort ändern' })).toBeVisible();
    await expect(security.getByRole('list', { name: 'Authenticator-App' }).getByText('Pixel 8')).toBeVisible();
    await expect(security.getByRole('link', { name: 'Auf der Anmeldeseite hinzufügen' })).toHaveAttribute('href', '/auth/flow/classic/webauthn-setup');
    await expect(security.getByRole('button', { name: 'Neu erzeugen' })).toBeVisible();
    await expect(security.getByText('tester@example.com')).toBeVisible();
    const manage = security.getByRole('link', { name: /Auf der Anmeldeseite verwalten/ });
    await expect(manage).toHaveAttribute('href', 'https://login.example.com/if/user/#/settings');
    await expect(manage).toHaveAttribute('target', '_blank');
    await expect(manage).toHaveAttribute('rel', /noopener/);
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
    api.devices.push({ id: 'dev-new-0000000000003', label: 'Firefox auf Windows', name: null, kind: 'web', approved: false, current: false, created_at: '2026-10-14T08:00:00Z', last_seen: '2026-10-14T08:00:00Z' });
    await page.goto('/me/account');
    const sessions = page.getByRole('region', { name: 'Sitzungen & Geräte' });
    await expect(sessions.getByText('1 Gerät wartet auf Freigabe.')).toBeVisible();
    await expect(sessions.getByRole('link', { name: 'Unter Geräte freigeben' })).toHaveAttribute('href', '/devices');
  });

  test('manage link hidden when manageUrl is null', async ({ page, api }) => {
    api.account = { ...api.account, manageUrl: null };
    await page.goto('/me/account');
    await expect(page.getByRole('region', { name: 'Sicherheit' }).getByRole('button', { name: 'Passwort ändern' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Auf der Anmeldeseite verwalten/ })).toHaveCount(0);
  });

  test('mfa null: the security rows stay usable', async ({ page, api }) => {
    api.account = { ...api.account, mfa: null };
    await page.goto('/me/account');
    const security = page.getByRole('region', { name: 'Sicherheit' });
    // the rows do not depend on Authentik's 2FA state: they stay usable (the backend decides on each action)
    await expect(security.getByRole('button', { name: 'Passwort ändern' })).toBeVisible();
    await expect(security.getByRole('link', { name: /Auf der Anmeldeseite verwalten/ })).toBeVisible();
  });

  test('?reauth=failed shows an alert', async ({ page }) => {
    await page.goto('/me/account?reauth=failed');
    await expect(page.locator('[data-hint="reauth-failed"]')).toContainText('Klappt es wieder nicht, versuch es in einer halben Minute');
    await expect(page.getByRole('alert')).toHaveText('Die Anmeldung konnte nicht bestätigt werden. Bitte versuch es noch einmal.');
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

/** E-mail stage B: the E-Mails card (one switch per mail type, saved at once) */
test.describe('mail card', () => {
  const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'E-Mails' });

  test('mail card shows the switches and saves one', async ({ page, api }) => {
    api.account = { ...api.account, email: 'anna@friend.example.com' };
    await page.goto('/me/account');
    const mail = card(page);
    await expect(mail.getByRole('heading', { level: 2, name: 'E-Mails' })).toBeVisible();
    await expect(mail.getByText('anna@friend.example.com')).toBeVisible();
    const sw = (name: string) => mail.getByRole('switch', { name });
    for (const name of ['Verfügbare Wünsche', 'Aufnahmen', 'Ablaufende Downloads']) {
      await expect(sw(name)).toHaveAttribute('aria-checked', 'true');
      await expect(sw(name)).toBeEnabled();
    }
    await expect(mail.getByText('Wenn etwas, das du dir gewünscht hast, da ist.')).toBeVisible();
    await expect(mail.getByText('Wenn eine Aufnahme fertig ist, fehlschlägt oder gelöscht wird.')).toBeVisible();
    await expect(mail.getByText('Kurz bevor Downloads auf deinen Geräten ablaufen.')).toBeVisible();
    await expect(mail.getByText('Dein Server verschickt noch keine E-Mails.')).toHaveCount(0);
    await expect(mail.getByRole('switch')).toHaveCount(4); // no admin switches for a non-admin
    await sw('Aufnahmen').click();
    await expect(sw('Aufnahmen')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => api.log).toContain('PUT /api/account/mail {"type":"recording","on":false} -> 200');
    expect(api.accountMail.prefs).toMatchObject({ available: true, recording: false, licence: true, digest: false });
    await expect(sw('Verfügbare Wünsche')).toHaveAttribute('aria-checked', 'true');
    // the card sits between the sessions and "Deine Daten", and the settings link of the mails finds it
    await expect(page.locator('section#mail')).toBeAttached();
    // the address is changed under "Sicherheit", as on the profile card
    await expect(mail.getByRole('link', { name: 'Zur E-Mail-Adresse' })).toHaveAttribute('href', '#sec-email');
  });

  test('mail card shows the recap switch off by default', async ({ page, api }) => {
    api.account = { ...api.account, email: 'anna@friend.example.com' };
    await page.goto('/me/account');
    const mail = card(page);
    const recap = mail.getByRole('switch', { name: 'Wochenrückblick' });
    await expect(recap).toHaveAttribute('aria-checked', 'false');
    await expect(recap).toBeEnabled();
    await expect(mail.getByText('Jede Woche eine E-Mail mit neuen Filmen und Folgen, deinen Wünschen und Empfehlungen.')).toBeVisible();
    await recap.click();
    await expect(recap).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => api.log).toContain('PUT /api/account/mail {"type":"digest","on":true} -> 200');
  });

  test('an admin sees the admin switches and saves one', async ({ page, api }) => {
    api.account = { ...api.account, email: 'anna@friend.example.com' };
    api.accountMail = { ...api.accountMail, admin: true };
    await page.goto('/me/account');
    const mail = card(page);
    await expect(mail.getByRole('heading', { level: 3, name: 'Für Admins' })).toBeVisible();
    await expect(mail.getByRole('switch')).toHaveCount(8);
    for (const name of ['Neue Versionen', 'Fehlgeschlagene Updates', 'Probleme im Systemcheck', 'Speicherplatz']) {
      await expect(mail.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
      await expect(mail.getByRole('switch', { name })).toBeEnabled();
    }
    await expect(mail.getByText('Wenn eine neue Version bereitsteht, einmal pro Version.')).toBeVisible();
    await expect(mail.getByText('Wenn ein Update nicht geklappt hat.')).toBeVisible();
    await expect(mail.getByText('Wenn eine Zeile im Systemcheck zum Problem wird, höchstens einmal am Tag.')).toBeVisible();
    await expect(mail.getByText('Wenn der Speicher für Downloads, Vorschauen oder Aufnahmen fast voll ist, einmal am Tag.')).toBeVisible();
    await mail.getByRole('switch', { name: 'Probleme im Systemcheck' }).click();
    await expect(mail.getByRole('switch', { name: 'Probleme im Systemcheck' })).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => api.log).toContain('PUT /api/account/mail {"type":"syscheck","on":false} -> 200');
  });

  test('a non-admin sees no admin switches', async ({ page, api }) => {
    api.account = { ...api.account, email: 'anna@friend.example.com' };
    await page.goto('/me/account');
    const mail = card(page);
    await expect(mail.getByRole('switch', { name: 'Aufnahmen' })).toBeVisible();
    await expect(mail.getByRole('heading', { name: 'Für Admins' })).toHaveCount(0);
    await expect(mail.getByRole('switch')).toHaveCount(4);
    await expect(mail.getByRole('switch', { name: 'Neue Versionen' })).toHaveCount(0);
  });

  test('/me/account#mail scrolls to the E-Mails card once it is there', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    // the switches answer late: the card renders long after the browser looked for #mail
    await page.route('**/api/account/mail', async (r) => { if (r.request().method() === 'GET') await new Promise((f) => setTimeout(f, 400)); await r.fallback(); });
    await page.goto('/me/account#mail');
    await expect(card(page).getByRole('heading', { level: 2, name: 'E-Mails' })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
    // nothing scrolls it away once the sessions have loaded
    await expect(page.getByRole('region', { name: 'Sitzungen & Geräte' }).getByRole('listitem')).toHaveCount(2);
    await expect(card(page).getByRole('heading', { level: 2, name: 'E-Mails' })).toBeInViewport();
  });

  test('the account and its switches are read at once', async ({ page }) => {
    const order: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/account/mail') order.push('mail asked'); });
    await page.route('**/api/account', async (r) => { await new Promise((f) => setTimeout(f, 300)); order.push('account answered'); await r.fallback(); });
    await page.goto('/me/account');
    await expect(card(page).getByRole('switch', { name: 'Aufnahmen' })).toBeEnabled();
    expect(order.indexOf('mail asked')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mail asked')).toBeLessThan(order.indexOf('account answered'));
  });

  test('without a hash the page stays at the top', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto('/me/account');
    await expect(card(page)).toBeAttached();
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });

  test('two switches flipped at once keep their own new values', async ({ page }) => {
    let server = { available: true, recording: true, licence: true };
    let firstHeld!: () => void;
    const second = new Promise<void>((f) => { firstHeld = f; });
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>((f) => { releaseSecond = f; });
    await page.route('**/api/account/mail', async (r) => {
      if (r.request().method() !== 'PUT') return r.fallback();
      const b = r.request().postDataJSON() as { type: 'available' | 'recording'; on: boolean };
      if (b.type === 'available') await second; // answers once the second switch is on its way
      else { firstHeld(); await secondHeld; }
      server = { ...server, [b.type]: b.on };
      await r.fulfill({ json: { prefs: server } });
    });
    await page.goto('/me/account');
    const sw = (name: string) => card(page).getByRole('switch', { name });
    await expect(sw('Aufnahmen')).toBeEnabled();
    const first = page.waitForResponse((res) => res.request().method() === 'PUT' && res.request().postData()!.includes('available'));
    await sw('Verfügbare Wünsche').click();
    await sw('Aufnahmen').click();
    await first;
    // the first answer (the server did not have the second switch yet) leaves the second one alone
    await page.waitForTimeout(150);
    await expect(sw('Verfügbare Wünsche')).toHaveAttribute('aria-checked', 'false');
    await expect(sw('Aufnahmen')).toHaveAttribute('aria-checked', 'false');
    releaseSecond();
    await expect(sw('Aufnahmen')).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw('Aufnahmen')).toHaveAttribute('aria-checked', 'false');
    await expect(sw('Verfügbare Wünsche')).toHaveAttribute('aria-checked', 'false');
    await expect(sw('Ablaufende Downloads')).toHaveAttribute('aria-checked', 'true');
  });

  test.describe('saving fails', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('mail card reverts a switch when saving fails', async ({ page, api }) => {
      api.accountMail.failPut = true;
      await page.goto('/me/account');
      const lic = card(page).getByRole('switch', { name: 'Ablaufende Downloads' });
      await expect(lic).toHaveAttribute('aria-checked', 'true');
      await lic.click();
      await expect(card(page).getByRole('alert')).toHaveText('Die Einstellung konnte nicht gespeichert werden. Versuch es noch einmal.');
      await expect(lic).toHaveAttribute('aria-checked', 'true');
      expect(api.accountMail.prefs.licence).toBe(true);
    });
  });

  test('mail card without address disables the switches and links to the e-mail section', async ({ page, api }) => {
    api.account = { ...api.account, email: null };
    api.accountMail = { ...api.accountMail, hasAddress: false };
    await page.goto('/me/account');
    const mail = card(page);
    await expect(mail.getByText('Keine E-Mail-Adresse hinterlegt')).toBeVisible();
    await expect(mail.getByRole('link', { name: 'Zur E-Mail-Adresse' })).toHaveAttribute('href', '#sec-email');
    for (const name of ['Verfügbare Wünsche', 'Aufnahmen', 'Ablaufende Downloads', 'Wochenrückblick']) await expect(mail.getByRole('switch', { name })).toBeDisabled();
  });

  test('mail card when mail is not set up shows the note', async ({ page, api }) => {
    api.account = { ...api.account, email: 'anna@friend.example.com' };
    api.accountMail = { ...api.accountMail, configured: false };
    await page.goto('/me/account');
    const mail = card(page);
    await expect(mail.getByText('Dein Server verschickt noch keine E-Mails.')).toBeVisible();
    for (const name of ['Verfügbare Wünsche', 'Aufnahmen', 'Ablaufende Downloads', 'Wochenrückblick']) await expect(mail.getByRole('switch', { name })).toBeDisabled();
    expect(api.log.filter((l) => l.startsWith('PUT /api/account/mail'))).toEqual([]);
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
      // the switches are read alongside the account; the backend refuses them to a kids profile too, and an answer is never shown
      await page.route('**/api/account/mail', (r) => r.fulfill({ status: 403, json: { error: 'owner_required' } }));
      await page.goto('/me/account');
      await expect(page.getByText('Dein Konto verwaltest du im Hauptprofil.')).toBeVisible();
      await expect(page.locator('main').getByRole('region')).toHaveCount(0);
      await expect(page.getByRole('switch')).toHaveCount(0); // a kids profile has no mail switches: mail is account level
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

/** Block 23 self-service: your data (export) and deleting the account */
test.describe('your data and account deletion', () => {
  test.use({ allowedConsole: /status of 401/ }); // the first delete answers 401 reauth_required
  const REAUTH = () => Date.now() + 600_000;

  test('download link points to the export', async ({ page }) => {
    await page.goto('/me/account');
    const data = page.getByRole('region', { name: 'Deine Daten' });
    const link = data.getByRole('link', { name: 'Meine Daten herunterladen' });
    await expect(link).toHaveAttribute('href', '/api/account/export');
    await expect(link).toHaveAttribute('download', '');
    await expect(data.getByText(/nur deine eigenen Daten/)).toBeVisible();
  });

  test('delete asks for the sign-in in place (in-app dialog), then deletes; no redirect', async ({ page, api }) => {
    const st = loginState({ starts: [{ body: password('tester') }], answers: [() => { api.account = { ...api.account, reauthUntil: REAUTH() }; return { body: done('') }; }] });
    await installLogin(page.context(), st);
    let classic = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/auth/reauth') classic++; });
    await page.goto('/me/account');
    await page.getByRole('region', { name: 'Konto löschen' }).getByRole('button', { name: 'Konto löschen …' }).click();
    await page.getByRole('dialog', { name: 'Konto löschen?' }).getByRole('button', { name: 'Mein Konto löschen' }).click();
    const sign = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await sign.getByLabel('Passwort', { exact: true }).fill('hunter2-fixture');
    await sign.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByRole('dialog', { name: 'Konto wird gelöscht' })).toContainText('Dein Konto wird am 21. Oktober 2026 gelöscht.');
    expect(api.log.filter((l) => l.startsWith('POST /api/account/delete'))).toEqual(['POST /api/account/delete {"confirm":true} -> 401', 'POST /api/account/delete {"confirm":true} -> 200']);
    expect(classic).toBe(0);
  });

  test('in place: still refused after the sign-in shows an error, no second round', async ({ page, api }) => {
    api.reauthLapsed = true;
    const st = loginState({ starts: [{ body: password('tester') }], answers: [{ body: done('') }] });
    await installLogin(page.context(), st);
    await page.goto('/me/account');
    await page.getByRole('button', { name: 'Konto löschen …' }).click();
    const dlg = page.getByRole('dialog', { name: 'Konto löschen?' });
    await dlg.getByRole('button', { name: 'Mein Konto löschen' }).click();
    const sign = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await sign.getByLabel('Passwort', { exact: true }).fill('hunter2-fixture');
    await sign.getByRole('button', { name: 'Anmelden' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Die Anmeldung konnte nicht bestätigt werden. Bitte versuch es noch einmal.');
    expect(st.calls.filter((c) => c.path === '/auth/flow/start')).toHaveLength(1);
    expect(api.log.filter((l) => l.startsWith('POST /api/account/delete'))).toHaveLength(2);
  });

  test('delete asks for re-authentication (classic, no in-app sign-in), then confirms with the date', async ({ page, api }) => {
    await classicSignIn(page);
    let next: string | null = null;
    // the forced sign-in (backend /auth/reauth) comes straight back to `next`, now recently authenticated
    await page.route('**/auth/reauth?**', (r) => {
      next = new URL(r.request().url()).searchParams.get('next');
      api.account = { ...api.account, reauthUntil: REAUTH() };
      return r.fulfill({ status: 302, headers: { location: next ?? '/' } });
    });
    await page.goto('/me/account');
    const opener = page.getByRole('region', { name: 'Konto löschen' }).getByRole('button', { name: 'Konto löschen …' });
    await opener.click();
    let dlg = page.getByRole('dialog', { name: 'Konto löschen?' });
    // the export comes first, then the 7 days, the restore by signing in, signed out at once (the sign-in account only at the end)
    await expect(dlg.getByRole('link', { name: 'Meine Daten herunterladen' })).toHaveAttribute('href', '/api/account/export');
    await expect(dlg).toContainText('in 7 Tagen endgültig gelöscht');
    await expect(dlg).toContainText('indem du dich wieder anmeldest');
    await expect(dlg).toContainText('Du wirst sofort auf allen Geräten abgemeldet; dein Anmeldekonto wird deaktiviert, sobald die Löschung endgültig ist.');
    await expect(dlg).not.toContainText('sofort deaktiviert');
    await expect(dlg).toContainText('meldest du dich dafür noch einmal an');
    await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
    // Escape closes it and gives the focus back
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await dlg.getByRole('button', { name: 'Mein Konto löschen' }).click();
    // back from the sign-in: the dialog is open again and the flag is gone from the address
    await expect.poll(() => next).toBe('/me/account?delete=1');
    dlg = page.getByRole('dialog', { name: 'Konto löschen?' });
    await expect(dlg).toBeVisible();
    await expect(page).toHaveURL(/\/me\/account$/);
    // the backend was asked first (it refuses a last admin before any sign-in); it answered reauth_required
    expect(api.log.filter((l) => l.startsWith('POST /api/account/delete'))).toEqual(['POST /api/account/delete {"confirm":true} -> 401']);
    await dlg.getByRole('button', { name: 'Mein Konto löschen' }).click();
    const done = page.getByRole('dialog', { name: 'Konto wird gelöscht' });
    await expect(done).toContainText('Dein Konto wird am 21. Oktober 2026 gelöscht.');
    expect(api.log.filter((l) => l.startsWith('POST /api/account/delete'))).toEqual(['POST /api/account/delete {"confirm":true} -> 401', 'POST /api/account/delete {"confirm":true} -> 200']);
    await expect(done.getByRole('button', { name: 'OK' })).toBeFocused();
    await done.getByRole('button', { name: 'OK' }).click();
    await expect(page).toHaveURL(/\/$/); // the session is gone
  });
});

test.describe('account deletion refused', () => {
  test.use({ allowedConsole: /status of (400|401)/ });
  test('(classic) a lapsed re-authentication answer sends the person to sign in again', async ({ page, api }) => {
    await classicSignIn(page);
    api.account = { ...api.account, reauthUntil: Date.now() + 600_000 };
    api.reauthLapsed = true; // the window ran out between loading the page and confirming
    let next: string | null = null;
    await page.route('**/auth/reauth?**', (r) => { next = new URL(r.request().url()).searchParams.get('next'); return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>sign in</p>' }); });
    await page.goto('/me/account');
    await page.getByRole('button', { name: 'Konto löschen …' }).click();
    await page.getByRole('dialog', { name: 'Konto löschen?' }).getByRole('button', { name: 'Mein Konto löschen' }).click();
    await expect.poll(() => next).toBe('/me/account?delete=1');
  });

  test('delete as last admin shows the hint', async ({ page }) => {
    // no recent sign-in: the refusal comes first, nobody is sent through the sign-in for nothing
    let reauth = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/auth/reauth') reauth++; });
    await page.route('**/api/account/delete', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"last_admin"}' }));
    await page.goto('/me/account');
    await page.getByRole('button', { name: 'Konto löschen …' }).click();
    const dlg = page.getByRole('dialog', { name: 'Konto löschen?' });
    await dlg.getByRole('button', { name: 'Mein Konto löschen' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Du bist der letzte Admin – mach zuerst jemand anderen zum Admin.');
    await expect(dlg.getByRole('button', { name: 'Mein Konto löschen' })).toBeVisible(); // still open, nothing else happened
    await expect(page).toHaveURL(/\/me\/account$/);
    expect(reauth).toBe(0);
  });
});

test('nothing below the sessions card jumps while the lists fill in (slow sessions and security answers)', async ({ page }) => {
  const slow = (glob: string) => page.route(glob, async (r) => { if (r.request().method() === 'GET') await new Promise((f) => setTimeout(f, 700)); await r.fallback(); });
  await slow('**/api/devices');
  await slow('**/api/account/security');
  const ids = ['acc-profile', 'acc-security', 'acc-sessions', 'acc-mail', 'acc-data', 'acc-delete'];
  await recordCardTops(page, ids);
  await page.goto('/me/account');
  const sessions = page.getByRole('region', { name: 'Sitzungen & Geräte' });
  await expect(sessions.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Sicherheit' }).getByText('Pixel 8')).toBeVisible();
  const tops = await cardTopsRecorded(page, ids);
  for (const id of ids) {
    const seen = tops[id]!;
    expect(Math.max(...seen) - Math.min(...seen), `${id} moved`).toBeLessThanOrEqual(1);
  }
});

test('the sessions and security reads start right after the account answer, not after the slow mail answer', async ({ page }) => {
  const order: string[] = [];
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (['/api/devices', '/api/account/security'].includes(p)) order.push(p); });
  await page.route('**/api/account/mail', async (r) => { if (r.request().method() === 'GET') await new Promise((f) => setTimeout(f, 1200)); order.push('mail answered'); await r.fallback(); });
  await page.goto('/me/account');
  await expect(page.getByRole('region', { name: 'Sitzungen & Geräte' })).toBeVisible();
  expect(order.indexOf('/api/devices')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('/api/devices')).toBeLessThan(order.indexOf('mail answered'));
  expect(order.indexOf('/api/account/security')).toBeLessThan(order.indexOf('mail answered'));
});

test('a hanging sessions read does not hold the page: the card shows its error hint', async ({ page }) => {
  await page.route('**/api/devices', () => new Promise(() => undefined)); // never answers
  await page.goto('/me/account');
  await expect(page.getByRole('status').filter({ hasText: 'Lade' }).first()).toBeAttached();
  await expect(page.getByRole('region', { name: 'Sitzungen & Geräte' }).getByRole('alert')).toBeVisible({ timeout: 12_000 }); // after the 8 s read timeout
  await expect(page.getByRole('region', { name: 'E-Mails' })).toBeVisible();
});
