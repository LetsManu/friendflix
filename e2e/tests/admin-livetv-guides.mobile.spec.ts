// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator } from '@playwright/test';
import { ltvGuideMock } from '../mocks/admin.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Live-TV → Quellen on a phone (375 px), extra-guides plan Task 3: the guide card and the guide sheet fit, every target ≥ 44 px.
const W = 375;
async function fits(l: Locator, what: string, minH = 0) {
  const b = await l.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b!.x >= 0 && b!.x + b!.width <= W + 0.5, `${what} inside 375 px`).toBe(true);
  if (minH) expect(b!.height, `${what} height`).toBeGreaterThanOrEqual(minH);
}

test.describe('admin: Live-TV, Programmführer (phone, 375 px)', () => {
  test.beforeEach(({ api, page }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    api.admin.livetv.area.sources.push(
      ltvGuideMock({ id: 'g-a', name: 'Weltempfang', position: 2, servedChannels: 37 }),
      ltvGuideMock({ id: 'g-b', name: 'Hafen Guide', position: 3, guideScope: ['src-nordlicht', 'src-feeds'] }),
    );
    return page.setViewportSize({ width: W, height: 812 });
  });

  test('the guide card fits', async ({ page }) => {
    await page.goto('/admin/livetv');
    const c = page.getByRole('region', { name: 'Hafen Guide', exact: true });
    await expect(c.locator('[data-scope]')).toHaveText('Gilt für: Nordlicht Paket, Eigene Streams');
    await fits(c, 'guide card');
    await fits(c.getByRole('button', { name: 'Jetzt aktualisieren' }), 'Jetzt aktualisieren', 44);
    await fits(c.getByRole('button', { name: 'Aktionen für Hafen Guide' }), 'guide menu', 44);
    await fits(c.getByRole('button', { name: '„Hafen Guide“ nach oben' }), 'move up', 44);
    await fits(c.getByRole('button', { name: '„Hafen Guide“ nach unten' }), 'move down', 44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the guide sheet fits 375 px', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    await page.getByRole('dialog', { name: 'Quelle hinzufügen' }).getByRole('radio', { name: 'Programmführer', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Programmführer hinzufügen' });
    await fits(dlg, 'guide sheet');
    for (const name of ['Anbieterliste', 'Programmführer', 'Eigene Streams', 'Alle Sender', 'Nur diese Quellen']) await fits(dlg.getByRole('radio', { name, exact: true }), name, 44);
    for (const name of ['Prüfen', 'Speichern', 'Schließen', 'anzeigen']) await fits(dlg.getByRole('button', { name }), name, 44);
    await dlg.getByRole('radio', { name: 'Nur diese Quellen' }).click();
    const row = dlg.locator('[data-scope-list] label', { hasText: 'Nordlicht Paket' });
    await row.scrollIntoViewIfNeeded();
    await fits(row, 'scope row', 44);
    await dlg.getByLabel('Programmführer (XMLTV-Adresse)').fill('https://epg.example.com/guide.xml');
    await dlg.getByRole('button', { name: 'Prüfen' }).click();
    await expect(dlg.locator('[data-test-result]')).toHaveText('2.140 Sender im Programmführer');
    await fits(dlg.locator('[data-test-result]'), 'result');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
