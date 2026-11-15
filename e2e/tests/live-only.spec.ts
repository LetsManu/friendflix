// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { ME, items } from '../mocks/fixtures.js';
import { asLgApp } from '../mocks/webos.js';

// A person without libraries (roles redesign §3.2, §6): /api/me.areas.library is false. Only Live TV and the account pages are left:
// the bar, the account menu, the footer, the TV rail and the start page offer no library page, a deep link to one lands on /live
// (replacing it), and the boot hint of the last answer keeps the library tabs from flashing in before /api/me is there.
// Anna Beispiel watches Nordlicht TV and Hafenkanal (mocks/livetv.ts).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const LIVE_ONLY = { library: false, livetv: true, requests: false, together: false, downloads: false } as const;
const nav = (page: Page) => page.getByRole('navigation', { name: 'Hauptnavigation' });
/** the paths a person without libraries may open (web/src/lib/gate.ts LIBRARY_FREE) */
const LIBRARY_FREE = /^\/(live|profiles|settings|devices|me|remote|offline|welcome|admin|invite|login|reset|restore|confirm-email|pending|setup|diagnose|tv|cast-receiver)(\/|$)/;
const noIntro = () => { localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };
/** the library API calls of the page (GET /api/library/**, the watchlist) */
function libraryCalls(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (/^\/api\/(library|watchlist|home)(\/|$)/.test(p)) seen.push(p); });
  return seen;
}
function liveOnly(api: MockState) {
  api.features = { livetv: true };
  api.areas = { ...LIVE_ONLY };
  api.canDownload = true; // the role may download, but downloads are library items: the account menu still has no Downloads
  api.accountSaved = { name: 'Anna Beispiel', avatar: 'a1' };
}
/** a remote key as a TV sends it: only keyCode is meaningful */
const press = (page: Page, keyCode: number) =>
  page.evaluate((keyCode) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { keyCode, key: 'Unidentified', bubbles: true, cancelable: true } as KeyboardEventInit)); }, keyCode);
/**
 * Records every frame in which a library tab, the categories, the search or a footer link off the allowlist is visible (opacity and
 * visibility counted): `window.__libSeen`.
 */
