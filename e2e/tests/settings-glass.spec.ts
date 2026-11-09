// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { APP_UA, fakeNativeApp } from '../mocks/native.js';

/**
 * Glass settings, /me and secondary pages (glass spec §6): the sections are glass cards over the still ambient background, a
 * sticky side navigation marks the section in view with the sliding light pill, the checkbox rows are coral switches, Save
 * draws its checkmark, and calm mode turns the glass solid at once.
 */

const css = (loc: Locator, prop: string, pseudo: string | null = null) =>
  loc.evaluate((e, [p, ps]) => getComputedStyle(e, ps).getPropertyValue(p!), [prop, pseudo] as const);

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
/** PUT /api/prefs answers with what was sent; the last body is kept */
async function echoPrefs(page: Page) {
  const sent: { body: Record<string, unknown> | null } = { body: null };
  await page.route('**/api/prefs', (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    sent.body = JSON.parse(r.request().postData() ?? '{}');
    return r.fulfill({ json: { prefs: sent.body } });
  });
  return sent;
}

test.describe('glass settings side navigation (desktop, in the app)', () => {
  test.use({ userAgent: APP_UA }); // inside the Android app the app section is rendered too: all six sections
  test.beforeEach(({ page }) => fullMotion(page));

  test('sections are glass cards on an ambient background; side nav marks the section in view', async ({ page }) => {
    await fakeNativeApp(page);
    await page.goto('/settings');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    await expect(page.locator('.frost-amb')).toBeAttached();
    const lang = page.locator('#language.panel');
    expect(await css(lang, 'border-top-left-radius')).toBe('24px');
    expect(await css(lang, 'background-image')).toContain('linear-gradient');
    expect(await css(lang, 'padding')).toBe('22px 24px');

    const nav = page.getByRole('navigation', { name: 'Einstellungsbereiche' });
    await expect(nav).toHaveClass(/(^|\s)snav(\s|$)/);
    await expect(nav).toHaveClass(/frost-flat/);
    expect(await css(nav, 'backdrop-filter')).toBe('none'); // a static card: the glass look without blur
    expect(await css(nav, 'position')).toBe('sticky');
    const links = nav.getByRole('link');
    await expect(links).toHaveText(['Sprache', 'App auf diesem Gerät', 'Wiedergabe-Einstellungen', 'Empfehlungen', 'Intro', 'Benachrichtigungen']);
    expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(['#language', '#app', '#prefs', '#reco', '#intro', '#push']);
    for (const box of await links.evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await expect(links.first()).toHaveAttribute('aria-current', 'location');

    const mid = nav.locator('.sp .m');
    await expect(nav.locator('.sp')).toHaveClass(/ready/);
    const y0 = (await mid.boundingBox())!.y;
    await page.locator('#push').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    const push = nav.getByRole('link', { name: 'Benachrichtigungen' });
    await expect(push).toHaveAttribute('aria-current', 'location');
    await expect(nav.locator('[aria-current]')).toHaveCount(1);
    // the pill glides there (a transform; the nav is sticky, so its box stays put)
    await expect.poll(async () => (await mid.boundingBox())!.y).toBeGreaterThan(y0 + 150);
    await expect.poll(async () => Math.abs((await mid.boundingBox())!.y - (await push.boundingBox())!.y)).toBeLessThan(1.5);

    // a click scrolls to the section (smoothly) and marks it
    await nav.getByRole('link', { name: 'Empfehlungen' }).click();
    await expect(nav.getByRole('link', { name: 'Empfehlungen' })).toHaveAttribute('aria-current', 'location');
    await expect.poll(() => page.locator('#reco').evaluate((e) => Math.round(e.getBoundingClientRect().top))).toBeLessThan(140);
  });
});

test.describe('glass settings (desktop)', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('switches: real checkboxes styled as coral switches', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('switch')).not.toHaveCount(0);
    expect(await page.getByRole('switch').count()).toBeGreaterThanOrEqual(10);
    const auto = page.getByLabel('Nächste Folge automatisch starten');
    await expect(auto).toHaveAttribute('type', 'checkbox');
    const track = page.locator('.sw-row', { has: auto }).locator('.sw-tr');
    const knob = track.locator('i');
    const was = await auto.isChecked();
    await auto.click();
    await expect(auto).toBeChecked({ checked: !was });
    if (was) await auto.click();
    await expect(auto).toBeChecked();
    expect(await css(track, 'background-color')).toBe('rgb(255, 79, 109)');
    expect(await css(track, 'width')).toBe('46px');
    expect(await css(track, 'height')).toBe('28px');
    await expect.poll(() => css(knob, 'transform')).toBe('matrix(1, 0, 0, 1, 18, 0)');
    expect(await css(knob, 'transition-timing-function')).toBe('cubic-bezier(0.34, 1.56, 0.64, 1)');
    await auto.click();
    await expect(auto).not.toBeChecked();
    expect(await css(track, 'background-color')).not.toBe('rgb(255, 79, 109)');
    // keyboard: Space toggles, the focus ring is on the track
    await auto.focus();
    await page.keyboard.press('Space');
    await expect(auto).toBeChecked();
    expect(await css(track, 'outline-style')).toBe('solid');
  });

  test('save draws the checkmark, then returns', async ({ page }) => {
    const sent = await echoPrefs(page);
    await page.goto('/settings');
    const save = page.locator('#prefs').getByRole('button', { name: 'Speichern', exact: true });
    await save.click();
    await expect.poll(() => sent.body).not.toBeNull();
    const done = page.locator('#prefs button[type="submit"]');
    await expect(done).toContainText('Gespeichert');
    const path = done.locator('svg.chk path');
    await expect(path).toHaveAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    expect(await path.evaluate((e) => e.getAnimations().map((a) => a.effect!.getTiming().duration))).toEqual([420]);
    await expect(page.locator('#prefs [role="status"]')).toHaveText('Gespeichert');
    await page.waitForTimeout(2300);
    await expect(done).toHaveText('Speichern');
    await expect(done.locator('svg.chk')).toHaveCount(0);
  });

  test('turning calm mode on makes glass solid at once', async ({ page }) => {
    await echoPrefs(page);
    await page.goto('/settings');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    await page.evaluate(() => { (window as unknown as { __ff: number }).__ff = 1; });
    const nav = page.locator('.snav');
    expect(await css(nav, 'background-image')).toContain('linear-gradient');
    await page.getByLabel('Ruhiger Modus').check();
    await page.locator('#prefs').getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)m-glass(\s|$)/);
    expect(await css(nav, 'backdrop-filter')).toBe('none');
    expect(await css(nav, 'background-image')).toBe('none');
    expect(await css(nav, 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await css(page.locator('#language'), 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await page.evaluate(() => (window as unknown as { __ff?: number }).__ff)).toBe(1); // no reload
  });
});

