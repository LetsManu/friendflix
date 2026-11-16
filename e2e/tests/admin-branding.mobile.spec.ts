// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

// Admin → Branding on a phone (390 × 844): the tabs scroll sideways inside their row (the page never does), the preview sits below the
// form, every control is a 44 px target, and the save bar sits above the tab bar.
test.describe('admin: branding (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the tabs scroll, the preview sits below the form, nothing scrolls the page sideways', async ({ page }) => {
    await page.goto('/admin/branding');
    const tabs = page.getByRole('tablist', { name: 'Bereiche' });
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    const sizes = await tabs.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).overflowX }));
    expect(sizes.overflow).toBe('auto');
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    const last = tabs.getByRole('tab', { name: 'Farben & Stimmung' });
    await last.click();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(last).toBeInViewport({ ratio: 0.99 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // the preview below the form
    const form = await page.getByRole('tabpanel', { name: 'Farben & Stimmung' }).boundingBox();
    const pv = await page.locator('[data-pv-frame]').boundingBox();
    expect(pv!.y).toBeGreaterThanOrEqual(form!.y + form!.height);
    expect(pv!.x + pv!.width).toBeLessThanOrEqual(390);
  });

  test('44 px targets: tabs, swatches, segments and preview tabs', async ({ page }) => {
    await page.goto('/admin/branding');
    await page.getByRole('tab', { name: 'Farben & Stimmung' }).click();
    const targets = [
      ...await page.getByRole('tablist', { name: 'Bereiche' }).getByRole('tab').all(),
      ...await page.getByRole('radiogroup', { name: 'Akzentfarbe' }).getByRole('radio').all(),
      ...await page.getByRole('radiogroup', { name: 'Stimmung im Hintergrund' }).getByRole('radio').all(),
      ...await page.getByRole('tablist', { name: 'Vorschau' }).getByRole('tab').all(),
    ];
    for (const t of targets) {
      const b = (await t.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('an edit shows the save bar; the page end keeps room for it, so nothing is covered', async ({ page, api }) => {
    await page.goto('/admin/branding');
    await page.getByLabel('Name der Plattform').fill('Nordlicht Kino');
    const sb = page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
    await expect(sb).toContainText('1 Änderung am Branding');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const reset = page.getByRole('button', { name: 'Auf Standard zurücksetzen' });
    const r = (await reset.boundingBox())!, s = (await sb.boundingBox())!;
    expect(r.y + r.height).toBeLessThanOrEqual(s.y);
    await sb.getByRole('button', { name: 'Speichern' }).click();
    await expect(sb).toHaveCount(0);
    expect(api.brandAdmin.puts).toEqual([{ rev: 0, brand: { name: 'Nordlicht Kino' } }]);
  });
});
