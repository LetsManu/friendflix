// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { episodes, items, MOVIE, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { boxInViewport, row } from '../helpers.js';

/** Desktop wide hover preview (spec desktop browse §2): grows out of the card after a 500 ms rest, ~2.5 cards wide. */

const BECAUSE = 'Weil du „Inkwell“ gesehen hast';
const INTERLACE = items[1]!;

/** the "because" row with an engine v2 reason on its first title (Interlace) */
async function withReason(page: Page) {
  await page.route('**/api/library/because', (r) => r.fulfill({ json: {
    because: { name: MOVIE.name },
    items: items.slice(1, 12).map((it, i) => (i === 0 ? { ...it, reason: { seed: { id: MOVIE.id, name: MOVIE.name }, traits: [] } } : it)),
  } }));
}

/** a frozen page clock: the open / close delays only move with `clock.runFor` */
async function freezeClock(page: Page) {
  const t0 = new Date('2026-11-07T18:00:00Z').getTime();
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(t0 + 1000);
}

async function openOn(page: Page, card: Locator): Promise<Locator> {
  await card.scrollIntoViewIfNeeded();
  await card.locator('a.thumb').hover();
  const dpv = page.locator('.dpv.ready');
  await expect(dpv).toBeVisible();
  return dpv;
}

const dimOf = (card: Locator) => card.locator('.media').evaluate((e) => getComputedStyle(e, '::before').opacity);

