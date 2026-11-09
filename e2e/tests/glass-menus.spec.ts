// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';

/**
 * Glass menus and toasts (glass spec §5, §8.3, §8.5): every menu is a glass card that grows out of its button (380 ms spring) and
 * folds back into it (200 ms), reversing mid-flight; the selected row is a light pill. Toasts are glass pills at the bottom centre
 * with a status dot, the action and a 5 s countdown ring that pauses on hover. Calm mode: at once; TV and kids: solid.
 */

const BECAUSE = 'Weil du „Inkwell“ gesehen hast';

/** full motion without the brand intro over the page, no trailers; a frame guard no test host trips */
async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
}
async function calmMode(page: Page) {
  await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
  await page.addInitScript(() => localStorage.setItem('ff_calm:p1', '1'));
}

type Anim = { duration: number; origin: string; play: string };
/** waits frame by frame (in the page) for the element's first animation that has a duration, and reports it */
const anim = (loc: Locator): Promise<Anim> => loc.evaluate((e) => new Promise<Anim>((res, rej) => {
  const t0 = performance.now();
  const step = () => {
    const a = e.getAnimations().find((x) => Number(x.effect?.getTiming().duration) > 0);
    if (a) { res({ duration: Number(a.effect!.getTiming().duration), origin: getComputedStyle(e).transformOrigin, play: a.playState }); return; }
    if (performance.now() - t0 > 2000) { rej(new Error('no animation')); return; }
    requestAnimationFrame(step);
  };
  step();
}));
/** no animation left on the element */
const settled = (loc: Locator) => expect.poll(() => loc.evaluate((e) => e.getAnimations().length)).toBe(0);
const css = (loc: Locator, prop: string) => loc.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

async function hoverCard(page: Page): Promise<Locator> {
  await page.goto('/');
  const card = row(page, BECAUSE).locator('article.card').nth(1);
  await card.scrollIntoViewIfNeeded();
  await card.locator('a.thumb').hover();
  const dpv = page.locator('.dpv.ready');
  await expect(dpv).toBeVisible();
  await settled(dpv);
  return dpv;
}

/** the menu is a glass card that grows out of its trigger: the spring's 380 ms and a transform-origin inside the trigger's extent */
async function expectGrows(menu: Locator, trigger: Locator) {
  const a = await anim(menu);
  expect(a.duration).toBe(380);
  await expect(menu).toHaveClass(/\bfrost-menu\b/);
  expect(await css(menu, 'border-top-left-radius')).toBe('20px');
  expect(await css(menu, 'backdrop-filter')).toContain('blur(38px)');
  await settled(menu);
  const box = (await menu.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left }; }));
  const t = (await trigger.boundingBox())!;
  const ox = box.left + parseFloat(a.origin.split(' ')[0]!);
  expect(ox).toBeGreaterThanOrEqual(t.x - 0.5);
  expect(ox).toBeLessThanOrEqual(t.x + t.width + 0.5);
}

