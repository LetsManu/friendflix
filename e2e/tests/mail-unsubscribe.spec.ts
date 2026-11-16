// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

/**
 * E-mail stage B: /mail/unsubscribe?t=<token>, the page the footer link of every switchable mail opens. Public (no session, no
 * /api/me); the token goes into memory and out of the address bar, nothing is sent until "Abbestellen" is pressed, and the page
 * never sends a Referer. A fictional token of the backend's shape (v1.<user id>.<type>.<43-char mac>).
 */
const TOKEN = 'v1.0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21.licence.' + 'A'.repeat(21) + '_-' + 'z9'.repeat(10);
const MAC = TOKEN.split('.')[3]!;

test.describe('/mail/unsubscribe', () => {
  test('unsubscribe page names the type and sends nothing until pressed', async ({ page, api }) => {
    const res = await page.goto(`/mail/unsubscribe?t=${TOKEN}`);
    expect(res!.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.getByRole('heading', { level: 1, name: 'E-Mails abbestellen' })).toBeVisible();
    await expect(page.getByText('Keine E-Mails mehr zu ablaufenden Downloads?')).toBeVisible();
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    await expect(page).toHaveURL(/\/mail\/unsubscribe$/); // replaceState dropped the token
    expect(page.url()).not.toContain('t=');
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href, history.state]));
    expect(stored).not.toContain(MAC);
    await page.waitForTimeout(300); // nothing goes out by itself (a mail scanner that opens the page changes nothing)
    expect(api.unsubscribe.posts).toEqual([]);
    await page.getByRole('button', { name: 'Abbestellen' }).click();
    await expect(page.getByText('Abbestellt.')).toBeVisible();
    expect(api.unsubscribe.posts).toEqual([{ t: TOKEN, on: false }]);
  });

  test('pressing Abbestellen then Wieder anmelden', async ({ page, api }) => {
    await page.goto(`/mail/unsubscribe?t=${TOKEN}`);
    await page.getByRole('button', { name: 'Abbestellen' }).click();
    await expect(page.getByText('Abbestellt.')).toBeVisible();
    await expect(page.getByText('Du bekommst keine E-Mails mehr zu ablaufenden Downloads.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'E-Mail-Einstellungen' })).toHaveAttribute('href', '/me/account#mail');
    await page.getByRole('button', { name: 'Wieder anmelden' }).click();
    await expect(page.getByText('Wieder angemeldet.')).toBeVisible();
    await expect(page.getByText('Du bekommst wieder E-Mails zu ablaufenden Downloads.')).toBeVisible();
    expect(api.unsubscribe.posts).toEqual([{ t: TOKEN, on: false }, { t: TOKEN, on: true }]);
    expect(api.log.every((l) => !l.includes('/api/public/mail/unsubscribe?'))).toBe(true); // the token never goes into a URL
  });

  test('an invalid token shows the invalid view', async ({ page, api }) => {
    await page.goto(`/mail/unsubscribe?t=v2.${MAC}`);
    await expect(page.getByText('Dieser Link ist ungültig.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abbestellen' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'E-Mail-Einstellungen' })).toHaveAttribute('href', '/me/account#mail');
    await expect(page).toHaveURL(/\/mail\/unsubscribe$/);
    expect(api.unsubscribe.posts).toEqual([]);
  });

  test.describe('refused', () => {
    test.use({ allowedConsole: /status of 400/ });
    test('a 400 shows the invalid view', async ({ page, api }) => {
      api.unsubscribe.status = 400;
      await page.goto(`/mail/unsubscribe?t=${TOKEN}`);
      await page.getByRole('button', { name: 'Abbestellen' }).click();
      await expect(page.getByText('Dieser Link ist ungültig.')).toBeVisible();
      await expect(page.getByText('Abbestellt.')).toBeHidden();
    });
  });

  test.describe('unreachable', () => {
    test.use({ allowedConsole: /status of (429|500)/ });
    test('too many tries and a failure keep the button for another try', async ({ page, api }) => {
      api.unsubscribe.status = 429;
      await page.goto(`/mail/unsubscribe?t=${TOKEN}`);
      const btn = page.getByRole('button', { name: 'Abbestellen' });
      await btn.click();
      await expect(page.getByRole('alert')).toHaveText('Zu viele Versuche. Warte eine Minute und versuch es dann noch einmal.');
      api.unsubscribe.status = 500;
      await btn.click();
      await expect(page.getByRole('alert')).toHaveText('Das hat gerade nicht geklappt. Versuch es noch einmal.');
      api.unsubscribe.status = 200;
      await btn.click();
      await expect(page.getByText('Abbestellt.')).toBeVisible();
      expect(api.unsubscribe.posts).toHaveLength(3);
    });
  });

  test('the page works without a session', async ({ page, api }) => {
    let me = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/me') me++; });
    await page.route('**/api/me', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }));
    await page.goto(`/mail/unsubscribe?t=${TOKEN}`);
    await page.getByRole('button', { name: 'Abbestellen' }).click();
    await expect(page.getByText('Abbestellt.')).toBeVisible();
    await expect(page).toHaveURL(/\/mail\/unsubscribe$/); // no sign-in redirect
    expect(me).toBe(0);
    expect(api.unsubscribe.posts).toHaveLength(1);
  });
});
