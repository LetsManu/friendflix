// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Locator, type Page } from '@playwright/test';

/** Row section by its accessible name (e.g. "Weiterschauen"). */
export const row = (page: Page, title: string | RegExp): Locator => page.locator('section.row').filter({ has: page.getByRole('heading', { level: 2, name: title }) });

/** True when the page has no horizontal scrollbar. */
export const noHorizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

/** Hovers a desktop card and waits for the wide hover preview (portal; ready = positioned and visible). */
export async function openPopout(page: Page, card: Locator): Promise<Locator> {
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  const hp = page.locator('.dpv.ready');
  await expect(hp).toBeVisible();
  return hp;
}

export async function boxInViewport(page: Page, el: Locator): Promise<{ ok: boolean; box: { x: number; y: number; width: number; height: number } | null; vw: number; vh: number }> {
  const box = await el.boundingBox();
  const { vw, vh } = await page.evaluate(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
  const ok = !!box && box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= vw + 0.5 && box.y + box.height <= vh + 0.5;
  return { ok, box, vw, vh };
}

/**
 * The red channel of a screenshot area (the page's own pixels, device scale 1) as rows of values, decoded in the page by a
 * canvas: for checking a surface for hard steps (a seam, a band) where a style check cannot see what the compositor drew.
 */
export async function redPixels(page: Page, x: number, y: number, width: number, height: number): Promise<number[][]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    return Array.from({ length: img.height }, (_, cy) => Array.from({ length: img.width }, (_, cx) => d[(cy * img.width + cx) * 4]!));
  }, png.toString('base64'));
}
/** each column of a screenshot strip, averaged over its rows (evens out the glass grain); see redPixels */
export async function pixelCols(page: Page, x: number, y: number, width: number, height = 1): Promise<number[]> {
  const rows = await redPixels(page, x, y, width, height);
  return rows[0]!.map((_, cx) => rows.reduce((a, r) => a + r[cx]!, 0) / rows.length);
}
/** the mean of `row[from..to)` */
export const meanOf = (row: number[], from: number, to: number): number => row.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
