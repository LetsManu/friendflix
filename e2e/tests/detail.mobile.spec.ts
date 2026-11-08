// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/** Block 21 on phones: clamped synopsis, sticky tab bar, horizontally scrolling ratings line, 44 px tabs; phone browse §4: the reworked page. */
const LONG = 'Ein Dieb, der Geheimnisse aus Träumen stiehlt, bekommt einen letzten Auftrag. '.repeat(8);
const ABOUT = {
  ratings: [
    { key: 'community', value: 7.8, max: 10, from: 'jellyfin' }, { key: 'imdb', value: 8.1, max: 10, from: 'omdb' }, { key: 'rt', value: 92, max: 100, from: 'omdb' },
    { key: 'mc', value: 81, max: 100, from: 'omdb' }, { key: 'friends', value: 4.5, max: 5, from: 'friends' },
  ],
  tagline: 'Dein Traum ist der Tatort.',
  countries: ['US'], studios: ['Wardell Pictures'], tags: [], keywords: [], links: [{ kind: 'imdb', url: 'https://www.imdb.com/title/tt1375666/' }],
  collection: null, canRequest: false, sources: ['jellyfin', 'omdb'],
};

async function open(page: Page) {
  await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, (r) => r.fulfill({ json: ABOUT }));
  await page.route(new RegExp(`/api/items/${MOVIE.id}$`), (r) => r.fulfill({ json: { item: { ...MOVIE, overview: LONG }, inWatchlist: false, thumb: 0, langs: { audio: ['deu'], subs: [] } } }));
  await page.goto('/item/' + MOVIE.id);
  await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
}
const tablist = (page: Page) => page.getByRole('tablist', { name: 'Weitere Inhalte' });

