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
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  test('the list picker never opens half-loaded: its row spins (same width) until the lists are in, then its box holds', async ({ page }) => {
    await page.route('**/api/items/*/lists', async (r) => { await later(800); await r.fallback(); });
    await page.goto(`/item/${MOVIE.id}`);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    const row = pop(page).getByRole('button', { name: /Zu Liste hinzufügen/ });
    const w = (await row.boundingBox())!.width;
    await row.click();
    const lm = page.locator('.lm-pop');
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(row.locator('.spinner')).toBeVisible();
    await expect(lm).toHaveCount(0);
    expect(Math.abs((await row.boundingBox())!.width - w)).toBeLessThanOrEqual(0.5);
    await expect(lm).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-busy', /.*/);
    await expect(lm.getByRole('checkbox')).not.toHaveCount(0);
    const box = await lm.boundingBox();
    await later(400);
    expect(await lm.boundingBox()).toEqual(box);
    // the lists are kept a while: closed and opened again, the picker is there at once
    await page.keyboard.press('Escape');
    await expect(lm).toHaveCount(0);
    await row.click();
    await expect(lm).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-busy', /.*/);
  });

  test('Escape cancels a list picker that waits for its lists (its ⋯ menu stays)', async ({ page }) => {
    await page.route('**/api/items/*/lists', async (r) => { await later(800); await r.fallback(); });
    await page.goto(`/item/${MOVIE.id}`);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    const row = pop(page).getByRole('button', { name: /Zu Liste hinzufügen/ });
    await row.click();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape');
    await expect(row).not.toHaveAttribute('aria-busy', /.*/);
    await later(1000);
    await expect(page.locator('.lm-pop')).toHaveCount(0);
    await expect(pop(page)).toBeVisible();
  });

  test.describe('a failed list load', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('opens the list picker with its error row', async ({ page }) => {
      await page.route('**/api/items/*/lists', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }));
      await page.goto(`/item/${MOVIE.id}`);
      await page.getByRole('button', { name: 'Mehr', exact: true }).click();
      await pop(page).getByRole('button', { name: /Zu Liste hinzufügen/ }).click();
      const lm = page.locator('.lm-pop');
      await expect(lm).toBeVisible();
      await expect(lm.getByRole('alert')).toHaveText('Listen konnten nicht geladen werden.');
    });
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

  test('activating the checked profile row closes the menu and returns the focus to the avatar', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: multiMe }));
    await page.addInitScript(() => sessionStorage.setItem('ff-profile-picked', '1'));
    await page.goto('/watchlist');
    await acctBtn(page).click();
    const menu = acct(page);
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Tester' }).click();
    await expect(menu).toBeHidden();
    await expect(acctBtn(page)).toBeFocused();
  });

  test('account menu by keyboard: End, Home and the arrows move (wrapping), Escape gives the focus back to the avatar', async ({ page }) => {
    await page.goto('/watchlist');
    await acctBtn(page).focus();
    await page.keyboard.press('Enter');
    const menu = acct(page);
    await expect(menu).toBeVisible();
    const items = menu.locator('[role^=menuitem]');
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(acctBtn(page)).toBeFocused();
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

  test('notifications: the bell opens the sheet (a titled dialog), unread rows marked, rows 44 px', async ({ page }) => {
    await page.goto('/watchlist');
    const bell = bar(page).getByRole('button', { name: /Benachrichtigungen/ });
    await expect(bell.locator('.dot')).toHaveText('1');
    await expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    await bell.click();
    const notes = page.locator('#ff-notes');
    await expect(notes).toBeVisible();
    await expect(notes).toHaveAttribute('role', 'dialog');
    await expect(notes.getByRole('heading', { level: 2 })).toHaveText('Benachrichtigungen');
    await expect(bell).toHaveAttribute('aria-expanded', 'true');
    const rows = notes.locator('li.nr > .main');
    await expect(rows.first()).toBeVisible();
    for (const r of (await rows.all()).slice(0, 8)) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    const unread = notes.locator('li.nr.unread');
    expect(await unread.count()).toBeGreaterThan(0);
    for (const r of await unread.all()) {
      const dot = (await r.locator('.tile .udot').boundingBox())!;
      expect(Math.abs(dot.width - 10)).toBeLessThanOrEqual(0.5);
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
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(pop(page)).toBeVisible();
    // the notifications sheet (modal: nothing behind it can be pressed while it is open) closes the ⋯ menu
    await bar(page).getByRole('button', { name: /Benachrichtigungen/ }).click();
    await expect(page.locator('#ff-notes')).toBeVisible();
    await expect(pop(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#ff-notes')).toHaveCount(0);
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(pop(page)).toBeVisible();
    await acctBtn(page).click();
    await expect(acct(page)).toBeVisible();
    await expect(pop(page)).toHaveCount(0);
  });
});

test.describe('Select', () => {
  const role = (page: Page) => page.getByRole('combobox', { name: 'Rolle', exact: true });
  const list = (page: Page) => page.locator('[role=listbox]');
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('a click opens a glass listbox: 44 px options, the current one checked, inside the window', async ({ page }) => {
    await page.goto('/admin/users');
    await expect.poll(() => role(page).locator('option').count()).toBeGreaterThan(3); // the roles have loaded
    await role(page).click();
    const lb = list(page);
    await expect(lb).toBeVisible();
    await expect(lb).toHaveClass(/\bfrost\b/);
    await expect(lb).toBeFocused();
    const opts = lb.locator('[role=option]');
    expect(await opts.count()).toBe(await role(page).locator('option').count());
    for (const o of await opts.all()) expect(Math.abs((await o.boundingBox())!.height - 44)).toBeLessThanOrEqual(0.5);
    await expect(lb.locator('[role=option][aria-selected="true"]')).toHaveCount(1);
    await expect(lb.locator('[role=option][aria-selected="true"]')).toHaveText('Alle Rollen');
    const fit = await boxInViewport(page, lb);
    expect(fit.ok, JSON.stringify(fit)).toBe(true);
    // as wide as the select at least, right under it
    const sb = (await role(page).boundingBox())!;
    expect(fit.box!.width).toBeGreaterThanOrEqual(sb.width - 0.5);
    expect(fit.box!.y).toBeGreaterThanOrEqual(sb.y + sb.height);
    // a second press on the select closes it
    await role(page).click();
    await expect(lb).toHaveCount(0);
  });

  test('keys: Space opens, End and ArrowUp move, Enter picks and fires change', async ({ page, api }) => {
    await page.goto('/admin/users');
    const sel = role(page);
    await expect.poll(() => sel.locator('option').count()).toBeGreaterThan(3); // the roles have loaded
    const values = await sel.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const want = values[values.length - 2]!;
    await sel.focus();
    await page.keyboard.press('Space');
    const lb = list(page);
    await expect(lb).toBeVisible();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await expect(lb.locator(`#${await lb.getAttribute('aria-activedescendant')}`)).toHaveAttribute('data-value', want);
    await page.keyboard.press('Enter');
    await expect(lb).toHaveCount(0);
    await expect(sel).toHaveValue(want);
    await expect(sel).toBeFocused();
    // the filter ran (change): the people with that role are listed, the others are not
    const table = page.getByRole('table', { name: 'Nutzer' });
    const holder = api.admin.users.find((u) => u.role === want)!;
    const other = api.admin.users.find((u) => u.role !== want && u.role !== 'admin')!;
    await expect(table.getByRole('row', { name: new RegExp(holder.name) })).toBeVisible();
    await expect(table.getByRole('row', { name: new RegExp(other.name) })).toHaveCount(0);
  });

  test('near the window\'s bottom it opens upward', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await page.goto('/admin/users');
    const sel = role(page);
    await expect(sel).toBeVisible();
    // room above the filter row so it can sit on the window's bottom edge
    await sel.evaluate((e) => { (e.closest('main') as HTMLElement).style.paddingTop = '900px'; });
    await sel.evaluate((e) => e.scrollIntoView({ block: 'end' }));
    await sel.click();
    const lb = list(page);
    await expect(lb).toBeVisible();
    const fit = await boxInViewport(page, lb);
    expect(fit.ok, JSON.stringify(fit)).toBe(true);
    expect(fit.box!.y + fit.box!.height).toBeLessThanOrEqual((await sel.boundingBox())!.y + 0.5);
  });

  test.describe('in the delete dialog', () => {
    test.use({ allowedConsole: /status of 409/ }); // the role is in use: the server asks where its people go
    test('Escape inside a dialog closes only the listbox', async ({ page, api }) => {
      const extra = api.admin.matrix.roles.find((r) => r.key === 'family')!;
      api.admin.matrix.roles.splice(4, 0, { ...extra, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 2, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...extra.values } });
      await page.goto('/admin/roles');
      await omaMenu(page).click();
      await pop(page).getByRole('button', { name: 'Löschen' }).click();
      const dlg = page.locator('[role=alertdialog]');
      const to = dlg.getByRole('combobox', { name: 'Neue Rolle' });
      await expect(to).toBeVisible();
      await to.click();
      await expect(list(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(list(page)).toHaveCount(0);
      await expect(dlg).toBeVisible();
      await expect(to).toBeFocused();
    });

    test('a press on the backdrop with the list open closes only the list; the next press closes the dialog', async ({ page, api }) => {
      const extra = api.admin.matrix.roles.find((r) => r.key === 'family')!;
      api.admin.matrix.roles.splice(4, 0, { ...extra, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 2, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...extra.values } });
      await page.goto('/admin/roles');
      await omaMenu(page).click();
      await pop(page).getByRole('button', { name: 'Löschen' }).click();
      const dlg = page.locator('[role=alertdialog]');
      const to = dlg.getByRole('combobox', { name: 'Neue Rolle' });
      await expect(to).toBeVisible();
      await to.click();
      await expect(list(page)).toBeVisible();
      await page.mouse.click(6, 450);
      await expect(list(page)).toHaveCount(0);
      await expect(dlg).toBeVisible();
      await page.mouse.click(6, 450);
      await expect(dlg).toHaveCount(0);
    });

    test('Tab and Shift+Tab from the open list stay inside the dialog', async ({ page, api }) => {
      const extra = api.admin.matrix.roles.find((r) => r.key === 'family')!;
      api.admin.matrix.roles.splice(4, 0, { ...extra, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 2, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...extra.values } });
      await page.goto('/admin/roles');
      await omaMenu(page).click();
      await pop(page).getByRole('button', { name: 'Löschen' }).click();
      const dlg = page.locator('[role=alertdialog]');
      const to = dlg.getByRole('combobox', { name: 'Neue Rolle' });
      const inside = () => dlg.evaluate((d) => d.contains(document.activeElement));
      await expect(to).toBeVisible();
      // the select is the dialog's first control: Shift+Tab wraps to its last one (the trap), not out of the dialog
      await to.click();
      await expect(list(page)).toBeVisible();
      await page.keyboard.press('Shift+Tab');
      await expect(list(page)).toHaveCount(0);
      await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
      // the select as the dialog's last (and only) control: Tab and Shift+Tab keep the focus on it
      await dlg.getByRole('button', { name: 'Abbrechen' }).evaluate((b) => { (b as HTMLButtonElement).disabled = true; });
      for (const key of ['Tab', 'Shift+Tab']) {
        await to.click();
        await expect(list(page)).toBeVisible();
        await page.keyboard.press(key);
        await expect(list(page)).toHaveCount(0);
        await expect(to, key).toBeFocused();
        expect(await inside(), key).toBe(true);
      }
    });
  });

  /** the value of the option aria-activedescendant points at */
  const activeValue = (page: Page) => list(page).evaluate((e) => document.getElementById(e.getAttribute('aria-activedescendant') ?? '')?.dataset.value ?? null);

  test('typeahead, Space and a click pick; aria-expanded follows the list', async ({ page, api }) => {
    await page.goto('/admin/users');
    const sel = role(page);
    await expect.poll(() => sel.locator('option').count()).toBeGreaterThan(3); // the roles have loaded
    await expect(sel).toHaveAttribute('aria-expanded', 'false');
    await sel.click();
    await expect(list(page)).toBeVisible();
    await expect(sel).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('g');
    await expect.poll(() => activeValue(page)).toBe('guest');
    await page.waitForTimeout(600); // the typeahead buffer clears after 500 ms: Space picks again (within it, Space types)
    await page.keyboard.press('Space');
    await expect(list(page)).toHaveCount(0);
    await expect(sel).toHaveValue('guest');
    await expect(sel).toBeFocused();
    await expect(sel).toHaveAttribute('aria-expanded', 'false');
    // a word: "fr" finds Freund past Familie; Escape keeps the value
    await page.keyboard.press('Space');
    await expect(list(page)).toBeVisible();
    await page.keyboard.type('fr');
    await expect.poll(() => activeValue(page)).toBe('friend');
    await page.keyboard.press('Escape');
    await expect(sel).toHaveValue('guest');
    // a click on an option picks it and the filter runs
    await sel.click();
    await list(page).getByRole('option', { name: 'Familie', exact: true }).click();
    await expect(list(page)).toHaveCount(0);
    await expect(sel).toHaveValue('family');
    const table = page.getByRole('table', { name: 'Nutzer' });
    const holder = api.admin.users.find((u) => u.role === 'family')!;
    const other = api.admin.users.find((u) => u.role === 'guest')!;
    await expect(table.getByRole('row', { name: new RegExp(holder.name) })).toBeVisible();
    await expect(table.getByRole('row', { name: new RegExp(other.name) })).toHaveCount(0);
  });

  test('disabled options are skipped', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByRole('combobox', { name: 'Recht', exact: true }).selectOption({ index: 1 }); // a right filter: "Wartet auf Freigabe" is off
    const status = page.getByRole('combobox', { name: 'Status', exact: true });
    await status.click();
    const lb = list(page);
    await expect(lb.locator('[role=option][data-value="pending"]')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('End');
    await expect.poll(() => activeValue(page)).toBe('deleting');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => activeValue(page)).toBe('expiring');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => activeValue(page)).toBe('deleting');
    await lb.locator('[role=option][data-value="pending"]').click({ force: true }); // a press on it picks nothing (force: it is aria-disabled)
    await expect(lb).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(status).toHaveValue('deleting');
  });

  test('PageDown / PageUp move a page of options; neither the list nor the page scrolls on its own', async ({ page }) => {
    await page.goto('/admin/users');
    const right = page.getByRole('combobox', { name: 'Recht', exact: true });
    await expect.poll(() => right.locator('option').count()).toBeGreaterThan(12); // the rights have loaded
    const values = await right.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    await right.click();
    const lb = list(page);
    await expect(lb).toBeVisible();
    const rows = await lb.evaluate((e) => Math.floor(e.clientHeight / 44) - 1);
    expect(values.length).toBeGreaterThan(rows + 1); // the list is longer than a page
    const y = await page.evaluate(() => scrollY);
    await page.keyboard.press('PageDown');
    await expect.poll(() => activeValue(page)).toBe(values[rows]);
    await page.keyboard.press('PageDown');
    await expect.poll(() => activeValue(page)).toBe(values[Math.min(2 * rows, values.length - 1)]);
    // the active row is inside the list's box
    const box = (await lb.boundingBox())!;
    const act = (await lb.locator(`[data-value="${values[Math.min(2 * rows, values.length - 1)]}"]`).boundingBox())!;
    expect(act.y).toBeGreaterThanOrEqual(box.y - 0.5);
    expect(act.y + act.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    await page.keyboard.press('End');
    await page.keyboard.press('PageUp');
    await expect.poll(() => activeValue(page)).toBe(values[values.length - 1 - rows]);
    await page.keyboard.press('Home');
    await page.keyboard.press('PageUp'); // clamped at the first
    await expect.poll(() => activeValue(page)).toBe(values[0]);
    await expect(lb).toBeVisible();
    expect(await page.evaluate(() => scrollY)).toBe(y);
  });

  test('a select that becomes disabled closes its list', async ({ page }) => {
    await page.goto('/admin/users');
    const right = page.getByRole('combobox', { name: 'Recht', exact: true });
    await right.click();
    await expect(list(page)).toBeVisible();
    // "Wartet auf Freigabe" turns the right filter off; set without touching focus or the pointer
    await page.getByRole('combobox', { name: 'Status', exact: true }).evaluate((s) => {
      (s as HTMLSelectElement).value = 'pending';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(right).toBeDisabled();
    await expect(list(page)).toHaveCount(0);
  });

  test('selectOption still works and closes an open listbox', async ({ page }) => {
    await page.goto('/admin/users');
    await role(page).click();
    await expect(list(page)).toBeVisible();
    await role(page).selectOption('guest');
    await expect(role(page)).toHaveValue('guest');
    await expect(list(page)).toHaveCount(0);
  });
});

test.describe('toasts', () => {
  test.use({ viewport: { width: 1100, height: 700 } });
  const LONG = 'Dunmoor Part Two Extended Director Cut with all the long placeholder words that keep going on and on and on';

  test('a long toast wraps inside the window with 44 px controls; the message is 15 px / 600', async ({ page, api }) => {
    api.asAdmin = true;
    api.admin.requests.find((r) => r.id === 101)!.title = LONG;
    await page.goto('/admin');
    await page.getByRole('region', { name: 'Wartet auf dich' }).getByRole('button', { name: new RegExp(`„${LONG}“ freigeben`) }).click();
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    await page.waitForTimeout(450); // the rise has settled
    expect((await boxInViewport(page, toast)).ok).toBe(true);
    const x = await page.locator('.toast .x').boundingBox();
    expect(x!.width).toBeCloseTo(44, 0);
    expect(x!.height).toBeCloseTo(44, 0);
    const t = (await toast.boundingBox())!;
    expect(Math.abs(x!.y + x!.height / 2 - (t.y + t.height / 2))).toBeLessThanOrEqual(1);
    expect(t.height).toBeGreaterThan(52); // it wrapped
    const m = await page.locator('.toast .msg').evaluate((e) => { const s = getComputedStyle(e); return { fs: s.fontSize, fw: s.fontWeight, lh: s.lineHeight }; });
    expect(m.fs).toBe('15px');
    expect(m.fw).toBe('600');
    expect(parseFloat(m.lh)).toBeCloseTo(19.5, 1);
    const pad = await toast.evaluate((e) => { const s = getComputedStyle(e); return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft, s.columnGap]; });
    expect(pad).toEqual(['4px', '4px', '4px', '20px', '12px']);
  });
});
