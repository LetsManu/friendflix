// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop menus (menus glass stage 2): the title, card and admin ⋯ menus share one anatomy (a header line, 44 px rows with a
 * 24 px icon column, the removal or deletion last after a divider), place themselves inside the window next to their button,
 * close on a scroll that moves their button, an outside press, a route change and another pop-up, and move with the arrow
 * keys, Home and End. 1440×900, the suite's default (reduced) motion.
 */
import type { Locator, Page } from '@playwright/test';
import { ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { PROFILES } from '../mocks/api.js';
import { expect, test, type MockState } from '../fixtures.js';
import { boxInViewport, openPopout, row } from '../helpers.js';

test.use({ viewport: { width: 1440, height: 900 } });

/** an extra admin-made role "Oma" (it can be deleted: its ⋯ menu ends in a destructive row) */
function addOma(api: MockState) {
  api.asAdmin = true;
  const extra = api.admin.matrix.roles.find((r) => r.key === 'family')!;
  api.admin.matrix.roles.splice(4, 0, { ...extra, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 0, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...extra.values } });
}

const LOOK = ['width', 'height', 'borderTopWidth', 'borderTopColor', 'backgroundColor', 'borderRadius'] as const;
const look = (loc: Locator) => loc.evaluate((e, keys) => {
  const s = getComputedStyle(e) as unknown as Record<string, string>;
  return Object.fromEntries(keys.map((k) => [k, s[k]]));
}, [...LOOK]);
const color = (loc: Locator) => loc.evaluate((e) => getComputedStyle(e).color);
const pop = (page: Page) => page.locator('.ma-pop');
const omaMenu = (page: Page) => page.getByRole('button', { name: 'Aktionen für Oma' });