test.describe('detail page (phone)', () => {
  test('synopsis clamped to 3 lines with Mehr; Mehr expands, aria-expanded true', async ({ page }) => {
    await open(page);
    const syn = page.locator('#dv-syn');
    const btn = page.getByRole('button', { name: 'Mehr lesen', exact: true });
    await expect(btn).toHaveAttribute('aria-controls', 'dv-syn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    const lines = () => syn.evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
    expect(await lines()).toBe(3);
    await btn.click();
    const less = page.getByRole('button', { name: 'Weniger anzeigen', exact: true });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(await lines()).toBeGreaterThan(3);
    await less.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  test('ratings line and tagline sit together right under the meta line, above the buttons', async ({ page }) => {
    await open(page);
    const meta = (await page.locator('.dbody .meta').boundingBox())!;
    const line = (await page.getByRole('list', { name: 'Bewertungen' }).boundingBox())!;
    const tag = page.locator('.dbody .tagline');
    await expect(tag).toHaveText('Dein Traum ist der Tatort.');
    const tagBox = (await tag.boundingBox())!;
    const play = (await page.locator('.dbody a.play').boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(meta.y + meta.height - 1);
    expect(tagBox.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
    expect(tagBox.y + tagBox.height).toBeLessThanOrEqual(play.y + 1);
  });

  test('tab bar sticks under the app bar while scrolling', async ({ page }) => {
    await open(page);
    const bar = tablist(page);
    await expect(bar).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    const navH = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')));
    const box = (await bar.boundingBox())!;
    expect(Math.abs(box.y - navH)).toBeLessThan(2);
  });

  test('ratings line scrolls horizontally, page has no horizontal overflow', async ({ page }) => {
    await open(page);
    const line = page.getByRole('list', { name: 'Bewertungen' });
    await expect(line).toContainText('Freunde 4,5 ★');
    const m = await line.evaluate((e) => ({ wrap: getComputedStyle(e).flexWrap, ox: getComputedStyle(e).overflowX, sw: e.scrollWidth, cw: e.clientWidth, h: e.getBoundingClientRect().height }));
    expect(m.wrap).toBe('nowrap');
    expect(m.ox).toBe('auto');
    expect(m.h).toBeLessThan(40); // one line
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('tabs are at least 44 px high', async ({ page }) => {
    await open(page);
    const tabs = tablist(page).getByRole('tab');
    await expect(tabs).toHaveText(['Details', 'Mehr davon']);
    for (const t of await tabs.all()) expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

/** media in the test browser: play() / pause() only flip a flag (no real decoding), `paused` reads it; every trailer request counted */
async function fakeTrailer(page: Page) {
  const asked: string[] = [];
  await page.addInitScript(() => {
    const on = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get(this: HTMLMediaElement) { return !on.get(this); } });
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { on.set(this, true); this.dispatchEvent(new Event('playing')); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) { on.set(this, false); this.dispatchEvent(new Event('pause')); };
    HTMLMediaElement.prototype.load = function () { /* nothing to fetch */ };
  });
  await page.route('**/api/items/*/trailer', (r) => { asked.push(r.request().url()); return r.fulfill({ json: { url: '/media/trailer-test.mp4' } }); });
  await page.route('**/media/trailer-test.mp4', (r) => r.fulfill({ status: 204 }));
  return asked;
}
/** a frozen page clock from before the first navigation: page timers only move with `clock.runFor` */
async function freezeClock(page: Page) {
  const t0 = new Date('2026-11-08T18:00:00Z').getTime();
  await page.clock.install({ time: t0 });
  await page.clock.pauseAt(t0 + 1000);
}
const allowDownloads = (page: Page) => Promise.all([
  page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } })),
  page.route('**/api/downloads', (r) => r.fulfill({ json: { downloads: [] } })),
]);
const width = async (l: import('@playwright/test').Locator) => (await l.boundingBox())!.width;

test.describe('phone detail page (phone browse §4)', () => {
  test('backdrop with the glass back button on top; Play and Download fill the width; back leads home after a deep link', async ({ page }) => {
    await allowDownloads(page);
    await open(page);
    const hero = page.locator('.dv .hero');
    const hb = (await hero.boundingBox())!;
    expect(hb.height).toBeGreaterThanOrEqual(280);
    expect(hb.height).toBeLessThanOrEqual(320);
    const back = hero.getByRole('link', { name: 'Zurück' });
    await expect(back).toBeVisible();
    const bb = (await back.boundingBox())!;
    expect(bb.width).toBeGreaterThanOrEqual(44);
    expect(bb.y).toBeGreaterThanOrEqual(hb.y);
    expect(bb.y + bb.height).toBeLessThanOrEqual(hb.y + hb.height / 2);
    const body = page.locator('.dbody');
    const inner = await body.evaluate((e) => e.clientWidth - parseFloat(getComputedStyle(e).paddingLeft) - parseFloat(getComputedStyle(e).paddingRight));
    const play = body.getByRole('link', { name: 'Abspielen' });
    const dl = body.getByRole('button', { name: 'Herunterladen', exact: true });
    await expect(play).toBeVisible();
    await expect(dl).toBeVisible();
    expect(Math.abs((await width(play)) - inner)).toBeLessThan(1.5);
    expect(Math.abs((await width(dl)) - inner)).toBeLessThan(1.5);
    expect((await dl.boundingBox())!.y).toBeGreaterThan((await play.boundingBox())!.y);
    // Play is white, Download a glass button
    expect(await play.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
    // My list / Rate / Share under the synopsis
    await expect(body.getByRole('button', { name: 'Merkliste' })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Teilen' })).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('Download is not shown when downloads are not allowed', async ({ page }) => {
    let me = 0;
    page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/me') me++; });
    await open(page); // the mock profile: downloads.allowed false
    await expect(page.locator('.dbody').getByRole('link', { name: 'Abspielen' })).toBeVisible();
    await expect.poll(() => me).toBeGreaterThanOrEqual(2); // the layout's and the detail page's (download permission) answers are in
    await expect(page.getByRole('button', { name: /Herunterladen/ })).toHaveCount(0);
  });

  test('series: Download names the next episode (S·E)', async ({ page }) => {
    await allowDownloads(page);
    await page.goto('/item/' + SERIES.id);
    await expect(page.getByRole('heading', { level: 1, name: SERIES.name })).toBeVisible();
    await expect(page.locator('.dbody').getByRole('button', { name: /^S1·F\d+ herunterladen$/ })).toBeVisible();
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('the coral underline slides (transform) to the chosen tab, the panel crossfades (120 ms out, then 200 ms in)', async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'));
      await freezeClock(page);
      await open(page);
      const list = tablist(page);
      const ul = list.locator('.ul');
      const details = list.getByRole('tab', { name: 'Details' });
      const more = list.getByRole('tab', { name: 'Mehr davon' });
      await expect(details).toHaveAttribute('aria-selected', 'true');
      const underTab = async (tab: typeof details) => {
        await page.clock.runFor(50);
        const [u, t] = [(await ul.boundingBox())!, (await tab.boundingBox())!];
        return Math.abs(u.x - t.x) < 1.5 && Math.abs(u.width - t.width) < 1.5;
      };
      await expect.poll(() => underTab(details)).toBe(true);
      const before = await ul.evaluate((e) => getComputedStyle(e).transform);
      expect(await ul.evaluate((e) => getComputedStyle(e).transitionProperty)).toBe('transform');
      await more.click();
      await expect(more).toHaveAttribute('aria-selected', 'true');
      // the old panel fades out first (the frozen clock holds it there), the new one is still hidden
      await expect(page.locator('.panes')).toHaveClass(/\bout\b/);
      await expect(page.locator('#dv-panel-details')).toBeVisible();
      await expect(page.locator('#dv-panel-more')).toBeHidden();
      await page.clock.runFor(130);
      await expect(page.locator('#dv-panel-more')).toBeVisible();
      await expect(page.locator('#dv-panel-details')).toBeHidden();
      await expect(page.locator('.panes')).toHaveClass(/\bin\b/);
      await expect.poll(() => underTab(more)).toBe(true);
      expect(await ul.evaluate((e) => getComputedStyle(e).transform)).not.toBe(before);
    });

    test('calm mode: no trailer starts in the backdrop', async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'));
      const asked = await fakeTrailer(page);
      await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true, hoverTrailers: true } } }));
      await freezeClock(page);
      await open(page);
      await expect(page.locator('html')).toHaveClass(/\bcalm\b/);
      await expect(page.locator('.dv .hero img.bg')).toHaveClass(/loaded/);
      await page.clock.runFor(3000);
      expect(asked).toEqual([]);
      await expect(page.locator('.dv .hero video.hv')).not.toHaveClass(/\bon\b/);
    });

    test('control: without calm the muted trailer starts after 1.5 s', async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'));
      const asked = await fakeTrailer(page);
      await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: false, hoverTrailers: true } } }));
      await freezeClock(page);
      await open(page);
      await expect(page.locator('.dv .hero img.bg')).toHaveClass(/loaded/);
      await expect.poll(async () => { await page.clock.runFor(200); return asked.length; }).toBe(1);
      await expect(page.locator('.dv .hero video.hv')).toHaveClass(/\bon\b/);
    });
  });

  test('reduced motion: the tab panel switches at once and the underline does not slide', async ({ page }) => {
    await open(page);
    const list = tablist(page);
    const ul = list.locator('.ul');
    await expect(ul).toBeAttached();
    expect(await ul.evaluate((e) => parseFloat(getComputedStyle(e).transitionDuration))).toBeLessThan(0.001); // none (or the app's global ~0)
    await list.getByRole('tab', { name: 'Mehr davon' }).click();
    await expect(page.locator('#dv-panel-more')).toBeVisible();
    await expect(page.locator('.panes')).not.toHaveClass(/\bout\b/);
    const [u, t] = [(await ul.boundingBox())!, (await list.getByRole('tab', { name: 'Mehr davon' }).boundingBox())!];
    expect(Math.abs(u.x - t.x)).toBeLessThan(1.5);
  });
});
