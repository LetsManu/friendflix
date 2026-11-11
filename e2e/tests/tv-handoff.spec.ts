// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { episodes, ME } from '../mocks/fixtures.js';
import { offer } from '../mocks/handoff.js';
import { mockPlayer } from '../mocks/scenes.js';
import { dunmoor } from './cast-remote-setup.js';

/** Device hand-off, the "continue here" card in TV mode: a solid panel in the focus tile, driven by the remote (spec device hand-off 2.4). */
dunmoor(); // Dunmoor, S1 E4 "The Lantern Road"
test.use({ viewport: { width: 1920, height: 1080 } });

/** a paired television gets the 10-foot design (html.tv), as tv-layout.spec.ts does */
async function setTv(page: Page) {
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } }));
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await mockPlayer(page); // the tile's Play warms the playback info; OK on the card opens the player
}
/** Back on a webOS remote, sent to the focused element (the layout listens on the window) */
const back = (page: Page) => page.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 461, bubbles: true, cancelable: true })));
const region = (page: Page) => page.getByRole('region', { name: 'Auf einem anderen Gerät angefangen' });
const go = (page: Page) => region(page).getByRole('link', { name: /^Hier weiterschauen:/ });
const tilePlay = (page: Page) => page.locator('section.tile [data-autofocus]');
const opacity = (page: Page) => page.locator('[data-handoff]').evaluate((e) => getComputedStyle(e).opacity);
const askedHandoff = (page: Page) => { const n: string[] = []; page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/handoff') n.push(r.url()); }); return n; };

test('an early answer takes focus and OK plays', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  const asked = askedHandoff(page);
  await page.goto('/');
  await expect(page.locator('html.tv')).toHaveCount(1);
  await expect(go(page)).toBeFocused();
  await expect(go(page)).toHaveText('Hier weiterschauen ab 23:10');
  // the TV focus style: the focused button is the white fill
  expect(await go(page).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.waitForTimeout(2600); // the layout's own first focus (the tile's Play) does not pull it away
  await expect(go(page)).toBeFocused();
  expect(asked).toHaveLength(1); // asked once per page load
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/watch/${episodes[0]!.id}\\?t=1390$`));
});

test('a late answer does not take focus', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  await page.route('**/api/handoff*', async (r) => { await new Promise((x) => setTimeout(x, 3000)); await r.fallback(); });
  await page.goto('/');
  await expect(tilePlay(page)).toBeFocused();
  await expect(page.locator('main .rows section.row').first()).toBeVisible();
  const rowY = () => page.locator('main .rows section.row').first().evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const y = await rowY();
  await expect(region(page)).toBeVisible({ timeout: 6000 });
  await page.waitForTimeout(300);
  await expect(tilePlay(page)).toBeFocused(); // never stolen
  expect(await rowY()).toBe(y); // and the rows did not move
  await page.keyboard.press('ArrowUp');
  await expect(go(page)).toBeFocused();
  await expect(page.locator('nav.rail')).not.toHaveClass(/open/);
  await page.keyboard.press('ArrowDown'); // and back down to the tile
  await expect(tilePlay(page)).toBeFocused();
});

test('Back returns to the tile without dismissing', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  await page.goto('/');
  await expect(go(page)).toBeFocused();
  await back(page);
  await expect(tilePlay(page)).toBeFocused();
  await expect(region(page)).toBeVisible();
  await expect(page.locator('nav.rail')).not.toHaveClass(/open/); // Back on the card is the card's, not the page's
  await page.reload();
  await expect(region(page)).toBeVisible(); // not dismissed
});

test('Right then OK dismisses and focus returns to the tile', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  await page.goto('/');
  await expect(go(page)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const x = region(page).getByRole('button', { name: 'Ausblenden' });
  await expect(x).toBeFocused();
  expect(await x.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.keyboard.press('ArrowLeft');
  await expect(go(page)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(region(page)).toHaveCount(0);
  await expect(tilePlay(page)).toBeFocused();
  await page.reload();
  await expect(tilePlay(page)).toBeFocused();
  await page.waitForTimeout(300);
  await expect(region(page)).toHaveCount(0); // gone for good on this device
});

test('moving into the rows fades the card, coming back shows it', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  await page.goto('/');
  await expect(go(page)).toBeFocused();
  await page.keyboard.press('ArrowDown'); // card -> the tile's Play
  await expect(tilePlay(page)).toBeFocused();
  await page.keyboard.press('ArrowDown'); // -> the first row
  await expect(page.locator('main .rows .card .thumb:focus')).toHaveCount(1);
  await expect.poll(() => opacity(page)).toBe('0');
  await expect(page.locator('[data-handoff]')).toHaveCount(1); // faded, not removed
  await expect(page.locator('[data-handoff]')).toHaveAttribute('inert', '');
  await page.keyboard.press('ArrowUp'); // back to the tile
  await expect(tilePlay(page)).toBeFocused();
  await expect.poll(() => opacity(page)).toBe('1');
  await expect(page.locator('[data-handoff]')).not.toHaveAttribute('inert', '');
  await page.keyboard.press('ArrowUp');
  await expect(go(page)).toBeFocused();
});

test('a late answer while the focus is in the rows arrives hidden and shows once the tile is back', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  let release = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  await page.route('**/api/handoff*', async (r) => { await gate; await r.fallback(); });
  await page.goto('/');
  await expect(tilePlay(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const focused = page.locator('main .rows .card .thumb:focus');
  await expect(focused).toHaveCount(1);
  const rowY = () => page.locator('main .rows section.row').first().evaluate((e) => Math.round(e.getBoundingClientRect().top));
  await page.waitForTimeout(500); // the rows' glide settles
  const y = await rowY();
  release();
  await expect(page.locator('[data-handoff]')).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await opacity(page)).toBe('0');
  await expect(region(page)).toHaveCount(0); // hidden from assistive tech while faded
  await expect(focused).toHaveCount(1); // the focus stays on the card in the row
  expect(await rowY()).toBe(y);
  await page.keyboard.press('ArrowUp');
  await expect(tilePlay(page)).toBeFocused();
  await expect.poll(() => opacity(page)).toBe('1');
  await expect(region(page)).toBeVisible();
});

test.describe('full motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('the card fades (opacity only) and does not drop in again when it comes back', async ({ page, api }) => {
    api.handoff.home = offer();
    await setTv(page);
    await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // no clip in the tile
    await page.goto('/');
    await expect(go(page)).toBeFocused();
    const card = page.locator('[data-handoff]');
    await expect.poll(() => card.evaluate((e) => e.getAnimations().length)).toBe(0); // the entrance ran
    const box = await card.boundingBox();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('main .rows .card .thumb:focus')).toHaveCount(1);
    // leaving: a CSS transition of opacity, nothing else
    const leave = await card.evaluate((e) => e.getAnimations().map((a) => (a as CSSTransition).transitionProperty ?? 'animation'));
    expect(leave).toEqual(['opacity']);
    await expect.poll(() => opacity(page)).toBe('0');
    await page.keyboard.press('ArrowUp');
    await expect(tilePlay(page)).toBeFocused();
    const show = await card.evaluate((e) => e.getAnimations().map((a) => (a as CSSTransition).transitionProperty ?? 'animation'));
    expect(show).toEqual(['opacity']);
    await expect.poll(() => opacity(page)).toBe('1');
    expect(await card.boundingBox()).toEqual(box);
  });
});

test('the card is solid on TV, top right of the tile inside the gutter, after the title in reading order', async ({ page, api }) => {
  api.handoff.home = offer();
  await setTv(page);
  await page.goto('/');
  await expect(go(page)).toBeFocused();
  const s = await page.locator('[data-handoff]').evaluate((e) => { const c = getComputedStyle(e); return { filter: c.backdropFilter, bg: c.backgroundColor }; });
  expect(s.filter).toBe('none');
  expect(s.bg).toBe('rgb(28, 26, 33)'); // --fr-solid
  const g = await page.evaluate(() => {
    const tile = document.querySelector('section.tile')!.getBoundingClientRect();
    const card = document.querySelector('[data-handoff]')!.getBoundingClientRect();
    const body = document.querySelector('section.tile .body')!.getBoundingClientRect();
    const title = document.querySelector('section.tile .body :is(h1, img.logo)')!;
    const el = document.querySelector('[data-handoff]')!;
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { right: tile.right - card.right, top: card.top - tile.top, bottom: card.bottom, tileBottom: tile.bottom, apart: card.left - body.right, afterTitle: follows(title, el), beforePlay: follows(el, document.querySelector('section.tile [data-autofocus]')!) };
  });
  expect(Math.round(g.right)).toBe(56);
  expect(Math.round(g.top)).toBe(56);
  expect(g.bottom).toBeLessThan(g.tileBottom);
  expect(g.apart).toBeGreaterThan(0); // clear of the tile's text column
  expect(g.afterTitle).toBe(true);
  expect(g.beforePlay).toBe(true);
});
