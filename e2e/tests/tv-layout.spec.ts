// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, hex, items, ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { asLgApp } from '../mocks/webos.js';
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

    test('the open rail closes when the focus leaves it by other means (a page or command focusing the content)', async ({ page, api: _api }) => {
      const card = await home(page);
      await card.focus();
      await page.keyboard.press('ArrowLeft');
      await open(page);
      await card.focus(); // not a rail key: e.g. a phone-remote command or a page that focuses itself
      await closed(page);
      await expect(card).toBeFocused();
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
      const s = await thumb.evaluate((e) => { const c = getComputedStyle(e); return { outline: c.outlineStyle, radius: c.borderTopLeftRadius }; });
      expect(s.outline).toBe('none');
      expect(s.radius).toBe('6px');
      // spec 5.2: the ring + shadow is a layer of its own over the artwork that fades in (opacity) after the scale started
      const ring = () => thumb.evaluate((e) => { const c = getComputedStyle(e.closest('.media')!, '::after'); return { shadow: c.boxShadow, radius: c.borderTopLeftRadius, opacity: c.opacity }; });
      await expect.poll(async () => (await ring()).opacity).toBe('1');
      const r = await ring();
      expect(r.shadow).toContain('rgb(255, 255, 255) 0px 0px 0px 3px');
      expect(r.radius).toBe('6px');
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
      // a ranked card's name starts with "Platz n: "; the tile shows the title alone
      const name = (await target.getAttribute('aria-label'))!.replace(/^Platz \d+: /, '').split(',')[0]!;
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
  test.describe('gaps (Task 8)', () => {
    /** Back on a webOS remote, sent to the focused element (the layout listens on the window) */
    const back = (page: Page) => page.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 461, bubbles: true })));

    test('Back on the home page with the rail closed opens the rail', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
      await expect(page.locator('nav.rail')).not.toHaveClass(/open/);
      await back(page);
      await expect(page.locator('nav.rail')).toHaveClass(/open/);
    });

    test('a card of the Top 10 row shows its rank in the focus tile', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.goto('/');
      const card = page.locator('main .rows section.row[aria-label="Top 10 nach Bewertung"] .card .thumb').nth(1);
      await expect(card).toBeAttached();
      await card.focus();
      await expect(page.locator('section.tile')).toContainText('Top 10 · Platz 2');
    });

    test('empty home rows: the tile shows the hero with Play focused and Down moves into the rows below it', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.route('**/api/home', (r) => r.fulfill({ json: { parts: { hero: SERIES, resume: [], nextup: [], leaving: [], recs: { items: [], recIds: [], friends: [] }, because: { because: null, items: [], more: [] }, hubs: [], themed: [] }, failed: [] } }));
      await page.goto('/');
      const tile = page.locator('section.tile');
      await expect(tile).toBeVisible();
      await expect(tile.locator('[data-autofocus]')).toBeFocused();
      await expect(tile).toContainText(SERIES.name);
      await page.keyboard.press('ArrowDown');
      // the first row below the tile: with the personal rows empty that is a row with cards or the categories row
      await expect(page.locator('main .rows :is(section.row .card .thumb, section.cr a.cat):focus')).toHaveCount(1);
    });

    test('rail Account opens the account page; Sign out, settings and devices are reachable with the arrows', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
      await page.locator('main .card .thumb').first().focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('nav.rail')).toHaveClass(/open/);
      await page.locator('nav.rail a.acct').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/me$/);
      await expect(page.locator('nav.rail')).not.toHaveClass(/open/);
      await expect(page.locator('nav.rail a.acct')).toHaveAttribute('aria-current', 'page');
      const out = page.getByRole('button', { name: 'Abmelden' });
      await expect(out).toBeVisible();
      await expect(page.locator('main a[href="/settings"]')).toBeVisible();
      await expect(page.locator('main a[href="/devices"]')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Server wechseln' })).toHaveCount(0); // only in the LG app
      // D-pad: everything on the page is reachable with the arrows from its first element (walk every arrow from every reached element)
      await page.locator('main .notes, main p.muted.pad').first().waitFor(); // the notifications have loaded
      await page.evaluate(() => document.querySelectorAll<HTMLElement>('main a[href], main button').forEach((e, i) => (e.dataset.k = String(i))));
      const key = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.k ?? '');
      const seen = new Set<string>(['0']), todo = ['0'];
      while (todo.length) {
        const k = todo.shift()!;
        for (const dir of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
          await page.locator(`main [data-k="${k}"]`).focus();
          await page.keyboard.press(dir);
          const to = await key();
          if (to && !seen.has(to)) { seen.add(to); todo.push(to); }
        }
        if (await page.locator('nav.rail.open').count()) await page.keyboard.press('ArrowRight'); // Left at the edge opened the rail
      }
      const reached = await page.evaluate((ks) => ks.map((k) => { const e = document.querySelector<HTMLElement>(`main [data-k="${k}"]`)!; return e.getAttribute('href') ?? e.textContent!.trim(); }), [...seen]);
      for (const want of ['/settings', '/devices', 'Abmelden']) expect(reached).toContain(want);
    });

    test('LG app: the account page offers Change server', async ({ page, api: _api }) => {
      await asLgApp(page);
      await setTv(page, true);
      await page.goto('/me?ff_app=webos');
      await expect(page.getByRole('button', { name: 'Server wechseln' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
    });

    test('Back on a genre page opened from the home categories row returns home, to the tile', async ({ page, api: _api }) => {
      await setTv(page, true);
      await page.goto('/');
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
      const cat = page.locator('main section.cr a.cat').first();
      await expect(cat).toBeAttached();
      const href = (await cat.getAttribute('href'))!;
      await cat.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL((u) => u.pathname + u.search === href);
      await expect(page.locator('main a, main button').first()).toBeAttached();
      await page.waitForTimeout(300); // the page has settled its focus
      await back(page);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('nav.rail')).not.toHaveClass(/open/);
      await expect(page.locator('main section.cr a.cat').first()).toBeFocused();
    });

    test('desktop untouched: with tv false the desktop header and the billboard render, no tile or rail', async ({ page, api: _api }) => {
      await setTv(page, false);
      await page.goto('/');
      await expect(page.locator('html.tv')).toHaveCount(0);
      await expect(page.locator('header.nav')).toBeVisible();
      await expect(page.locator('section.billboard')).toBeVisible(); // desktop browse: the trailer billboard
      await expect(page.locator('section.tile')).toHaveCount(0);
      await expect(page.locator('nav.rail')).toHaveCount(0);
    });
  });

  test.describe('motion (spec 5.2)', () => {
    async function home(page: Page) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await setTv(page, true);
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // motion allowed: no trailer for the tile
      await page.goto('/');
      await expect(page.locator('section.tile [data-autofocus]')).toBeFocused();
      await expect(page.locator('main .rows section.row .card .thumb').first()).toBeVisible();
    }
    /** the row with the most cards (it has to scroll sideways) */
    async function longRow(page: Page) {
      const label = await page.locator('main .rows section.row').evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.querySelectorAll('.card').length] as const).sort((a, b) => b[1] - a[1])[0]![0]);
      return page.locator(`main .rows section.row[aria-label="${label}"]`);
    }

    test('reduced motion: focus changes apply at once, without a scale', async ({ page, api: _api }) => {
      await home(page);
      const thumb = page.locator('main .rows section.row .card .thumb').first();
      await thumb.focus();
      const s = await thumb.evaluate((e) => { const c = getComputedStyle(e.closest('.card')!); return { transform: c.transform, dur: Math.max(...c.transitionDuration.split(',').map((v) => parseFloat(v))) }; });
      expect(s.transform === 'none' || s.dur <= 0.001).toBe(true);
      expect(s.transform).toBe('none');
    });

    test.describe('full motion', () => {
      test.use({ reducedMotion: 'no-preference' });
      // the TV frame guard with a budget no test host misses: this software-rendered browser draws at 40-110 ms per frame, so on the
      // shared runner the guard (3 frames over 32 ms) would trip into the reduced set (no view transition, by design). Unit-tested in lib/tv/motion.test.ts.
      test.beforeEach(({ page }) => page.addInitScript(() => { (window as unknown as { __ffTvGuard: { slowMs: number; frames: number } }).__ffTvGuard = { slowMs: 1000, frames: 3 }; }));

      test('Right glides the row track (transform during the move, none at rest) and the focused card ends fully in view', async ({ page, api: _api }) => {
        await home(page);
        const row = await longRow(page);
        await row.locator('.card .thumb').first().focus();
        await page.waitForTimeout(400);
        let moved = false, reduced = false;
        for (let i = 0; i < 9 && !moved && !reduced; i++) {
          await page.keyboard.press('ArrowRight');
          const t = await row.locator('.strip').evaluate((e) => getComputedStyle(e).transform);
          moved = t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
          reduced = await page.evaluate(() => document.documentElement.classList.contains('tv-motion-reduced')); // tripped guard: no glide by design
        }
        expect(moved || reduced).toBe(true);
        for (let i = 0; reduced && i < 9; i++) await page.keyboard.press('ArrowRight'); // still walk far enough to scroll the track
        await expect.poll(() => row.locator('.strip').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
        const r = await page.evaluate(() => {
          const slot = document.activeElement!.closest('.slot')!.getBoundingClientRect(), tr = document.activeElement!.closest('.track')!.getBoundingClientRect();
          return { l: slot.left, r: slot.right, tl: tr.left, tr: tr.right, vw: innerWidth };
        });
        expect(r.l).toBeGreaterThanOrEqual(r.tl);
        expect(r.r).toBeLessThanOrEqual(Math.min(r.tr, r.vw));
      });

      test('Down glides the page: the rows move by transform, the focused row comes to rest under the tile', async ({ page, api: _api }) => {
        await home(page);
        await page.locator('main .rows .card .thumb').first().focus();
        await page.waitForTimeout(400);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        // a glide (transform while moving), or a session whose frame guard tripped on a busy machine: that one moves without the
        // glide by design (motionLevel 'reduced'), so only the resting place below can be checked
        await page.waitForFunction(() => getComputedStyle(document.querySelector('main .rows')!).transform !== 'none' || document.documentElement.classList.contains('tv-motion-reduced'), null, { polling: 'raf', timeout: 2000 });
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('main .rows')!).transform)).toBe('none');
        const d = await page.evaluate(() => { const t = document.querySelector('section.tile')!.getBoundingClientRect(); const r = document.activeElement!.closest('section')!.getBoundingClientRect(); return Math.abs(r.top - t.bottom); });
        expect(d).toBeLessThan(8);
      });

      test('a settled focus change re-enters the tile text in a stagger (the title animates)', async ({ page, api: _api }) => {
        await home(page);
        const thumbs = page.locator('main .rows section.row').first().locator('.card .thumb');
        await thumbs.nth(0).focus();
        await page.waitForTimeout(500);
        await thumbs.nth(1).focus();
        await page.waitForFunction(() => {
          const el = document.querySelector('section.tile .body:not(.ghost) :is(h1, img.logo)[data-st]');
          return !!el && el.getAnimations().length > 0;
        }, null, { polling: 'raf', timeout: 3000 });
        // the outgoing text is a lifeless copy: nothing in it can take the focus
        expect(await page.locator('section.tile .ghost a:not([tabindex="-1"]), section.tile .ghost [data-autofocus]').count()).toBe(0);
      });

      test('card -> detail starts a view transition (the artwork carries the shared name); Back returns', async ({ page, api: _api }) => {
        await page.addInitScript(() => {
          const d = document as Document & { startViewTransition?: (cb: () => unknown) => unknown };
          const orig = d.startViewTransition?.bind(d);
          const w = window as unknown as { __vt: string[] };
          w.__vt = [];
          if (orig) d.startViewTransition = (cb: () => unknown) => { w.__vt.push(String([...document.querySelectorAll<HTMLElement>('main .card img')].filter((i) => i.style.viewTransitionName === 'ff-tv-art').length)); return orig(cb); };
        });
        await home(page);
        const thumb = page.locator('main .rows section.row .card a.thumb[href^="/item/"]').first();
        await thumb.focus();
        await page.waitForTimeout(300); // the row has glided to it
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/item\//);
        const vt = await page.evaluate(() => (window as unknown as { __vt: string[] }).__vt);
        expect(vt[0]).toBe('1'); // the focused card's artwork carries the shared name when the old page is captured
        await expect(page.locator('html')).not.toHaveClass(/ff-vt-(tv|art)/); // cleaned up
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(/\/$/);
        await expect.poll(() => page.evaluate(() => (window as unknown as { __vt: string[] }).__vt.length)).toBe(2); // Back plays it in reverse
      });

      test('without the View Transitions API card -> detail still navigates', async ({ page, api: _api }) => {
        await page.addInitScript(() => { delete (Document.prototype as unknown as { startViewTransition?: unknown }).startViewTransition; });
        await home(page);
        const thumb = page.locator('main .rows section.row .card a.thumb[href^="/item/"]').first();
        await thumb.focus();
        await page.waitForTimeout(300); // the row has glided to it
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/item\//);
        await expect(page.locator('main')).toBeVisible();
      });

      test('the rail dot springs to the new page (transform transition)', async ({ page, api: _api }) => {
        await home(page);
        const dot = page.locator('nav.rail .dot');
        await expect(dot).toHaveClass(/on/);
        expect(await dot.evaluate((e) => getComputedStyle(e).transitionProperty)).toContain('transform');
      });
    });
  });

  test.describe('detail sub-screens (spec 3)', () => {
    const ABOUT = { ratings: [{ key: 'community', value: 7.8, max: 10, from: 'jellyfin' }], countries: [], studios: ['Wardell Pictures'], tags: [], keywords: [], links: [], collection: null, canRequest: false, sources: ['jellyfin'] };
    async function tv(page: Page) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await setTv(page, true);
      await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: ABOUT }));
    }
    /** Back on a webOS remote, sent to the focused element (the layout listens on the window) */
    const back = (page: Page) => page.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 461, bubbles: true })));
    const focusedHref = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('href') ?? '');

    test('Episodes opens as a route with the next-up episode focused; Back returns to the button that opened it', async ({ page, api: _api }) => {
      await tv(page);
      await page.goto(`/item/${SERIES.id}`);
      await expect(page.locator('.tvd .btns a.play')).toBeFocused();
      for (let i = 0; i < 3 && !(await focusedHref(page)).endsWith('/episodes'); i++) await page.keyboard.press('ArrowDown');
      expect(await focusedHref(page)).toBe(`/item/${SERIES.id}/episodes`);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/item/${SERIES.id}/episodes$`));
      // the mocked next-up episode is "Folge 2"
      await expect(page.locator(`main a[href="/watch/${episodes[1]!.id}"]`)).toBeFocused();
      await back(page);
      await expect(page).toHaveURL(new RegExp(`/item/${SERIES.id}$`));
      await expect.poll(() => focusedHref(page)).toBe(`/item/${SERIES.id}/episodes`);
    });

    test('Episodes: Left goes to the seasons, moving there switches the season and keeps the focus, Right enters the list, OK plays', async ({ page, api: _api }) => {
      await tv(page);
      const s2 = hex(201);
      const second = [0, 1].map((i) => ({ ...episodes[i + 2]!, name: `Zweite ${i + 1}`, seasonId: s2, parentIndexNumber: 2, positionTicks: 0, played: false }));
      await page.route(/\/api\/items\/[0-9a-f]{32}\/seasons$/, (r) => r.fulfill({ json: { items: [
        { id: hex(200), name: 'Staffel 1', type: 'Season', indexNumber: 1, genres: [], image: true, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0 },
        { id: s2, name: 'Staffel 2', type: 'Season', indexNumber: 2, genres: [], image: true, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0 },
      ] } }));
      await page.route(/\/api\/items\/[0-9a-f]{32}\/episodes\?/, (r) => r.fulfill({ json: { items: new URL(r.request().url()).searchParams.get('seasonId') === s2 ? second : episodes } }));
      await page.goto(`/item/${SERIES.id}/episodes`);
      const nextUp = page.locator(`main a[href="/watch/${episodes[1]!.id}"]`);
      await expect(nextUp).toBeFocused();
      // a 16:9 still, the coral progress bar on the episode with progress, the watched check on a played one
      await expect(page.locator(`main a[href="/watch/${episodes[0]!.id}"] .bar`)).toHaveCount(1);
      await page.keyboard.press('ArrowLeft');
      const seasons = page.locator('main .seasons a, main .seasons button');
      await expect(seasons.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(seasons.nth(1)).toBeFocused();
      await expect(page.locator('main .eplist')).toContainText('Zweite 1');
      await expect(seasons.nth(1)).toBeFocused(); // the season changed under the focus
      await page.keyboard.press('ArrowRight');
      await expect(page.locator(`main a[href="/watch/${second[0]!.id}"]`)).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(seasons.nth(1)).toBeFocused(); // back to the selected season, not the geometric neighbour
      // OK plays it (the same player link as the desktop episode list)
      await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: null } }));
      await page.route('**/api/bookmarks?*', (r) => r.fulfill({ json: { bookmarks: [] } }));
      await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: [] } }));
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/watch/${second[0]!.id}$`));
    });

    test('More like this: a card grid on the 152 px edge, five per row, the focused card\'s reason in the line above', async ({ page, api: _api }) => {
      await tv(page);
      const similar = items.slice(1, 9).map((i, n) => ({ ...i, reason: n === 1 ? { seed: { id: MOVIE.id, name: MOVIE.name }, traits: [] } : undefined }));
      await page.route(/\/api\/items\/[0-9a-f]{32}\/similar$/, (r) => r.fulfill({ json: { items: similar } }));
      await page.goto(`/item/${MOVIE.id}/more`);
      const cards = page.locator('main .grid .card .thumb');
      await expect(cards.first()).toBeFocused();
      const geo = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.left), y: Math.round(r.top) })));
      expect(Math.abs(geo[0]!.x - 152)).toBeLessThanOrEqual(2);
      expect(geo.filter((g) => Math.abs(g.y - geo[0]!.y) < 2)).toHaveLength(5);
      const cap = page.locator('main .focusline');
      await expect(cap).toContainText(similar[0]!.name);
      await page.keyboard.press('ArrowRight');
      await expect(cards.nth(1)).toBeFocused();
      await expect(cap).toContainText(similar[1]!.name);
      await expect(cap).toContainText(MOVIE.name); // "because you watched Inkwell"
      await page.keyboard.press('ArrowDown');
      await expect(cards.nth(6)).toBeFocused();
    });

    test('Collection: the parts as a card grid, the focused part named above it', async ({ page, api: _api }) => {
      await tv(page);
      const part = (o: object) => ({ image: true, played: false, current: false, inLibrary: true, from: 'jellyfin', ...o });
      const collection = { name: 'Matrix-Reihe', from: 'jellyfin', parts: [part({ id: items[3]!.id, name: 'Teil Eins', year: 1999, played: true }), part({ id: MOVIE.id, name: MOVIE.name, current: true }), part({ name: 'Teil Drei', inLibrary: false, tmdbId: 7 })] };
      await page.unroute(/\/api\/items\/[0-9a-f]{32}\/about$/);
      await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: { ...ABOUT, collection } }));
      await page.goto(`/item/${MOVIE.id}/collection`);
      await expect(page.locator('main h1')).toContainText('Matrix-Reihe');
      const cards = page.locator('main .grid .card .thumb');
      await expect(cards).toHaveCount(2);
      await expect(page.locator('main .focusline')).toContainText(/Teil Eins|Inkwell/);
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('main .focusline')).toContainText(MOVIE.name);
    });

    test('Extras: the clips as a card grid that plays them; Story so far: the text and the way on', async ({ page, api: _api }) => {
      await tv(page);
      await page.route('**/api/items/*/extras/all', (r) => r.fulfill({ json: { items: [
        { ...MOVIE, id: 'a'.repeat(32), name: 'Trailer 1', kind: 'trailer', runtimeTicks: 1_500_000_000 },
        { ...MOVIE, id: 'b'.repeat(32), name: 'Making-of', kind: 'extra', runtimeTicks: 6_000_000_000 },
      ] } }));
      await page.goto(`/item/${MOVIE.id}/extras`);
      const cards = page.locator('main .grid .card .thumb');
      await expect(cards.first()).toBeFocused();
      await expect(cards.first()).toHaveAttribute('href', `/watch/${'a'.repeat(32)}`);
      await expect(page.locator('main .focusline')).toContainText('Trailer 1');
      await expect(page.locator('main .focusline')).toContainText('3 Min.');
      await page.route('**/api/items/*/story', (r) => r.fulfill({ json: { story: { reason: 'newSeason', season: { number: 1, name: 'Staffel 1', overview: 'Was in Staffel 1 geschah.' }, episode: { id: episodes[5]!.id, name: 'Folge 6', season: 1, index: 6, overview: 'Das Finale.' }, next: { id: episodes[1]!.id, season: 2, index: 1 } } } }));
      await page.goto(`/item/${SERIES.id}/story`);
      await expect(page.locator('main')).toContainText('Was in Staffel 1 geschah.');
      await expect(page.locator(`main a.tv-btn[href="/watch/${episodes[1]!.id}"]`)).toBeFocused();
    });

    test('Info: ratings, details and the cast; every focusable is reachable with the arrows', async ({ page, api: _api }) => {
      await tv(page);
      await page.goto(`/item/${MOVIE.id}/info`);
      await expect(page.locator('main').getByRole('list', { name: 'Bewertungen' })).toBeVisible();
      await expect(page.locator('main a[href^="/person/"]').first()).toBeVisible();
      await expect(page.locator('main')).toContainText('Wardell Pictures');
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(true);
      // walk the arrow graph from the first focus; every focusable in the content must be visited
      const all = await page.locator('main').evaluate((m) => [...m.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((e) => e.getClientRects().length && !e.closest('[hidden], [inert]')).length);
      const seen = new Set<string>();
      const key = () => page.evaluate(() => { const a = document.activeElement as HTMLElement; const all = [...document.querySelectorAll('main a[href], main button:not([disabled])')]; return a.closest('main') ? String(all.indexOf(a)) : ''; });
      const queue = [await key()];
      seen.add(queue[0]!);
      while (queue.length) {
        const k = queue.shift()!;
        for (const dir of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
          await page.evaluate((i) => (document.querySelectorAll('main a[href], main button:not([disabled])')[Number(i)] as HTMLElement).focus(), k);
          await page.keyboard.press(dir);
          const n = await key();
          if (n && !seen.has(n)) { seen.add(n); queue.push(n); }
        }
      }
      expect(seen.size).toBe(all);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });

    test('outside TV mode a sub-screen route replaces itself with the detail page', async ({ page, api: _api }) => {
      await setTv(page, false);
      await page.goto('/');
      await page.goto(`/item/${MOVIE.id}/more`);
      await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
      await expect(page.locator('html.tv')).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(/\/$/); // replaced, not pushed: Back skips the sub-screen URL
    });

    test.describe('full motion', () => {
      test.use({ reducedMotion: 'no-preference' });
      // the TV frame guard with a budget no test host misses: this software-rendered browser draws at 40-110 ms per frame, so on the
      // shared runner the guard (3 frames over 32 ms) would trip into the reduced set (no view transition, by design). Unit-tested in lib/tv/motion.test.ts.
      test.beforeEach(({ page }) => page.addInitScript(() => { (window as unknown as { __ffTvGuard: { slowMs: number; frames: number } }).__ffTvGuard = { slowMs: 1000, frames: 3 }; }));
      test('detail -> sub-screen slides in from the right 24 px, Back slides the other way; the classes are cleaned up', async ({ page, api: _api }) => {
        await page.addInitScript(() => {
          const d = document as Document & { startViewTransition?: (cb: () => unknown) => unknown };
          const orig = d.startViewTransition?.bind(d);
          const w = window as unknown as { __vt: string[] };
          w.__vt = [];
          if (orig) d.startViewTransition = (cb: () => unknown) => { const r = document.documentElement; w.__vt.push(`${[...r.classList].filter((c) => c.startsWith('ff-vt')).sort().join(' ')}|${r.style.getPropertyValue('--ff-vt-dx')}`); return orig(cb); };
        });
        await tv(page);
        await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
        await page.goto(`/item/${MOVIE.id}`);
        await expect(page.locator('.tvd .btns a.play')).toBeFocused();
        await page.locator(`.tvd .btns a[href="/item/${MOVIE.id}/more"]`).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}/more$`));
        await expect.poll(() => page.evaluate(() => (window as unknown as { __vt: string[] }).__vt)).toEqual(['ff-vt-sub ff-vt-tv|24px']);
        await expect(page.locator('html')).not.toHaveClass(/ff-vt/);
        await expect(page.locator('main .grid .card .thumb').first()).toBeFocused();
        await back(page);
        await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
        // Back reverses (the content slides in from the left); a session whose frame guard tripped keeps only the crossfade
        const reduced = await page.evaluate(() => document.documentElement.classList.contains('tv-motion-reduced'));
        await expect.poll(() => page.evaluate(() => (window as unknown as { __vt: string[] }).__vt[1])).toBe(reduced ? 'ff-vt-tv|' : 'ff-vt-sub ff-vt-tv|-24px');
        await expect(page.locator('html')).not.toHaveClass(/ff-vt/);
        expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ff-vt-dx'))).toBe('');
        await expect.poll(() => focusedHref(page)).toBe(`/item/${MOVIE.id}/more`);
      });
    });
  });
});
