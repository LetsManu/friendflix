// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { syscheckHealthy, syscheckTroubled, syscheckTroubledEncoder, syscheckWith } from '../mocks/syscheck.js';
import { browserLinesHoldStill, gateSyscheck, listHoldsNothingBelow } from './syscheck-helpers.js';

test.describe('Systemcheck (phone)', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
  });

  test('no horizontal scroll at 375 px; action targets ≥ 44 px', async ({ page, api }) => {
    api.syscheck.result = syscheckTroubled();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/admin/status');
    const sc = page.locator('#systemcheck');
    await expect(sc.locator('li[data-id="signin.authentik"] .pill.err')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const targets = [sc.getByRole('button', { name: 'Jetzt prüfen' }), ...await sc.locator('li[data-id] .actions').getByRole('link').all()];
    expect(targets.length).toBeGreaterThan(3);
    for (const t of targets) {
      const box = (await t.boundingBox())!;
      expect(box.height, await t.innerText()).toBeGreaterThanOrEqual(44);
    }
  });

  test('long texts and the HEVC check wrap on a phone', async ({ page, api }) => {
    api.syscheck.result = syscheckWith([
      { id: 'media.encoder', status: 'warning', cause: 'hevc_failed', fix: 'hevc_failed', settingKey: 'HEVC_STREAMS', settingGroup: 'playback', params: { advice: 'hevc_failed,no_tonemap,downmix_plain', hevc: 'failed' } },
      { id: 'core.disk.downloads', status: 'warning', cause: 'disk_full', fix: 'disk_full', settingKey: 'HEALTH_DISK_WARN_PCT', settingGroup: 'health', params: { pct: 93, sharedWith: 'previews' } },
    ]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/admin/status');
    const enc = page.locator('#systemcheck li[data-id="media.encoder"]');
    await expect(enc).toContainText('Der HEVC-Test hat kein HEVC-Video geliefert.');
    await expect(enc).toContainText('Tone-Mapping ist aus');
    await expect(enc).toContainText('„Tone-Mapping aktivieren“ einschalten'); // a further advice keeps its fix
    await expect(enc).toContainText('Dave750');
    const hevc = enc.getByRole('button', { name: 'HEVC jetzt prüfen' });
    await expect(hevc).toBeVisible();
    expect((await hevc.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#systemcheck li[data-id="core.disk.downloads"]')).toContainText('Gleiches Laufwerk wie die Vorschauen.');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('cold load at 375 px: nothing below the list renders before it, then the disks never move', async ({ page, api }) => {
    api.syscheck.result = syscheckTroubledEncoder();
    await page.setViewportSize({ width: 375, height: 812 });
    await listHoldsNothingBelow(page);
  });

  test('skeleton and loaded list have the same height at 375 px', async ({ page, api }) => {
    api.syscheck.result = syscheckHealthy();
    await page.setViewportSize({ width: 375, height: 812 });
    const release = await gateSyscheck(page);
    await page.goto('/admin/status');
    const sc = page.locator('#systemcheck');
    await expect(sc.locator('li[data-id] .skeleton').first()).toBeVisible();
    const before = (await sc.boundingBox())!;
    release();
    await expect(sc.locator('li[data-id] .skeleton')).toHaveCount(0);
    await expect(sc.locator('li[data-id="media.encoder"]').getByRole('button', { name: 'HEVC jetzt prüfen' })).toBeVisible();
    const after = (await sc.boundingBox())!;
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
  });

  test('375 px: a failing browser line never pushes the cards below down, cold and on the next visit', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await browserLinesHoldStill(page);
  });
});
