// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** TV side rail: every entry keeps its full size and stays inside the screen, also with Live TV's extra entries, at small TV heights */
async function asTv(page: Page, livetv: boolean) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, features: { livetv } } }));
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // motion allowed: no trailer for the tile
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [] } }));
}

test.describe('TV rail fits the screen', () => {
  test.use({ reducedMotion: 'no-preference' }); // the focused entry scales 1.08 (reduced motion: none)
  for (const livetv of [true, false]) {
    for (const [w, h] of [[960, 540], [1280, 720], [1920, 1080]] as const) {
      test(`${w}x${h}, Live TV ${livetv ? 'on' : 'off'}: every entry has its full size and ends inside the screen`, async ({ page, api: _api }) => {
        await page.setViewportSize({ width: w, height: h });
        await asTv(page, livetv);
        await page.goto('/');
        await expect(page.locator('nav.rail a.who')).toBeVisible();
        const links = page.locator('nav.rail a');
        await expect(links).toHaveCount(livetv ? 10 : 8);
        // each entry in turn gets the focus (D-pad): it must then be at full size, inside the screen and inside the list's visible part, clear of account and profile
        await page.keyboard.press('Shift'); // keyboard modality: :focus-visible matches
        const n = await links.count();
        for (let i = 0; i < n; i++) {
          await links.nth(i).focus();
          const b = await links.nth(i).evaluate((e) => {
            const r = e.getBoundingClientRect();
            const clip = (e.closest('ul') ?? e.closest('nav'))!.getBoundingClientRect();
            const fixedTop = e.closest('ul') ? (document.querySelector('nav.rail a.acct') as HTMLElement).getBoundingClientRect().top : Infinity;
            return { href: e.getAttribute('href'), top: r.top, bottom: r.bottom, h: r.height, clipTop: clip.top, clipBottom: clip.bottom, fixedTop };
          });
          expect(b.h, `${b.href} height`).toBeGreaterThanOrEqual(56);
          expect(b.top, `${b.href} top`).toBeGreaterThanOrEqual(Math.max(0, b.clipTop) - 3);
          expect(b.bottom, `${b.href} bottom`).toBeLessThanOrEqual(Math.min(h, b.clipBottom, b.fixedTop) + 3);
          await page.waitForTimeout(450); // the focus scale (420 ms spring) has settled
          const x = await links.nth(i).evaluate((e) => { const u = e.closest('ul'); return u ? { right: e.getBoundingClientRect().right, ulRight: u.getBoundingClientRect().right, sw: u.scrollWidth, cw: u.clientWidth } : null; });
          if (x && w < 1920) { // the list is a scroller only on short screens: the scaled entry must not be cut on the right, nor scroll sideways
            expect(x.right, `${b.href} scaled right edge`).toBeLessThanOrEqual(x.ulRight);
            expect(x.sw, `${b.href} list scrolls sideways`).toBeLessThanOrEqual(x.cw + 1);
          }
        }
      });
    }
  }
});
