// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('admin: Umwandlungen card (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the card fits 375 px with no horizontal scroll, every control is at least 44 px', async ({ page, api }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // the long case: a custom value of 16 slots, the longest texts
    api.admin.conv.running = [{ kind: 'film', hevc: true, label: 'Dunmoor – Die lange Fassung mit einem sehr langen Titel', since: null, device: 'Wohnzimmer-Fernseher von Anna Beispiel' }];
    api.settings.groups.flatMap((g) => g.items).find((i) => i.key === 'CONVERSION_SLOTS')!.value = 16;
    api.admin.conv.bench = { ...api.admin.conv.bench, stale: true, noRealtime: true };
    await page.goto('/admin/playback');
    const c = page.getByRole('region', { name: 'Umwandlungen' });
    await expect(c.getByText('1 von 16 belegt')).toBeVisible();
    await expect(c.getByRole('spinbutton')).toHaveText('16');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const vw = await page.evaluate(() => window.innerWidth);
    const box = (await c.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    for (const target of [c.getByRole('button', { name: 'Neu messen' }), c.getByRole('radio', { name: 'Automatisch (3)' }), c.getByRole('radio', { name: 'Eigener Wert' }),
      c.getByRole('radio', { name: 'Filme & Serien zuerst' }), c.getByRole('radio', { name: 'Live-TV zuerst' }), c.getByRole('radio', { name: 'Gleichrangig' }),
      c.getByRole('button', { name: 'Weniger' }), c.getByRole('button', { name: 'Mehr' })]) {
      await target.scrollIntoViewIfNeeded();
      const b = (await target.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
    }
    // the 16 segments wrap inside the card
    const bar = c.getByRole('img', { name: /Belegung/ });
    const bb = (await bar.boundingBox())!;
    expect(bb.x + bb.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  });

  test('on Plex the header has no empty row for the measure button', async ({ page, api }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    api.serverKind = 'plex';
    api.admin.conv.measure = { running: false, busy: null, last: { outcome: 'unsupported', at: null } };
    await page.goto('/admin/playback');
    const c = page.getByRole('region', { name: 'Umwandlungen' });
    await expect(c.getByText('Messung nur mit Jellyfin')).toBeVisible();
    await expect(c.getByTestId('conv-measure')).toHaveCount(0);
    const head = (await c.locator('.head').boundingBox())!;
    const ttl = (await c.locator('.head .ttl').boundingBox())!;
    expect(head.height).toBeCloseTo(ttl.height, 0); // no 44-px (or gap-only) row under the title
  });
});
