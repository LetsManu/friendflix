// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, items, MOVIE, SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { openPopout, row } from '../helpers.js';

/** Desktop full-page detail (spec desktop browse §3): cinematic backdrop, left column, tabs only with content. */

const INTERLACE = items[1]!;
const tablist = (page: Page) => page.getByRole('tablist', { name: 'Weitere Inhalte' });
const desk = (page: Page) => page.locator('.dd');

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

/** a frozen page clock from before the first navigation: the 1.5 s trailer delay only moves with `clock.runFor` */
async function freezeClock(page: Page) {
  const t0 = new Date('2026-11-07T18:00:00Z').getTime();
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(t0 + 1000);
}

/** GET /api/items/:id answers this item */
async function itemIs(page: Page, item: Record<string, unknown>) {
  await page.route(new RegExp(`/api/items/${item.id as string}$`), (r) => r.fulfill({ json: { item, inWatchlist: false, thumb: 0 } }));
}

const EXTRAS = [
  { ...items[2], id: 'e0000000000000000000000000000001', name: 'Offizieller Trailer', type: 'Trailer', kind: 'trailer', runtimeTicks: 1_500_000_000 },
  { ...items[3], id: 'e0000000000000000000000000000002', name: 'Hinter den Kulissen', type: 'Video', kind: 'extra', runtimeTicks: 6_000_000_000 },
];

