// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { boxInViewport, openPopout, row } from '../helpers.js';

// Desktop wide hover preview (portal in <body>) and the quick-view modal opened from it.
test.describe('hover pop-out (desktop)', () => {
  test('stays inside the viewport for the first and the last visible card of a row', async ({ page }) => {
    await page.goto('/');
    const r = row(page, 'Weil du „Inkwell“ gesehen hast');
    await r.scrollIntoViewIfNeeded();
    const cards = r.locator('article.card');
    await expect(cards.first()).toBeVisible();

    // last card that is fully inside the viewport horizontally (the row scrolls, so the DOM-last card is off-screen)
    const lastVisible = await page.evaluate(() => {
      const row = [...document.querySelectorAll('section.row')].find((s) => s.getAttribute('aria-label')?.startsWith('Weil du'))!;
      const list = [...row.querySelectorAll('article.card')];
      let idx = 0;
      list.forEach((c, i) => { const b = c.getBoundingClientRect(); if (b.left >= 0 && b.right <= window.innerWidth) idx = i; });
      return idx;
    });
    expect(lastVisible).toBeGreaterThan(2);

    for (const idx of [0, lastVisible]) {
      const hp = await openPopout(page, cards.nth(idx));
      const { ok, box, vw, vh } = await boxInViewport(page, hp);
      expect(ok, `pop-out of card ${idx} ${JSON.stringify(box)} must fit ${vw}x${vh}`).toBe(true);
      // it is anchored to the card it belongs to
      await expect(hp).toHaveAccessibleName(/^Vorschau: /);
      await page.mouse.move(2, 2);
      await expect(page.locator('.dpv')).toHaveCount(0);
    }
  });

  test('pop-out actions: Merkliste toggles through the API', async ({ page, api }) => {
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').nth(1); // The Dawn Keeper: not on the list yet
    const hp = await openPopout(page, card);
    await hp.getByRole('button', { name: 'Zur Merkliste hinzufügen' }).click();
    await expect(hp.getByRole('button', { name: 'Von der Merkliste entfernen' })).toBeVisible();
    expect(api.log.some((l) => l.startsWith('POST /api/items/') && l.includes('/watchlist'))).toBe(true);
  });
});

test.describe('detail from the pop-out (desktop: the full page, no popup)', () => {
  test('⌄ opens the full page; browser Back returns home', async ({ page }) => {
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').first();
    const hp = await openPopout(page, card);
    await hp.getByRole('link', { name: /^Mehr Infos zu / }).click();

    await expect(page).toHaveURL(/\/item\/0{31}2$/);
    await expect(page.locator('.dd').getByRole('heading', { level: 1 })).toHaveText('Interlace');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.dpv')).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('section.billboard')).toBeVisible();
  });

  test('a click on the pop-out picture opens the detail page; its buttons keep their own action', async ({ page, api }) => {
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').nth(1);
    let hp = await openPopout(page, card);
    // a button inside the pop-out still does its own thing and does not navigate
    await hp.getByRole('button', { name: 'Zur Merkliste hinzufügen' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(api.log.some((l) => l.includes('/watchlist'))).toBe(true);

    await page.mouse.move(2, 2);
    await expect(page.locator('.dpv')).toHaveCount(0);
    hp = await openPopout(page, card);
    await hp.locator('.dpv-art').click({ position: { x: 40, y: 30 } });
    await expect(page).toHaveURL(/\/item\//);
    await expect(page.locator('.dd').getByRole('heading', { level: 1 })).toHaveText('The Dawn Keeper');
    await expect(page.locator('.dpv')).toHaveCount(0);
  });
});