test.describe('glass menus', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('profile, bell, categories and ⋯ menus are glass cards that grow from their button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    const bar = page.locator('[data-desk-bar]');

    const acct = bar.getByRole('button', { name: /Profilmenü/ });
    await acct.click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    await expectGrows(menu, acct);
    await expect(menu.getByRole('menuitem').first()).toBeFocused(); // the focus moves into the menu
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(acct).toBeFocused(); // and back to its button

    const bell = bar.getByRole('button', { name: /Benachrichtigungen/ });
    await bell.click();
    const notes = bar.locator('.drop.wide');
    await expectGrows(notes, bell);
    await page.keyboard.press('Escape');
    await expect(notes).toHaveCount(0);
    await expect(bell).toBeFocused();

    const catBtn = bar.locator('.pill').getByRole('button', { name: 'Kategorien' });
    await catBtn.click();
    const cats = page.getByRole('region', { name: 'Kategorien' });
    await expectGrows(cats, catBtn);
    await page.mouse.click(1200, 700); // a click outside closes it
    await expect(cats).toHaveCount(0);

    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    const pop = page.locator('.ma-pop');
    await expectGrows(pop, more);
    await expect(pop).toHaveClass(/\bfrost-safe\b/); // artwork can sit behind it
  });

  test('closing reverses (200 ms) and leaves nothing behind', async ({ page }) => {
    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    const pop = page.locator('.ma-pop');
    await settled(pop);
    const r = (await pop.boundingBox())!;
    await page.keyboard.press('Escape');
    expect(await pop.count()).toBe(1); // still there: it folds back
    expect((await anim(pop)).duration).toBe(200);
    await expect(more).toBeFocused();
    await page.waitForTimeout(400);
    await expect(pop).toHaveCount(0);
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.ma-pop'), [r.x + r.width / 2, r.y + r.height / 2])).toBe(false);
  });

  test('toggle fast: open, close mid-open, open again — ends open with one popover', async ({ page }) => {
    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    await more.click();
    await more.click();
    const pop = page.locator('.ma-pop');
    await expect(pop).toHaveCount(1);
    await settled(pop);
    await expect(pop).toHaveCount(1);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await css(pop, 'opacity')).toBe('1');
    expect(await css(pop, 'transform')).toBe('none');
  });

  test('selected row is a light pill', async ({ page }) => {
    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    const pop = page.locator('.ma-pop');
    await pop.getByRole('button', { name: 'Als Favorit markieren' }).click(); // a toggle: now pressed
    await expect(pop).toHaveCount(0);
    await more.click();
    const on = pop.locator('.mi[aria-pressed="true"]');
    await expect(on).toHaveCount(1);
    await settled(pop);
    await page.mouse.move(2, 400); // not hovering it
    expect(await css(on, 'background-color')).toBe('rgba(255, 255, 255, 0.13)');
    expect(await css(on, 'border-top-left-radius')).toBe('12px');
    expect((await on.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test('toast: a glass pill bottom centre with a status dot, Undo and a 5 s ring that pauses on hover', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    const row = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
    await row.getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    const toast = page.locator('.toast.frost');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveClass(/\bfrost-pill\b/);
    await settled(toast);
    const b = (await toast.boundingBox())!;
    expect(Math.abs(b.x + b.width / 2 - 640)).toBeLessThanOrEqual(2);
    expect(800 - (b.y + b.height)).toBeGreaterThanOrEqual(34); // 36 px from the bottom
    await expect(toast.locator('.dot.success')).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Rückgängig' })).toBeVisible();
    const fg = toast.locator('.ring .fg');
    const ring = await anim(fg);
    expect(Math.abs(ring.duration - 5000)).toBeLessThanOrEqual(100); // the time left when it started (≈ 5 s)
    await toast.locator('.msg').hover();
    await expect.poll(() => fg.evaluate((e) => e.getAnimations()[0]?.playState)).toBe('paused');
    await page.mouse.move(640, 300);
    await expect.poll(() => fg.evaluate((e) => e.getAnimations()[0]?.playState)).toBe('running');
  });

  test('toast rises in and slides out; calm is instant', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    const ignore = async () => {
      const r = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
      await r.getByRole('button', { name: /Aktionen/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    };
    await ignore();
    const toast = page.locator('.toast.frost');
    expect((await anim(toast)).duration).toBe(420);
    await settled(toast);
    await toast.getByRole('button', { name: 'Hinweis schließen' }).click();
    expect(await toast.count()).toBe(1); // it slides out
    expect((await anim(toast)).duration).toBe(260);
    await expect(toast).toHaveCount(0);
  });

  test('calm mode: menus and toasts appear and go at once, solid', async ({ page, api }) => {
    await calmMode(page);
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    await expect(page.locator('html')).toHaveClass(/m-still/);
    const r = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
    await r.getByRole('button', { name: /Aktionen/ }).click();
    const pop = page.locator('.ma-pop');
    await expect(pop).toBeVisible();
    expect(await pop.evaluate((e) => e.getAnimations().length)).toBe(0);
    expect(await css(pop, 'backdrop-filter')).toBe('none');
    expect(await css(pop, 'background-color')).toBe('rgb(28, 26, 33)');
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    const toast = page.locator('.toast.frost');
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((e) => e.getAnimations().length)).toBe(0);
    expect(await toast.locator('.ring .fg').evaluate((e) => e.getAnimations().length)).toBe(0); // the ring shows full
    await toast.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect(toast).toHaveCount(0, { timeout: 150 });
  });

  test('TV and kids: menus solid', async ({ page }) => {
    // TV: a card's actions (OK held) are a solid glass-shaped dialog that appears at once
    await page.goto('/?tv=1');
    const thumb = page.locator('.card .thumb').first();
    await expect(thumb).toBeVisible();
    await thumb.focus();
    await page.keyboard.down('Enter'); await page.waitForTimeout(800); await page.keyboard.up('Enter');
    const sheet = page.locator('.sheet.tvsheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveClass(/\bfrost\b/);
    expect(await css(sheet, 'backdrop-filter')).toBe('none');
    expect(await css(sheet, 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await sheet.evaluate((e) => e.getAnimations().length)).toBe(0);

    // kids: a shared menu surface keeps the solid fallback with the new shape
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } } }));
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await page.goto('/kids');
    await expect(page.locator('html')).toHaveClass(/(^|\s)kids(\s|$)/);
    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'km'; d.className = 'frost frost-menu frost-safe'; d.style.cssText = 'position:fixed;left:10px;top:100px;width:200px;height:100px'; document.body.appendChild(d); });
    const km = page.locator('#km');
    expect(await css(km, 'backdrop-filter')).toBe('none');
    expect(await css(km, 'border-top-left-radius')).toBe('20px');
  });
});
