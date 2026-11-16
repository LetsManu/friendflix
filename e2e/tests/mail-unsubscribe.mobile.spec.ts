// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

const TOKEN = 'v1.0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21.recording.' + 'A'.repeat(21) + '_-' + 'z9'.repeat(10);

test('phone: the unsubscribe page fits, its button is ≥ 44 px and the view swap does not move the heading', async ({ page }) => {
  await page.goto(`/mail/unsubscribe?t=${TOKEN}`);
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(page.getByText('Keine E-Mails mehr zu Aufnahmen?')).toBeVisible();
  const btn = page.getByRole('button', { name: 'Abbestellen' });
  expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await noHorizontalOverflow(page)).toBe(true);
  const before = await h1.boundingBox();
  await btn.tap();
  await expect(page.getByText('Abbestellt.')).toBeVisible();
  expect(await h1.boundingBox()).toEqual(before);
  const again = page.getByRole('button', { name: 'Wieder anmelden' });
  expect((await again.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole('link', { name: 'E-Mail-Einstellungen' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await again.tap();
  await expect(page.getByText('Wieder angemeldet.')).toBeVisible();
  expect(await h1.boundingBox()).toEqual(before);
  expect(await noHorizontalOverflow(page)).toBe(true);
});
