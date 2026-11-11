// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME, episodes } from '../mocks/fixtures.js';
import { offer } from '../mocks/handoff.js';
import { mockPlayer } from '../mocks/scenes.js';
import { dunmoor } from './cast-remote-setup.js';

/** Device hand-off, the start page's "continue here" card on the desktop billboard (spec device hand-off 2.4). */
dunmoor(); // Dunmoor, S1 E4 "The Lantern Road"

const region = (page: Page) => page.getByRole('region', { name: 'Auf einem anderen Gerät angefangen' });
const rowY = async (page: Page) => Math.round((await page.locator('section.row').first().boundingBox())!.y);
const askedHandoff = (page: Page) => { const n: string[] = []; page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/handoff') n.push(r.url()); }); return n; };

test('card overlays the billboard and moves nothing', async ({ page, api }) => {
  api.handoff.home = offer();
  await page.route('**/api/handoff*', async (r) => { await new Promise((x) => setTimeout(x, 500)); await r.fallback(); }); // answers late
  await page.goto('/');
  await expect(page.locator('section.row').first()).toBeVisible();
  await expect(page.locator('section.billboard h1')).toBeVisible();
  const y = await rowY(page);
  const h1 = (await page.locator('section.billboard h1').boundingBox())!;
  const r = region(page);
  await expect(r).toBeVisible();
  expect(await rowY(page)).toBe(y);
  expect(await page.locator('section.billboard h1').boundingBox()).toEqual(h1);
  await expect(r).toContainText('Zuletzt auf LG-Fernseher · vor 12 Minuten');
  await expect(r).toContainText('Dunmoor S1:F4 · The Lantern Road');
  const go = r.getByRole('link', { name: 'Hier weiterschauen: Dunmoor S1:F4 · The Lantern Road ab 23:10, zuletzt auf LG-Fernseher' });
  await expect(go).toHaveText('Hier weiterschauen ab 23:10');
  // top right of the billboard, inside the page gutter, 380 px wide, below the top bar
  const box = (await r.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.width).toBe(380);
  expect(Math.round(vw - (box.x + box.width))).toBeGreaterThanOrEqual(16);
  expect(box.y).toBeGreaterThanOrEqual(68);
  expect(box.y).toBeLessThan(140);
  await page.waitForTimeout(500);
  expect(await rowY(page)).toBe(y);
});

test.describe('narrow desktop', () => {
  test.use({ viewport: { width: 768, height: 800 } });
  test('the card stays clear of the title and the meta line', async ({ page, api }) => {
    api.handoff.home = offer();
    await page.goto('/');
    await expect(region(page)).toBeVisible();
    await page.waitForTimeout(400);
    const c = (await region(page).boundingBox())!;
    expect(c.x + c.width).toBeLessThanOrEqual(768);
    for (const sel of ['section.billboard h1', 'section.billboard .meta']) {
      const b = (await page.locator(sel).boundingBox())!;
      const apart = c.x >= b.x + b.width - 0.5 || c.x + c.width <= b.x + 0.5 || c.y >= b.y + b.height - 0.5 || c.y + c.height <= b.y + 0.5;
      expect(apart, sel).toBe(true);
    }
    expect(c.width).toBeGreaterThanOrEqual(200);
  });
});

test('reading order: the card follows the heading and precedes the billboard buttons', async ({ page, api }) => {
  api.handoff.home = offer();
  await page.goto('/');
  await expect(region(page)).toBeVisible();
  const order = await page.evaluate(() => {
    const h1 = document.querySelector('section.billboard h1')!;
    const card = document.querySelector('[data-handoff]')!;
    const play = document.querySelector('section.billboard a.play')!;
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { afterH1: follows(h1, card), beforePlay: follows(card, play) };
  });
  expect(order).toEqual({ afterH1: true, beforePlay: true });
});

test('continue goes to the position', async ({ page, api }) => {
  api.handoff.home = offer();
  await mockPlayer(page);
  await page.goto('/');
  await region(page).getByRole('link', { name: /^Hier weiterschauen:/ }).click();
  await expect(page).toHaveURL(new RegExp(`/watch/${episodes[0]!.id}\\?t=1390$`));
});

test('Ausblenden hides it for good', async ({ page, api }) => {
  api.handoff.home = offer();
  await mockPlayer(page); // focus returns to the billboard's Play link, which prefetches the playback info
  const asked = askedHandoff(page);
  await page.goto('/');
  await expect(region(page)).toBeVisible();
  await region(page).getByRole('button', { name: 'Ausblenden' }).click();
  await expect(region(page)).toHaveCount(0);
  await page.reload();
  await expect.poll(() => asked.length).toBeGreaterThanOrEqual(2); // asked again, answered, and still nothing
  await expect(page.locator('section.row').first()).toBeVisible();
  await page.waitForTimeout(300);
  await expect(region(page)).toHaveCount(0);
  api.handoff.home = offer({ id: 'hd-2' }); // the other device played on: a new id brings the card back
  await page.reload();
  await expect(region(page)).toBeVisible();
});

test.describe('no card', () => {
  test.use({ allowedConsole: /status of 500/ }); // the mocked failing request
  test('when there is none or the request fails', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('section.row').first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(region(page)).toHaveCount(0);
    api.handoff.home = offer();
    await page.route('**/api/handoff*', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }));
    await page.reload();
    await expect(page.locator('section.row').first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(region(page)).toHaveCount(0);
    await expect(page.getByText(/boom/i)).toHaveCount(0);
  });
});

test('a slow answer moves nothing', async ({ page, api }) => {
  api.handoff.home = offer();
  await page.route('**/api/handoff*', async (r) => { await new Promise((x) => setTimeout(x, 2500)); await r.fallback(); });
  await page.goto('/');
  await expect(page.locator('section.row').first()).toBeVisible();
  const y = await rowY(page);
  await expect(region(page)).toBeVisible({ timeout: 6000 });
  expect(await rowY(page)).toBe(y);
});

test('the card waits for the billboard title: a late title never meets a card that already moved things', async ({ page, api }) => {
  api.handoff.home = offer();
  let release = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  await page.route(/\/api\/library\/items\?.*sort=Random/, async (r) => { await gate; await r.fallback(); });
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/handoff');
  await page.goto('/');
  await answered;
  await page.waitForTimeout(400);
  await expect(page.locator('section.billboard h1')).toHaveCount(0); // no title yet ...
  await expect(region(page)).toHaveCount(0); // ... and no card, although its answer is in
  release();
  await expect(page.locator('section.billboard h1')).toBeVisible();
  await expect(region(page)).toBeVisible();
  const y = await rowY(page);
  const h1 = (await page.locator('section.billboard h1').boundingBox())!;
  await page.waitForTimeout(500);
  expect(await rowY(page)).toBe(y);
  expect(await page.locator('section.billboard h1').boundingBox()).toEqual(h1);
});

test.describe('kids profile', () => {
  const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
  test('kids profiles never ask', async ({ page, api }) => {
    api.handoff.home = offer();
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(() => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    const asked = askedHandoff(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/kids$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Was schauen wir heute?' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(asked).toEqual([]);
    await expect(region(page)).toHaveCount(0);
  });
});
