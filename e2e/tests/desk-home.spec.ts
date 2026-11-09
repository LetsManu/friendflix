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

/**
 * A frozen page clock from before the first navigation: page timers (the 1.5 s trailer delay among them) only move with
 * `clock.runFor`, so nothing can fire while the test waits for the page under load. (Pausing after the page loaded raced:
 * the clock ran freely until then.)
 */
async function freezeClock(page: Page) {
  const t0 = new Date('2026-11-07T18:00:00Z').getTime();
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(t0 + 1000);
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
    test.beforeEach(({ page }) => page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'))); // no brand intro over the page (frozen clocks keep it there)

    test('trailer fades in after 1.5s and the synopsis collapses to one line; mute toggle and age badge at the right edge', async ({ page }) => {
      await fakeMedia(page);
      let asked = 0;
      page.on('request', (r) => { if (/\/api\/items\/[^/]+\/trailer$/.test(r.url())) asked++; });
      await freezeClock(page);
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.getByRole('heading', { level: 1 })).toHaveText(MOVIE.name);
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      await page.clock.runFor(1200);
      expect(asked).toBe(0); // not yet
      await expect(bb.locator('video.hv')).not.toHaveClass(/on/);
      await expect(bb.getByRole('button', { name: 'Ton', exact: true })).toHaveCount(0);
      await page.clock.runFor(400);
      await expect.poll(async () => { await page.clock.runFor(50); return asked; }).toBe(1);
      await expect.poll(async () => { await page.clock.runFor(50); return bb.locator('video.hv').evaluate((v: HTMLVideoElement) => !v.paused); }).toBe(true);
      await expect(bb.locator('video.hv')).toHaveClass(/on/);
      await page.clock.runFor(700); // the beat between the picture and the text (QUIET_MS)
      await expect.poll(async () => { await page.clock.runFor(50); return bb.evaluate((e) => e.classList.contains('quiet')); }).toBe(true);
      // synopsis: the full text fades away, one line stays (opacity + translate only)
      const full = bb.locator('.syn.full'), one = bb.locator('.syn.one');
      await expect.poll(() => full.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
      await expect.poll(() => one.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      expect(await one.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('1');
      // the mute toggle and the age badge, on the right edge, level with the buttons
      // (a fixed name, the state is aria-pressed only: no "Ton aus, gedrückt")
      const mute = bb.getByRole('button', { name: 'Ton', exact: true });
      await expect(mute).toBeVisible();
      await expect(mute).toHaveAttribute('aria-pressed', 'false');
      const playBox = (await bb.getByRole('link', { name: 'Abspielen' }).boundingBox())!;
      const muteBox = (await mute.boundingBox())!;
      expect(Math.abs((muteBox.y + muteBox.height / 2) - (playBox.y + playBox.height / 2))).toBeLessThanOrEqual(2);
      expect(muteBox.x).toBeGreaterThan(1000);
      const ageBox = (await bb.locator('.side .agebadge').boundingBox())!;
      expect(Math.round(ageBox.x + ageBox.width)).toBe(1280);
      await mute.click();
      await expect(mute).toHaveAttribute('aria-pressed', 'true');
      expect(await bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
      // the trailer moves by itself: a pause button stops it, and only that button starts it again (WCAG 2.2.2)
      const paused = () => bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.paused);
      await bb.getByRole('button', { name: 'Vorschau anhalten' }).click();
      await expect.poll(paused).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 700));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.clock.runFor(800);
      expect(await paused()).toBe(true); // back in view: still paused
      await bb.getByRole('button', { name: 'Vorschau fortsetzen' }).click();
      await expect.poll(paused).toBe(false);
    });

    test('trailer pauses when the billboard scrolls out of view', async ({ page }) => {
      await fakeMedia(page);
      await freezeClock(page);
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      const paused = () => bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.paused);
      // the whole 1.5 s delay in one step: how much page time passes must not depend on how often a poll gets to run under load
      await page.clock.runFor(1600);
      await expect.poll(async () => { await page.clock.runFor(50); return paused(); }).toBe(false);
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
      await freezeClock(page);
      await page.goto('/');
      const bb = page.locator('section.billboard');
      await expect(bb.locator('img.bg')).toHaveClass(/loaded/);
      const paused = () => bb.locator('video.hv').evaluate((v: HTMLVideoElement) => v.paused);
      // the whole 1.5 s delay in one step: how much page time passes must not depend on how often a poll gets to run under load
      await page.clock.runFor(1600);
      await expect.poll(async () => { await page.clock.runFor(50); return paused(); }).toBe(false);
      // rest the pointer on the first card long enough for its preview
      await page.locator('article.card').first().hover();
      await page.clock.runFor(2000); // the card's open delay plus the hover preview's 1 s clip delay
      await expect.poll(async () => { await page.clock.runFor(50); return paused(); }).toBe(true);
      await expect(bb.locator('video.hv')).not.toHaveClass(/on/);
    });
  });
});