test.describe('desktop ⋯ menus', () => {
  test('title ⋯ and admin ⋯ look the same', async ({ page, api }) => {
    await page.goto(`/item/${MOVIE.id}`);
    const title = page.locator('.ma.ring').first();
    await expect(title).toBeVisible();
    const a = await look(title);
    addOma(api);
    await page.goto('/admin/roles');
    const b = await look(omaMenu(page));
    expect(b).toEqual(a);
  });

  test('card ⋯ menu: header, 44 px rows, 24 px icon column, the removal last after a divider, one line each', async ({ page }) => {
    await page.goto('/');
    const dpv = await openPopout(page, row(page, 'Weiterschauen').locator('article.card').first());
    await dpv.getByRole('button', { name: /^Mehr Aktionen für / }).click();
    const menu = pop(page);
    await expect(menu).toBeVisible();
    await expect(menu.locator('.gm-head')).toHaveText(SERIES.name);
    const rows = menu.locator('.gm-row');
    expect(await rows.count()).toBeGreaterThan(1);
    for (const r of await rows.all()) expect(Math.abs((await r.boundingBox())!.height - 44)).toBeLessThanOrEqual(0.5);
    const ics = menu.locator('.gm-ic');
    expect(await ics.count()).toBeGreaterThan(1);
    for (const ic of await ics.all()) expect(Math.abs((await ic.boundingBox())!.width - 24)).toBeLessThanOrEqual(0.5);
    const last = menu.locator('ul > li > .gm-row').last();
    await expect(last).toHaveText('Aus Weiterschauen entfernen');
    expect(await last.evaluate((e) => e.parentElement!.previousElementSibling?.classList.contains('gm-sep'))).toBe(true);
  });

  test('admin ⋯ menu: destructive last after a divider; label white, icon light red', async ({ page, api }) => {
    addOma(api);
    await page.goto('/admin/roles');
    await omaMenu(page).click();
    const last = pop(page).locator('ul > li > .gm-row').last();
    await expect(last).toHaveClass(/\bdanger\b/);
    expect(await last.evaluate((e) => e.parentElement!.previousElementSibling?.classList.contains('gm-sep'))).toBe(true);
    await page.mouse.move(2, 890); // not hovering it
    expect(await color(last.locator('span').filter({ hasText: 'Löschen' }))).toBe('rgb(255, 255, 255)');
    expect(await color(last.locator('svg'))).toBe('rgb(255, 157, 157)');
  });

  test('keys: ArrowDown wraps, Home / End, Escape gives the focus back to ⋯', async ({ page, api }) => {
    addOma(api);
    await page.goto('/admin/roles');
    const btn = omaMenu(page);
    await btn.click();
    const rows = pop(page).locator('.gm-row:not([disabled])');
    const n = await rows.count();
    expect(n).toBeGreaterThan(2);
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press('ArrowDown'); // wraps
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('ArrowUp'); // wraps back
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pop(page)).toHaveCount(0);
    await expect(btn).toBeFocused();
  });

  test('stays inside the window near the bottom and right edges', async ({ page, api }) => {
    addOma(api);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto('/admin/roles');
    const last = page.locator('li[data-role]').last();
    await expect(last).toBeVisible();
    await last.evaluate((e) => e.scrollIntoView({ block: 'end' }));
    const btn = last.locator('button.ma');
    await btn.click();
    const menu = pop(page);
    await expect(menu).toBeVisible();
    const fit = await boxInViewport(page, menu);
    expect(fit.ok, JSON.stringify(fit)).toBe(true);
    expect(fit.box!.y + fit.box!.height).toBeLessThanOrEqual((await btn.boundingBox())!.y); // it flipped up

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/item/${MOVIE.id}`);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(menu).toBeVisible();
    const fit2 = await boxInViewport(page, menu);
    expect(fit2.ok, JSON.stringify(fit2)).toBe(true);
  });

  test('a resize keeps the open menu inside the window', async ({ page }) => {
    await page.goto(`/item/${MOVIE.id}`);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(pop(page)).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(pop(page)).toBeVisible();
    await expect.poll(async () => (await boxInViewport(page, pop(page))).ok).toBe(true);
  });

  test('scrolling the page under an admin ⋯ menu closes it; an outside press closes it', async ({ page, api }) => {
    addOma(api);
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.goto('/admin/roles');
    await omaMenu(page).click();
    await expect(pop(page)).toBeVisible();
    await page.mouse.wheel(0, 300);
    await expect(pop(page)).toHaveCount(0);
    await omaMenu(page).click();
    await expect(pop(page)).toBeVisible();
    await page.getByRole('heading', { level: 1 }).click();
    await expect(pop(page)).toHaveCount(0);
  });

  test('one pop-up at a time', async ({ page }) => {
    await page.goto(`/item/${MOVIE.id}`);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(pop(page)).toBeVisible();
    await page.locator('[data-desk-bar]').getByRole('button', { name: /Profilmenü/ }).click();
    await expect(pop(page)).toHaveCount(0);
    await expect(page.getByRole('menu', { name: 'Profilmenü' })).toBeVisible();
  });

  test('the list picker inside a ⋯ menu keeps its parent open', async ({ page }) => {
    await page.goto(`/item/${MOVIE.id}`);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await pop(page).getByRole('button', { name: /Zu Liste hinzufügen/ }).click();
    await expect(page.locator('.lm-pop')).toBeVisible();
    await expect(pop(page)).toBeVisible();
  });

  test('a route change closes the menu', async ({ page }) => {
    // in-app navigation (the page component can stay mounted from one title to the next): title → title, then Back
    await page.goto(`/item/${SERIES.id}`);
    await expect(page.getByRole('button', { name: 'Mehr', exact: true })).toBeVisible();
    await page.evaluate((href) => { const a = document.createElement('a'); a.href = href; a.id = 'e2e-nav'; document.body.appendChild(a); a.click(); }, `/item/${MOVIE.id}`);
    await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(pop(page)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/item/${SERIES.id}$`));
    await expect(pop(page)).toHaveCount(0);
  });
});

