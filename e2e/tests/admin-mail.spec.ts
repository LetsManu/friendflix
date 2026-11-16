// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { LEAK, mailConfigured } from '../mocks/settings.js';
import { SERVER_IDS, result } from '../mocks/syscheck.js';

// Admin → Einstellungen → Benachrichtigungen → E-Mail (mail stage A): the SMTP settings, the status line (GET /api/admin/mail/status)
// and *Testmail senden* (POST /api/admin/mail/test, to the admin's own address). Answers carry codes only; the mocks also carry a
// password and an address the real API never sends (the LEAK canary): neither may reach the page.
type Page = import('@playwright/test').Page;
const card = (page: Page, name: string) => page.locator('section', { has: page.getByRole('heading', { level: 2, name, exact: true }) });
const setting = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const ADDRESS = 'anna@friend.example.com';
/** a box in page coordinates (boundingBox() is relative to the viewport, which a click may scroll) */
const pageBox = (l: import('@playwright/test').Locator) => l.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
});

/** nothing the mocks carry beyond the real API (a password, an address) is on the page, in text or in a field */
async function noLeak(page: Page) {
  const html = await page.content();
  const values = await page.locator('input, textarea').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  for (const s of [html, values.join('\n')]) {
    expect(s).not.toContain(LEAK);
    expect(s).not.toContain(ADDRESS);
  }
}