test.describe('desktop wide hover preview', () => {
  test('opens after 500ms rest, not before; not while wheel-scrolling', async ({ page }) => {
    await freezeClock(page);
    await page.goto('/');
    const card = row(page, BECAUSE).locator('article.card').first();
    await card.scrollIntoViewIfNeeded();
    await card.locator('a.thumb').hover();
    await page.clock.runFor(450);
    await expect(page.locator('.dpv')).toHaveCount(0);
    await page.clock.runFor(100);
    await expect(page.locator('.dpv[role=dialog]')).toBeVisible();
    await expect(page.locator('.hp')).toHaveCount(0); // the old pop-out is gone on desktop

    // close it, rest on another card and scroll the page with the wheel meanwhile: no preview until the page rests 500 ms
    await page.keyboard.press('Escape');
    await expect(page.locator('.dpv')).toHaveCount(0);
    await row(page, BECAUSE).locator('article.card').nth(1).locator('a.thumb').hover();
    await page.clock.runFor(300);
    const y0 = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 30);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0);
    await page.clock.runFor(300);
    await expect(page.locator('.dpv')).toHaveCount(0);
    await page.clock.runFor(400);
    await expect(page.locator('.dpv')).toHaveCount(1);
  });

  test('wide tile: trailer left, Play / My list / rating / more right, match score, quality badges, synopsis, reco reason when present; neighbours dim', async ({ page }) => {
    await withReason(page);
    await page.route(`**/api/items/${INTERLACE.id}/facts`, (r) => r.fulfill({ json: { fresh: null, leaving: null, traits: { resolution: '4k', hdr: null, audio: null } } }));
    await page.goto('/');
    const cards = row(page, BECAUSE).locator('article.card');
    const dpv = await openOn(page, cards.first());
    await expect(dpv).toHaveAccessibleName(`Vorschau: ${INTERLACE.name}`);

    // ~2.5 cards wide, video column wider than the info column
    const cardBox = (await cards.first().boundingBox())!;
    const box = (await dpv.boundingBox())!;
    expect(box.width / cardBox.width).toBeCloseTo(2.5, 1);
    const art = (await dpv.locator('.dpv-art').boundingBox())!;
    const info = (await dpv.locator('.dpv-info').boundingBox())!;
    expect(art.x).toBeLessThan(info.x);
    expect(art.width).toBeGreaterThan(info.width);
    await expect(dpv.locator('.dpv-art .dpv-title')).toHaveText(INTERLACE.name);

    // actions in order: Play, My list, rating, ..., ⌄ (far right)
    await expect(dpv.getByRole('link', { name: `${INTERLACE.name} abspielen` })).toHaveAttribute('href', `/watch/${INTERLACE.id}`);
    await expect(dpv.getByRole('button', { name: /Merkliste/ })).toBeVisible();
    await expect(dpv.getByRole('button', { name: 'Bewerten' })).toBeVisible();
    const more = dpv.locator('a.dpv-more');
    await expect(more).toHaveAttribute('href', `/item/${INTERLACE.id}`);
    const moreBox = (await more.boundingBox())!;
    expect(moreBox.x + moreBox.width).toBeGreaterThan(info.x + info.width - 40);

    // meta: green match score, age box, length, quality chip
    const match = dpv.locator('.dpv-match');
    await expect(match).toHaveText('87 % für dich');
    expect(await match.evaluate((e) => getComputedStyle(e).color)).toMatch(/^rgb\((\d+), (\d+), (\d+)\)$/);
    const [r, g] = await match.evaluate((e) => getComputedStyle(e).color.match(/\d+/g)!.map(Number));
    expect(g!).toBeGreaterThan(r!);
    await expect(dpv.locator('.dpv-age')).toHaveText('FSK 12');
    await expect(dpv.locator('.dpv-meta')).toContainText('2 Std. 28 Min.');
    await expect(dpv.getByRole('list', { name: 'Bild und Ton' }).getByText('4K', { exact: true })).toBeVisible();

    // two-line synopsis, coral reco reason
    const syn = dpv.locator('.dpv-syn');
    await expect(syn).toContainText('packender Titel');
    expect(await syn.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('2');
    const why = dpv.locator('.dpv-why');
    await expect(why).toHaveText(BECAUSE);
    expect(await why.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 79, 109)');

    // the neighbours dim to 55 %, the hovered card does not
    await expect.poll(() => dimOf(cards.nth(1))).toBe('0.45');
    expect(await dimOf(cards.first())).toBe('0');
  });

  test('without a reason no reco line; Continue Watching shows the next episode', async ({ page }) => {
    await page.goto('/');
    let dpv = await openOn(page, row(page, BECAUSE).locator('article.card').first());
    await expect(dpv.locator('.dpv-why')).toHaveCount(0);
    await page.mouse.move(4, 400);
    await expect(page.locator('.dpv')).toHaveCount(0);
    await page.evaluate(() => scrollTo(0, 0));
    dpv = await openOn(page, row(page, 'Weiterschauen').locator('article.card').first());
    await expect(dpv.locator('.dpv-title')).toHaveText(SERIES.name);
    await expect(dpv.locator('.dpv-ep')).toHaveText(`S1·E1 ${episodes[0]!.name}`);
    await expect(dpv.locator('.dpv-progress')).toBeVisible();
    await expect(dpv.locator('a.dpv-more')).toHaveAttribute('href', `/item/${SERIES.id}`);
  });

  test('last card in a row and a row at the viewport bottom: preview fully inside the viewport', async ({ page }) => {
    await page.goto('/');
    const r = row(page, BECAUSE);
    await r.scrollIntoViewIfNeeded();
    const cards = r.locator('article.card');
    await expect(cards.first()).toBeVisible();
    const lastVisible = await r.evaluate((s) => {
      let idx = 0;
      [...s.querySelectorAll('article.card')].forEach((c, i) => { const b = c.getBoundingClientRect(); if (b.left >= 0 && b.right <= innerWidth) idx = i; });
      return idx;
    });
    expect(lastVisible).toBeGreaterThan(2);
    for (const idx of [0, lastVisible]) {
      const dpv = await openOn(page, cards.nth(idx));
      const { ok, box, vw, vh } = await boxInViewport(page, dpv);
      expect(ok, `preview of card ${idx} ${JSON.stringify(box)} must fit ${vw}x${vh}`).toBe(true);
      if (idx === lastVisible) expect(await dpv.evaluate((e) => e.dataset.origin)).toBe('right');
      await page.mouse.move(4, 400);
      await expect(page.locator('.dpv')).toHaveCount(0);
    }

    // the row's cards sit at the very bottom of the window
    await cards.first().evaluate((c) => { const b = c.getBoundingClientRect(); scrollBy(0, b.bottom - innerHeight + 4); });
    await page.waitForTimeout(100);
    const dpv = await openOn(page, cards.first());
    const { ok, box, vw, vh } = await boxInViewport(page, dpv);
    expect(ok, `bottom preview ${JSON.stringify(box)} must fit ${vw}x${vh}`).toBe(true);
  });

  test('closes 150ms after pointer leaves and on Esc; never takes keyboard focus', async ({ page }) => {
    await freezeClock(page);
    await page.goto('/');
    const cards = row(page, BECAUSE).locator('article.card');
    await cards.first().scrollIntoViewIfNeeded();
    await cards.first().locator('a.thumb').hover();
    await page.clock.runFor(600);
    const dpv = page.locator('.dpv.ready');
    await expect(dpv).toBeVisible();
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.dpv')))).toBe(false);

    await page.mouse.move(4, 400);
    await page.clock.runFor(100);
    await expect(page.locator('.dpv')).toHaveCount(1);
    await page.clock.runFor(100);
    await expect(page.locator('.dpv')).toHaveCount(0);

    await cards.first().locator('a.thumb').hover();
    await page.clock.runFor(600);
    await expect(dpv).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dpv')).toHaveCount(0);

    // keyboard focus on a card never opens a preview; Enter opens the title
    await page.mouse.move(4, 400);
    await cards.nth(2).locator('a.thumb').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(cards.nth(2).locator('a.thumb')).toBeFocused();
    await page.clock.runFor(1500);
    await expect(page.locator('.dpv')).toHaveCount(0);
    await page.clock.resume(); // the navigation needs its timers
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/item/${items[3]!.id}`));
  });

  test('resizing to 1000px closes an open preview and undims the row', async ({ page }) => {
    await page.goto('/');
    const cards = row(page, BECAUSE).locator('article.card');
    await openOn(page, cards.first());
    await expect.poll(() => dimOf(cards.nth(1))).toBe('0.45');
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator('.dpv')).toHaveCount(0);
    await expect.poll(() => dimOf(cards.nth(1))).toBe('0');
    // too narrow for a hover preview now
    await cards.nth(1).locator('a.thumb').hover();
    await page.waitForTimeout(900);
    await expect(page.locator('.dpv')).toHaveCount(0);
  });

  test('My list toggles from the preview; ⌄ opens /item/[id]', async ({ page, api }) => {
    await page.goto('/');
    const card = row(page, BECAUSE).locator('article.card').nth(1); // The Dawn Keeper: not on the list yet
    const dpv = await openOn(page, card);
    await dpv.getByRole('button', { name: 'Zur Merkliste hinzufügen' }).click();
    await expect(dpv.getByRole('button', { name: 'Von der Merkliste entfernen' })).toBeVisible();
    expect(api.log.some((l) => l.startsWith('POST /api/items/') && l.includes('/watchlist'))).toBe(true);
    await dpv.locator('a.dpv-more').click();
    await expect(page).toHaveURL(new RegExp(`/item/${items[2]!.id}$`));
    await expect(page.locator('.dpv')).toHaveCount(0);
  });
});
