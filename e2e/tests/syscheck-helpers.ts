// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page } from '@playwright/test';

/** Holds GET /api/admin/systemcheck until the returned function is called (then the mock answers). */
export async function gateSyscheck(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/admin/systemcheck', async (r) => { await gate; await r.fallback(); });
  return release;
}

/**
 * A cold load of Admin → Status with the Systemcheck answer held back: while the list is a skeleton nothing below it is rendered
 * (so it has nothing to push down), and once the answer is in, the disks card's top stays where it first appeared.
 */
export async function listHoldsNothingBelow(page: Page): Promise<void> {
  const release = await gateSyscheck(page);
  await page.goto('/admin/status');
  const sc = page.locator('#systemcheck');
  const disks = page.getByRole('region', { name: 'Speicher' });
  await expect(sc.locator('li[data-id] .skeleton').first()).toBeVisible();
  await expect(sc.locator('li[data-id="media.encoder"] .rsv')).toHaveCount(1);
  await page.waitForTimeout(300); // the snapshot, summary and streams have long answered by now
  await expect(disks).toHaveCount(0);
  release();
  await expect(disks).toBeVisible();
  const top = (await disks.boundingBox())!.y;
  await expect(sc.locator('li[data-id="signin.authentik"] .pill.err')).toBeVisible();
  await expect(sc.locator('li[data-id="media.encoder"]').getByRole('button', { name: 'HEVC jetzt prüfen' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(Math.abs((await disks.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
}
