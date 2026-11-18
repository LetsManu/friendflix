// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { updaterState } from '../mocks/updater.js';

test.describe('admin update with the opt-in updater (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  // the fake backend answers 502 while it "restarts" during a job
  test.use({ allowedConsole: /status of 502 \(Bad Gateway\)/ });

  test('320 px: the Portainer note fits', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign' };
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto('/admin/update');
    const note = page.getByRole('region', { name: 'Updater' }).locator('[data-foreign="manual"]');
    await expect(note).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const box = (await note.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  });

  for (const width of [390, 320]) {
    test(`${width} px: progress, rollback button and the fixed-version form fit, nothing overflows`, async ({ page, api }) => {
      // every service listed under Installiert, one with an update waiting
      const D = (c: string) => `sha256:${c.repeat(64)}`;
      const services = ['backend', 'gateway', 'web', 'livetv', 'updater'].map((service, i) => ({ service, state: 'running', health: 'healthy', sha: null, version: null,
        commit: String(i + 1).repeat(40), digest: D(String(i + 1)), registry: D(service === 'web' ? '9' : String(i + 1)), changed: service === 'web' }));
      api.updater = { ...updaterState(true), outcome: 'rolled_back', downPolls: 1, services };
      await page.setViewportSize({ width, height: 740 });
      await page.goto('/admin/update');
      const card = page.getByRole('region', { name: 'Updater' });
      const back = card.getByRole('button', { name: 'Zurück zur vorherigen Version' });
      await expect(back).toBeVisible();
      await expect(card.locator('tr[data-service="web"]')).toContainText('Update verfügbar');
      expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await card.getByRole('button', { name: 'Jetzt aktualisieren' }).tap();
      await card.getByRole('button', { name: 'Ja, starten' }).tap();
      await expect(card.locator('[data-result="rolled_back"]')).toBeVisible({ timeout: 20_000 });
      await expect(card.locator('li[data-step="rollback"]')).toBeVisible();
      const channel = page.getByRole('region', { name: 'Update-Kanal' });
      await channel.getByRole('radio', { name: 'Feste Version' }).tap();
      await expect(channel.getByLabel('Version (X.Y.Z)')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      for (const el of [card, card.locator('[data-services]'), channel.getByRole('radiogroup'), back, card.locator('ol.steps'), card.locator('[data-result]'), channel.getByLabel('Version (X.Y.Z)')]) {
        const box = await el.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    });
  }
});