/** Desktop rows (spec desktop browse §2): paged with arrows and a spring, page dots, rank numerals, today's order. */
test.describe('desktop rows', () => {
  /** "Weil du „Inkwell“ gesehen hast": 11 titles, 5 per page at 1280 px -> 3 pages */
  const because = (page: Page) => page.locator('section.row', { has: page.getByRole('heading', { name: /Weil du/ }) });

  test.describe('motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('row hover shows arrows; next moves one page with a transform, dots follow; prev hidden on the first page', async ({ page }) => {
      // once the last page hides "next", the pointer rests on a card: a slow run may open its hover preview (no clip for it here)
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
      await page.goto('/');
      const row = because(page);
      await row.scrollIntoViewIfNeeded();
      const prev = row.locator('button.pg.prev'), next = row.locator('button.pg.next');
      await expect(next).toHaveAttribute('aria-label', 'Nächste Seite');
      await expect(prev).toHaveAttribute('aria-label', 'Vorherige Seite');
      // first page: no way back; both arrows wait for the pointer
      await expect(prev).toBeHidden();
      expect(await next.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
      // the pointer rests on the row title, not on a card: a card would open its hover preview (and its trailer) under load
      await row.getByRole('heading', { name: /Weil du/ }).hover();
      await expect.poll(() => next.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      // 56 px edge areas with a gradient, on the row's right edge
      const nb = (await next.boundingBox())!;
      expect(Math.round(nb.width)).toBe(56);
      expect(Math.round(nb.x + nb.width)).toBe(1280);
      expect(await next.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain('linear-gradient');
      // dots: 3 pages, the first one current
      const dots = row.locator('.pgdots li');
      await expect(dots).toHaveCount(3);
      await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');
      // the scroll jumps one page at once; the strip springs back from where it was seen (transform, not scroll animation)
      const track = row.locator('.track');
      const w = await track.evaluate((e) => e.clientWidth);
      const moved = await row.evaluate((sec) => {
        const strip = sec.querySelector<HTMLElement>('.strip')!;
        sec.querySelector<HTMLButtonElement>('button.pg.next')!.click();
        return getComputedStyle(strip).transform;
      });
      expect(moved).not.toBe('none');
      const x = await track.evaluate((e) => e.scrollLeft);
      const pad = parseFloat(await track.evaluate((e) => getComputedStyle(e).paddingLeft));
      expect(Math.abs(x - (w - 2 * pad) - parseFloat(await track.evaluate((e) => getComputedStyle(e.querySelector('.strip')!).columnGap)))).toBeLessThanOrEqual(1);
      await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
      await expect(dots.nth(0)).not.toHaveAttribute('aria-current', 'true');
      await expect(prev).toBeVisible();
      // the spring settles back to no transform
      await expect.poll(() => row.locator('.strip').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
      // last page: next hides, the last dot is current
      await next.click();
      await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true');
      await expect(next).toBeHidden();
      // the pressed arrow went away: the keyboard focus moved to the other one; Enter goes back one viewport
      await expect(prev).toBeFocused();
      const end = await track.evaluate((e) => e.scrollLeft);
      await page.keyboard.press('Enter');
      await expect.poll(() => track.evaluate((e) => e.scrollLeft)).toBeCloseTo(end - (w - 2 * pad) - 8, 0);
      await expect(next).toBeVisible();
      await expect(prev).toBeVisible();
    });
  });

  test('arrows are reachable with Tab and show on focus; reduced motion jumps without a transform', async ({ page }) => {
    await page.goto('/');
    const row = because(page);
    await row.scrollIntoViewIfNeeded();
    const next = row.locator('button.pg.next');
    // the arrows are in the Tab order: Shift+Tab from the next row's title link lands on this row's next arrow
    // (tabbing forwards through the cards scrolls the row to its end, where the next arrow is gone)
    await page.getByRole('link', { name: /Neu hinzugefügt/ }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(next).toBeFocused();
    await page.mouse.move(640, 5);
    await expect.poll(() => next.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    const moved = await row.evaluate((sec) => {
      sec.querySelector<HTMLButtonElement>('button.pg.next')!.click();
      return getComputedStyle(sec.querySelector('.strip')!).transform;
    });
    expect(moved).toBe('none');
    await expect(row.locator('.pgdots li').nth(1)).toHaveAttribute('aria-current', 'true');
  });

  test('rows start at the logo: title and first card share its left edge, nothing covers the first row title', async ({ page }) => {
    await page.goto('/');
    const logo = (await page.locator('header a.logo, a.logo').first().boundingBox())!;
    const row = page.locator('.rows section.row').first();
    await expect(row.locator('article.card').first()).toBeVisible();
    const h2 = (await row.locator('h2').boundingBox())!;
    const card = (await row.locator('.slot').first().boundingBox())!;
    expect(Math.abs(h2.x - logo.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.x - logo.x)).toBeLessThanOrEqual(1);
    // the element at the title's centre is the title itself (the billboard overlap stays underneath)
    const top = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x!, y!); return !!e?.closest('.rows section.row h2'); }, [h2.x + 10, h2.y + h2.height / 2]);
    expect(top).toBe(true);
    // 20 px / 700 row titles
    expect(await row.locator('h2').evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight])).toEqual(['20px', '700']);
  });

  test('ranked rows show large outlined rank numbers on desktop', async ({ page }) => {
    await page.goto('/');
    const row = page.locator('section.row.rk').first();
    await row.scrollIntoViewIfNeeded();
    const rank = row.locator('.rank').first();
    await expect(rank).toHaveText('1');
    await expect(rank).toHaveAttribute('aria-label', 'Platz 1');
    const st = await rank.evaluate((e) => { const c = getComputedStyle(e); return { size: parseFloat(c.fontSize), stroke: parseFloat(c.webkitTextStroke || c.getPropertyValue('-webkit-text-stroke-width')), fill: c.webkitTextFillColor || c.color }; });
    expect(st.size).toBeGreaterThanOrEqual(120);
    expect(st.stroke).toBeGreaterThan(0);
    expect(st.fill).toBe('rgb(16, 20, 24)'); // the page colour inside the outline
    // the numeral sits beside the poster (left of it), not on top of it as a chip
    const r = (await rank.boundingBox())!, c = (await row.locator('article.card').first().boundingBox())!;
    expect(r.x).toBeLessThan(c.x);
    expect(r.height).toBeGreaterThan(c.height * .6);
  });

  test('rows keep today\'s order and reco captions', async ({ page }) => {
    // engine v2: the top pick carries its reason (the row caption)
    await page.route('**/api/library/because', (r) => r.fulfill({ json: { because: { name: 'Inkwell' }, items: items.slice(1, 12).map((i, n) => (n ? i : { ...i, reason: { seed: { id: MOVIE.id, name: MOVIE.name }, traits: [] } })) } }));
    await page.goto('/');
    await expect(page.locator('.rows section.row article.card').first()).toBeVisible();
    await expect.poll(() => page.locator('.rows > section.row h2').allTextContents()).toEqual(ORDER);
    // the reco row keeps its caption (ReasonCaption) and its titles in the engine's order
    const row = because(page);
    await expect(row.locator('.slot article.card').first()).toBeVisible();
    await expect(row.getByTestId('reason-caption')).toContainText('Inkwell');
    await row.hover();
    await expect(row.locator('.slot')).toHaveCount(11);
    expect(await row.locator('.slot').evaluateAll((s) => s.map((e) => e.querySelector('a[href^="/item/"]')?.getAttribute('href')))).toEqual(items.slice(1, 12).map((i) => `/item/${i.id}`));
  });
});
/** today's home rows with the default mocks (linked titles carry the "show all" hint) */
const ORDER = ['Weiterschauen', 'Nächste Folge', 'Von Freunden empfohlen', 'Freunde haben bewertet', 'Weil du „Inkwell“ gesehen hast', 'Neu hinzugefügtAlle anzeigen', 'Diese Woche bei uns', 'MerklisteAlle anzeigen', 'Top 10 nach Bewertung'];