function watchLibraryControls() {
  const w = window as unknown as { __libSeen: string[] };
  w.__libSeen = [];
  const free = /^\/(live|profiles|settings|devices|me|remote|offline|welcome|admin|invite|login|reset|restore|confirm-email|pending|setup|diagnose|tv|cast-receiver)(\/|$)/;
  const look = () => {
    for (const el of document.querySelectorAll<HTMLElement>('nav[aria-label="Hauptnavigation"] a, nav[aria-label="Hauptnavigation"] button, footer a, header a[href="/search"]')) {
      const href = el.getAttribute('href');
      if (href && free.test(href)) continue;
      if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) w.__libSeen.push(href ?? el.textContent ?? '?');
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

test.describe('a person without libraries (desktop)', () => {
  test.beforeEach(async ({ page, api }) => {
    liveOnly(api);
    await mockLivePlayer(page);
    await page.addInitScript(noIntro);
    await page.clock.install({ time: NOW });
  });

  test('desktop bar shows only Live; account menu shows no library entries; footer has no library links', async ({ page }) => {
    const lib = libraryCalls(page);
    await page.goto('/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    await expect(nav(page).getByRole('link')).toHaveText(['Live-TV']);
    await expect(nav(page).getByRole('button', { name: 'Kategorien' })).toHaveCount(0); // genres and languages are library data
    await expect(page.getByRole('search')).toHaveCount(0); // the search looks through the library
    await expect(page.getByRole('link', { name: 'Nordlicht TV' }).or(page.getByRole('button', { name: /^1 Nordlicht TV/ })).first()).toBeVisible();

    await page.getByRole('button', { name: 'Profilmenü (Anna Beispiel)' }).click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    for (const name of ['Mein Bereich', 'Konto & Einstellungen', 'Geräte', 'Hilfe']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Überrasch mich' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Downloads' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const hrefs = await page.getByRole('contentinfo').getByRole('link').evaluateAll((l) => l.map((a) => a.getAttribute('href')!));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h, h).toMatch(LIBRARY_FREE);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Konto & Einstellungen' })).toBeAttached();
    // the logo goes where the start is for this person
    await page.getByRole('link', { name: 'FriendFlix Startseite' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    expect(lib).toEqual([]);
  });

  test('/ opens /live; deep links land on /live (replace, Back does not return)', async ({ page }) => {
    const lib = libraryCalls(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    for (const link of ['/', '/browse/movies', `/item/${items[0]!.id}`, '/watchlist', '/party']) {
      await page.goto(link);
      await expect(page, link).toHaveURL((u) => u.pathname === '/live');
      await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
      await page.goBack();
      await expect(page, `Back from ${link}`).toHaveURL((u) => u.pathname === '/settings');
    }
    // an in-app link to a library page (a notification, an old bookmark in the page) goes to Live TV before that page mounts
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/browse/series'; a.textContent = 'x'; document.querySelector('main')!.append(a); a.click(); });
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    expect(lib).toEqual([]);
  });

  test('boot with a hint library:false never renders the Start tab', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ff-boot-hint', JSON.stringify({ approved: true, multi: false, tv: false, profile: 'p1', lang: 'de', library: false, livetv: true })));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked = false;
    await page.route('**/api/me', async (r) => { asked = true; await held; await r.fallback(); });
    await page.goto('/live');
    // the page renders early from the hint: the bar is there while /api/me still waits, with Live TV and without a library tab;
    // the logo already goes to Live TV
    await expect(nav(page).getByRole('link')).toHaveText(['Live-TV']);
    expect(asked).toBe(true);
    await expect(page.getByRole('link', { name: 'FriendFlix Startseite' })).toHaveAttribute('href', '/live');
    await expect(page.getByRole('link', { name: 'Start', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Kategorien' })).toHaveCount(0);
    await expect(page.getByRole('search')).toHaveCount(0);
    release();
    await expect(nav(page).getByRole('link')).toHaveText(['Live-TV']);
    await expect(nav(page).getByRole('link', { name: 'Start' })).toHaveCount(0);
  });

  test('a stale hint (library) never shows a library tab when /api/me says there is none', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ff-boot-hint', JSON.stringify({ approved: true, multi: false, tv: false, profile: 'p1', lang: 'de' })));
    await page.addInitScript(watchLibraryControls);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/me', async (r) => { await held; await r.fallback(); });
    await page.goto('/');
    // the start page renders early from the hint; the library tabs are laid out but unseen
    await expect(page.getByRole('link', { name: 'FriendFlix Startseite' })).toBeVisible();
    // (unseen: out of the accessibility tree too, so found by its place in the bar)
    await expect(page.locator('nav.pill a[href="/browse/movies"]')).toBeAttached();
    await expect(page.locator('nav.pill a[href="/browse/movies"]')).toBeHidden();
    release();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(nav(page).getByRole('link')).toHaveText(['Live-TV']);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => (window as unknown as { __libSeen: string[] }).__libSeen)).toEqual([]);
  });

  test('a correct hint (library): the tabs wait unseen for /api/me, then fade in', async ({ page, api }) => {
    api.areas = undefined; // an account with libraries
    await page.addInitScript(() => localStorage.setItem('ff-boot-hint', JSON.stringify({ approved: true, multi: false, tv: false, profile: 'p1', lang: 'de', livetv: true })));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/me', async (r) => { await held; await r.fallback(); });
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const movies = page.locator('nav.pill a[href="/browse/movies"]'); // (unseen: out of the accessibility tree, so found by its place)
    await expect(movies).toBeAttached();
    await expect(movies).toBeHidden();
    const before = await movies.boundingBox();
    release();
    await expect(movies).toBeVisible();
    expect(await movies.boundingBox()).toEqual(before); // laid out in place all along: it only fades in
  });

  test('TV app: Back on Live TV (the home of a person without libraries) opens the rail, then leaves the app', async ({ page }) => {
    const lg = await asLgApp(page);
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, features: { livetv: true }, areas: { ...LIVE_ONLY } } }));
    await page.goto('/live?ff_app=webos');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const rail = page.locator('nav.rail');
    await expect(rail.locator('a.who')).toBeVisible();
    // the list puts the focus on the last watched channel once it has loaded; a Back before that races the focus move
    await expect(page.locator(':focus')).toHaveAccessibleName(/^12 Kinderinsel/);
    // ... and the layout's boot focus check (every 150 ms until the content holds the focus) has seen it and stopped
    await page.waitForTimeout(400);
    await press(page, 461);
    await expect(rail).toHaveClass(/open/);
    await expect(rail.locator(':focus')).toHaveCount(1);
    expect(await lg.backCalls()).toBe(0);
    await press(page, 461);
    await expect.poll(lg.backCalls).toBe(1);
  });

  test('/remote: pairing and the keys stay; no Weiterschauen, no search, no library call', async ({ page, api }) => {
    await page.routeWebSocket(/\/ws\/remote/, (ws) => { ws.send(JSON.stringify({ t: 'hello', tvOnline: true })); });
    // any library call fails the test through the fixture's unmocked-call check
    await page.route(/\/api\/library\//, (r) => { api.unmocked.add(`library call on /remote: ${new URL(r.request().url()).pathname}`); return r.fulfill({ json: { items: [] } }); });
    const lib = libraryCalls(page);
    await page.goto('/remote');
    await expect(page.getByText('Fernseher verbunden')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Steuerung' })).toBeVisible();
    await expect(page.getByText('Fernseher koppeln').or(page.getByText('Weiteren Fernseher koppeln')).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Weiter schauen' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Titel suchen' })).toHaveCount(0);
    await expect(page.getByRole('search')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(lib).toEqual([]);
  });

  test('TV: /tv goes to /live?play=last; the rail shows Live only', async ({ page }) => {
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, startLive: false, features: { livetv: true }, areas: { ...LIVE_ONLY } } }));
    const to = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname === '/live' && new URL(r.url()).search === '?play=last');
    await page.goto('/tv');
    await to;
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/live/);
    // the side bar (TV preview of the same person: the paired TV went on into the player, which has no rail)
    await page.unroute('**/api/me');
    await page.goto('/live?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const rail = page.getByRole('navigation', { name: 'Hauptmenü' });
    await expect(rail.getByRole('listitem')).toHaveCount(1);
    await expect(rail.getByRole('listitem').getByRole('link')).toHaveAttribute('href', '/live');
  });

  test('kids profile without library opens /live, not /kids', async ({ page }) => {
    const kid = { ...ME, profileCount: 1, kids: true, onboarded: true, features: { livetv: true }, areas: { ...LIVE_ONLY }, profile: { id: 'p1', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
    await page.route('**/api/me', (r) => r.fulfill({ json: kid }));
    await page.goto('/');
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await page.goto('/kids');
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Suchen' })).toHaveCount(0); // the kids search looks through the library
    // the kids rule still holds: no account, device or admin pages; the settings stay
    for (const p of ['/me', '/devices', '/admin']) {
      await page.goto(p);
      await expect(page, p).toHaveURL((u) => u.pathname === '/live');
    }
    await page.goto('/settings');
    await expect(page).toHaveURL((u) => u.pathname === '/settings');
  });

  test('kids profile with neither library nor channel stays on / (no redirect loop)', async ({ page, api }) => {
    api.features = { livetv: false };
    const kid = { ...ME, profileCount: 1, kids: true, onboarded: true, features: { livetv: false }, areas: { ...LIVE_ONLY, livetv: false }, profile: { id: 'p1', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
    await page.route('**/api/me', (r) => r.fulfill({ json: kid }));
    const paths: string[] = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) paths.push(new URL(f.url()).pathname); });
    await page.goto('/kids');
    await expect(page).toHaveURL((u) => u.pathname === '/');
    await expect(page.getByRole('heading', { name: 'Für dich ist noch nichts freigegeben' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(paths.slice(paths.indexOf('/'))).not.toContain('/kids'); // / never sends back to /kids
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('no library and no channel: the start page says so and calls no library endpoint', async ({ page, api }) => {
    api.features = { livetv: false };
    api.areas = { ...LIVE_ONLY, livetv: false };
    const lib = libraryCalls(page);
    await page.goto('/browse/movies');
    await expect(page).toHaveURL((u) => u.pathname === '/');
    await expect(page.getByRole('heading', { level: 1, name: 'Für dich ist noch nichts freigegeben' })).toBeVisible();
    await expect(page.getByText('Frag die Person, die FriendFlix betreibt.')).toBeVisible();
    await expect(page.locator('section.row')).toHaveCount(0);
    await expect(nav(page).getByRole('link')).toHaveCount(0);
    // a reload renders from the boot hint: still nothing from the library
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Für dich ist noch nichts freigegeben' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(lib).toEqual([]);
  });

  test('welcome without library has 2 steps', async ({ page }) => {
    let onboarded = false;
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, name: 'Anna Beispiel', profile: { ...ME.profile, name: 'Anna' }, onboarded, features: { livetv: true }, areas: { ...LIVE_ONLY } } }));
    await page.route('**/api/prefs/onboarded', (r) => { onboarded = true; return r.fulfill({ json: { onboarded: true } }); });
    const lib = libraryCalls(page);
    const channelGets: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/livetv/channels') channelGets.push(r.url()); });
    // the start page: straight on to /welcome with Live TV as the next page (Live TV does not mount first)
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome\?next=%2Flive$/);
    await expect(page.getByText('Schritt 1 von 2')).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Alles bereit!' })).toBeVisible();
    await expect(page.getByText('Schritt 2 von 2')).toBeVisible();
    expect(channelGets).toEqual([]);
    await page.getByRole('button', { name: "Los geht's" }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    expect(onboarded).toBe(true);
    expect(lib).toEqual([]);
  });
});
