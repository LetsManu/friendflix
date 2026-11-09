// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures.js';

/**
 * The dense glass admin (glass spec §7): the sidebar is a glass panel with the sliding light pill on the current page, the
 * overview's numbers count up the first time they are seen (instant in calm mode), units never count, Save draws its
 * checkmark, and tables, cards and tiles are dense (rows ≥ 40 px, 16 px corners).
 */

const css = (loc: Locator, prop: string, pseudo: string | null = null) =>
  loc.evaluate((e, [p, ps]) => getComputedStyle(e, ps).getPropertyValue(p!), [prop, pseudo] as const);

async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    sessionStorage.setItem('ff-profile-picked', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
}
/** holds GET /api/admin/summary until release() (then the mocked backend answers) */
async function holdSummary(page: Page) {
  const held: Route[] = [];
  let open = false;
  await page.route('**/api/admin/summary', (r) => (open ? r.fallback() : void held.push(r)));
  return { release: async () => { open = true; for (const r of held.splice(0)) await r.fallback(); } };
}
const num = (s: string | null) => Number((s ?? '').replace(/\D/g, ''));

test.describe('dense glass admin (desktop)', () => {
  test.use({ allowedConsole: /status of 500/ });
  test.beforeEach(async ({ page, api }) => { api.asAdmin = true; await fullMotion(page); });

  test('sidebar is a glass panel with a sliding pill on the current page', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    const side = page.locator('.adm .side');
    await expect(side).toHaveClass(/frost-flat/);
    expect(await css(side, 'border-top-left-radius')).toBe('24px');
    expect(await css(side, 'background-image')).toContain('linear-gradient');
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    const overview = nav.getByRole('link', { name: /Übersicht/ });
    await expect(overview).toHaveAttribute('aria-current', 'page');
    // no coral bar any more: the pill marks the page
    expect(await css(overview, 'content', '::before')).toBe('none');
    const mid = side.locator('.sp .m');
    await expect(side.locator('.sp')).toHaveClass(/ready/);
    const t0 = await css(mid, 'transform');
    const y0 = (await mid.boundingBox())!.y;
    expect(Math.abs(y0 - (await overview.boundingBox())!.y)).toBeLessThan(1.5);

    await nav.getByRole('link', { name: 'Nutzer' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    const users = nav.getByRole('link', { name: 'Nutzer' });
    await expect(users).toHaveAttribute('aria-current', 'page');
    expect(await css(users, 'content', '::before')).toBe('none');
    await expect.poll(() => css(mid, 'transform')).not.toBe(t0);
    // it glides there (a transform over 450 ms) and lands on the entry
    await expect.poll(async () => Math.abs((await mid.boundingBox())!.y - (await users.boundingBox())!.y)).toBeLessThan(1.5);
    // links white .75, the current one white
    expect(await css(users, 'color')).toBe('rgb(255, 255, 255)');
    expect(await css(nav.getByRole('link', { name: /Audit-Log/ }), 'color')).toBe('rgba(255, 255, 255, 0.75)');
  });

  test('overview numbers count up on first view (1.1 s), instant in calm', async ({ page }) => {
    const hold = await holdSummary(page);
    await page.clock.install();
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    const tile = page.locator('.stats .tile').first();
    await tile.scrollIntoViewIfNeeded();
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 100);
    await hold.release();
    const val = tile.locator('.val');
    await expect(val).toHaveText('0');
    // the final value is read out meanwhile; the moving figures are hidden from assistive tech
    const finalText = (await tile.locator('.sr-only').textContent())!;
    const final = num(finalText);
    expect(final).toBeGreaterThan(1);
    await expect(val).toHaveAttribute('aria-hidden', 'true');
    // tabular figures in a box as wide as the final value: the tile does not move while it counts
    expect(await css(val, 'font-variant-numeric')).toBe('tabular-nums');
    expect(await css(val, 'min-width')).not.toBe('0px');
    // the figures' box keeps the final value's width and the label below does not move
    const w0 = (await val.boundingBox())!.width;
    const lx0 = (await tile.locator('.lbl').boundingBox())!.x;
    await page.clock.runFor(550);
    const mid = num(await val.textContent());
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(final);
    expect((await val.boundingBox())!.width).toBe(w0);
    expect((await tile.locator('.lbl').boundingBox())!.x).toBe(lx0);
    await page.clock.runFor(650);
    await expect(val).toHaveText(finalText);
    await expect(val).not.toHaveAttribute('aria-hidden', 'true');
    await expect(tile.locator('.sr-only')).toHaveCount(0);
  });

  test('calm mode: the final value at once', async ({ page }) => {
    await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
    const hold = await holdSummary(page);
    await page.clock.install();
    await page.goto('/admin');
    await expect(page.locator('html')).toHaveClass(/(^|\s)calm(\s|$)/);
    const tile = page.locator('.stats .tile').first();
    await tile.scrollIntoViewIfNeeded();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await hold.release();
    const val = tile.locator('.val');
    await expect(val).not.toHaveText('');
    expect(num(await val.textContent())).toBeGreaterThan(1);
    await expect(tile.locator('.sr-only')).toHaveCount(0);
  });

  test('non-numeric values do not count', async ({ page }) => {
    await page.clock.install();
    await page.goto('/admin/previews');
    const size = page.locator('.tile', { hasText: 'Größe' });
    await expect(size.locator('.val')).toHaveText(/\d.*B$/);
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    // a size ('3 GB') is shown as it is, never from 0
    const text = await size.locator('.val').textContent();
    expect(text).toMatch(/[A-Za-z]/);
    await expect(size.locator('.sr-only')).toHaveCount(0);
    await page.clock.runFor(1200);
    await expect(size.locator('.val')).toHaveText(text!);
  });

  test('save draws the checkmark', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const card = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Downloads', exact: true }) });
    await page.getByRole('group', { name: 'Downloads pro Stunde', exact: true }).getByRole('spinbutton').fill('7');
    await card.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts).toEqual([{ values: { DOWNLOAD_CREATE_PER_HOUR: 7 } }]);
    const btn = card.locator('button[type="submit"]');
    await expect(btn).toContainText('Gespeichert');
    await expect(btn.locator('svg.chk path')).toHaveAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    // the fill switches at once (no colour transition): white straight away
    await expect.poll(() => css(btn, 'background-color')).toBe('rgb(255, 255, 255)');
    expect(await css(btn, 'transition-property')).not.toMatch(/background|color/);
    await page.waitForTimeout(2400);
    await expect(btn).toHaveText('Speichern');
    await expect(btn).toBeDisabled();
  });

  test('dense rows: table rows ≥ 40 px, cards 16 px radius', async ({ page }) => {
    await page.goto('/admin/users');
    const table = page.getByRole('table').first();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await expect(table).toHaveClass(/frost-flat/);
    for (const h of await table.locator('tbody tr').evaluateAll((rs) => rs.map((r) => r.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(40);
    // status pills: every one carries a text (the "you" pill drops its icon on purpose, icon=""), the state pills an icon
    // too; the tone sits over a dark fill
    const pills = table.locator('.pill');
    for (const t of await pills.allTextContents()) expect(t.trim()).not.toBe('');
    const withIcon = table.locator('.pill:has(svg)');
    await expect(withIcon.first()).toBeVisible();
    expect(await css(withIcon.first(), 'background-image')).toContain('linear-gradient');

    await page.goto('/admin/settings');
    const card = page.locator('.adm .panel').first();
    await expect(card).toBeVisible();
    expect(await css(card, 'border-top-left-radius')).toBe('16px');
    expect(await css(card, 'padding')).toBe('16px 18px');
    expect(await css(card, 'background-image')).toContain('linear-gradient');
    // fields: 12 px corners on the darker glass fill
    const input = card.locator('input:not([type="checkbox"]):not([disabled])').first();
    if (await input.count()) expect(await css(input, 'border-top-left-radius')).toBe('12px');

    await page.goto('/admin');
    const tile = page.locator('.stats .tile').first();
    await expect(tile).toHaveClass(/frost-flat/);
    expect(await css(tile, 'border-top-left-radius')).toBe('16px');
  });
});
