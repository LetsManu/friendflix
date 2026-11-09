// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** Glass menus and toasts on the phone (glass spec §5): ⋯ is a glass bottom sheet that slides up and back down; toasts are glass pills above the tab bar. */

type Anim = { duration: number; transform: string };
/** waits frame by frame (in the page) for the element's first animation that has a duration; its duration and current transform */
const anim = (loc: Locator): Promise<Anim> => loc.evaluate((e) => new Promise<Anim>((res, rej) => {
  const t0 = performance.now();
  const step = () => {
    const a = e.getAnimations().find((x) => Number(x.effect?.getTiming().duration) > 0);
    if (a) {
      const kf = (a.effect as KeyframeEffect).getKeyframes();
      res({ duration: Number(a.effect!.getTiming().duration), transform: String(kf[0]?.transform ?? '') });
      return;
    }
    if (performance.now() - t0 > 2000) { rej(new Error('no animation')); return; }
    requestAnimationFrame(step);
  };
  step();
}));
const settled = (loc: Locator) => expect.poll(() => loc.evaluate((e) => e.getAnimations().length)).toBe(0);
const css = (loc: Locator, prop: string) => loc.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    sessionStorage.setItem('ff-profile-picked', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
}

test.describe('glass menus on the phone', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('⋯ opens a glass bottom sheet that slides up and back down', async ({ page }) => {
    await page.goto('/item/' + MOVIE.id);
    const more = page.getByRole('button', { name: 'Mehr', exact: true }).first();
    await more.click();
    const sheet = page.locator('.ma-pop.sheet');
    const a = await anim(sheet);
    expect(a.duration).toBe(380);
    expect(a.transform).toBe('translateY(100%)');
    await expect(sheet).toHaveClass(/\bfrost-sheet\b/);
    expect(await css(sheet, 'border-top-left-radius')).toBe('26px');
    expect(await css(sheet, 'border-bottom-left-radius')).toBe('0px');
    expect(await css(sheet, 'backdrop-filter')).toContain('blur(38px)');
    await settled(sheet);
    await expect(sheet.locator('.mi').first()).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await sheet.count()).toBe(1); // slides back down
    expect((await anim(sheet)).duration).toBe(200);
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.ma-wrap')).toHaveCount(0); // the scrim faded with it
    await expect(more).toBeFocused();
  });

  test('toasts sit above the tab bar as glass pills', async ({ page }) => {
    await page.goto('/admin');
    const attn = page.getByRole('region', { name: 'Wartet auf dich' });
    await attn.getByRole('button', { name: '„Dunmoor: Part Two“ freigeben' }).click();
    const toast = page.locator('.toast.frost');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveClass(/\bfrost-pill\b/);
    await settled(toast);
    expect(await css(toast, 'border-top-left-radius')).toBe('999px');
    const b = (await toast.boundingBox())!;
    const tb = (await page.getByRole('navigation', { name: 'Mobile Navigation' }).last().boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(tb.y + 1);
    expect(Math.abs(b.x + b.width / 2 - 195)).toBeLessThanOrEqual(2);
    await expect(toast.locator('.dot.success')).toBeVisible();
  });
});
