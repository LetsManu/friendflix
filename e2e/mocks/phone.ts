// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect } from '../fixtures.js';
import { episodes } from './fixtures.js';
import { mockPlayer, videoReady } from './scenes.js';

/**
 * Shared helpers of the phone player specs. Chromium reports no safe-area insets, so the --safe-* tokens from app.css are
 * forced (the app reads the insets only through them), with the values measured on an iPhone 15 Pro.
 */
export type Insets = { top: number; right: number; bottom: number; left: number };
/** portrait: status bar / Dynamic Island on top, home indicator below */
export const PORTRAIT: Insets = { top: 59, right: 0, bottom: 34, left: 0 };
/** landscape, the camera cut-out on the left */
export const LAND_L: Insets = { top: 0, right: 0, bottom: 21, left: 59 };
/** landscape, the camera cut-out on the right */
export const LAND_R: Insets = { top: 0, right: 59, bottom: 21, left: 0 };

/** forces the insets from the first render on */
export async function forceSafeArea(page: Page, s: Insets) {
  await page.addInitScript((v) => {
    const apply = () => {
      const st = document.documentElement?.style;
      if (!st) return;
      for (const [k, px] of Object.entries(v)) st.setProperty(`--safe-${k}`, `${px}px`);
    };
    apply();
    document.addEventListener('readystatechange', apply);
  }, s);
}

/** sets the insets on the running page (rotation) */
export const setSafeArea = (page: Page, s: Insets) => page.evaluate((v) => {
  for (const [k, px] of Object.entries(v)) document.documentElement.style.setProperty(`--safe-${k}`, `${px}px`);
}, s);

/** iOS ignores a programmatic volume (the hardware buttons own it): reading it back still gives 1 */
export const forceIosVolume = (page: Page) => page.addInitScript(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get: () => 1, set: () => undefined });
});

const EP = episodes[2]!;
export const EP_NAME = 'Overgeared - S01E03 - The Blacksmith Who Would Not Stop Talking';

/**
 * opens episode 3 (its name overridable; `o.series` renames the series, `o.segments` answers the segments request, `o.next` the
 * next-episode request) on the watch page and plays it; resolves once the dock's title block is there
 */
export async function openPhoneEpisode(page: Page, name = EP_NAME, o: { series?: string; segments?: unknown[]; next?: unknown } = {}) {
  await mockPlayer(page);
  await page.route(`**/api/items/${EP.id}`, (r) => r.fulfill({ json: { item: { ...EP, name, ...(o.series ? { seriesName: o.series } : {}) } } }));
  if (o.segments) await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: o.segments } }));
  if (o.next !== undefined) await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: o.next } }));
  await page.goto('/watch/' + EP.id);
  await videoReady(page);
  await expect(page.locator('.ptitle')).toContainText(name.slice(0, 12));
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
}

/** the controls hide after 3 s of playback: a tap on the picture (top left, away from the dock) brings them back */
export async function showControls(page: Page) {
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
}

export type Box = { name: string; x: number; y: number; w: number; h: number };
/** the bounding box of the first match of each selector (null when absent) */
export const boxes = (page: Page, selectors: string[]) => page.evaluate((sels) => sels.map((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { name: s, x: r.x, y: r.y, w: r.width, h: r.height };
}), selectors);

export const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
