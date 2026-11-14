// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

// Admin → Live-TV → Quellen on a phone (375 px), Task 21: the area's tabs are a scrolling chip row, the cards and sheets fit, every
// target is at least 44 px.
const W = 375;
async function fits(l: Locator, what: string, minH = 0) {
  const b = await l.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b!.x >= 0 && b!.x + b!.width <= W + 0.5, `${what} inside 375 px`).toBe(true);
  if (minH) expect(b!.height, `${what} height`).toBeGreaterThanOrEqual(minH);
}

test.describe('admin: Live-TV, Quellen (phone, 375 px)', () => {
  test.beforeEach(({ api, page }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    return page.setViewportSize({ width: W, height: 812 });
  });

  test('tabs become a chip row; cards fit 375 px', async ({ page }) => {
    await page.goto('/admin/livetv');
    const tabs = page.getByRole('tablist', { name: 'Live-TV-Bereiche' });
    await expect(tabs.getByRole('tab')).toHaveCount(6);
    // a row that scrolls sideways, of round chips, inside the page
    const row = await tabs.evaluate((el) => { const cs = getComputedStyle(el); return { x: cs.overflowX, wrap: cs.flexWrap, scrolls: el.scrollWidth > el.clientWidth }; });
    expect(row).toEqual({ x: 'auto', wrap: 'nowrap', scrolls: true });
    for (const t of await tabs.getByRole('tab').all()) {
      const r = await t.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
      expect(r).toBeGreaterThanOrEqual(20);
      expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(tabs.getByRole('tab', { name: 'Quellen' })).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    const list = page.getByRole('region', { name: 'Nordlicht Paket', exact: true });
    const own = page.getByRole('region', { name: 'Eigene Streams', exact: true });
    await expect(list.locator('[data-state]')).toContainText('412 Sender (+3 / −1)');
    await expect(own.locator('li', { hasText: 'Kanal Wolkenlos' })).toContainText('Sendet');
    await fits(list, 'list card');
    await fits(own, 'own streams card');
    await fits(own.locator('li', { hasText: 'Kanal Wolkenlos' }), 'push feed row');
    await fits(page.getByRole('button', { name: 'Quelle hinzufügen' }), 'Quelle hinzufügen', 44);
    await fits(list.getByRole('button', { name: 'Jetzt aktualisieren' }), 'Jetzt aktualisieren', 44);
    await fits(list.getByRole('button', { name: 'Aktionen für Nordlicht Paket' }), 'list menu', 44);
    await fits(own.getByRole('button', { name: 'Stream hinzufügen' }), 'Stream hinzufügen', 44);
    await fits(own.getByRole('button', { name: 'Aktionen für Kanal Wolkenlos' }), 'feed menu', 44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    // a chip far right scrolls into view and opens its tab
    await tabs.getByRole('tab', { name: 'Live-Status' }).click();
    await expect(page).toHaveURL(/\?tab=status$/);
    await expect(page.getByText('Live-TV läuft.')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the sheets and the one-time result fit the phone', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const add = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    await fits(add, 'source sheet');
    for (const name of ['Prüfen', 'Speichern', 'Schließen']) await fits(add.getByRole('button', { name }), name, 44);
    for (const b of await add.getByRole('button', { name: 'anzeigen' }).all()) await fits(b, 'anzeigen', 44);
    await add.getByRole('radio', { name: 'Eigene Streams' }).click();
    const st = page.getByRole('dialog', { name: 'Stream hinzufügen' });
    await fits(st, 'stream sheet');
    await st.getByRole('radio', { name: 'Encoder sendet an FriendFlix' }).click();
    await fits(st.getByRole('radio', { name: 'Encoder sendet an FriendFlix' }), 'push choice', 44);
    await st.getByRole('textbox', { name: 'Name', exact: true }).fill('Sternwarte 24');
    await st.getByRole('button', { name: 'Anlegen' }).click();
    const res = page.getByRole('dialog', { name: 'Zugangsdaten für Sternwarte 24' });
    await expect(res.getByRole('button', { name: 'Kopieren' })).toHaveCount(5);
    await fits(res, 'result sheet');
    for (const b of await res.getByRole('button', { name: 'Kopieren' }).all()) await fits(b, 'Kopieren', 44);
    await fits(res.getByLabel('SRT-Adresse', { exact: true }), 'SRT address field');
    await fits(res.getByRole('button', { name: 'Fertig' }), 'Fertig', 44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
