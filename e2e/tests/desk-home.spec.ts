// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { items, MOVIE, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/** Desktop home billboard (spec desktop browse §2): the recommendation engine's hero title with a trailer after 1.5 s. */

/** the billboard pool (GET /api/home builds its hero from the random pool: the first title with a backdrop) */
async function heroIs(page: Page, item: Record<string, unknown>) {
  await page.route(/\/api\/library\/items\?.*sort=Random/, (r) => r.fulfill({ json: { items: [item], total: 1 } }));
}

/** media in the test browser: play() / pause() only flip a flag (no real decoding), `paused` reads it */
async function fakeMedia(page: Page) {
  await page.addInitScript(() => {
    const on = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get(this: HTMLMediaElement) { return !on.get(this); } });
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { on.set(this, true); this.dispatchEvent(new Event('playing')); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) { on.set(this, false); this.dispatchEvent(new Event('pause')); };
    HTMLMediaElement.prototype.load = function () { /* nothing to fetch */ };
  });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: { url: '/media/trailer-test.mp4' } }));
  await page.route('**/media/trailer-test.mp4', (r) => r.fulfill({ status: 204 }));
}

test.describe('desktop billboard', () => {
  test('billboard: 80vh (min 520px), eyebrow only when a label exists, title logo or name, meta line, Play and More info', async ({ page }) => {
    await page.goto('/');
    const bb = page.locator('section.billboard');
    await expect(bb).toBeVisible();
    await expect(page.locator('section.hero')).toHaveCount(0); // the old desktop hero is gone
    await expect(bb.locator('[data-vt-art]')).toHaveCount(1);
    // 80 % of the 800 px viewport
    expect(Math.round((await bb.boundingBox())!.height)).toBe(640);
    // no label for Inkwell: no eyebrow at all (no generic "Film" pill)
    await expect(bb.locator('.eyebrow')).toHaveCount(0);
    await expect(bb.getByRole('heading', { level: 1 })).toHaveText(MOVIE.name);
    // year · age · length · genre
    const meta = bb.locator('.meta');
    await expect(meta.locator('> *:not(.sep)')).toHaveText(['2010', 'FSK 12', '2 Std. 28 Min.', 'Sci-Fi']);
    await expect(bb.locator('.syn.full')).toContainText('packender Titel');
    expect(await bb.locator('.syn.full').evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('3');
    const play = bb.getByRole('link', { name: 'Abspielen' });
    await expect(play).toHaveAttribute('href', `/watch/${MOVIE.id}`);
    expect(await play.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
    await expect(bb.getByRole('link', { name: 'Weitere Infos' })).toHaveAttribute('href', `/item/${MOVIE.id}`);
    // the age badge sits flush against the right edge of the screen
    const age = bb.locator('.side .agebadge');
    await expect(age).toHaveText('FSK 12');
    const box = (await age.boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(1280);

    // the min height on a short window
    await page.setViewportSize({ width: 1280, height: 600 });
    await expect.poll(async () => Math.round((await bb.boundingBox())!.height)).toBe(520);
  });

  test('a fresh label becomes the coral eyebrow; a title logo replaces the name; a series shows its seasons', async ({ page }) => {
    await heroIs(page, { ...SERIES, logo: true, childCount: 3 });
    await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: { [SERIES.id]: { fresh: 'newSeason' } } } }));
    await page.goto('/');
    const bb = page.locator('section.billboard');
    const eyebrow = bb.locator('.eyebrow');
    await expect(eyebrow).toHaveText('Neue Staffel');
    expect(await eyebrow.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 79, 109)');
    await expect(bb.getByRole('heading', { level: 1 }).locator('img')).toHaveAttribute('alt', SERIES.name);
    await expect(bb.locator('.meta > *:not(.sep)')).toHaveText(['2008', 'FSK 12', '3 Staffeln', 'Drama']);
    await expect(bb.getByRole('link', { name: 'Abspielen' })).toHaveAttribute('href', `/item/${SERIES.id}`);
  });

  test('title without backdrop and logo shows the name and no broken image', async ({ page }) => {
    await heroIs(page, { ...items[4], backdrop: false, logo: false });
    await page.goto('/');
    const bb = page.locator('section.billboard');
    await expect(bb.getByRole('heading', { level: 1 })).toHaveText(items[4]!.name);
    await expect(bb.locator('img')).toHaveCount(0);
    await expect(bb.getByRole('link', { name: 'Abspielen' })).toBeVisible();
  });

  test.describe('trailer', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('trailer fades in after 1.5s and the synopsis collapses to one line; mute toggle and age badge at the right edge', async ({ page }) => {
      await fakeMedia(page);
      let asked = 0;
      page.on('request', (r) => { if (/\/api\/items\/[^/]+\/trailer$/.test(r.url())) asked++; });
      await page.clock.install();
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.getByRole('heading', { level: 1 })).toHaveText(MOVIE.name);
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      // the page clock (not the test runner's) decides: stop it right after the backdrop arrived
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 20));
      await page.clock.runFor(1200);
      expect(asked).toBe(0); // not yet
      await expect(bb.locator('video.hv')).not.toHaveClass(/on/);
      await expect(bb.getByRole('button', { name: 'Ton einschalten' })).toHaveCount(0);
      await page.clock.runFor(400);
      await expect.poll(async () => { await page.clock.runFor(50); return asked; }).toBe(1);
      await expect.poll(async () => { await page.clock.runFor(50); return bb.locator('video.hv.on').count(); }).toBe(1);
      await expect.poll(async () => { await page.clock.runFor(100); return bb.evaluate((e) => e.classList.contains('quiet')); }).toBe(true);
      // synopsis: the full text fades away, one line stays (opacity + translate only)
      const full = bb.locator('.syn.full'), one = bb.locator('.syn.one');
      await expect.poll(() => full.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
      await expect.poll(() => one.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      expect(await one.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('1');
      // the mute toggle and the age badge, on the right edge, level with the buttons
      const mute = bb.getByRole('button', { name: 'Ton einschalten' });
      await expect(mute).toBeVisible();
      await expect(mute).toHaveAttribute('aria-pressed', 'false');
      const playBox = (await bb.getByRole('link', { name: 'Abspielen' }).boundingBox())!;
      const muteBox = (await mute.boundingBox())!;
      expect(Math.abs((muteBox.y + muteBox.height / 2) - (playBox.y + playBox.height / 2))).toBeLessThanOrEqual(2);
      expect(muteBox.x).toBeGreaterThan(1000);
      const ageBox = (await bb.locator('.side .agebadge').boundingBox())!;
      expect(Math.round(ageBox.x + ageBox.width)).toBe(1280);
      await mute.click();
      await expect(bb.getByRole('button', { name: 'Ton ausschalten' })).toHaveAttribute('aria-pressed', 'true');
      expect(await bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
    });

    test('trailer pauses when the billboard scrolls out of view', async ({ page }) => {
      await fakeMedia(page);
      await page.clock.install();
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 20));
      const paused = () => bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.paused);
      await expect.poll(async () => { await page.clock.runFor(200); return paused(); }).toBe(false);
      await expect(bb.locator('video.hv')).toHaveClass(/on/);
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect.poll(paused).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(paused).toBe(false);
    });

    test('a hover preview (another preview owner) pauses the billboard trailer', async ({ page }) => {
      await fakeMedia(page);
      // a movie in the first row (just under the billboard): its hover card plays a clip
      await page.route('**/api/library/resume', (r) => r.fulfill({ json: { items: [{ ...items[2], positionTicks: 9_000_000_000, playedPercentage: 10 }] } }));
      await page.clock.install();
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 20));
      const paused = () => bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.paused);
      await expect.poll(async () => { await page.clock.runFor(200); return paused(); }).toBe(false);
      // rest the pointer on the first card long enough for its preview
      await page.locator('article.card').first().hover();
      await expect.poll(async () => { await page.clock.runFor(200); return paused(); }).toBe(true);
      await expect(bb.locator('video.hv')).not.toHaveClass(/on/);
    });
  });
});
