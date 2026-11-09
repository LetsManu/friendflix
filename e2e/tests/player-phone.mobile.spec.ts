// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { forceSafeArea, openPhoneEpisode, overlap, PORTRAIT, showControls, type Box } from '../mocks/phone.js';

/**
 * The player on an iPhone 15 Pro (home-screen app): portrait 393x852 with the status bar / Dynamic Island on top (59 px) and
 * the home indicator below (34 px); landscape 852x393 with the island on a side edge (59 px left and right) and 21 px below.
 * Chromium reports no insets, so the --safe-* tokens from app.css are forced (the app reads the insets only through them).
 * PHONE_SHOTS=<dir> [PHONE_SHOTS_TAG=before|after] saves a screenshot of each layout.
 * The dock itself (order, long titles, both cut-out sides, rotation) is covered by phone-player.mobile.spec.ts.
 */
const LAYOUTS = [
  { name: 'portrait', viewport: { width: 393, height: 852 }, safe: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: 'landscape', viewport: { width: 852, height: 393 }, safe: { top: 0, right: 59, bottom: 21, left: 59 } },
] as const;
const SHOTS = process.env.PHONE_SHOTS;

/** every visible, hit-testable control of the player chrome (top bar, dock) */
const controls = (page: Page) => page.evaluate(() => {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('.ovl button, .ctl button, .ctl [role="slider"]')) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ name: el.getAttribute('aria-label') ?? el.textContent!.trim().slice(0, 24), x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
});

for (const L of LAYOUTS) {
  test.describe(`phone player, ${L.name} (iPhone safe areas)`, () => {
    test.use({ viewport: L.viewport });
    test.beforeEach(async ({ page }) => { await forceSafeArea(page, L.safe); });

    test('controls do not overlap, stay inside the safe area and are big enough to tap', async ({ page, api: _api }) => {
      await openPhoneEpisode(page);
      await showControls(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${process.env.PHONE_SHOTS_TAG ?? 'after'}-${L.name}.png` });
      const boxes = await controls(page);
      const { width: vw, height: vh } = L.viewport;
      expect(boxes.length).toBeGreaterThanOrEqual(9);
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        // inside the safe area (no control under the Dynamic Island, the status bar or the home indicator)
        expect.soft(b.x, `${b.name} left`).toBeGreaterThanOrEqual(L.safe.left - 0.5);
        expect.soft(b.x + b.w, `${b.name} right`).toBeLessThanOrEqual(vw - L.safe.right + 0.5);
        expect.soft(b.y, `${b.name} top`).toBeGreaterThanOrEqual(L.safe.top - 0.5);
        expect.soft(b.y + b.h, `${b.name} bottom`).toBeLessThanOrEqual(vh - L.safe.bottom + 0.5);
        if (b.name !== 'Position') { // the seek bar is a thin line with a taller invisible hit area
          expect.soft(b.w, `${b.name} width`).toBeGreaterThanOrEqual(44);
          expect.soft(b.h, `${b.name} height`).toBeGreaterThanOrEqual(44);
        }
        for (const o of boxes.slice(i + 1)) expect.soft(overlap(b, o), `${b.name} overlaps ${o.name}`).toBe(false);
      }
      // no centre controls: play / pause between -10 and +10 sit in the left pill, the play button the largest
      await expect(page.locator('.cc')).toHaveCount(0);
      const pill = page.locator('.pill.lp');
      for (const name of ['Pause', '10 Sekunden zurück', '10 Sekunden vor']) await expect(pill.getByRole('button', { name, exact: true })).toBeVisible();
      const play = (await pill.getByRole('button', { name: 'Pause', exact: true }).boundingBox())!;
      expect(play.width).toBeGreaterThanOrEqual(56); expect(play.height).toBeGreaterThanOrEqual(56);
      // both times beside the seek bar
      await expect(page.locator('.ctl .el')).toHaveText(/^\d+:\d\d$/);
      await expect(page.locator('.ctl .rem')).toHaveText(/^−\d+:\d\d$/);
      const [el, track, rem] = await Promise.all(['.ctl .el', '.ctl .track', '.ctl .rem'].map(async (s) => (await page.locator(s).boundingBox())!));
      expect(el!.x + el!.width).toBeLessThanOrEqual(track!.x);
      expect(track!.x + track!.width).toBeLessThanOrEqual(rem!.x);
      // the quality chip and the lock sit in the top bar
      const chip = (await page.getByRole('button', { name: /^Original/ }).boundingBox())!;
      expect(chip.y + chip.height).toBeLessThan(vh / 3);
      const lock = (await page.locator('.ptop').getByRole('button', { name: 'Bedienung sperren' }).boundingBox())!;
      expect(lock.y + lock.height).toBeLessThan(vh / 3);
      // the dock reaches the screen edge (its scrim covers the home indicator strip)
      const bar = (await page.locator('.ctl').boundingBox())!;
      expect(Math.round(bar.y + bar.height)).toBe(vh);
    });
  });
}

test.describe('phone player, portrait', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  test('lock lives in the top bar; the unlock button sits alone at the bottom', async ({ page, api: _api }) => {
    await forceSafeArea(page, PORTRAIT);
    await openPhoneEpisode(page);
    await showControls(page);
    await page.locator('.ptop').getByRole('button', { name: 'Bedienung sperren' }).tap();
    await expect(page.locator('.stage.locked')).toHaveCount(1);
    const unlock = page.getByRole('button', { name: 'Entsperren (gedrückt halten)' });
    await expect(unlock).toBeVisible();
    const b = (await unlock.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(852 - 34);
    await expect(page.locator('.cc button')).toHaveCount(0);
    await expect(page.locator('.ctl.hide')).toHaveCount(1);
    await expect(page.locator('.ovl.hide')).toHaveCount(1);
  });

  test('menus open above the bottom bar inside the safe area', async ({ page, api: _api }) => {
    await forceSafeArea(page, PORTRAIT);
    await openPhoneEpisode(page);
    await showControls(page);
    await page.getByRole('button', { name: 'Mehr', exact: true }).tap();
    const menu = page.getByRole('dialog', { name: 'Mehr' });
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!, track = (await page.locator('.ctl .tlrow').boundingBox())!;
    expect(m.y + m.height).toBeLessThanOrEqual(track.y - 7.5);
    expect(m.y).toBeGreaterThanOrEqual(59);
  });
});
