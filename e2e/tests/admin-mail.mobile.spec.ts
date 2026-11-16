// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { mailConfigured } from '../mocks/settings.js';

// The E-Mail card on a phone (390 × 844): *Testmail senden* is a 44 px target and nothing in the card, the result line included,
// widens the page.
test.describe('admin: e-mail (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the button is 44 px high and the card has no horizontal overflow', async ({ page, api }) => {
    mailConfigured(api.settings);
    api.settings.mail.test = { status: 200, body: { state: 'queued', code: 'recipient_refused' } };
    await page.goto('/admin/settings?tab=notifications');
    const mail = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'E-Mail', exact: true }) });
    const button = mail.getByRole('button', { name: 'Testmail senden' });
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await button.click();
    await expect(mail.getByTestId('mail-result')).toContainText('versucht es weiter');
    const box = (await mail.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await mail.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
