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

/**
 * The page's own headers without nosniff: the browser's proxy.headers line becomes a warning (headers_stripped; hsts_missing needs an
 * https origin, which the e2e server is not; the row is the same). `hold(true)` keeps that answer back until `hold(false)`.
 */
export async function stripHeaders(page: Page): Promise<{ hold(on: boolean): void }> {
  let gate: Promise<void> | null = null, open: () => void = () => undefined;
  await page.route((u) => u.pathname === '/' && u.search === '', async (r) => {
    await gate;
    await r.fulfill({ status: 200, contentType: 'text/html', headers: { 'referrer-policy': 'same-origin' }, body: '<!doctype html>' });
  });
  return { hold: (on) => { if (on) gate = new Promise((res) => { open = res; }); else { open(); gate = null; } } };
}

/**
 * A failing browser line (proxy.headers warning) never pushes the page down: on a cold visit the content below waits for the
 * browser checks; on the next visit their remembered results are in place at once, while they run again. The disks card stays put.
 */
export async function browserLinesHoldStill(page: Page): Promise<void> {
  const probe = await stripHeaders(page);
  const sc = page.locator('#systemcheck');
  const headers = sc.locator('li[data-id="proxy.headers"]');
  const disks = page.getByRole('region', { name: 'Speicher' });
  // cold: the warning and its fix are in before the disks appear
  await page.goto('/admin/status');
  await expect(disks).toBeVisible();
  await expect(headers.locator('.pill.warn')).toBeVisible();
  const top = (await disks.boundingBox())!.y;
  await page.waitForLoadState('networkidle');
  expect(Math.abs((await disks.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
  // the next visit: the server answer and the probes held, the remembered warning is shown at once with its height
  const release = await gateSyscheck(page);
  probe.hold(true);
  await page.goto('/admin');
  await page.goto('/admin/status');
  await expect(headers).toContainText('Sicherheits');
  await expect(headers.locator('.pill')).toHaveText('wird geprüft…');
  await expect(disks).toBeVisible();
  const top2 = (await disks.boundingBox())!.y;
  release();
  probe.hold(false);
  await expect(headers.locator('.pill.warn')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(Math.abs((await disks.boundingBox())!.y - top2)).toBeLessThanOrEqual(1);
}
