// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { episodes, items, MOVIE, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { boxInViewport, row } from '../helpers.js';
import { png } from '../mocks/png.js';

/**
 * Desktop hover card (spec desktop browse §2, glass spec §3): grows out of the card after a 500 ms rest; one glass card of the same
 * size on every card (16:9 picture on top, text below), always fully on screen; shrinks back on close. Poster tilt (§8.7).
 */

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

/** full motion without the brand intro over the page, no trailers */
async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 }; // no test host trips it
  });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
}
async function calmMode(page: Page) {
  await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
  await page.addInitScript(() => localStorage.setItem('ff_calm:p1', '1'));
}
/** the hover card has finished growing (no running animation) */
const settled = (dpv: Locator) => expect.poll(() => dpv.evaluate((e) => e.getAnimations().length)).toBe(0);
/** the index of the last card fully inside the window */
const lastVisibleIn = (r: Locator) => r.evaluate((s) => {
  let idx = 0;
  [...s.querySelectorAll('article.card')].forEach((c, i) => { const b = c.getBoundingClientRect(); if (b.left >= 0 && b.right <= innerWidth) idx = i; });
  return idx;
});
async function closeByLeaving(page: Page) {
  await page.mouse.move(4, 400);
  await expect(page.locator('.dpv')).toHaveCount(0);
}
/** at rest: no transform, or one within a hair of identity (the eased tilt is a few frames from its exact rest at 600 ms) */
const isIdentity = (m: string) => {
  if (m === 'none') return true;
  const v = /matrix(?:3d)?\((.+)\)/.exec(m)?.[1]?.split(',').map(Number) ?? [];
  const id = v.length === 6 ? [1, 0, 0, 1, 0, 0] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return v.length === id.length && v.every((x, i) => Math.abs(x - id[i]!) < (i >= 12 || (v.length === 6 && i >= 4) ? 0.05 : 0.002));
};

