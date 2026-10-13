import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME, MOVIE, SERIES } from '../mocks/fixtures.js';
import { row, openPopout } from '../helpers.js';

/** Block 21: detail page restructure (ratings line, tagline, always-on tabs with Details, links, social card). */
const ABOUT_EMPTY = { ratings: [], countries: [], studios: [], tags: [], keywords: [], links: [], collection: null, canRequest: false, sources: ['jellyfin'] };
const NO_KEYS = {
  ...ABOUT_EMPTY,
  ratings: [{ key: 'community', value: 7.8, max: 10, from: 'jellyfin' }, { key: 'friends', value: 4.5, max: 5, from: 'friends' }],
  studios: ['Wardell Pictures', 'Aster 9'],
  tags: ['Traum'],
  releaseDate: '2010-07-16',
  originalTitle: 'Ink Well',
  countries: ['US', 'Großbritannien'],
  links: [
    { kind: 'imdb', url: 'https://www.imdb.com/title/tt1375666/' },
    { kind: 'tmdb', url: 'https://www.themoviedb.org/movie/27205' },
    { kind: 'trakt', url: 'https://trakt.tv/search/imdb/tt1375666' },
  ],
};
const WITH_KEYS = {
  ...NO_KEYS,
  ratings: [
    { key: 'community', value: 7.8, max: 10, from: 'jellyfin' }, { key: 'imdb', value: 8.1, max: 10, from: 'omdb' },
    { key: 'rt', value: 92, max: 100, from: 'omdb' }, { key: 'mc', value: 81, max: 100, from: 'omdb' }, { key: 'friends', value: 4.5, max: 5, from: 'friends' },
  ],
  tagline: 'Dein Traum ist der Tatort.',
  sources: ['jellyfin', 'tmdb', 'omdb'],
};
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

/** every about request; the server leaves the friends' rating out for kids profiles (x-ff-profile p3 in these tests) */
async function mockAbout(page: Page, body: object | ((r: Route) => Promise<void> | void)) {
  await page.route(/\/api\/items\/[0-9a-f]{32}\/about$/, async (r) => {
    if (typeof body === 'function') return body(r);
    const kids = r.request().headers()['x-ff-profile'] === 'p3';
    const b = body as typeof NO_KEYS;
    return r.fulfill({ json: kids ? { ...b, ratings: b.ratings.filter((x) => x.key !== 'friends') } : b });
  });
}
const ratingsLine = (page: Page) => page.getByRole('list', { name: 'Bewertungen' });
const tablist = (page: Page) => page.getByRole('tablist', { name: 'Weitere Inhalte' });