test.describe('admin: e-mail', () => {
  test.use({ allowedConsole: /status of (400|429)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('mail card on the notifications tab', async ({ page }) => {
    await page.goto('/admin/settings?tab=notifications');
    const mail = card(page, 'E-Mail');
    await expect(mail).toBeVisible();
    for (const label of ['SMTP-Server', 'Port', 'Verschlüsselung', 'Benutzername', 'Passwort', 'Absenderadresse']) await expect(setting(page, label)).toBeVisible();
    // the password is write-only: no value, only "Nicht gesetzt" and an empty password field
    const pw = setting(page, 'Passwort');
    await expect(pw.getByText('Nicht gesetzt', { exact: true })).toBeVisible();
    await expect(pw.locator('input[type="text"]')).toHaveCount(0);
    await expect(setting(page, 'Verschlüsselung').getByRole('combobox').locator('option')).toHaveText(['STARTTLS', 'TLS', 'Keine']);
    // not configured yet: the status line asks for server and sender
    await expect(mail.getByTestId('mail-status')).toHaveText('Trag Server und Absenderadresse ein und speichere.');
    // nothing to send with yet: the button waits for a saved server and sender
    await expect(mail.getByRole('button', { name: 'Testmail senden' })).toBeDisabled();
    await expect(mail.getByText('Geht an deine eigene Adresse.')).toBeVisible();
    await noLeak(page);
  });

  test('test mail success', async ({ page, api }) => {
    mailConfigured(api.settings);
    api.settings.mail.test = { status: 200, body: { state: 'sent', to: ADDRESS, password: LEAK } };
    await page.goto('/admin/settings?tab=notifications');
    const mail = card(page, 'E-Mail');
    await expect(mail.getByTestId('mail-status')).toContainText('Zuletzt gesendet');
    const button = mail.getByRole('button', { name: 'Testmail senden' });
    await expect(button).toBeEnabled();
    const before = { button: await pageBox(button), card: await pageBox(mail) };
    const statusCalls = api.settings.mail.statusCalls;
    await button.click();
    await expect(mail.getByRole('status').filter({ hasText: 'Testmail gesendet' })).toHaveText('Testmail gesendet. Schau in dein Postfach.');
    expect(api.settings.mail.tests).toBe(1);
    // the status is read again after the test
    await expect.poll(() => api.settings.mail.statusCalls).toBeGreaterThan(statusCalls);
    // the result line had its space already: nothing moved
    const after = { button: await pageBox(button), card: await pageBox(mail) };
    expect(after).toEqual(before);
    await noLeak(page);
  });

  test('test mail errors show a sentence', async ({ page, api }) => {
    mailConfigured(api.settings);
    api.settings.mail.test = { status: 400, body: { error: 'no_address' } };
    await page.goto('/admin/settings?tab=notifications');
    const mail = card(page, 'E-Mail');
    const button = mail.getByRole('button', { name: 'Testmail senden' });
    await button.click();
    const line = mail.getByTestId('mail-result');
    await expect(line).toHaveText('Dein Konto hat keine E-Mail-Adresse.');
    api.settings.mail.test = { status: 200, body: { state: 'failed', code: 'auth', smtp: 535, reply: LEAK } };
    await button.click();
    await expect(line).toHaveText('Nicht gesendet: Benutzername oder Passwort abgelehnt (SMTP 535)');
    api.settings.mail.test = { status: 429, body: { error: 'rate_limited' } };
    await button.click();
    await expect(line).toHaveText('Zu viele Testmails. Warte ein paar Minuten.');
    expect(api.settings.mail.tests).toBe(3);
    await noLeak(page);
  });

  test('status line shows the last failure with its SMTP status', async ({ page, api }) => {
    mailConfigured(api.settings);
    api.settings.mail.status = {
      ...api.settings.mail.status, queued: 2,
      lastFailure: { kind: 'invite', code: 'recipient_refused', smtp: 550, at: '2026-11-16T10:00:00Z', to: ADDRESS, reply: LEAK },
    };
    await page.goto('/admin/settings?tab=notifications');
    const status = card(page, 'E-Mail').getByTestId('mail-status');
    await expect(status).toContainText('Letzter Fehler: Empfängeradresse abgelehnt (SMTP 550)');
    await expect(status).toContainText('2 E-Mails warten');
    await noLeak(page);
  });

  test('the status is read again after the card is saved', async ({ page, api }) => {
    await page.goto('/admin/settings?tab=notifications');
    const mail = card(page, 'E-Mail');
    await expect(mail.getByTestId('mail-status')).toHaveText('Trag Server und Absenderadresse ein und speichere.');
    await setting(page, 'SMTP-Server').getByRole('textbox').fill('mail.example.com');
    await setting(page, 'Absenderadresse').getByRole('textbox').fill('kino@friend.example.com');
    api.settings.mail.status = { ...api.settings.mail.status, configured: true };
    await mail.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts.length).toBe(1);
    expect(api.settings.puts[0]!.values).toEqual({ MAIL_SMTP_HOST: 'mail.example.com', MAIL_FROM: 'kino@friend.example.com' });
    await expect(mail.getByTestId('mail-status')).toHaveText('Noch keine E-Mail gesendet.');
  });

  test('Systemcheck shows the mail line', async ({ page, api }) => {
    api.syscheck.result = result([
      ...SERVER_IDS.map((id) => ({ id, status: 'ok' as const })),
      { id: 'core.mail', status: 'problem', cause: 'mail_auth', fix: 'mail_auth', settingKey: 'MAIL_SMTP_PASSWORD', settingGroup: 'mail', docs: 'mail.md' },
    ]);
    await page.goto('/admin/status');
    const line = page.locator('#systemcheck li[data-id="core.mail"]');
    await expect(line).toContainText('E-Mail-Versand');
    await expect(line.locator('.pill.err')).toHaveText('Problem');
    await expect(line).toContainText('Der Mailserver hat die Anmeldung abgelehnt.');
    const link = line.getByRole('link', { name: 'Zur Einstellung' });
    await expect(link).toHaveAttribute('href', '/admin/settings?setting=MAIL_SMTP_PASSWORD');
    // the mail line sits right after the .env line
    const ids = await page.locator('#systemcheck li[data-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    expect(ids.indexOf('core.mail')).toBe(ids.indexOf('core.env') + 1);
    await link.click();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=notifications$/);
    await expect(page.locator('#setting-MAIL_SMTP_PASSWORD')).toHaveAttribute('data-flash', 'static');
  });
});
