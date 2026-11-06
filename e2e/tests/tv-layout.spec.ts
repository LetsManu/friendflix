// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** TV layout: a paired television gets the 10-foot design (html.tv) */
async function setTv(page: Page, tv: boolean) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, audioTracks: [], subtitles: [] } })); // the TV home warms its hero title
}

test.describe('TV layout', () => {
  test('tokens: black background and white focus ring on TV', async ({ page, api: _api }) => {
    await setTv(page, true);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(page.locator('nav.rail a.who')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
    // a plain focusable (not a .tv-btn: buttons show focus by their white fill, spec 5.1) keeps the white ring
    await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
    await page.locator('nav.rail a.who').focus();
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { tag: el.tagName, color: s.outlineColor, width: s.outlineWidth, shadow: s.boxShadow };
    });
    expect(ring.color).toBe('rgb(255, 255, 255)');
    expect(ring.width).toBe('3px');
    expect(ring.shadow).toBe('none');
  });

  test('tokens: .tv-btn on a <button> keeps its own size', async ({ page, api: _api }) => {
    await setTv(page, true);
    await page.goto('/');
    await expect(page.locator('nav.rail a.who')).toBeVisible();
    const r = await page.evaluate(() => {
      const b = document.createElement('button'); b.className = 'tv-btn'; b.textContent = 'x'; document.body.append(b);
      return { fs: parseFloat(getComputedStyle(b).fontSize), root: parseFloat(getComputedStyle(document.documentElement).fontSize), h: b.getBoundingClientRect().height };
    });
    expect(r.fs).toBeCloseTo(r.root * 1.375, 1); // spec 5.1: 22 px at 1080p (22 / 16 rem)
    expect(r.h).toBeGreaterThanOrEqual(56);
  });

  test('tokens: desktop keeps the dark grey background', async ({ page, api: _api }) => {
    await setTv(page, false);
    await page.goto('/');
    await expect(page.locator('html.tv')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 20, 24)');
  });

  test.describe('rail', () => {
    const open = (page: Page) => expect(page.locator('nav.rail')).toHaveClass(/open/);
    const closed = (page: Page) => expect(page.locator('nav.rail')).not.toHaveClass(/open/);
    async function home(page: Page) {
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('nav.rail a.who')).toBeAttached();
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused(); // the page's own first focus has landed
      const card = page.locator('main .card .thumb').first();
      await expect(card).toBeVisible();
      return card;
    }

    test('Left from the first card opens the rail on the active item, Right closes it and restores the card', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.keyboard.press('ArrowLeft');
      await open(page);
      await expect(page.locator('nav.rail a[aria-current="page"]')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await closed(page);
      await expect(card).toBeFocused();
    });

    test('Left from any element in the rail band (hero buttons) opens the rail instead of focusing a collapsed item', async ({ page, api: _api }) => {
      await home(page);
      const el = page.locator('main a[href], main button').filter({ visible: true });
      const n = await el.count();
      for (let i = 0; i < n; i++) {
        const e = el.nth(i);
        const box = await e.boundingBox();
        if (!box || box.y < 300 || box.y > 700 || box.x > 400) continue;
        await e.focus();
        await page.keyboard.press('ArrowLeft');
        const inRail = await page.evaluate(() => !!document.activeElement?.closest('nav.rail'));
        if (inRail) await open(page);
        else await closed(page); // a neighbour in the content took it
        await page.keyboard.press('ArrowRight').catch(() => {});
        await closed(page);
      }
      // collapsed items are never spatial targets
      await expect(page.locator('nav.rail')).toHaveAttribute('data-nav-skip', '');
    });

    test('OK on Movies navigates', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.keyboard.press('ArrowLeft');
      await open(page);
      await page.locator('nav.rail a[href="/browse/movies"]').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/browse\/movies/);
      await closed(page);
    });

    test('pointer hover opens the rail, leaving it closes it and the card keeps the focus', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.mouse.move(10, 400);
      await page.mouse.move(40, 420);
      await open(page);
      await page.mouse.move(900, 20); // the top margin: nothing focusable
      await closed(page);
      await expect(card).toBeFocused();
    });
  });

  test.describe('polish (spec 5.1)', () => {
    const alpha = (c: string) => { const m = /rgba?\(([^)]+)\)/.exec(c); const p = m ? m[1]!.split(',').map((v) => parseFloat(v)) : []; return p.length === 4 ? p[3]! : 1; };
    async function home(page: Page) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
      await expect(page.locator('main .rows section.row .card .thumb').first()).toBeVisible();
    }

    test('tile title, first row title and first card share the 152 px left edge at 1920x1080', async ({ page, api: _api }) => {
      await home(page);
      const x = await page.evaluate(() => {
        const left = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().left;
        return { title: left('section.tile .body :is(h1, img.logo)'), row: left('main .rows section.row h2'), card: left('main .rows section.row .card .thumb') };
      });
      expect(Math.abs(x.title - 152)).toBeLessThanOrEqual(2);
      expect(Math.abs(x.row - x.title)).toBeLessThanOrEqual(2);
      expect(Math.abs(x.card - x.title)).toBeLessThanOrEqual(2);
    });

    test('buttons: focus is a white fill without a ring, the other button is translucent', async ({ page, api: _api }) => {
      await home(page);
      const s = await page.evaluate(() => {
        const st = (el: Element) => { const c = getComputedStyle(el); return { outline: c.outlineStyle, bg: c.backgroundColor, color: c.color }; };
        return { play: st(document.querySelector('section.tile [data-autofocus]')!), info: st(document.querySelector('section.tile .btns > :not([data-autofocus])')!) };
      });
      expect(s.play.outline).toBe('none');
      expect(s.play.bg).toBe('rgb(255, 255, 255)');
      expect(s.play.color).toBe('rgb(0, 0, 0)');
      expect(alpha(s.info.bg)).toBeLessThan(0.3);
      expect(s.info.color).toBe('rgb(255, 255, 255)');
    });

    test('row titles are 26 px x root scale, weight 600', async ({ page, api: _api }) => {
      await home(page);
      const r = await page.evaluate(() => {
        const h = getComputedStyle(document.querySelector('main .rows section.row h2')!);
        return { fs: parseFloat(h.fontSize), fw: h.fontWeight, root: parseFloat(getComputedStyle(document.documentElement).fontSize) };
      });
      expect(r.fs).toBeCloseTo((26 * r.root) / 16, 1);
      expect(r.fw).toBe('600');
    });

    test('no generic type eyebrow: only a meaningful label is shown, in coral', async ({ page, api: _api }) => {
      await home(page);
      const tile = page.locator('section.tile');
      // the hero is ranked: its eyebrow says so
      await expect(tile.locator('.tv-eyebrow')).toContainText('Top 10');
      expect(await tile.locator('.tv-eyebrow').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 79, 109)');
      // a title without a label has no eyebrow at all (no "FILM" / "SERIE")
      const card = page.locator('main .rows section.row[aria-label="Weiterschauen"] .card .thumb[aria-label^="The Dawn Keeper"]');
      await card.focus();
      await expect(tile).toHaveAttribute('aria-label', 'The Dawn Keeper');
      await expect(tile.locator('.tv-eyebrow')).toHaveCount(0);
    });

    test('cards: focus ring is a box-shadow that follows the 6 px radius, no outline', async ({ page, api: _api }) => {
      await home(page);
      const thumb = page.locator('main .rows section.row .card .thumb').first();
      await thumb.focus();
      const s = await thumb.evaluate((e) => { const c = getComputedStyle(e); return { outline: c.outlineStyle, shadow: c.boxShadow, radius: c.borderTopLeftRadius }; });
      expect(s.outline).toBe('none');
      expect(s.shadow).toContain('rgb(255, 255, 255) 0px 0px 0px 3px');
      expect(s.radius).toBe('6px');
    });
  });

  test.describe('home', () => {
    const rowLabels = (page: Page) => page.locator('main .rows section.row').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

    test('focus tile with Play focused, Down reaches the first card, resting on it shows its title in the tile', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.goto('/');
      const tile = page.locator('section.tile');
      await expect(tile).toBeVisible();
      const play = tile.locator('[data-autofocus]');
      await expect(play).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('main .rows .card .thumb:focus')).toHaveCount(1);
      // resting on a card for 400 ms puts its title in the tile (instead of the hero and its buttons)
      const target = page.locator('main .rows section.row[aria-label="Diese Woche bei uns"] .card .thumb').first();
      await target.focus();
      const name = (await target.getAttribute('aria-label'))!.split(',')[0]!;
      await page.waitForTimeout(400);
      await expect(tile).toHaveAttribute('aria-label', name);
      await expect(tile.locator('[data-autofocus]')).toHaveCount(0); // the buttons give way to the card's info
      // the tile stays on screen while the rows slide up under it; the focused row's top sits at the tile bottom
      await page.locator('main .rows .card .thumb').first().focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
      await expect.poll(async () => page.evaluate(() => { const t = document.querySelector('section.tile')!.getBoundingClientRect(); const r = document.activeElement!.closest('section')!.getBoundingClientRect(); return { top: t.top, d: Math.abs(r.top - t.bottom) < 8 || window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2, inView: t.bottom > 0 && t.top < innerHeight }; })).toEqual({ top: 0, d: true, inView: true });
      // Up from the first row returns to the tile: the hero and its buttons are back
      await page.locator('main .rows .card .thumb').first().focus();
      await page.keyboard.press('ArrowUp');
      await expect(play).toBeFocused();
    });

    test('the rows are the same list as on desktop', async ({ page, api: _api }) => {
      await setTv(page, false);
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      const desktop = await rowLabels(page);
      expect(desktop.length).toBeGreaterThan(3);
      await page.unroute('**/api/me');
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('html.tv')).toHaveCount(1);
      await expect(page.locator('section.tile')).toBeVisible();
      await expect(page.locator('main .rows section.cr')).toBeAttached();
      await page.waitForLoadState('networkidle');
      await expect.poll(() => rowLabels(page)).toEqual(desktop);
    });
  });
});