test.describe('glass /me and secondary pages (desktop)', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('/me: tiles and lists are glass', async ({ page }) => {
    await page.goto('/me');
    await expect(page.locator('.frost-amb')).toBeAttached();
    const tiles = page.getByRole('list', { name: 'Schnellzugriff' }).getByRole('link');
    await expect(tiles.first()).toBeVisible();
    for (const tile of await tiles.all()) {
      await expect(tile).toHaveClass(/frost-flat/);
      expect(await css(tile, 'border-top-left-radius')).toBe('18px');
      expect(await css(tile, 'background-image')).toContain('linear-gradient');
    }
    const lists = page.locator('.groups ul.lst');
    await expect(lists.first()).toBeVisible();
    for (const l of await lists.all()) await expect(l).toHaveClass(/frost-flat/);
    // a row on hover: 12 px corners, a darker fill
    const row = lists.first().getByRole('link').first();
    expect(await css(row, 'border-top-left-radius')).toBe('12px');
    await row.hover();
    await expect.poll(() => css(row, 'background-color')).toBe('rgba(18, 16, 24, 0.3)');
    // dim text on glass is white at .9 (AA over the brightest glow)
    expect(await css(page.locator('.gh').first(), 'color')).toBe('rgba(255, 255, 255, 0.9)');
  });

  test('admin-free secondary page (/devices) has the ambient layer; the home page does not', async ({ page }) => {
    await page.goto('/devices');
    await expect(page.locator('.frost-amb')).toBeAttached();
    await expect(page.locator('html')).toHaveClass(/(^|\s)amb(\s|$)/);
    expect(await css(page.locator('.frost-amb'), 'position')).toBe('fixed');
    expect(await css(page.locator('.frost-amb'), 'z-index')).toBe('-1');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Weiterschauen' })).toBeVisible();
    await expect(page.locator('.frost-amb')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)amb(\s|$)/);
  });
});
