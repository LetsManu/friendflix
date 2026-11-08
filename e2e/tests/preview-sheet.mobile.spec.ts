// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';
import { row } from '../helpers.js';
import { mockV2Home } from '../mocks/reco.js';

/** a real touch swipe (Playwright's touchscreen only taps): start, a few moves, end */
async function swipe(page: Page, x: number, fromY: number, toY: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (y: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(fromY) });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(fromY + ((toY - fromY) * i) / 8) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** a mouse drag on the sheet's grab handle (dragClose follows mouse/pen on `.grab`) */
async function dragHandle(page: Page, dy: number) {
  const b = (await page.locator('[role="dialog"] .grab').boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + (dy * i) / 6);
  await page.mouse.up();
}

test.describe('preview sheet (phone)', () => {
  test('tapping a poster opens the preview sheet; Escape closes it and returns focus', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    await poster.tap();

    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 2, name: 'Interlace' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/); // the sheet does not navigate
    await expect(sheet.getByRole('button', { name: 'Schließen' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(poster).toBeFocused();
  });

  test('the close button and the backdrop dismiss the sheet', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });

    await poster.tap();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Schließen' }).tap();
    await expect(sheet).toBeHidden();

    await poster.tap();
    await expect(sheet).toBeVisible();
    await page.touchscreen.tap(195, 40); // backdrop above the sheet
    await expect(sheet).toBeHidden();
  });

  test('swiping down anywhere on the sheet closes it; a short swipe springs back', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await poster.tap();
    await expect(sheet).toBeVisible();

    const title = await sheet.getByRole('heading', { level: 2 }).boundingBox();
    if (!title) throw new Error('no title box');
    const x = title.x + 20, y = title.y + title.height / 2;

    await swipe(page, x, y, y + 30); // short: stays open and returns to its place
    await expect(sheet).toBeVisible();
    await expect.poll(async () => (await sheet.boundingBox())?.y).toBeLessThan(y);

    await swipe(page, x, y, y + 220); // long: closes
    await expect(sheet).toBeHidden();

    // a swipe that starts on the play button closes the sheet without starting playback
    await poster.tap();
    await expect(sheet).toBeVisible();
    const play = await sheet.locator('a.play').boundingBox();
    if (!play) throw new Error('no play box');
    await swipe(page, play.x + play.width / 2, play.y + play.height / 2, play.y + 260);
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test('opens from the carousel and from a row poster with Play and Details; no Download without the permission', async ({ page }) => {
    await page.goto('/');
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    const carousel = page.getByRole('region', { name: 'Top-Tipps für dich' });
    const centred = carousel.locator('[aria-roledescription="slide"]').first().getByRole('link');
    await centred.tap();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: /^(Abspielen|Fortsetzen)$/ })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Details' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Merkliste' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Bewerten/ })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Download/ })).toHaveCount(0); // me.downloads.allowed is false
    await expect(sheet.locator('.why')).toHaveCount(0); // engine v1 items carry no reason
    await sheet.getByRole('button', { name: 'Schließen' }).tap();
    await expect(sheet).toBeHidden();

    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    await poster.tap();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Details' })).toHaveAttribute('href', /^\/item\//);
    await sheet.getByRole('link', { name: 'Details' }).tap();
    await expect(page).toHaveURL(/\/item\/[0-9a-f]+$/);
    await expect(sheet).toHaveCount(0);
  });

  test('dragging the handle down 150 px closes it; up 150 px opens the detail page', async ({ page }) => {
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    const href = (await poster.getAttribute('href'))!;
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });

    await poster.tap();
    await expect(sheet).toBeVisible();
    await dragHandle(page, 150);
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/$/);

    await poster.tap();
    await expect(sheet).toBeVisible();
    await dragHandle(page, -150);
    await expect(page).toHaveURL(new RegExp(`${href.replace(/^.*\/item\//, '/item/')}$`));
    await expect(sheet).toHaveCount(0);
  });

  test('a recommendation opens with its reason line', async ({ page }) => {
    await mockV2Home(page);
    await page.goto('/');
    const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
    await poster.scrollIntoViewIfNeeded();
    await poster.tap();
    const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
    await expect(sheet.locator('.why')).toHaveText(/^Weil du „Inkwell“ gesehen hast/);
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('the sheet springs in and leaves with an exit before it unmounts; focus returns to the opener', async ({ page }) => {
      await page.goto('/');
      const poster = row(page, 'Weil du „Inkwell“ gesehen hast').locator('.pc a').first();
      await poster.scrollIntoViewIfNeeded();
      await poster.tap();
      const sheet = page.getByRole('dialog', { name: /^Vorschau: / });
      await expect(sheet).toBeVisible();
      expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).toMatch(/rise/); // springs up (none under reduced motion)
      // close and read the leaving state in one round-trip: the exit lasts ~280 ms of real time
      const state = await page.evaluate(async () => {
        const el = document.querySelector<HTMLElement>('[role="dialog"].sheet')!;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await Promise.resolve();
        await new Promise((r) => requestAnimationFrame(r));
        const s = document.querySelector('.sheet');
        return { count: document.querySelectorAll('.sheet[role="dialog"]').length, out: Boolean(s?.classList.contains('out')), dimOut: Boolean(document.querySelector('.dim')?.classList.contains('out')), focusOnOpener: document.activeElement?.closest('.pc') !== null };
      });
      expect(state).toEqual({ count: 1, out: true, dimOut: true, focusOnOpener: true });
      await expect(sheet).toHaveCount(0);
      await expect(poster).toBeFocused();
    });
  });
});
