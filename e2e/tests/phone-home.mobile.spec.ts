// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { items, type MockItem } from '../mocks/fixtures.js';

/** Phone browse block 3, home: the swipe carousel at the top (spec §2). */
const HERO = items[0]!; // Inkwell (movie)
const FRESH = items[9]!; // Dahlia (series), labelled "Neue Staffel"
const RECS = [items[1]!, items[2]!, FRESH, items[8]!, items[10]!, items[11]!];
/** hero first, then the fresh-labelled title, then the rest in row order (capped at 5) */
const ORDER = [HERO, FRESH, items[1]!, items[2]!, items[8]!];

async function mockHome(page: Page, o: { hero: MockItem | null; recs: MockItem[]; latest?: MockItem[] }) {
  await page.route('**/api/home', (r) => r.fulfill({ json: {
    parts: {
      hero: o.hero, resume: [], nextup: [], leaving: [],
      recs: { items: o.recs, recIds: [], friends: [] }, because: { because: null, items: [], more: [] }, hubs: [], themed: [],
    },
    failed: [],
  } }));
  // the newest titles (idle row): the second candidate list
  await page.route((u) => u.pathname === '/api/library/items', (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get('sort') === 'DateCreated') return r.fulfill({ json: { items: o.latest ?? [], total: (o.latest ?? []).length } });
    return r.fallback();
  });
  await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: { [FRESH.id]: { fresh: 'newSeason' } } } }));
}

const carousel = (page: Page) => page.getByRole('region', { name: 'Top-Tipps für dich' });
const slide = (c: Locator, n: number, m = 5) => c.getByRole('group', { name: `${n} von ${m}` });
const live = (c: Locator) => c.locator('[aria-live="polite"]');
const centreX = async (l: Locator) => { const b = (await l.boundingBox())!; return b.x + b.width / 2; };

/** a mouse drag on the track, `dx` px sideways; `slow` pauses before letting go (no flick) */
async function drag(page: Page, track: Locator, dx: number, slow = false) {
  const b = (await track.boundingBox())!;
  const x = 195, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x + (dx * i) / 6, y);
    if (slow) await page.waitForTimeout(30);
  }
  if (slow) await page.waitForTimeout(200);
  await page.mouse.up();
}

