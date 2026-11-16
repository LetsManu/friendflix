// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';
import { mockRecording, type MockRecording } from '../mocks/livetv.js';

// Finding the recordings (DVR follow-ups; the owner: "I didn't find a way to watch it from any menu"): the *Aufnahmen* row sat only at
// the bottom of /live, after the whole channel list. Now the desktop bar has *Aufnahmen* after Live-TV, the TV side bar too, /live's
// heading carries an *Aufnahmen* link in view, and the home page shows *Deine Aufnahmen* once something is finished. All of it only
// with Live TV for this profile. A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const nav = (page: Page) => page.getByRole('navigation', { name: 'Hauptnavigation' });
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, features: { livetv: true }, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

async function arm(page: Page, api: MockState, recs: MockRecording[] = []) {
  api.features = { livetv: true };
  api.livetv.recordings = recs;
  await mockLivePlayer(page);
  await page.clock.install({ time: NOW });
}

test.describe('finding the recordings', () => {
  test('desktop bar: Aufnahmen follows Live-TV and is the one active tab on its pages', async ({ page, api }) => {
    await arm(page, api);
    await page.goto('/');
    await expect(nav(page).getByRole('link', { name: 'Aufnahmen' })).toBeVisible();
    const labels = await nav(page).getByRole('link').allTextContents();
    expect(labels.indexOf('Aufnahmen')).toBe(labels.indexOf('Live-TV') + 1);
    await nav(page).getByRole('link', { name: 'Aufnahmen' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
    await expect(page.getByRole('heading', { level: 1, name: 'Meine Aufnahmen' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Aufnahmen' })).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).getByRole('link', { name: 'Live-TV' })).not.toHaveAttribute('aria-current', 'page');
    // on Live TV itself the Live-TV tab is the active one
    await nav(page).getByRole('link', { name: 'Live-TV' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live');
    await expect(nav(page).getByRole('link', { name: 'Live-TV' })).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).getByRole('link', { name: 'Aufnahmen' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('without Live TV there is no Aufnahmen entry', async ({ page, api }) => {
    api.features = { livetv: false };
    await page.goto('/');
    await expect(nav(page).getByRole('link', { name: 'Filme' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Aufnahmen' })).toHaveCount(0);
    await page.goto('/me');
    await expect(page.getByRole('main').getByRole('link', { name: 'Einstellungen', exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Aufnahmen', exact: true })).toHaveCount(0);
  });

  test('/live: the heading carries an Aufnahmen link, in view without scrolling', async ({ page, api }) => {
    await arm(page, api, [mockRecording({ start: at(11, 20), end: at(11, 21) })]);
    await page.goto('/live');
    const link = page.getByRole('main').getByRole('link', { name: 'Aufnahmen', exact: true });
    await expect(link).toBeVisible();
    const b = (await link.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.y + b.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    // the heading row keeps its height: the link fits in it
    const h1 = (await page.getByRole('heading', { level: 1, name: 'Live-TV' }).boundingBox())!;
    expect(Math.abs(b.y + b.height / 2 - (h1.y + h1.height / 2))).toBeLessThan(6);
    await link.click();
    await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
    await expect(page.getByRole('heading', { level: 1, name: 'Meine Aufnahmen' })).toBeVisible();
  });

  test('a kids profile\'s /live has no Aufnahmen link (its row of shared recordings stays as it was)', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    await arm(page, api);
    await page.goto('/live');
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Aufnahmen', exact: true })).toHaveCount(0);
  });

  test('home: Deine Aufnahmen shows the finished recordings and opens them', async ({ page, api }) => {
    const done = mockRecording({ title: 'Sternstunde Physik', seriesKey: 'sternstunde physik', start: at(11, 20), end: at(11, 21) });
    const partial = mockRecording({ start: at(10, 20), end: at(10, 21), state: 'partial', gaps: 1 });
    const running = mockRecording({ title: 'Wetter am Hafen', seriesKey: 'wetter', state: 'recording', growing: true, start: at(12, 20, 15), end: at(12, 21) });
    const planned = mockRecording({ title: 'Hafenrunde', seriesKey: 'hafen', state: 'scheduled', start: at(12, 22), end: at(12, 23), bytes: 0, durationS: null });
    await arm(page, api, [planned, running, done, partial]);
    await page.goto('/');
    const row = page.getByRole('region', { name: 'Deine Aufnahmen' });
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole('heading', { name: 'Deine Aufnahmen' })).toBeVisible();
    // finished ones only, newest first (the running and the planned one are not finished)
    await expect(row.getByRole('listitem')).toHaveCount(2);
    await expect(row.getByRole('listitem').nth(0)).toContainText('Sternstunde Physik');
    await expect(row.getByRole('listitem').nth(1)).toContainText('Die Leuchtturmwärter');
    await expect(row.getByRole('link', { name: 'Alle' })).toHaveAttribute('href', '/live/recordings');
    await Promise.all([
      page.waitForURL((u) => u.pathname === `/live/recordings/${done.id}`, { waitUntil: 'commit' }),
      row.getByRole('button', { name: 'Abspielen: Sternstunde Physik' }).click(),
    ]);
  });

  test('home: no row while nothing is finished, and no request without Live TV', async ({ page, api }) => {
    await arm(page, api, [mockRecording({ title: 'Hafenrunde', state: 'scheduled', start: at(12, 22), end: at(12, 23), bytes: 0, durationS: null })]);
    await page.goto('/');
    await expect.poll(() => api.livetv.recLists).toEqual(['state=done']);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('region', { name: 'Deine Aufnahmen' })).toHaveCount(0);
    // Live TV off: the home page does not ask
    api.features = { livetv: false };
    api.livetv.recLists = [];
    await page.reload();
    await expect(nav(page).getByRole('link', { name: 'Filme' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(api.livetv.recLists).toEqual([]);
  });

  test('home: with finished recordings last time the row\'s room is held while it loads, so nothing below jumps', async ({ page, api }) => {
    await arm(page, api, [mockRecording({ title: 'Sternstunde Physik', start: at(11, 20), end: at(11, 21) })]);
    await page.addInitScript(() => localStorage.setItem('ff-home-recs:p1', '1'));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/livetv/recordings?*', async (r) => { await held; await r.fallback(); });
    await page.goto('/');
    const row = page.getByRole('region', { name: 'Deine Aufnahmen' });
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await row.scrollIntoViewIfNeeded();
    const before = await row.boundingBox();
    release();
    await expect(row.getByRole('listitem')).toHaveCount(1);
    await expect(row).not.toHaveAttribute('aria-busy', 'true');
    const after = (await row.boundingBox())!;
    expect(Math.abs(after.y - before!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - before!.height)).toBeLessThanOrEqual(8);
    // nothing finished any more: the hint goes, next time nothing is held
    api.livetv.recordings = [];
    await page.unroute('**/api/livetv/recordings?*');
    await page.reload();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ff-home-recs:p1'))).toBeNull();
    await expect(row).toHaveCount(0);
  });

  test('TV: /live never shows the heading\'s Aufnahmen link, not even for a frame', async ({ page, api }) => {
    await arm(page, api);
    await page.addInitScript(() => {
      const w = window as unknown as { __seen: boolean };
      w.__seen = false;
      const look = () => { if (document.querySelector('main a.recs')) w.__seen = true; requestAnimationFrame(look); };
      requestAnimationFrame(look);
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/live?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Live-TV' })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __seen: boolean }).__seen)).toBe(false);
  });

  test('TV side bar: Aufnahmen follows Live-TV and opens Meine Aufnahmen', async ({ page, api }) => {
    await arm(page, api, [mockRecording({ start: at(11, 20), end: at(11, 21) })]);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/live?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const rail = page.getByRole('navigation', { name: 'Hauptmenü' });
    const hrefs = await rail.getByRole('listitem').getByRole('link').evaluateAll((l) => l.map((a) => a.getAttribute('href')));
    expect(hrefs.indexOf('/live/recordings')).toBe(hrefs.indexOf('/live') + 1);
    await rail.locator('a[href="/live/recordings"]').click();
    await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
    await expect(rail.locator('a[href="/live/recordings"]')).toHaveAttribute('aria-current', 'page');
    await expect(rail.locator('a[href="/live"]')).not.toHaveAttribute('aria-current', 'page');
  });
});
