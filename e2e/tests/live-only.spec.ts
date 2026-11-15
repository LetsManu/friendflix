// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { ME, items } from '../mocks/fixtures.js';

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
  api.accountSaved = { name: 'Anna Beispiel', avatar: 'a1' };
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
    await page.addInitScript(() => localStorage.setItem('ff-boot-hint', JSON.stringify({ approved: true, multi: false, tv: false, profile: 'p1', lang: 'de', library: false })));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked = false;
    await page.route('**/api/me', async (r) => { asked = true; await held; await r.fallback(); });
    await page.goto('/live');
    // the page renders early from the hint: the bar is there while /api/me still waits, without a single library tab
    await expect(page.getByRole('link', { name: 'FriendFlix Startseite' })).toBeVisible();
    expect(asked).toBe(true);
    await expect(page.getByRole('link', { name: 'Start', exact: true })).toHaveCount(0);
    await expect(nav(page).getByRole('link')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Kategorien' })).toHaveCount(0);
    await expect(page.getByRole('search')).toHaveCount(0);
    release();
    await expect(nav(page).getByRole('link')).toHaveText(['Live-TV']);
    await expect(nav(page).getByRole('link', { name: 'Start' })).toHaveCount(0);
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
  });

  test('kids profile with neither library nor channel stays on / (no redirect loop)', async ({ page, api }) => {
    api.features = { livetv: false };
    const kid = { ...ME, profileCount: 1, kids: true, onboarded: true, features: { livetv: false }, areas: { ...LIVE_ONLY, livetv: false }, profile: { id: 'p1', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
    await page.route('**/api/me', (r) => r.fulfill({ json: kid }));
    const paths: string[] = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) paths.push(new URL(f.url()).pathname); });
    await page.goto('/kids');
    await expect(page).toHaveURL((u) => u.pathname === '/');
    await page.waitForLoadState('networkidle');
    expect(paths.slice(paths.indexOf('/'))).not.toContain('/kids'); // / never sends back to /kids
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('welcome without library has 2 steps', async ({ page }) => {
    let onboarded = false;
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, name: 'Anna Beispiel', profile: { ...ME.profile, name: 'Anna' }, onboarded, features: { livetv: true }, areas: { ...LIVE_ONLY } } }));
    await page.route('**/api/prefs/onboarded', (r) => { onboarded = true; return r.fulfill({ json: { onboarded: true } }); });
    const lib = libraryCalls(page);
    await page.goto('/live');
    await expect(page).toHaveURL(/\/welcome\?next=%2Flive$/);
    await expect(page.getByText('Schritt 1 von 2')).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Alles bereit!' })).toBeVisible();
    await expect(page.getByText('Schritt 2 von 2')).toBeVisible();
    await page.getByRole('button', { name: "Los geht's" }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    expect(onboarded).toBe(true);
    expect(lib).toEqual([]);
  });
});