/** a real touch swipe (Playwright's touchscreen only taps): start, a few moves, end */
async function touchSwipe(page: Page, x: number, fromY: number, toY: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (y: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(fromY) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(fromY + ((toY - fromY) * i) / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('phone home carousel', () => {
  test('five slides, hero first, the fresh title second with its label; dots and buttons follow a swipe', async ({ page }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(c).toBeVisible();
    await expect(c).toHaveAttribute('aria-roledescription', 'carousel');
    const slides = c.getByRole('group');
    await expect(slides).toHaveCount(5);
    await expect(slides.first()).toHaveAttribute('aria-roledescription', 'slide');
    // the badge answer moves the labelled title up to second place
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');
    for (const [i, it] of ORDER.entries()) await expect(slide(c, i + 1).getByRole('link')).toHaveAccessibleName(`${it.name}, Vorschau öffnen`);
    await expect(live(c)).toHaveText(HERO.name);
    const dots = c.locator('.dots i');
    await expect(dots).toHaveCount(5);
    await expect(dots.nth(0)).toHaveClass(/\bon\b/);
    const play = c.getByRole('link', { name: 'Abspielen' });
    await expect(play).toHaveAttribute('href', `/watch/${HERO.id}`);
    // the centred card is ~70 % of the width, in the middle
    const first = slide(c, 1);
    expect(Math.round(await centreX(first))).toBe(195);
    expect(Math.round((await first.boundingBox())!.width)).toBe(Math.round(390 * 0.7));

    // drag left 120 px: the second card comes to the middle
    await drag(page, c.locator('.track'), -120);
    await expect(live(c)).toHaveText(FRESH.name);
    await expect(dots.nth(1)).toHaveClass(/\bon\b/);
    await expect(dots.nth(0)).not.toHaveClass(/\bon\b/);
    await expect.poll(async () => Math.round(await centreX(slide(c, 2)))).toBe(195);
    // the buttons act on the centred card (a series: its page)
    await expect(play).toHaveAttribute('href', `/item/${FRESH.id}`);
    await expect(page.getByRole('dialog')).toHaveCount(0); // the drag did not open the sheet

    // a short drag springs back to the same card
    await drag(page, c.locator('.track'), -20, true);
    await expect(live(c)).toHaveText(FRESH.name);
    await expect.poll(async () => Math.round(await centreX(slide(c, 2)))).toBe(195);
    await expect(dots.nth(1)).toHaveClass(/\bon\b/);

    // drag right: back to the first card
    await drag(page, c.locator('.track'), 120);
    await expect(live(c)).toHaveText(HERO.name);
    await expect(play).toHaveAttribute('href', `/watch/${HERO.id}`);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('a vertical swipe on the carousel scrolls the page and keeps the slide', async ({ page }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');
    const b = (await c.locator('.track').boundingBox())!;
    await touchSwipe(page, 195, b.y + b.height - 20, b.y + b.height - 320);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await expect(live(c)).toHaveText(HERO.name);
    await expect(c.locator('.dots i').nth(0)).toHaveClass(/\bon\b/);
  });

  test('a touch swipe sideways moves one card', async ({ page }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');
    const b = (await c.locator('.track').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const y = b.y + b.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300 - i * 18, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(live(c)).toHaveText(FRESH.name);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('tap: the centred card opens the preview sheet, a side card comes to the middle; arrow keys move', async ({ page }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');

    // the side card peeks at the right edge: a tap centres it, no sheet
    await slide(c, 2).getByRole('link').tap({ position: { x: 20, y: 120 } });
    await expect(live(c)).toHaveText(FRESH.name);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => Math.round(await centreX(slide(c, 2)))).toBe(195);

    await slide(c, 2).getByRole('link').tap();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 2, name: FRESH.name })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await sheet.getByRole('button', { name: 'Schließen' }).tap();
    await expect(sheet).toBeHidden();

    // keyboard: the centred card is the one tab stop; arrows move and focus follows
    await expect(slide(c, 2).getByRole('link')).toHaveAttribute('tabindex', '0');
    await expect(slide(c, 1).getByRole('link')).toHaveAttribute('tabindex', '-1');
    await slide(c, 2).getByRole('link').focus();
    await page.keyboard.press('ArrowRight');
    await expect(live(c)).toHaveText(items[1]!.name);
    await expect(slide(c, 3).getByRole('link')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(live(c)).toHaveText(HERO.name);
    await expect(slide(c, 1).getByRole('link')).toBeFocused();
  });

  test('My list acts on the centred card', async ({ page, api }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');
    await drag(page, c.locator('.track'), -120);
    await expect(live(c)).toHaveText(FRESH.name);
    const list = c.getByRole('button', { name: 'Merkliste' });
    await expect(list).toHaveAttribute('aria-pressed', 'false');
    await list.tap();
    await expect(list).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => api.log.some((l) => l.includes(FRESH.id))).toBe(true);
  });

  test('one candidate: a single card without dots', async ({ page }) => {
    await mockHome(page, { hero: HERO, recs: [] });
    await page.goto('/');
    const c = carousel(page);
    await expect(c).toBeVisible();
    await expect(c.getByRole('group')).toHaveCount(1);
    await expect(slide(c, 1, 1)).toBeVisible();
    await expect(c.locator('.dots')).toHaveCount(0);
    await expect(c.getByRole('link', { name: 'Abspielen' })).toHaveAttribute('href', `/watch/${HERO.id}`);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('no candidate with a poster: today\'s hero', async ({ page }) => {
    await mockHome(page, { hero: { ...HERO, image: false }, recs: [] });
    await page.goto('/');
    const hero = page.locator('.mh');
    await expect(hero).toBeVisible();
    await expect(hero.locator('.pcard')).toHaveAccessibleName(`${HERO.name}, Vorschau öffnen`);
    await page.waitForTimeout(500); // the idle rows have landed: still no carousel
    await expect(carousel(page)).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