test.describe('desktop detail page', () => {
  test('More info on the billboard and ⌄ in the preview navigate to /item/[id] (no ItemModal on desktop); phone still opens the modal', async ({ page }) => {
    await page.goto('/');
    const bb = page.locator('section.billboard');
    await bb.getByRole('link', { name: 'Weitere Infos' }).click();
    await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
    await expect(desk(page)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(desk(page).getByRole('heading', { level: 1 })).toHaveText(MOVIE.name);

    // the hover preview's ⌄ navigates too
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').first();
    const hp = await openPopout(page, card.locator('a.thumb'));
    await hp.getByRole('link', { name: /^Mehr Infos zu / }).click();
    await expect(page).toHaveURL(new RegExp(`/item/${INTERLACE.id}$`));
    await expect(desk(page)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // phone: the same title link in "More like this" still opens the popup over the page
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/item/' + MOVIE.id);
    await expect(desk(page)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Mehr davon' }).click();
    await page.getByRole('tabpanel', { name: 'Mehr davon' }).getByRole('link').nth(1).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('series: Episodes tab first with season picker and next-up highlighted; More like this; Extras; Details', async ({ page }) => {
    await page.route('**/api/items/*/extras/all', (r) => r.fulfill({ json: { items: EXTRAS } }));
    await page.goto('/item/' + SERIES.id);
    const dd = desk(page);
    await expect(dd.getByRole('heading', { level: 1 })).toHaveText(SERIES.name);
    await expect(tablist(page).getByRole('tab')).toHaveText(['Folgen', 'Mehr davon', 'Trailer & Extras', 'Details']);
    await expect(tablist(page).getByRole('tab', { name: 'Folgen' })).toHaveAttribute('aria-selected', 'true');
    const eps = page.getByRole('tabpanel', { name: 'Folgen' });
    await expect(eps.getByRole('combobox', { name: 'Staffel' })).toBeVisible();
    // a horizontal row of 16:9 tiles
    const tiles = eps.locator('li.eprow');
    await expect(tiles).toHaveCount(episodes.length);
    const a = (await tiles.nth(0).boundingBox())!, b = (await tiles.nth(1).boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
    const th = (await tiles.nth(0).locator('.th').boundingBox())!;
    expect(Math.abs(th.width / th.height - 16 / 9)).toBeLessThan(0.05);
    // next up (episode 2) highlighted; episode 1 shows its progress line
    await expect(tiles.nth(1)).toHaveClass(/cur/);
    await expect(tiles.nth(1).locator('a.ep')).toHaveAttribute('aria-current', 'true');
    await expect(tiles.nth(0).locator('.bar')).toHaveCount(1);
    // Play continues the next episode
    await expect(dd.locator('.acts a.play')).toHaveText(/S1·F2/);
    await expect(dd.locator('.acts a.play')).toHaveAttribute('href', `/watch/${episodes[1]!.id}`);

    await tablist(page).getByRole('tab', { name: 'Mehr davon' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Mehr davon' }).getByRole('link').first()).toBeVisible();
    await tablist(page).getByRole('tab', { name: 'Trailer & Extras' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Trailer & Extras' }).getByText('Hinter den Kulissen')).toBeVisible();
    await tablist(page).getByRole('tab', { name: 'Details' }).click();
    const det = page.getByRole('tabpanel', { name: 'Details' });
    await expect(det.locator('section.cast')).toBeVisible();
    await expect(det.getByRole('heading', { name: /Infos zu Bright Valley/ })).toBeVisible();
  });

  test('movie without extras or similar: only Details', async ({ page }) => {
    await page.route('**/api/items/*/similar', (r) => r.fulfill({ json: { items: [] } }));
    await page.route(/\/api\/library\/items\?.*genre=/, (r) => r.fulfill({ json: { items: [], total: 0 } }));
    await page.goto('/item/' + MOVIE.id);
    await expect(desk(page).getByRole('heading', { level: 1 })).toHaveText(MOVIE.name);
    await expect(tablist(page).getByRole('tab')).toHaveText(['Details']);
    await expect(tablist(page).getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Details' })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
  });

  test('left column: eyebrow only with a label, meta line with the match score, 4-line synopsis with More, actions', async ({ page }) => {
    await page.route('**/api/items/*/facts', (r) => r.fulfill({ json: { fresh: null, leaving: null, traits: { resolution: '4k', hdr: null, audio: null } } }));
    await page.goto('/item/' + MOVIE.id);
    const dd = desk(page);
    await expect(dd.locator('.eyebrow')).toHaveCount(0);
    const meta = dd.locator('.col .meta');
    await expect(meta.locator('.match')).toHaveText('88 % für dich');
    expect(await meta.locator('.match').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(74, 222, 128)');
    await expect(meta).toContainText('2010');
    await expect(meta.locator('.age')).toHaveText('FSK 12');
    await expect(meta).toContainText('2 Std. 28 Min.');
    await expect(meta.locator('.qc')).toContainText('4K');
    const syn = dd.locator('.syn');
    expect(await syn.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('4');
    // the left column is ~42 % of the window
    const col = (await dd.locator('.col').boundingBox())!;
    expect(col.width / 1280).toBeGreaterThan(0.38);
    expect(col.width / 1280).toBeLessThan(0.46);
    // actions: Play (white), My list, rating, more
    const play = dd.locator('.acts').getByRole('link', { name: 'Abspielen' });
    await expect(play).toHaveAttribute('href', `/watch/${MOVIE.id}`);
    expect(await play.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
    await expect(dd.locator('.acts').getByRole('button', { name: /Merkliste/ })).toBeVisible();
    // entrance parts in order (Task 7 staggers them)
    const parts = await dd.locator('.col [data-st]').evaluateAll((els) => els.map((e) => e.className.split(' ').find((c) => ['eyebrow', 'title', 'facts', 'synbox', 'acts'].includes(c))));
    expect(parts).toEqual(['title', 'facts', 'synbox', 'acts']);
    // a fresh label becomes the coral eyebrow
    await page.route('**/api/discover/badges', (r) => r.fulfill({ json: { badges: { [SERIES.id]: { fresh: 'newSeason' } } } }));
    await page.goto('/item/' + SERIES.id);
    const eb = desk(page).locator('.eyebrow');
    await expect(eb).toHaveText('Neue Staffel');
    expect(await eb.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 79, 109)');
    await expect(desk(page).locator('.col [data-st]').first()).toHaveClass(/eyebrow/);
  });

  test('a long synopsis is clamped to 4 lines and More expands it', async ({ page }) => {
    await itemIs(page, { ...MOVIE, overview: 'Ein sehr langer Text. '.repeat(60) });
    await page.goto('/item/' + MOVIE.id);
    const syn = desk(page).locator('.syn');
    const more = desk(page).locator('.synbox button');
    await expect(more).toHaveText('Mehr lesen');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    const h0 = (await syn.boundingBox())!.height;
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(more).toHaveText('Weniger anzeigen');
    expect((await syn.boundingBox())!.height).toBeGreaterThan(h0 + 20);
  });

  test('tab change: coral underline moves, panel crossfades, arrow keys move between tabs', async ({ page }) => {
    await page.goto('/item/' + SERIES.id);
    const tabs = tablist(page);
    await expect(tabs.getByRole('tab')).toHaveText(['Folgen', 'Mehr davon', 'Details']);
    const ink = tabs.locator('.ink');
    expect(await ink.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 79, 109)');
    const inkX = () => ink.evaluate((e) => Math.round(e.getBoundingClientRect().left));
    const tabX = (name: string) => tabs.getByRole('tab', { name }).evaluate((e) => Math.round(e.getBoundingClientRect().left));
    await expect.poll(inkX).toBe(await tabX('Folgen'));
    await tabs.getByRole('tab', { name: 'Details' }).click();
    await expect.poll(inkX).toBe(await tabX('Details'));
    await expect(page.getByRole('tabpanel', { name: 'Details' })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Folgen' })).toHaveCount(0);
    // the underline moves by transform only
    expect(await ink.evaluate((e) => getComputedStyle(e).transform)).not.toBe('none');

    // roving tabindex: only the selected tab is in the tab order; arrows move and select
    await expect(tabs.getByRole('tab', { name: 'Details' })).toHaveAttribute('tabindex', '0');
    await expect(tabs.getByRole('tab', { name: 'Folgen' })).toHaveAttribute('tabindex', '-1');
    await tabs.getByRole('tab', { name: 'Details' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.getByRole('tab', { name: 'Mehr davon' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Folgen' })).toBeFocused(); // wraps
    await page.keyboard.press('End');
    await expect(tabs.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  });

  test.describe('motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    // the profile intro (it plays with motion on) stays off: it would cover the page
    test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }))); });

    test('the panel crossfades: the old one fades out, the new one rises 8px and fades in', async ({ page }) => {
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // no clip: nothing plays
      await page.goto('/item/' + SERIES.id);
      await expect(page.getByRole('tabpanel', { name: 'Folgen' })).toBeVisible();
      await page.evaluate(() => {
        const w = window as unknown as { __anims: string[] };
        w.__anims = [];
        const orig = Element.prototype.animate;
        Element.prototype.animate = function (this: Element, k: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
          if (this.getAttribute('role') === 'tabpanel') w.__anims.push(`${this.id}:${JSON.stringify(k)}:${typeof o === 'object' ? o.duration : o}`);
          return orig.call(this, k, o);
        };
      });
      await tablist(page).getByRole('tab', { name: 'Details' }).click();
      await expect(page.getByRole('tabpanel', { name: 'Details' })).toBeVisible();
      const anims = await page.evaluate(() => (window as unknown as { __anims: string[] }).__anims);
      expect(anims.find((a) => a.startsWith('dd-panel-episodes:'))).toMatch(/"opacity":0.*:120$/);
      expect(anims.find((a) => a.startsWith('dd-panel-details:'))).toMatch(/translate3d\(0px, 8px, 0px\).*:200$/);
    });

    test('backdrop fixed while scrolling; trailer after 1.5s with mute in the action row', async ({ page }) => {
      await fakeMedia(page);
      await itemIs(page, { ...MOVIE, trailers: 1 });
      let asked = 0;
      page.on('request', (r) => { if (/\/api\/items\/[^/]+\/trailer$/.test(r.url())) asked++; });
      await freezeClock(page);
      await page.goto('/item/' + MOVIE.id);
      const dd = desk(page);
      await expect(dd.getByRole('heading', { level: 1 })).toHaveText(MOVIE.name);
      const art = dd.locator('[data-vt-art]');
      await expect(art).toHaveCount(1);
      await expect(art.locator('img.bg')).toHaveClass(/loaded/);
      await page.clock.runFor(1200);
      expect(asked).toBe(0);
      await expect(dd.locator('.acts').getByRole('button', { name: 'Ton einschalten' })).toHaveCount(0);
      await page.clock.runFor(400);
      await expect.poll(async () => { await page.clock.runFor(50); return asked; }).toBe(1);
      await expect.poll(async () => { await page.clock.runFor(50); return art.locator('video').evaluate((v: HTMLVideoElement) => !v.paused); }).toBe(true);
      await expect(art.locator('video')).toHaveClass(/on/);
      const mute = dd.locator('.acts').getByRole('button', { name: 'Ton einschalten' });
      await expect(mute).toBeVisible();
      await mute.click();
      await expect(dd.locator('.acts').getByRole('button', { name: 'Ton ausschalten' })).toHaveAttribute('aria-pressed', 'true');

      // the backdrop stays put while the page scrolls, and darkens as the tabs reach the top
      expect(await art.evaluate((e) => getComputedStyle(e).position)).toBe('fixed');
      const dim = () => dd.locator('.dim').evaluate((e) => Number(getComputedStyle(e).opacity));
      const d0 = await dim();
      const tabsTop = await tablist(page).evaluate((e) => e.getBoundingClientRect().top + scrollY);
      await page.evaluate((y) => scrollTo(0, y), tabsTop - 80);
      await expect.poll(async () => { await page.clock.runFor(50); return dim(); }).toBeGreaterThan(d0 + 0.3);
      expect(Math.round((await art.boundingBox())!.y)).toBe(0);
    });
  });

  test('title without backdrop/logo renders name text and no broken image', async ({ page }) => {
    const bare = { ...items[4]!, backdrop: false, logo: false };
    await itemIs(page, bare);
    await page.goto('/item/' + bare.id);
    const dd = desk(page);
    await expect(dd.getByRole('heading', { level: 1 })).toHaveText(bare.name);
    await expect(dd.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(dd.locator('[data-vt-art] img')).toHaveCount(0);
    await expect(dd.locator('.tlogo')).toHaveCount(0);
    await expect(dd.locator('.acts a.play')).toBeVisible();
  });

  test('‹ Back goes back in the app, or home after a deep link', async ({ page }) => {
    await page.goto('/');
    await page.locator('section.billboard').getByRole('link', { name: 'Weitere Infos' }).click();
    await expect(page).toHaveURL(new RegExp(`/item/${MOVIE.id}$`));
    await page.locator('a.dback').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('section.billboard')).toBeVisible();

    await page.goto('/item/' + MOVIE.id);
    const back = page.locator('a.dback');
    await expect(back).toHaveText(/Zurück/);
    await back.click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });
});
