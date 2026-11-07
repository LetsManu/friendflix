// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME, MOVIE, MOVIE2, SERIES, items } from '../mocks/fixtures.js';

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
/** desktop page: the Details tab comes last (spec desktop browse §3); select it and return its panel */
async function details(page: Page) {
  await tablist(page).getByRole('tab', { name: 'Details' }).click();
  return page.getByRole('tabpanel', { name: 'Details' });
}

test.describe('detail page (desktop)', () => {
  test('no keys: ratings line shows ★ and Freunde, tabs Mehr davon/Details, Mehr davon selected, studios + links in Details', async ({ page }) => {
    await mockAbout(page, NO_KEYS);
    await page.goto('/item/' + MOVIE.id);
    await expect(ratingsLine(page)).toContainText('★ 7,8');
    await expect(ratingsLine(page)).toContainText('Freunde 4,5 ★');
    await expect(ratingsLine(page)).not.toContainText('IMDb');
    // the star rating is not repeated in the meta line
    await expect(page.locator('.top .meta')).not.toContainText('★');
    await expect(tablist(page).getByRole('tab')).toHaveText(['Mehr davon', 'Details']);
    await expect(tablist(page).getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('aria-selected', 'true');
    const panel = await details(page);
    await expect(panel.getByText('Wardell Pictures, Aster 9')).toBeVisible();
    await expect(panel.getByText('16. Juli 2010')).toBeVisible();
    await expect(panel.getByText('Ink Well')).toBeVisible();
    await expect(panel.getByText('Vereinigte Staaten, Großbritannien')).toBeVisible();
    await expect(panel.getByRole('link', { name: /^IMDb/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: /^TMDB/ })).toBeVisible();
    // the info block keeps director/genres/age but drops the cast line (the cast row with photos heads the Details tab)
    await expect(panel.getByText('Altersfreigabe:')).toBeVisible();
    await expect(panel.getByText('Besetzung:')).toHaveCount(0);
    await expect(panel.locator('section.cast')).toBeVisible();
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
    const links = (await details(page)).locator('a[href^="http"]');
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
    await expect(tablist(page).getByRole('tab')).toHaveText(['Folgen', 'Mehr davon', 'Details']);
    await expect(tablist(page).getByRole('tab', { name: 'Folgen' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Folgen' }).getByText('Folge 1', { exact: false }).first()).toBeVisible();
    await tablist(page).getByRole('tab', { name: 'Details' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Details' });
    await expect(panel.getByRole('heading', { name: /Infos zu Bright Valley/ })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Folgen' })).toHaveCount(0);
    // empty about: no ratings line; the meta line carries the match score
    await expect(ratingsLine(page)).toHaveCount(0);
    await expect(page.locator('.top .meta')).toContainText('95 % für dich');
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
    // the desktop column sits on the bottom of the first screen: a ratings block that grows or collapses moves the parts of
    // the column (above it while the column is anchored to the bottom, below it once the column outgrows the screen); every
    // part that moves glides there (FLIP, transform only) instead of jumping
    for (const [name, body] of [
      ['about with no ratings: the reserved line collapses smoothly', { ...NO_KEYS, ratings: [] }],
      ['about with a tagline: the block grows smoothly', WITH_KEYS],
    ] as const) {
      test(name, async ({ page }) => {
        await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { hoverTrailers: false, autoStartPreview: false } } })); // no hero trailer
        await page.addInitScript(noIntro);
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        await mockAbout(page, async (r) => { await held; await r.fulfill({ json: body }); });
        await page.goto('/item/' + MOVIE.id);
        await expect(page.locator('.top .rl.ph')).toHaveCount(1);
        await expect(page.locator('.top h1')).toBeVisible();
        const tops = () => page.locator('.top > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        const before = await tops();
        await page.evaluate(() => {
          const w = window as unknown as { __glide: Array<[number, string]> };
          w.__glide = [];
          const orig = Element.prototype.animate;
          Element.prototype.animate = function (this: Element, k: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
            const col = document.querySelector('.top');
            if (this.parentElement === col) w.__glide.push([[...col!.children].indexOf(this), JSON.stringify(k)]);
            return orig.call(this, k, o);
          };
        });
        release();
        if (body.ratings.length) await expect(page.locator('.top .tagline')).toBeVisible();
        else await expect(page.locator('.top .rl')).toHaveCount(0); // the placeholder is gone
        await page.waitForTimeout(500); // the glide (320 ms) is over
        const after = await tops();
        const moved = before.map((y, i) => [i, after[i]! - y] as const).filter(([, d]) => Math.abs(d) > 5);
        expect(moved.length, 'the ratings block changed the column').toBeGreaterThan(0);
        const glides = await page.evaluate(() => (window as unknown as { __glide: Array<[number, string]> }).__glide);
        for (const [i, d] of moved) {
          const g = glides.find(([j]) => j === i);
          expect(g, `part ${i} of the column glides to its new place`).toBeTruthy();
          const from = Number(/translate3d\(0px, (-?[\d.]+)px/.exec(g![1])?.[1]);
          expect(Math.abs(from + d)).toBeLessThan(2); // it starts where it was
        }
      });
    }
  });

  test('⋯ menu Download opens the sheet while another tab is selected', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, downloads: { allowed: true, max: 5 } } }));
    await page.route('**/api/downloads', (r) => r.fulfill({ json: { downloads: [] } }));
    await page.route(/\/api\/downloads\/options\//, (r) => r.fulfill({ json: { allowed: true, qualities: [{ id: 'hd', label: 'HD', height: 1080, estBytes: 2e9 }], audio: [], subtitles: [], quota: { used: 0, max: 5 }, days: 30 } }));
    await mockAbout(page, NO_KEYS);
    await page.goto('/item/' + MOVIE.id);
    // by keyboard: a mouse click scrolls the tab into view, the tab switch scrolls the page back and leaves the pointer
    // over Play, whose hover prefetch (POST /api/playback/info, after 150 ms) then fires when the next step is slow
    await tablist(page).getByRole('tab', { name: 'Mehr davon' }).press('Enter');
    await expect(tablist(page).getByRole('tab', { name: 'Mehr davon' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('button', { name: 'Herunterladen', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Herunterladen' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('HD')).toBeVisible();
  });

  test('modal variant (phone: a title from "Mehr davon" opens in the popup): same tabs and ratings line', async ({ page }) => {
    await mockAbout(page, NO_KEYS);
    await page.setViewportSize({ width: 390, height: 844 }); // desktop has no popup (it navigates to the full page)
    await page.goto('/item/' + MOVIE.id);
    await tablist(page).getByRole('tab', { name: 'Mehr davon' }).click();
    await page.getByRole('tabpanel', { name: 'Mehr davon' }).getByRole('link', { name: /Interlace/ }).first().click();
    const modal = page.getByRole('dialog', { name: /Interlace/ });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('list', { name: 'Bewertungen' })).toContainText('Freunde 4,5 ★');
    await expect(modal.getByRole('tablist', { name: 'Weitere Inhalte' }).getByRole('tab')).toHaveText(['Details', 'Mehr davon']);
    await expect(modal.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    await expect(modal.getByRole('tabpanel', { name: 'Details' }).getByRole('link', { name: /^IMDb/ })).toBeVisible();
  });
});

test.describe('detail page: final review fixes', () => {
  test.use({ allowedConsole: /status of 500/ });
  const NOTICE = 'Dieses Produkt nutzt die TMDB-API, ist aber weder von TMDB unterstützt noch zertifiziert.';

  test('TMDB notice under the Details links only when TMDB data was used', async ({ page }) => {
    let body: object = WITH_KEYS;
    await mockAbout(page, (r) => r.fulfill({ json: body }));
    await page.goto('/item/' + MOVIE.id);
    const panel = await details(page);
    await expect(panel.getByText(NOTICE)).toBeVisible();
    await expect(panel.locator('.attrib img, .attrib svg')).toHaveCount(0);
    body = NO_KEYS;
    await page.goto('/item/' + MOVIE2.id);
    await expect((await details(page)).getByText('Wardell Pictures, Aster 9')).toBeVisible();
    await expect(page.getByText(NOTICE)).toHaveCount(0);
  });

  test('saving a rating updates the friends\' average in the ratings line', async ({ page }) => {
    let rated = false;
    await mockAbout(page, (r) => r.fulfill({ json: { ...NO_KEYS, ratings: [NO_KEYS.ratings[0], { key: 'friends', value: rated ? 3 : 4.5, max: 5, from: 'friends' }] } }));
    await page.route(/\/api\/items\/[0-9a-f]{32}\/rating$/, (r) => { rated = true; return r.fulfill({ json: { ok: true } }); });
    await page.route(/\/api\/items\/[0-9a-f]{32}\/ratings$/, (r) => r.fulfill({ json: rated
      ? { ratings: [{ userId: 'f1', name: 'Anna', stars: 5, review: null, mine: false }, { userId: 'me', name: 'Tester', stars: 1, review: null, mine: true }], average: 3 }
      : { ratings: [{ userId: 'f1', name: 'Anna', stars: 5, review: 'Super!', mine: false }], average: 4.5 } }));
    await page.goto('/item/' + MOVIE.id);
    await expect(ratingsLine(page)).toContainText('Freunde 4,5 ★');
    const panel = await details(page);
    await panel.getByRole('button', { name: /1 Stern/ }).first().click();
    await panel.getByRole('button', { name: 'Speichern' }).click();
    await expect(ratingsLine(page)).toContainText('Freunde 3,0 ★');
    await expect(ratingsLine(page)).not.toContainText('4,5');
  });

  test('a late about answer for the previous title never shows on the next one', async ({ page }) => {
    const NEXT = 'f'.repeat(32);
    let releaseA!: () => void, releaseB!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const gateB = new Promise<void>((r) => { releaseB = r; });
    let askedA = false, askedNextItem = false, answeredNext = false;
    await mockAbout(page, async (r) => {
      if (r.request().url().includes(NEXT)) { answeredNext = true; return r.fulfill({ status: 500, json: { error: 'x' } }); }
      askedA = true;
      await gateA;
      return r.fulfill({ json: WITH_KEYS });
    });
    await page.route(new RegExp(`/api/items/${NEXT}$`), async (r) => {
      askedNextItem = true;
      await gateB;
      return r.fulfill({ json: { item: { ...MOVIE2, id: NEXT, name: 'Nachzügler' }, inWatchlist: false, thumb: 0, langs: { audio: ['deu'], subs: [] } } });
    });
    await page.goto('/item/' + MOVIE.id);
    await expect.poll(() => askedA).toBe(true);
    // in-app navigation to a title that is not in the item cache: its item request is still open
    await page.evaluate((id) => { const a = document.createElement('a'); a.href = '/item/' + id; document.body.appendChild(a); a.click(); }, NEXT);
    await expect.poll(() => askedNextItem).toBe(true);
    releaseA(); // the previous title's about arrives now
    await page.waitForTimeout(200);
    releaseB();
    await expect(page.getByRole('heading', { level: 1, name: 'Nachzügler' })).toBeVisible();
    await expect.poll(() => answeredNext).toBe(true);
    await page.waitForTimeout(300);
    await expect(ratingsLine(page)).toHaveCount(0);
    await expect(page.getByText('IMDb 8,1')).toHaveCount(0);
    await expect(page.locator('.top .tagline')).toHaveCount(0);
  });
});

test.describe('detail page: TV', () => {
  // TV mode renders the scroll-free page (DetailTv, spec section 3): the tabs, cast row and collection row of the scrolling
  // page become sub-screens reached from the button list (tests/tv-detail.spec.ts covers the list itself)
  test('no tabs or scrolling sections: Down from Play walks the button list to the sub-screen links', async ({ page }) => {
    await mockAbout(page, NO_KEYS);
    await page.route('**/api/playback/info', (r) => r.fulfill({ json: {} })); // the focused play button prefetches the playback info
    await page.goto('/item/' + MOVIE.id + '?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const play = page.locator('.tvd .btns a.play');
    await expect(play).toBeFocused();
    await expect(page.locator('.dv .tabs, .dv section.cast, .dv .cap')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.tvd .btns a[href="/item/' + MOVIE.id + '/more"]')).toBeFocused();
  });

  test('with a collection: the list offers it as a sub-screen instead of the collection row', async ({ page }) => {
    const part = (o: object) => ({ image: true, played: false, current: false, inLibrary: true, from: 'jellyfin', ...o });
    const collection = { name: 'Matrix-Reihe', from: 'jellyfin', parts: [part({ id: SERIES.id, name: 'Teil Eins', played: true }), part({ id: MOVIE.id, name: MOVIE.name, current: true }), part({ id: items[4]!.id, name: 'Teil Drei' })] };
    await mockAbout(page, { ...NO_KEYS, collection });
    await page.route('**/api/playback/info', (r) => r.fulfill({ json: {} }));
    await page.goto('/item/' + MOVIE.id + '?tv=1');
    await expect(page.locator('.tvd .btns a.play')).toBeFocused();
    await expect(page.locator('.tvd .btns a[href="/item/' + MOVIE.id + '/collection"]')).toHaveCount(1);
    await expect(page.getByRole('region', { name: /Teil 2 von 3/ })).toHaveCount(0);
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
    // the pick leaves with location.href (a full document load to "/"), then boot() sends the kids profile on to /kids
    // (client-side). Wait for /kids, where the app has settled: a URL check on "not /profiles" passed at the commit of
    // "/", before the new document had a <body>, and the link click below must not race the app's own redirect.
    await page.waitForURL((u) => u.pathname === '/kids');
    // back to the same title: the kids profile gets its own answer, never the grown-up's cached friends' rating
    await page.evaluate((id) => { const a = document.createElement('a'); a.href = '/item/' + id; document.body.appendChild(a); a.click(); }, MOVIE.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Inkwell' })).toBeVisible();
    await expect(ratingsLine(page)).toContainText('★ 7,8');
    await expect(ratingsLine(page)).not.toContainText('Freunde');
    await expect(page.locator('.social')).toHaveCount(0);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });
});