/** WCAG contrast of two sRGB colours */
type RGB = [number, number, number];
const lum = (c: RGB) => c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrastOf = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const mixRGB = (b: RGB, t: RGB, a: number): RGB => [0, 1, 2].map((i) => b[i]! * (1 - a) + t[i]! * a) as RGB;
const rgba = (s: string): { rgb: RGB; a: number } => { const n = s.match(/[\d.]+/g)!.map(Number); return { rgb: [n[0]!, n[1]!, n[2]!], a: n[3] ?? 1 }; };

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

  test('stacked card: trailer on top, Play / My list / rating / more below, match score, quality badges, synopsis, reco reason when present; neighbours dim', async ({ page }) => {
    await withReason(page);
    await page.route(`**/api/items/${INTERLACE.id}/facts`, (r) => r.fulfill({ json: { fresh: null, leaving: null, traits: { resolution: '4k', hdr: null, audio: null } } }));
    await page.goto('/');
    const cards = row(page, BECAUSE).locator('article.card');
    const dpv = await openOn(page, cards.first());
    await expect(dpv).toHaveAccessibleName(`Vorschau: ${INTERLACE.name}`);

    // one column: the full-width 16:9 picture on top, the text below
    const box = (await dpv.boundingBox())!;
    const art = (await dpv.locator('.dpv-art').boundingBox())!;
    const info = (await dpv.locator('.dpv-info').boundingBox())!;
    expect(box.width).toBeCloseTo(560, 0);
    expect(art.width).toBeCloseTo(box.width, 0);
    expect(art.y + art.height).toBeLessThanOrEqual(info.y + 0.5);
    expect(info.width).toBeCloseTo(box.width, 0);
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

    // three-line synopsis, coral reco reason
    const syn = dpv.locator('.dpv-syn');
    await expect(syn).toContainText('packender Titel');
    expect(await syn.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('3');
    const why = dpv.locator('.dpv-why');
    await expect(why).toHaveText(BECAUSE);
    expect(await why.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 138, 160)'); // the mockup's light coral (AA)

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
    const lastVisible = await lastVisibleIn(r);
    expect(lastVisible).toBeGreaterThan(2);
    for (const idx of [0, lastVisible]) {
      const dpv = await openOn(page, cards.nth(idx));
      const { ok, box, vw, vh } = await boxInViewport(page, dpv);
      expect(ok, `preview of card ${idx} ${JSON.stringify(box)} must fit ${vw}x${vh}`).toBe(true);
      if (idx === lastVisible) expect(box!.x + box!.width).toBeCloseTo(vw - 12, 0); // clamped to the right margin
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

  test('a click on the rating keeps focus inside, yet the preview still closes when the pointer leaves', async ({ page }) => {
    await page.goto('/');
    const dpv = await openOn(page, row(page, BECAUSE).locator('article.card').first());
    await dpv.getByRole('button', { name: 'Bewerten' }).click();
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.dpv')))).toBe(true);
    await page.mouse.move(4, 400);
    await expect(page.locator('.dpv')).toHaveCount(0);
  });

  test.describe('billboard', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('a preview without a clip of its own still pauses the billboard trailer; it resumes when the preview closes', async ({ page }) => {
      await fakeMedia(page);
      await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { hoverClip: false } } })); // no clip for the hovered card (no trailers either)
      // a movie in the first row, just under the billboard
      await page.route('**/api/library/resume', (r) => r.fulfill({ json: { items: [{ ...items[2], positionTicks: 9_000_000_000, playedPercentage: 10 }] } }));
      // with motion allowed the cold-start brand intro covers the page, and the frozen clock would keep it there: hover() then
      // scrolls looking for a free spot, and a billboard scrolled out of view rightly stays paused. Start as a warm session.
      await page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'));
      await freezeClock(page);
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      const paused = () => bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.paused);
      await page.clock.runFor(1600);
      await expect.poll(async () => { await page.clock.runFor(50); return paused(); }).toBe(false);

      await page.locator('article.card').first().locator('a.thumb').hover();
      await page.clock.runFor(600);
      await expect(page.locator('.dpv')).toHaveCount(1);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await expect.poll(async () => { await page.clock.runFor(50); return paused(); }).toBe(true);
      await page.clock.runFor(1500); // the preview has no clip: still paused a while later
      expect(await paused()).toBe(true);

      await page.mouse.move(4, 200);
      await page.clock.runFor(200);
      await expect(page.locator('.dpv')).toHaveCount(0);
      await expect.poll(async () => { await page.clock.runFor(50); return paused(); }).toBe(false);
    });
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

  test('hover card: same size on 16:9, poster-only and Top 10 cards', async ({ page }) => {
    // the second title of the "because" row has no backdrop: its card shows the poster contained in the 16:9 slot
    await page.route('**/api/library/because', (r) => r.fulfill({ json: {
      because: { name: MOVIE.name },
      items: items.slice(1, 12).map((it, i) => (i === 1 ? { ...it, backdrop: false } : it)),
    } }));
    await page.goto('/');
    const because = row(page, BECAUSE).locator('article.card');
    await expect(because.nth(1).locator('img.contain')).toHaveCount(1);
    const ranked = page.locator('section.row.rk').first().locator('article.card').first();
    const sizes: { w: number; aw: number; ah: number }[] = [];
    for (const card of [because.first(), because.nth(1), ranked]) {
      const dpv = await openOn(page, card);
      sizes.push(await dpv.evaluate((e) => {
        const a = e.querySelector('.dpv-art')!.getBoundingClientRect();
        return { w: e.getBoundingClientRect().width, aw: a.width, ah: a.height };
      }));
      await closeByLeaving(page);
    }
    expect(await ranked.locator('.thumb').evaluate((e) => e.getBoundingClientRect().height / e.getBoundingClientRect().width)).toBeCloseTo(1.5, 1);
    for (const s of sizes) {
      expect(Math.abs(s.w - 560)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.ah - 315)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.aw / s.ah - 16 / 9)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(s.w - sizes[0]!.w)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(s.ah - sizes[0]!.ah)).toBeLessThanOrEqual(0.5);
    }
  });

  for (const vp of [{ width: 1280, height: 800 }, { width: 1100, height: 620 }]) {
    test(`hover card: always fully on screen, nothing clipped (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize(vp);
      const long = 'Ein langer Überblick. '.repeat(30).slice(0, 600);
      await page.route('**/api/library/because', (r) => r.fulfill({ json: {
        because: { name: MOVIE.name },
        items: items.slice(1, 12).map((it) => ({ ...it, overview: long, reason: { seed: { id: MOVIE.id, name: MOVIE.name }, traits: [] } })),
      } }));
      await page.goto('/');
      const r = row(page, BECAUSE);
      await r.scrollIntoViewIfNeeded();
      const cards = r.locator('article.card');
      await expect(cards.first()).toBeVisible();
      const check = async (what: string) => {
        const dpv = page.locator('.dpv.ready');
        const { ok, box, vw, vh } = await boxInViewport(page, dpv);
        expect(ok, `${what} ${JSON.stringify(box)} must fit ${vw}x${vh}`).toBe(true);
        const b = box!;
        for (const m of [b.x, b.y, vw - b.x - b.width, vh - b.y - b.height]) expect(m, `${what} margins`).toBeGreaterThanOrEqual(11.5);
        const t = await dpv.evaluate((e) => {
          const syn = e.querySelector<HTMLElement>('.dpv-syn')!, why = e.querySelector<HTMLElement>('.dpv-why')!, info = e.querySelector<HTMLElement>('.dpv-info')!;
          const lh = parseFloat(getComputedStyle(syn).lineHeight);
          const ib = info.getBoundingClientRect(), db = e.getBoundingClientRect();
          return { clamp: getComputedStyle(syn).webkitLineClamp, synH: syn.clientHeight, lh, why: [why.scrollHeight, why.clientHeight], info: [info.scrollHeight, info.clientHeight], infoBottom: ib.bottom, cardBottom: db.bottom, synBottom: syn.getBoundingClientRect().bottom };
        });
        expect(t.clamp).toBe('3');
        expect(t.synH).toBeLessThanOrEqual(3 * t.lh + 1); // three lines, the rest ellipsised
        expect(t.why[0]!).toBeLessThanOrEqual(t.why[1]! + 1);
        expect(t.info[0]!).toBeLessThanOrEqual(t.info[1]! + 1);
        expect(t.synBottom).toBeLessThanOrEqual(t.infoBottom + 0.5);
        expect(t.infoBottom).toBeLessThanOrEqual(t.cardBottom + 0.5);
      };
      await openOn(page, cards.first());
      await check('first card');
      await closeByLeaving(page);
      const last = await lastVisibleIn(r);
      expect(last).toBeGreaterThan(1);
      await openOn(page, cards.nth(last));
      await check('last visible card');
      await closeByLeaving(page);
      // the row's cards at the very bottom of the window
      await cards.first().evaluate((c) => { const b = c.getBoundingClientRect(); scrollBy(0, b.bottom - innerHeight + 4); });
      await page.waitForTimeout(100);
      await openOn(page, cards.first());
      await check('bottom card');
    });
  }

  test('no hover card under 600 px tall windows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await freezeClock(page);
    await page.goto('/');
    const card = row(page, BECAUSE).locator('article.card').first();
    await card.scrollIntoViewIfNeeded();
    await card.locator('a.thumb').hover();
    await page.clock.runFor(600);
    await expect(page.locator('.dpv')).toHaveCount(0);
    await page.clock.runFor(600);
    await expect(page.locator('.dpv')).toHaveCount(0);
  });

  test('bright artwork raises the scrim', async ({ page }) => {
    const white = png(64, 36, [255, 255, 255]);
    await page.route(`**/media/Items/${INTERLACE.id}/Images/**`, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: white }));
    await page.goto('/');
    const dpv = await openOn(page, row(page, BECAUSE).locator('article.card').first());
    await expect.poll(async () => Number(await dpv.evaluate((e) => getComputedStyle(e).getPropertyValue('--fr-scrim')))).toBeGreaterThanOrEqual(0.66);
  });

  test('text part passes AA over bright page content behind it (white Top 10 posters)', async ({ page }) => {
    // every picture white except the hovered card's (dark art: its tone keeps the glass scrim light, the worst case)
    const white = png(32, 48, [255, 255, 255]), dark = png(64, 36, [12, 10, 16]);
    await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: white }));
    const added = row(page, 'Neu hinzugefügt');
    await page.goto('/');
    const card = added.locator('article.card').nth(1);
    const id = (await card.locator('a.thumb').getAttribute('href'))!.split('/').pop()!;
    await page.route(`**/media/Items/${id}/**`, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: dark }));
    // with a reco reason (the coral line), wherever the row gets that title from
    await page.route('**/api/library/items?**', (r) => {
      if (new URL(r.request().url()).searchParams.get('sort') !== 'DateCreated') return r.fallback();
      return r.fulfill({ json: { items: items.map((it) => (it.id === id ? { ...it, reason: { seed: { id: MOVIE.id, name: MOVIE.name }, traits: [] } } : it)), total: items.length } });
    });
    await page.reload();
    // the row just above the Top 10 row, so the card's text part lies over the white posters
    await card.evaluate((c) => { const b = c.getBoundingClientRect(); scrollBy(0, b.top - innerHeight * 0.45); });
    const dpv = await openOn(page, card);
    const info = dpv.locator('.dpv-info');
    const ib = (await info.boundingBox())!;
    const behind = await page.evaluate(([x, y]) => document.elementsFromPoint(x!, y!).some((e) => e.matches('section.row.rk img')), [ib.x + ib.width / 2, ib.y + ib.height - 30]);
    expect(behind, 'a white Top 10 poster lies behind the text part').toBe(true);
    // the colours white text sits on, in the painted order, over a pure white page: glass scrim → milk → the text part's underlay
    const m = await dpv.evaluate((e) => {
      const i = e.querySelector<HTMLElement>('.dpv-info')!;
      const col = (sel: string) => { const n = e.querySelector<HTMLElement>(sel); return n ? getComputedStyle(n).color : null; };
      return { scrim: getComputedStyle(e).getPropertyValue('--fr-scrim'), under: getComputedStyle(i).backgroundColor, inks: [col('.dpv-syn'), col('.dpv-meta'), col('.dpv-match'), col('.dpv-why'), col('.dpv-age')].filter(Boolean) as string[] };
    });
    expect(Number(m.scrim)).toBeLessThan(0.5); // the dark art's light glass: the underlay alone carries the text
    let bg = mixRGB(mixRGB([255, 255, 255], [18, 16, 24], Number(m.scrim)), [240, 236, 248], 0.19);
    const u = rgba(m.under);
    expect(u.a).toBeGreaterThanOrEqual(0.7);
    bg = mixRGB(bg, u.rgb, u.a);
    expect(m.inks.length).toBe(5);
    for (const ink of m.inks) {
      const k = rgba(ink);
      expect(contrastOf(mixRGB(bg, k.rgb, k.a), bg), ink).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.describe('late growth', () => {
  test.use({ allowedConsole: /status of 500/ }); // the mocked failed save
  test('late growth (quality chips, a failed save) in a 600 px window keeps the card on screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const long = 'Ein langer Überblick. '.repeat(30).slice(0, 600);
    await page.route('**/api/library/resume', (r) => r.fulfill({ json: { items: [{ ...episodes[0], overview: long, reason: { seed: { id: MOVIE.id, name: MOVIE.name }, traits: [] } }] } }));
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    await page.route('**/api/items/*/facts', async (r) => { await gate; await r.fulfill({ json: { fresh: null, leaving: null, traits: { resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' } } }); });
    await page.route('**/api/items/*/watchlist', (r) => r.fulfill({ status: 500, json: {} }));
    await page.goto('/');
    const dpv = await openOn(page, row(page, 'Weiterschauen').locator('article.card').first());
    await expect(dpv.locator('.dpv-ep')).toBeVisible();
    const onScreen = async (what: string) => {
      await expect.poll(async () => {
        const { box, vw, vh } = await boxInViewport(page, dpv);
        const b = box!;
        return Math.min(b.x, b.y, vw - b.x - b.width, vh - b.y - b.height);
      }, { message: what }).toBeGreaterThanOrEqual(11.5);
      const t = await dpv.evaluate((e) => { const i = e.querySelector('.dpv-info')!.getBoundingClientRect(), s = e.querySelector('.dpv-syn')!.getBoundingClientRect(); return { ib: i.bottom, db: e.getBoundingClientRect().bottom, sb: s.bottom }; });
      expect(t.ib).toBeLessThanOrEqual(t.db + 0.5);
    };
    await onScreen('at open');
    release();
    await expect(dpv.locator('.dpv-meta').getByText('4K', { exact: true })).toBeVisible();
    await onScreen('after the quality chips');
    await dpv.getByRole('button', { name: /Merkliste/ }).click();
    await expect(dpv.locator('.fb span')).toBeVisible();
    await onScreen('after the failed-save note');
  });
  });

  test.describe('full motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('closing mid-grow shrinks from where it is (no jump to full size)', async ({ page }) => {
      await fullMotion(page);
      await page.goto('/');
      const card = row(page, BECAUSE).locator('article.card').first();
      await card.scrollIntoViewIfNeeded();
      // in the page: wait (frame by frame) until the card is a few frames into its grow, press Esc there, then sample the scale every
      // frame through the close: it never goes back up
      const waiting = page.evaluate(() => new Promise<number[]>((done) => {
        const sx = (e: Element) => { const t = getComputedStyle(e).transform; return t === 'none' ? 1 : new DOMMatrix(t).a; };
        let frames = 0;
        const wait = () => {
          const e = document.querySelector<HTMLElement>('.dpv.ready');
          if (!e || !e.getAnimations().some((a) => a.playState === 'running') || ++frames < 3) { if (!e) frames = 0; requestAnimationFrame(wait); return; }
          const out: number[] = [sx(e)];
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const tickF = () => { if (!e.isConnected) return done(out); out.push(sx(e)); requestAnimationFrame(tickF); };
          requestAnimationFrame(tickF);
        };
        requestAnimationFrame(wait);
      }));
      await card.locator('a.thumb').hover();
      const scales = await waiting;
      expect(scales[0]!).toBeLessThan(1);
      for (let i = 1; i < scales.length; i++) expect(scales[i]!, JSON.stringify(scales)).toBeLessThanOrEqual(scales[0]! + 0.02);
      await expect(page.locator('.dpv')).toHaveCount(0);
    });

    test('the card is glass with tone and sheen; Play solid white', async ({ page }) => {
      await fullMotion(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
      const dpv = await openOn(page, row(page, BECAUSE).locator('article.card').first());
      await settled(dpv);
      await expect(dpv).toHaveClass(/(^|\s)frost(\s|$)/);
      expect(await dpv.evaluate((e) => getComputedStyle(e).backdropFilter)).toContain('blur(38px)');
      expect(await dpv.evaluate((e) => getComputedStyle(e).borderRadius)).toBe('22px');
      // the tone sampled from the card's artwork: tint triple and scrim set inline, the front tint layer on
      expect(await dpv.evaluate((e) => e.style.getPropertyValue('--fr-tint'))).toMatch(/^\d+, \d+, \d+$/);
      await expect(dpv.locator('.frost-tint i.on')).toHaveCount(1);
      expect(await dpv.locator('.play').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
      // 44 px glass circles
      const add = dpv.getByRole('button', { name: /Merkliste/ });
      await expect(add).toHaveClass(/frost-btn/);
      expect((await add.boundingBox())!.width).toBeCloseTo(44, 0);
      const b = (await dpv.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
      await page.mouse.move(b.x + b.width / 2 + 20, b.y + b.height / 2 + 10, { steps: 4 });
      await expect(dpv.locator('.frost-sheen.on')).toHaveCount(1);
    });

    test('closing shrinks back (full) and is instant in calm', async ({ page }) => {
      await fullMotion(page);
      await page.goto('/');
      const dpv = await openOn(page, row(page, BECAUSE).locator('article.card').first());
      await settled(dpv);
      await page.keyboard.press('Escape');
      const st = await page.evaluate(() => {
        const e = document.querySelector('.dpv');
        return { attached: Boolean(e), running: e ? e.getAnimations().some((a) => a.playState === 'running') : false };
      });
      expect(st).toEqual({ attached: true, running: true });
      await page.waitForTimeout(250);
      await expect(page.locator('.dpv')).toHaveCount(0);
    });

    test('closing is instant in calm mode', async ({ page }) => {
      await fullMotion(page);
      await calmMode(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(/m-still/);
      await openOn(page, row(page, BECAUSE).locator('article.card').first());
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.querySelectorAll('.dpv').length)).toBe(0);
    });

    test('poster tilt: the hovered card leans and lifts; neighbours step back; calm: none', async ({ page }) => {
      await fullMotion(page);
      await freezeClock(page);
      await page.goto('/');
      const cards = row(page, BECAUSE).locator('article.card');
      await cards.nth(1).scrollIntoViewIfNeeded();
      const thumb = cards.nth(1).locator('a.thumb');
      const tf = () => thumb.evaluate((e) => getComputedStyle(e).transform);
      const b = (await thumb.boundingBox())!;
      await page.mouse.move(b.x + b.width * 0.75, b.y + b.height * 0.25, { steps: 3 });
      await page.clock.runFor(300);
      const m = await tf();
      expect(isIdentity(m), m).toBe(false);
      const v = m.match(/matrix3d\((.+)\)/)![1]!.split(',').map(Number);
      expect(v[13]!).toBeLessThan(0); // lifted: a negative y translation
      await expect(page.locator('.dpv')).toHaveCount(0); // still resting: the hover card opens at 500 ms
      await expect.poll(() => cards.nth(2).evaluate((e) => Number(getComputedStyle(e).opacity))).toBeCloseTo(0.62, 1);
      expect(Math.abs(Number(await cards.nth(2).evaluate((e) => getComputedStyle(e).opacity)) - 0.62)).toBeLessThanOrEqual(0.02);
      expect(Number(await cards.nth(1).evaluate((e) => getComputedStyle(e).opacity))).toBe(1);
      // leave: everything eases back
      await page.mouse.move(4, 400);
      await page.clock.runFor(600);
      expect(isIdentity(await tf())).toBe(true);
      await expect.poll(() => cards.nth(2).evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    });

    test('poster tilt: none in calm mode', async ({ page }) => {
      await fullMotion(page);
      await calmMode(page);
      await freezeClock(page);
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(/m-still/);
      const cards = row(page, BECAUSE).locator('article.card');
      await cards.nth(1).scrollIntoViewIfNeeded();
      const thumb = cards.nth(1).locator('a.thumb');
      const b = (await thumb.boundingBox())!;
      for (const [fx, fy] of [[0.75, 0.25], [0.2, 0.8]] as const) {
        await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 3 });
        await page.clock.runFor(150);
        expect(isIdentity(await thumb.evaluate((e) => getComputedStyle(e).transform))).toBe(true);
        expect(await cards.nth(2).evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      }
    });

    test('poster tilt settles back when the hover card opens', async ({ page }) => {
      await fullMotion(page);
      await freezeClock(page);
      await page.goto('/');
      const cards = row(page, BECAUSE).locator('article.card');
      await cards.nth(1).scrollIntoViewIfNeeded();
      const thumb = cards.nth(1).locator('a.thumb');
      const b = (await thumb.boundingBox())!;
      await page.mouse.move(b.x + b.width * 0.75, b.y + b.height * 0.25, { steps: 3 });
      await page.clock.runFor(600);
      await expect(page.locator('.dpv')).toHaveCount(1);
      await page.clock.runFor(600);
      expect(isIdentity(await thumb.evaluate((e) => getComputedStyle(e).transform))).toBe(true);
      await expect(row(page, BECAUSE)).not.toHaveClass(/tilt-row/);
      await expect(row(page, BECAUSE)).toHaveClass(/dpv-dim/);
    });
  });
});