test.describe('header menus', () => {
  const bar = (page: Page) => page.locator('[data-desk-bar]');
  const acctBtn = (page: Page) => bar(page).getByRole('button', { name: /Profilmenü/ });
  const acct = (page: Page) => page.getByRole('menu', { name: 'Profilmenü' });
  const multiMe = { ...ME, profileCount: 3, profileChosen: true };
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('account menu: the person in the header, 44 px rows with a 24 px icon column; Abmelden last, with its icon, left-aligned like the rest', async ({ page }) => {
    await page.goto('/watchlist');
    await acctBtn(page).click();
    const menu = acct(page);
    await expect(menu).toBeVisible();
    const head = menu.locator('.acct-who');
    await expect(head).toContainText(ME.profile.name);
    await expect(head).toContainText(`${ME.name} · ${ME.roleLabel}`);
    const rows = menu.locator('.gm-row');
    expect(await rows.count()).toBeGreaterThan(4);
    for (const r of await rows.all()) expect(Math.abs((await r.boundingBox())!.height - 44)).toBeLessThanOrEqual(0.5);
    for (const ic of await menu.locator('.gm-ic').all()) expect(Math.abs((await ic.boundingBox())!.width - 24)).toBeLessThanOrEqual(0.5);
    const out = menu.getByRole('menuitem', { name: 'Von FriendFlix abmelden' });
    await expect(rows.last()).toHaveText('Von FriendFlix abmelden');
    await expect(out.locator('.gm-ic svg')).toHaveCount(1);
    const x = async (name: string) => (await menu.getByRole('menuitem', { name }).locator('.gm-lbl').boundingBox())!.x;
    expect(Math.abs((await x('Von FriendFlix abmelden')) - (await x('Mein Bereich')))).toBeLessThanOrEqual(1);
  });

  test('the profile rows hold their place while they load', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: multiMe }));
    await page.route('**/api/profiles', async (r) => { await later(600); await r.fulfill({ json: { profiles: PROFILES, max: 5, activeId: 'p1' } }); });
    await page.addInitScript(() => sessionStorage.setItem('ff-profile-picked', '1'));
    await page.goto('/watchlist');
    await expect(acctBtn(page)).toBeEnabled();
    await acctBtn(page).click();
    const menu = acct(page);
    await expect(menu).toBeVisible();
    const h = () => menu.evaluate((e) => (e as HTMLElement).offsetHeight);
    const before = await h();
    await expect(menu.locator('.skel')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { name: 'Anna' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Ben' })).toHaveAttribute('aria-checked', 'false');
    await expect(menu.getByRole('menuitemradio', { name: 'Tester' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.locator('.skel')).toHaveCount(0);
    expect(Math.abs((await h()) - before)).toBeLessThanOrEqual(1);
    await expect(menu.locator('.gm-head')).toHaveText('Profil wechseln');
  });

  test.describe('a failed profile list', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('still opens the menu', async ({ page }) => {
      await page.route('**/api/me', (r) => r.fulfill({ json: multiMe }));
      await page.route('**/api/profiles', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }));
      await page.addInitScript(() => sessionStorage.setItem('ff-profile-picked', '1'));
      await page.goto('/watchlist');
      await acctBtn(page).click();
      await expect(acct(page)).toBeVisible();
      await expect(acct(page).locator('.skel')).toHaveCount(0);
      await expect(acctBtn(page)).not.toHaveAttribute('aria-busy', /.*/);
      await expect(acct(page).getByRole('menuitem', { name: 'Mein Bereich' })).toBeVisible();
    });
  });

  test('notifications: a header line, unread rows marked, rows 44 px', async ({ page }) => {
    await page.goto('/watchlist');
    const bell = bar(page).getByRole('button', { name: /Benachrichtigungen/ });
    await expect(bell.locator('.dot')).toHaveText('1');
    await bell.click();
    const notes = page.locator('#ff-notes');
    await expect(notes).toBeVisible();
    await expect(notes.locator('.gm-head')).toHaveText('Benachrichtigungen');
    const rows = notes.locator('.gm-row');
    expect(await rows.count()).toBeGreaterThan(0);
    for (const r of await rows.all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    const unread = notes.locator('.gm-row.unread');
    expect(await unread.count()).toBeGreaterThan(0);
    for (const r of await unread.all()) {
      const dot = (await r.locator('.gm-ic .ndot').boundingBox())!;
      expect(Math.abs(dot.width - 8)).toBeLessThanOrEqual(0.5);
    }
  });

  test('Categories never opens half-loaded', async ({ page }) => {
    await page.route('**/api/library/genres', async (r) => { await later(500); await r.fulfill({ json: { genres: ['Action', 'Drama'] } }); });
    await page.goto('/watchlist');
    const btn = bar(page).locator('.pill').getByRole('button', { name: 'Kategorien' });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#ff-cats')).toHaveCount(0);
    const cats = page.locator('#ff-cats');
    await expect(cats).toBeVisible();
    await expect(cats.getByRole('link', { name: 'Drama' })).toBeVisible();
    await expect(cats.locator('[role=status]')).toHaveCount(0);
    await expect(btn).not.toHaveAttribute('aria-busy', /.*/);
  });

  test('Categories stays inside the window at 1100 and 900 px', async ({ page }) => {
    for (const width of [1100, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/watchlist');
      await bar(page).locator('.pill').getByRole('button', { name: 'Kategorien' }).click();
      const cats = page.locator('#ff-cats');
      await expect(cats.getByRole('link', { name: 'Drama' })).toBeVisible();
      await expect.poll(async () => JSON.stringify(await boxInViewport(page, cats))).toContain('"ok":true');
    }
  });

  test('one pop-up at a time across the bar', async ({ page }) => {
    await page.goto(`/item/${MOVIE.id}`);
    await bar(page).getByRole('button', { name: /Benachrichtigungen/ }).click();
    await expect(page.locator('#ff-notes')).toBeVisible();
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(pop(page)).toBeVisible();
    await expect(page.locator('#ff-notes')).toHaveCount(0);
    await acctBtn(page).click();
    await expect(acct(page)).toBeVisible();
    await expect(pop(page)).toHaveCount(0);
  });
});
