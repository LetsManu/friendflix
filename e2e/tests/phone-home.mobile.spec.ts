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
/** a slide by its label; slides two or more places away are hidden (out of the a11y tree), so a CSS locator */
const slide = (c: Locator, n: number, m = 5) => c.locator(`[aria-roledescription="slide"][aria-label="${n} von ${m}"]`);
const live = (c: Locator) => c.locator('[aria-live="polite"]');
/** what the live region announces for the centred card: its position, then its title */
const said = (n: number, it: MockItem, m = 5) => `${n} von ${m}, ${it.name}`;
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
    const slides = c.locator('[aria-roledescription="slide"]');
    await expect(slides).toHaveCount(5);
    await expect(slides.first()).toHaveAttribute('role', 'group');
    await expect(slides.first()).toHaveAttribute('aria-roledescription', 'slide');
    // the badge answer moves the labelled title up to second place
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');
    for (const [i, it] of ORDER.entries()) await expect(slide(c, i + 1).locator('a.card')).toHaveAttribute('aria-label', `${it.name}, Vorschau öffnen`);
    await expect(live(c)).toHaveText(said(1, HERO));
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
    await expect(live(c)).toHaveText(said(2, FRESH));
    await expect(dots.nth(1)).toHaveClass(/\bon\b/);
    await expect(dots.nth(0)).not.toHaveClass(/\bon\b/);
    await expect.poll(async () => Math.round(await centreX(slide(c, 2)))).toBe(195);
    // the buttons act on the centred card (a series: its page)
    await expect(play).toHaveAttribute('href', `/item/${FRESH.id}`);
    await expect(page.getByRole('dialog')).toHaveCount(0); // the drag did not open the sheet

    // a short drag springs back to the same card
    await drag(page, c.locator('.track'), -20, true);
    await expect(live(c)).toHaveText(said(2, FRESH));
    await expect.poll(async () => Math.round(await centreX(slide(c, 2)))).toBe(195);
    await expect(dots.nth(1)).toHaveClass(/\bon\b/);

    // drag right: back to the first card
    await drag(page, c.locator('.track'), 120);
    await expect(live(c)).toHaveText(said(1, HERO));
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
    await expect(live(c)).toHaveText(said(1, HERO));
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
    await expect(live(c)).toHaveText(said(2, FRESH));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('tap: the centred card opens the preview sheet, a side card comes to the middle; arrow keys move', async ({ page }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');

    // the side card peeks at the right edge: a tap centres it, no sheet
    await slide(c, 2).getByRole('link').tap({ position: { x: 20, y: 120 } });
    await expect(live(c)).toHaveText(said(2, FRESH));
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
    await expect(live(c)).toHaveText(said(3, items[1]!));
    await expect(slide(c, 3).getByRole('link')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(live(c)).toHaveText(said(1, HERO));
    await expect(slide(c, 1).getByRole('link')).toBeFocused();
  });

  test('My list acts on the centred card', async ({ page, api }) => {
    await mockHome(page, { hero: HERO, recs: RECS });
    await page.goto('/');
    const c = carousel(page);
    await expect(slide(c, 2).locator('.eyebrow')).toHaveText('Neue Staffel');
    await drag(page, c.locator('.track'), -120);
    await expect(live(c)).toHaveText(said(2, FRESH));
    const list = c.getByRole('button', { name: 'Merkliste' });
    // FRESH is on the default mock watchlist: the button starts pressed, a tap removes it
    await expect(list).toHaveAttribute('aria-pressed', 'true');
    await list.tap();
    await expect(list).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => api.log.some((l) => l.startsWith('DELETE') && l.includes(FRESH.id))).toBe(true);
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

  test('picks that arrive after the reader scrolled do not move the page', async ({ page }) => {
    // no intro over the page; the billboard title has no poster and there are no recommendations: the carousel's cards come
    // only with the newest titles (an idle request), held back here until the page has been scrolled
    await page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await mockHome(page, { hero: { ...HERO, image: false }, recs: [], latest: RECS });
    await page.route((u) => u.pathname === '/api/library/items', async (r) => {
      if (new URL(r.request().url()).searchParams.get('sort') !== 'DateCreated') return r.fallback();
      await held;
      return r.fallback();
    });
    await page.goto('/');
    await expect(page.locator('section.row').first()).toBeVisible();
    // the carousel's place is kept while its cards load
    const c = carousel(page);
    await expect(c).toHaveAttribute('aria-busy', 'true');
    await expect(c.locator('[aria-roledescription="slide"]')).toHaveCount(0);
    await expect(page.locator('.mh')).toHaveCount(0);
    await expect(async () => {
      await page.evaluate(() => window.scrollTo(0, 300));
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(300);
    }).toPass();
    const rowsTop = () => page.evaluate(() => Math.round(document.querySelector('.rows')!.getBoundingClientRect().top));
    const before = await rowsTop();
    // every scroll position from here on
    await page.evaluate(() => { const w = window as Window & { ys?: number[] }; w.ys = []; addEventListener('scroll', () => w.ys!.push(Math.round(scrollY))); });
    release();
    await expect(c.locator('[aria-roledescription="slide"]')).toHaveCount(5);
    await expect(c).not.toHaveAttribute('aria-busy', 'true');
    // the cards have been rendered and laid out (two frames)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const ys = await page.evaluate(() => (window as Window & { ys?: number[] }).ys ?? []);
    expect(Math.min(300, ...ys), `scroll positions after the cards came: ${ys.join(', ')}`).toBeGreaterThanOrEqual(300);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThanOrEqual(300);
    expect(await rowsTop()).toBe(before); // the rows did not move under the reader
  });

  test('no candidate with a poster: today\'s hero', async ({ page }) => {
    await mockHome(page, { hero: { ...HERO, image: false }, recs: [] });
    // the newest titles (the carousel's second candidate list) arrive with the idle rows
    const latest = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/library/items' && u.searchParams.get('sort') === 'DateCreated'; });
    await page.goto('/');
    const hero = page.locator('.mh');
    await expect(hero).toBeVisible();
    await expect(hero.locator('.pcard')).toHaveAccessibleName(`${HERO.name}, Vorschau öffnen`);
    await latest;
    // the answer has been applied and rendered (two frames): still no carousel
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await expect(carousel(page)).toHaveCount(0);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
