// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';

// A person without libraries on a phone (roles redesign §6): the tab bar has only Live, the header has no search and no category
// chips, and the start page is Live TV. Anna Beispiel watches Nordlicht TV and Hafenkanal (mocks/livetv.ts).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const tabbar = (page: Page) => page.getByRole('navigation', { name: 'Mobile Navigation' });

test.describe('a person without libraries (phone)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    api.areas = { library: false, livetv: true, requests: false, together: false, downloads: false };
    api.canDownload = true; // the role may download, but downloads are library items: no Downloads tab without a library
    api.accountSaved = { name: 'Anna Beispiel', avatar: 'a1' };
    await mockLivePlayer(page);
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await page.clock.install({ time: NOW });
  });

  test('tab bar shows only Live; no category chips', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    await expect(tabbar(page).getByRole('link')).toHaveCount(1);
    await expect(tabbar(page).getByRole('link')).toHaveAttribute('href', '/live');
    await expect(tabbar(page).getByRole('link')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Kategorien' })).toHaveCount(0);
    await expect(page.locator('html.m-chips')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Suche' })).toHaveCount(0);
    // /me: account things only, no library tiles or rows
    await page.getByRole('link', { name: 'Mein Bereich' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/me');
    await expect(page.getByRole('main').getByRole('link', { name: 'Einstellungen', exact: true })).toBeVisible();
    const hrefs = await page.locator('main .tiles2 a, main .groups a').evaluateAll((l) => l.map((a) => a.getAttribute('href')!));
    for (const h of hrefs) expect(h, h).toMatch(/^\/(settings|devices|remote|me|admin|diagnose|live\/recordings)(\/|#|$)/);
    // the Live-TV recordings are listed there (DVR follow-ups)
    expect(hrefs).toContain('/live/recordings');
    await expect(page.getByRole('button', { name: 'Überrasch mich' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Weiterschauen' })).toHaveCount(0);
  });

  test('a stale hint (library): nothing moves on the early page before the redirect to Live TV', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('ff-boot-hint', JSON.stringify({ approved: true, multi: false, tv: false, profile: 'p1', lang: 'de' }));
      // every frame on the early start page: the header room (--nav-h) and where the content starts
      const w = window as unknown as { __geo: Array<{ nav: string; top: number }> };
      w.__geo = [];
      const look = () => {
        const first = document.querySelector('main')?.firstElementChild;
        if (location.pathname === '/' && first) w.__geo.push({ nav: getComputedStyle(document.documentElement).getPropertyValue('--nav-h').trim(), top: Math.round(first.getBoundingClientRect().top) });
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/me', async (r) => { await held; await r.fallback(); });
    await page.goto('/');
    await expect(page.locator('html.m-chips')).toHaveCount(1); // the chips' room is there (the chips themselves wait unseen)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __geo: unknown[] }).__geo.length)).toBeGreaterThan(5);
    // the Live page's code takes a moment to arrive (as on a real network): the early page stays on screen meanwhile
    await page.route('**/_app/immutable/**', async (r) => { await new Promise((d) => setTimeout(d, 300)); await r.fallback(); });
    release();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    const geo = await page.evaluate(() => (window as unknown as { __geo: Array<{ nav: string; top: number }> }).__geo);
    expect(new Set(geo.map((g) => g.nav)), 'header room on the early page').toEqual(new Set(['104px']));
    expect(new Set(geo.map((g) => g.top)).size, 'content top on the early page').toBe(1);
  });
});
