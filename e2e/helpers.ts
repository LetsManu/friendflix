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
/**
 * The largest step along a row of column values: the mean of each `k` columns against the mean of the next `k` (evens out
 * the glass grain, so a soft gradient reads as no step and a hard edge as its full height); `at` is where it sits.
 */
export function worstStep(cols: number[], k = 6): { step: number; at: number } {
  let step = 0, at = -1;
  for (let x = k; x + k <= cols.length; x++) {
    const d = Math.abs(meanOf(cols, x - k, x) - meanOf(cols, x, x + k));
    if (d > step) { step = d; at = x; }
  }
  return { step: Math.round(step * 10) / 10, at };
}
/**
 * 1 px seam columns across a surface (e.g. a glass pill, round ends left out of `box`): each device-pixel column against
 * the mean of its two neighbours, row by row over the box's whole height. A seam (a column painted twice or not at all)
 * differs with one sign in nearly every row; grain, text and soft gradients do not. Returns the columns (CSS px) whose
 * median difference reaches `min` with the same sign in at least 90 % of the rows. One column at a time: an average over
 * a few columns cannot see a 1 px line.
 */
export async function seamColumns(page: Page, box: { x: number; y: number; width: number; height: number }, min = 1.5): Promise<Array<{ x: number; d: number; agree: number }>> {
  const clip = { x: Math.floor(box.x) - 1, y: Math.floor(box.y), width: Math.ceil(box.x + box.width) + 1 - (Math.floor(box.x) - 1), height: Math.ceil(box.y + box.height) - Math.floor(box.y) };
  const png = await page.screenshot({ clip, scale: 'device', animations: 'allow' });
  const img = await page.evaluate(async (b64) => {
    const im = new Image();
    im.src = 'data:image/png;base64,' + b64;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const g = c.getContext('2d')!;
    g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, im.width, im.height).data, L: number[] = [];
    for (let i = 0; i < d.length; i += 4) L.push(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
    return { w: im.width, h: im.height, L };
  }, png.toString('base64'));
  const k = img.w / clip.width; // device pixels per CSS px
  const y0 = Math.ceil((box.y - clip.y) * k + 0.5), y1 = Math.floor((box.y + box.height - clip.y) * k - 0.5);
  const x0 = Math.max(1, Math.ceil((box.x - clip.x) * k)), x1 = Math.min(img.w - 1, Math.floor((box.x + box.width - clip.x) * k));
  const out: Array<{ x: number; d: number; agree: number }> = [];
  for (let x = x0; x < x1; x++) {
    const ds: number[] = [];
    for (let y = y0; y < y1; y++) { const i = y * img.w + x; ds.push(img.L[i]! - (img.L[i - 1]! + img.L[i + 1]!) / 2); }
    const med = [...ds].sort((a, b) => a - b)[ds.length >> 1]!;
    const agree = ds.filter((d) => d !== 0 && Math.sign(d) === Math.sign(med)).length / ds.length;
    if (Math.abs(med) >= min && agree >= 0.9) out.push({ x: Math.round((clip.x + x / k) * 100) / 100, d: Math.round(med * 10) / 10, agree: Math.round(agree * 100) / 100 });
  }
  return out;
}