test.describe('detail page (desktop)', () => {
  test('no keys: ratings line shows ★ and Freunde, tabs Details/Mehr davon, Details selected, studios + links visible', async ({ page }) => {
    await mockAbout(page, NO_KEYS);
    await page.goto('/item/' + MOVIE.id);
    await expect(ratingsLine(page)).toContainText('★ 7,8');
    await expect(ratingsLine(page)).toContainText('Freunde 4,5 ★');
    await expect(ratingsLine(page)).not.toContainText('IMDb');
    // the star rating is not repeated in the meta line
    await expect(page.locator('.top .meta')).not.toContainText('★');
    await expect(tablist(page).getByRole('tab')).toHaveText(['Details', 'Mehr davon']);
    await expect(tablist(page).getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel', { name: 'Details' });
    await expect(panel.getByText('Wardell Pictures, Aster 9')).toBeVisible();
    await expect(panel.getByText('16. Juli 2010')).toBeVisible();
    await expect(panel.getByText('Ink Well')).toBeVisible();
    await expect(panel.getByText('Vereinigte Staaten, Großbritannien')).toBeVisible();
    await expect(panel.getByRole('link', { name: /^IMDb/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /^TMDB/ })).toBeVisible();
    // the info block keeps director/genres/age but drops the cast line (the cast row sits above the tabs)
    await expect(panel.getByText('Altersfreigabe:')).toBeVisible();
    await expect(panel.getByText('Besetzung:')).toHaveCount(0);
    await expect(page.locator('section.cast')).toBeVisible();
    // the right-hand column is gone
    await expect(page.locator('dl.right')).toHaveCount(0);
    // social card (reactions + stars) lives in the Details tab
    await expect(panel.locator('.social')).toBeVisible();
    await expect(panel.getByRole('heading', { name: /^Bewertungen/ })).toBeVisible();
  });

  test('mocked keys: IMDb/RT/MC in the ratings line; every external link has target _blank and rel "noopener noreferrer"', async ({ page }) => {
    await mockAbout(page, WITH_KEYS);
    await page.goto('/item/' + MOVIE.id);
    const line = ratingsLine(page);
    await expect(line.locator('li')).toHaveText(['★ 7,8Nutzerwertung 7,8 von 10', 'IMDb 8,1IMDb-Wertung 8,1 von 10', 'RT 92 %Rotten-Tomatoes-Wertung 92 %', 'MC 81Metacritic-Wertung 81 von 100', 'Freunde 4,5 ★Wertung deiner Freunde: 4,5 von 5 Sternen']);
    const links = page.getByRole('tabpanel', { name: 'Details' }).locator('a[href^="http"]');
    await expect(links).toHaveCount(3);
    for (const l of await links.all()) {
      await expect(l).toHaveAttribute('target', '_blank');
      await expect(l).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(l).toContainText('(öffnet in neuem Tab)');
    }
  });

  test('tagline in italics under the ratings line', async ({ page }) => {
    await mockAbout(page, WITH_KEYS);
    await page.goto('/item/' + MOVIE.id);
    const tag = page.locator('.top .tagline');
    await expect(tag).toHaveText('Dein Traum ist der Tatort.');
    expect(await tag.evaluate((e) => getComputedStyle(e).fontStyle)).toBe('italic');
    const lineBox = (await ratingsLine(page).boundingBox())!;
    const tagBox = (await tag.boundingBox())!;
    const synBox = (await page.locator('.top .ov').boundingBox())!;
    expect(tagBox.y).toBeGreaterThanOrEqual(lineBox.y + lineBox.height - 1);
    expect(synBox.y).toBeGreaterThanOrEqual(tagBox.y + tagBox.height - 1);
  });

  test('series: Episodes tab selected by default; Details tab shows the info block', async ({ page }) => {
    await mockAbout(page, ABOUT_EMPTY);
    await page.goto('/item/' + SERIES.id);
    await expect(tablist(page).getByRole('tab')).toHaveText(['Folgen', 'Details', 'Mehr davon']);
    await expect(tablist(page).getByRole('tab', { name: 'Folgen' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Folgen' }).getByText('Folge 1', { exact: false }).first()).toBeVisible();
    await tablist(page).getByRole('tab', { name: 'Details' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Details' });
    await expect(panel.getByRole('heading', { name: /Infos zu Bright Valley/ })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Folgen' })).toHaveCount(0);
    // empty about: no ratings line, the star stays in the meta line
    await expect(ratingsLine(page)).toHaveCount(0);
    await expect(page.locator('.top .meta')).toContainText('★');
  });

  test('about request starts after the hero is painted and the ratings placeholder keeps its height (no layout shift)', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let heroFirst: boolean | null = null;
    await mockAbout(page, async (r) => {
      heroFirst = await r.request().frame().evaluate(() => Boolean(document.querySelector('.dv .hero img.bg, .dv h1'))).catch(() => null);
      await held;
      await r.fulfill({ json: NO_KEYS });
    });
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
    await expect.poll(() => heroFirst).toBe(true);
    const ph = page.locator('.top .rl.ph');
    await expect(ph).toHaveCount(1);
    const syn = page.locator('.top .ov');
    const before = (await syn.boundingBox())!;
    release();
    await expect(ratingsLine(page)).toContainText('Freunde');
    const after = (await syn.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });

  test.describe('ratings block settles without a jump', () => {
    test.use({ reducedMotion: 'no-preference' });
    for (const [name, body, dir] of [
      ['about with no ratings: the reserved line collapses smoothly', { ...NO_KEYS, ratings: [] }, -1],
      ['about with a tagline: the block grows smoothly', WITH_KEYS, 1],
    ] as const) {
      test(name, async ({ page }) => {
        await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { hoverTrailers: false, autoStartPreview: false } } })); // no hero trailer
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        await mockAbout(page, async (r) => { await held; await r.fulfill({ json: body }); });
        await page.goto('/item/' + MOVIE.id);
        await expect(page.locator('.top .rl.ph')).toHaveCount(1);
        const syn = page.locator('.top .ov');
        await expect(syn).toBeVisible();
        // record the synopsis position on every frame while "about" resolves
        const rec = syn.evaluate((el) => new Promise<number[]>((done) => {
          const ys: number[] = [];
          const t0 = performance.now();
          const step = () => { ys.push(el.getBoundingClientRect().top); if (performance.now() - t0 < 1500) requestAnimationFrame(step); else done(ys); };
          requestAnimationFrame(step);
        }));
        await page.waitForTimeout(200);
        release();
        const ys = await rec;
        const total = ys[ys.length - 1]! - ys[0]!;
        expect(Math.sign(total)).toBe(dir);
        expect(Math.abs(total)).toBeGreaterThan(5);
        let maxStep = 0;
        for (let i = 1; i < ys.length; i++) maxStep = Math.max(maxStep, Math.abs(ys[i]! - ys[i - 1]!));
        expect(maxStep, `largest per-frame move of ${Math.abs(total)}px total`).toBeLessThan(Math.abs(total) * 0.6);
      });
    }
  });

  test('⋯ menu Download opens the sheet while another tab is selected', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } }));
    await page.route('**/api/downloads', (r) => r.fulfill({ json: { downloads: [] } }));
    await page.route(/\/api\/downloads\/options\//, (r) => r.fulfill({ json: { allowed: true, qualities: [{ id: 'hd', label: 'HD', height: 1080, estBytes: 2e9 }], audio: [], subtitles: [], quota: { used: 0, max: 5 }, days: 30 } }));
    await mockAbout(page, NO_KEYS);
    await page.goto('/item/' + MOVIE.id);
    await tablist(page).getByRole('tab', { name: 'Mehr davon' }).click();
    await expect(tablist(page).getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('button', { name: 'Herunterladen', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Herunterladen' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('HD')).toBeVisible();
  });

  test('modal variant (open from a card): same tabs and ratings line', async ({ page }) => {
    await mockAbout(page, NO_KEYS);
    await page.goto('/');
    const card = row(page, 'Weil du „Inkwell“ gesehen hast').locator('article.card').first();
    const hp = await openPopout(page, card);
    await hp.getByRole('link', { name: /^Mehr Infos zu / }).click();
    const modal = page.getByRole('dialog', { name: /Interlace/ });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('list', { name: 'Bewertungen' })).toContainText('Freunde 4,5 ★');
    await expect(modal.getByRole('tablist', { name: 'Weitere Inhalte' }).getByRole('tab')).toHaveText(['Details', 'Mehr davon']);
    await expect(modal.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await expect(modal.getByRole('tabpanel', { name: 'Details' }).getByRole('link', { name: /^IMDb/ })).toBeVisible();
  });
});

test.describe('detail page: TV', () => {
  test('focus moves from the play button down to the tabs, Right selects Mehr davon, Down enters its panel, Up returns to the tab', async ({ page }) => {
    await mockAbout(page, NO_KEYS);
    await page.route('**/api/playback/info', (r) => r.fulfill({ json: {} })); // the focused play button prefetches the playback info
    await page.goto('/item/' + MOVIE.id + '?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const play = page.locator('.dv .cap a.play');
    await expect(play).toBeVisible();
    await play.focus();
    const details = tablist(page).getByRole('tab', { name: 'Details' });
    await expect(play).toBeFocused();
    await expect(page.locator('section.cast a').first()).toBeVisible(); // layout settled: cast row and ratings line are in
    await expect(ratingsLine(page)).toContainText('Freunde');
    // exactly two steps: play button -> first person of the cast row -> Details tab (the ratings line and the synopsis are not focus stops)
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('section.cast a').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(details).toBeFocused();
    await expect(details).toHaveAttribute('tabindex', '0');
    await expect(tablist(page).getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('tabindex', '0'); // every tab is focusable on TV
    await page.keyboard.press('ArrowRight');
    const more = tablist(page).getByRole('tab', { name: 'Mehr davon' });
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel', { name: 'Mehr davon' });
    await expect(panel.locator('a[href], button').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const first = panel.locator('a[href], button:not([disabled])').first();
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('detail page: kids', () => {
  test('kids profile: no Freunde rating, no social card', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    await mockAbout(page, NO_KEYS);
    await page.goto('/item/' + MOVIE.id);
    await expect(ratingsLine(page)).toContainText('★ 7,8');
    await expect(ratingsLine(page)).not.toContainText('Freunde');
    await expect(tablist(page).getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Details' }).getByText('Wardell Pictures, Aster 9')).toBeVisible();
    await expect(page.locator('.social')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Bewertungen/ })).toHaveCount(0);
  });

  test('switch from the main profile to a kids profile: no friends\' rating from the cached about', async ({ page }) => {
    let me: object = { ...ME, profileCount: 3, onboarded: true };
    await page.route('**/api/me', (r) => r.fulfill({ json: me }));
    await page.addInitScript(noIntro);
    const list = [
      { id: 'p1', name: 'Tester', avatar: 'a1', isOwner: true, hasPin: false, active: true },
      { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, hasPin: false, active: false, kids: true, maxRating: 6 },
    ];
    await page.route('**/api/profiles', (r) => r.fulfill({ json: { profiles: list, max: 5, activeId: 'p1', kidsLock: null, kidsUnguarded: true } }));
    await page.route('**/api/profiles/p3/select', (r) => { me = KID; return r.fulfill({ json: { ok: true } }); });
    const asked: string[] = [];
    await mockAbout(page, async (r) => {
      const prof = r.request().headers()['x-ff-profile'] ?? '';
      asked.push(prof);
      const kids = (me as { kids?: boolean }).kids === true;
      await r.fulfill({ json: kids ? { ...NO_KEYS, ratings: NO_KEYS.ratings.filter((x) => x.key !== 'friends') } : NO_KEYS });
    });
    await page.goto('/item/' + MOVIE.id);
    await expect(ratingsLine(page)).toContainText('Freunde 4,5 ★');

    await page.goto('/profiles');
    await page.getByRole('button', { name: /Mia/ }).click();
    await expect(page).not.toHaveURL(/\/profiles/);
    // back to the same title: the kids profile gets its own answer, never the grown-up's cached friends' rating
    await page.evaluate((id) => { const a = document.createElement('a'); a.href = '/item/' + id; document.body.appendChild(a); a.click(); }, MOVIE.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
    await expect(ratingsLine(page)).toContainText('★ 7,8');
    await expect(ratingsLine(page)).not.toContainText('Freunde');
    await expect(page.locator('.social')).toHaveCount(0);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });
});
