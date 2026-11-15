// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';
import { mockRecording, type MockRecording } from '../mocks/livetv.js';

// The *Aufnahmen* row of the Live-TV tab and *Meine Aufnahmen* (Phase 3 Task 8, spec §15.7): the row shows the profile's latest 12
// recordings (a red dot and "läuft" while one records, a progress line once started), *Alle* opens /live/recordings on *Fertig*:
// grouped by series with episode lists, singles by date; *Behalten* toggles in place, *Löschen* waits 5 s behind an undo toast,
// *Geplant* cancels and shows the *Konflikt* chip, *Serien* the rules; *Neue Aufnahme* plans by time (weekday chips = a time rule).
// Kids profiles get a read-only row of shared recordings. A TV moves between tiles with the D-pad and plays with OK.
// A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const row = (page: Page) => page.getByRole('region', { name: 'Aufnahmen' });
const tiles = (page: Page) => row(page).getByRole('listitem');
const items = (page: Page) => page.locator('li.ritem');
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, features: { livetv: true }, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

async function arm(page: Page, api: MockState, recs: MockRecording[]) {
  api.features = { livetv: true };
  api.livetv.recordings = recs;
  await mockLivePlayer(page);
  await page.clock.install({ time: NOW });
}
const box = async (l: Locator) => (await l.boundingBox())!;

test.describe('Aufnahmen row and Meine Aufnahmen', () => {
  test('row shows the latest recordings with a running dot', async ({ page, api }) => {
    const done = Array.from({ length: 13 }, (_, i) => mockRecording({ title: `Folge ${i + 1}`, start: at(11 - Math.floor(i / 3), 18 - (i % 3)), end: at(11 - Math.floor(i / 3), 19 - (i % 3)), durationS: 2700, positionS: i === 0 ? 900 : 0 }));
    const running = mockRecording({ title: 'Die Leuchtturmwärter und das Licht der langen Nacht', state: 'recording', growing: true, start: at(12, 20, 15), end: at(12, 21) });
    const planned = mockRecording({ title: 'Wetter am Hafen', state: 'scheduled', start: at(12, 21), end: at(12, 21, 30), bytes: 0, durationS: null });
    await arm(page, api, [planned, running, ...done]);
    await page.goto('/live');
    await expect(row(page).getByRole('heading', { name: 'Aufnahmen' })).toBeVisible();
    await expect(tiles(page)).toHaveCount(12);
    // newest first, the planned one is not a tile
    await expect(tiles(page).nth(0)).toContainText('Die Leuchtturmwärter und das Licht der langen Nacht');
    await expect(tiles(page).nth(0)).toContainText('läuft');
    await expect(tiles(page).nth(0).locator('.rdot')).toHaveCount(1);
    await expect(tiles(page).nth(1)).toContainText('Folge 1');
    await expect(tiles(page).nth(1)).toContainText('45 Min.');
    await expect(row(page).getByText('Wetter am Hafen')).toHaveCount(0);
    await expect(tiles(page).nth(1).locator('.rdot')).toHaveCount(0);
    // the progress line is reserved on every tile; it shows the part seen
    await expect(tiles(page).locator('.pg')).toHaveCount(12);
    expect(await tiles(page).nth(1).locator('.pg i').evaluate((e) => getComputedStyle(e).transform)).toMatch(/matrix\(0\.333/);
    const h = await Promise.all([0, 1, 2].map(async (i) => (await box(tiles(page).nth(i))).height));
    expect(new Set(h.map(Math.round)).size).toBe(1);
    // every tile's picture fills its tile, whatever its title (the grid track is minmax(0, 1fr): the button's centred content never shrinks it)
    for (const i of [0, 1, 11]) expect(Math.round((await box(tiles(page).nth(i).locator('.pic'))).width), String(i)).toBe(Math.round((await box(tiles(page).nth(i))).width));
  });

  test('Alle opens Meine Aufnahmen on Fertig', async ({ page, api }) => {
    await arm(page, api, [mockRecording({})]);
    await page.goto('/live');
    await row(page).getByRole('link', { name: 'Alle' }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/live/recordings');
    await expect(page.getByRole('heading', { level: 1, name: 'Meine Aufnahmen' })).toBeVisible();
    const seg = page.getByRole('group', { name: 'Ansicht' });
    await expect(seg.getByRole('button')).toHaveText(['Fertig', 'Geplant', 'Serien']);
    await expect(seg.getByRole('button', { name: 'Fertig' })).toHaveAttribute('aria-pressed', 'true');
    await expect(items(page)).toHaveCount(1);
  });

  test('series group lists episodes', async ({ page, api }) => {
    const ep = (d: number, ep: string) => mockRecording({ ruleId: 'rule-1', subtitle: ep, start: at(d, 20, 15), end: at(d, 21) });
    await arm(page, api, [ep(5, 'Sturmnacht'), mockRecording({ title: 'Sternstunde Physik', seriesKey: 'sternstunde physik', start: at(9, 22), end: at(9, 23) }), ep(11, 'Nebelhorn'), ep(8, 'Flaute')]);
    await page.goto('/live/recordings');
    const group = page.getByRole('region', { name: 'Die Leuchtturmwärter' });
    await expect(group.getByRole('heading', { name: 'Die Leuchtturmwärter' })).toBeVisible();
    await expect(group).toContainText('3 Folgen');
    await expect(group.locator('li.ritem .sub')).toHaveText(['Nebelhorn', 'Flaute', 'Sturmnacht']);
    // the single stands on its own, after the group (its newest episode is newer)
    const all = await items(page).locator('.ti').allTextContents();
    expect(all.at(-1)).toBe('Sternstunde Physik');
  });

  test('Behalten toggles in place without layout shift', async ({ page, api }) => {
    const r = mockRecording({});
    await arm(page, api, [r, mockRecording({ title: 'Sternstunde Physik', seriesKey: 'x', start: at(10, 9), end: at(10, 10) })]);
    await page.goto('/live/recordings');
    const it = items(page).first();
    const keep = it.getByRole('button', { name: 'Behalten' });
    await expect(keep).toHaveAttribute('aria-pressed', 'false');
    const before = [await box(it), await box(keep), await box(items(page).nth(1))];
    await keep.click();
    await expect(keep).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => api.livetv.recCalls).toEqual([`PATCH /api/livetv/recordings/${r.id} {"keep":true}`]);
    const after = [await box(it), await box(keep), await box(items(page).nth(1))];
    for (let i = 0; i < 3; i++) for (const k of ['x', 'y', 'width', 'height'] as const) expect(after[i]![k]).toBeCloseTo(before[i]![k], 0);
  });

  test('Löschen undo within 5 s sends nothing', async ({ page, api }) => {
    const r = mockRecording({});
    await arm(page, api, [r]);
    await page.goto('/live/recordings');
    await page.clock.pauseAt(NOW.getTime() + 2_000);
    await items(page).first().getByRole('button', { name: 'Löschen' }).click();
    await expect(items(page)).toHaveCount(0);
    const t = page.getByRole('region', { name: 'Hinweise' });
    await expect(t.getByText('Aufnahme gelöscht')).toBeVisible();
    await page.clock.runFor(3_000);
    await t.getByRole('button', { name: 'Rückgängig' }).click();
    await expect(items(page)).toHaveCount(1);
    await page.clock.runFor(6_000);
    expect(api.livetv.recCalls).toEqual([]);
    // without the undo, the DELETE goes after 5 s
    await items(page).first().getByRole('button', { name: 'Löschen' }).click();
    await page.clock.runFor(4_500);
    expect(api.livetv.recCalls).toEqual([]);
    await page.clock.runFor(1_000);
    await expect.poll(() => api.livetv.recCalls).toEqual([`DELETE /api/livetv/recordings/${r.id}`]);
  });

  test('Geplant cancel', async ({ page, api }) => {
    const a = mockRecording({ title: 'Wetter am Hafen', state: 'scheduled', start: at(12, 21), end: at(12, 21, 30), bytes: 0, durationS: null, conflict: true });
    const b = mockRecording({ title: 'Sternstunde Physik', state: 'scheduled', start: at(13, 21), end: at(13, 22), bytes: 0, durationS: null, conflict: false });
    await arm(page, api, [a, b]);
    await page.goto('/live/recordings');
    await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Geplant' }).click();
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(0)).toContainText('Konflikt');
    await expect(items(page).nth(1)).not.toContainText('Konflikt');
    await items(page).nth(0).getByRole('button', { name: 'Abbrechen' }).click();
    await expect.poll(() => api.livetv.recCalls).toEqual([`DELETE /api/livetv/recordings/${a.id}`]);
    await expect(items(page)).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Aufnahme abgebrochen')).toBeVisible();
  });

  test('Geplant asks for the forecast; an unknown verdict (null) shows no chip', async ({ page, api }) => {
    const a = mockRecording({ title: 'Wetter am Hafen', state: 'scheduled', start: at(12, 21), end: at(12, 21, 30), bytes: 0, durationS: null, conflict: null });
    await arm(page, api, [a]);
    await page.goto('/live/recordings');
    await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Geplant' }).click();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page).first()).not.toContainText('Konflikt');
    expect(api.livetv.recLists.some((q) => q.includes('conflicts=1'))).toBe(true);
  });

  test('an owner without liveRecord keeps watching, narrowing and deleting; nothing that would be refused is offered', async ({ page, api }) => {
    api.perms = { liveRecord: false };
    const r = mockRecording({ visibility: 'account' });
    await arm(page, api, [r]);
    api.livetv.recLibraryExport = true;
    api.livetv.rules = [{ id: 'rule-1', kind: 'series', channelId: null, seriesKey: 'die leuchtturmwärter', title: 'Die Leuchtturmwärter', onlyNew: true, keepMax: 5, padBefore: null, padAfter: null, weekdays: null, startTime: null, durationMin: null, tz: null, enabled: true }];
    await page.goto('/live/recordings');
    const it = items(page).first();
    await expect(it.getByRole('button', { name: /^Abspielen/ })).toBeVisible();
    await expect(it.getByRole('button', { name: 'Behalten' })).toHaveCount(0);
    await expect(it.getByRole('button', { name: 'Behalten → in Bibliothek' })).toHaveCount(0);
    await it.getByRole('button', { name: 'Teilen …' }).click();
    // only a narrower audience: "Mit allen" would widen it
    await expect(it.getByRole('group', { name: 'Teilen …' }).getByRole('button')).toHaveText(['Nur für mich', 'Mit meinem Konto']);
    await it.getByRole('button', { name: 'Nur für mich' }).click();
    await expect.poll(() => api.livetv.recCalls).toEqual([`PATCH /api/livetv/recordings/${r.id} {"visibility":"private"}`]);
    await expect(it.getByRole('button', { name: 'Löschen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Neue Aufnahme' })).toHaveCount(0);
    // the series rules are read-only
    await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Serien' }).click();
    const rule = page.getByRole('region', { name: 'Die Leuchtturmwärter' });
    await expect(rule).toContainText('Höchstens 5 behalten');
    await expect(rule.getByRole('switch')).toHaveCount(0);
    await expect(rule.getByRole('button')).toHaveCount(0);
  });

  test('Behalten → in Bibliothek only when the server can export (mode both), and it keeps the recording', async ({ page, api }) => {
    const r = mockRecording({});
    await arm(page, api, [r, mockRecording({ title: 'Sternstunde Physik', seriesKey: 'x', start: at(10, 9), end: at(10, 10), state: 'recording', growing: true })]);
    await page.goto('/live/recordings');
    await expect(items(page).first().getByRole('button', { name: 'Behalten' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Behalten → in Bibliothek' })).toHaveCount(0);
    api.livetv.recLibraryExport = true;
    await page.reload();
    // a finished recording only (the running one cannot be exported yet)
    await expect(page.getByRole('button', { name: 'Behalten → in Bibliothek' })).toHaveCount(1);
    await items(page).first().getByRole('button', { name: 'Behalten → in Bibliothek' }).click();
    await expect.poll(() => api.livetv.recCalls).toEqual([`POST /api/livetv/recordings/${r.id}/library`]);
    await expect(items(page).first().getByRole('button', { name: 'Behalten', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('In der Bibliothek behalten')).toBeVisible();
  });

  test('Serien lists the rules with their settings', async ({ page, api }) => {
    await arm(page, api, []);
    api.livetv.rules = [{ id: 'rule-1', kind: 'series', channelId: null, seriesKey: 'die leuchtturmwärter', title: 'Die Leuchtturmwärter', onlyNew: true, keepMax: 5, padBefore: null, padAfter: null, weekdays: null, startTime: null, durationMin: null, tz: null, enabled: true }];
    await page.goto('/live/recordings');
    await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Serien' }).click();
    const r = page.getByRole('region', { name: 'Die Leuchtturmwärter' });
    await expect(r).toContainText('Alle Sender');
    await expect(r).toContainText('Höchstens 5 behalten');
    await r.getByRole('switch', { name: 'Nur neue Folgen' }).click();
    await expect.poll(() => api.livetv.recCalls).toEqual(['PATCH /api/livetv/rules/rule-1 {"onlyNew":false}']);
  });

  test('Neue Aufnahme with weekdays creates a time rule', async ({ page, api }) => {
    await arm(page, api, []);
    await page.goto('/live/recordings');
    await page.getByRole('button', { name: 'Neue Aufnahme' }).click();
    const s = page.getByRole('dialog', { name: 'Neue Aufnahme' });
    await s.getByLabel('Sender').selectOption({ label: '4 Hafenkanal' });
    await s.getByLabel('Beginn').fill('20:15');
    await s.getByLabel('Dauer (Minuten)').fill('45');
    await s.getByRole('button', { name: 'Mo' }).click();
    await s.getByRole('button', { name: 'Mi' }).click();
    await expect(s.getByRole('button', { name: 'Mi' })).toHaveAttribute('aria-pressed', 'true');
    await s.getByLabel('Titel').fill('Hafenrunde');
    await s.getByRole('button', { name: 'Aufnahme planen' }).click();
    await expect.poll(() => api.livetv.recCalls.length).toBe(1);
    const body = JSON.parse(api.livetv.recCalls[0]!.replace(/^POST \/api\/livetv\/rules /, ''));
    expect(body).toEqual({ kind: 'time', channelId: 'ch-hafen', weekdays: [1, 3], startTime: '20:15', durationMin: 45, tz: expect.any(String), title: 'Hafenrunde' });
    await expect(s).toHaveCount(0);
  });

  test('Neue Aufnahme without weekdays plans one recording by time', async ({ page, api }) => {
    await arm(page, api, []);
    await page.goto('/live/recordings');
    await page.getByRole('button', { name: 'Neue Aufnahme' }).click();
    const s = page.getByRole('dialog', { name: 'Neue Aufnahme' });
    await s.getByLabel('Sender').selectOption({ label: '21 Sternwarte 24' });
    await s.getByLabel('Datum').fill('2026-11-13');
    await s.getByLabel('Beginn').fill('06:30');
    await s.getByLabel('Dauer (Minuten)').fill('90');
    await s.getByRole('button', { name: 'Aufnahme planen' }).click();
    await expect.poll(() => api.livetv.recCalls.length).toBe(1);
    const body = JSON.parse(api.livetv.recCalls[0]!.replace(/^POST \/api\/livetv\/recordings /, ''));
    expect(body).toEqual({ channelId: 'ch-stern', start: new Date(2026, 10, 13, 6, 30).toISOString(), end: new Date(2026, 10, 13, 8, 0).toISOString(), title: 'Sternwarte 24' });
  });

  test('kids row shows only shared recordings, no actions', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    // the server sends only shares of kid-friendly channels
    await arm(page, api, [mockRecording({ title: 'Abenteuer Wattenmeer', mine: false, visibility: 'account', channel: { id: 'ch-kinder', name: 'Kinderinsel', logo: null } })]);
    await page.goto('/live');
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page).first()).toContainText('Abenteuer Wattenmeer');
    await expect(row(page).getByRole('link', { name: 'Alle' })).toHaveCount(0);
    await expect(row(page).getByRole('button')).toHaveCount(1); // the tile itself plays; nothing else
    await expect(row(page).getByText('Löschen')).toHaveCount(0);
  });

  test('the row is hidden without recordings and without liveRecord', async ({ page, api }) => {
    api.perms = { liveRecord: false };
    await arm(page, api, []);
    await page.goto('/live');
    await expect(page.getByRole('list', { name: 'Senderliste' }).getByRole('listitem')).toHaveCount(6);
    await expect(row(page)).toHaveCount(0);
  });
});

test('the loading rows have the height of real rows (nothing jumps when the list arrives)', async ({ page, api }) => {
  const r = mockRecording({ title: 'Die Leuchtturmwärter', start: at(11, 20), end: at(11, 21) });
  await arm(page, api, [r]);
  let release: () => void = () => undefined;
  const held = new Promise<void>((x) => { release = x; });
  await page.route('**/api/livetv/recordings?*', async (route) => { await held; await route.fallback(); });
  await page.goto('/live/recordings');
  const sk = page.locator('li.sk').first();
  await expect(sk).toBeVisible();
  const hs = (await box(sk)).height;
  release();
  const item = page.locator('li.ritem').first();
  await expect(item).toBeVisible();
  expect(Math.abs((await box(item)).height - hs)).toBeLessThanOrEqual(8);
});

test.describe('Meine Aufnahmen on a TV', () => {
  test('arrow keys move between tiles and OK plays', async ({ page, api }) => {
    const a = mockRecording({ title: 'Die Leuchtturmwärter', start: at(11, 20), end: at(11, 21) });
    const b = mockRecording({ title: 'Sternstunde Physik', seriesKey: 'sternstunde physik', start: at(10, 20), end: at(10, 21) });
    await arm(page, api, [a, b]);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/live/recordings?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    const tv = page.locator('.rtile');
    await expect(tv).toHaveCount(2);
    await expect(tv.nth(0)).toBeFocused();
    expect((await box(tv.nth(0))).height).toBeGreaterThanOrEqual(54);
    // TV text at least 28 px (at 1920 px)
    expect(parseFloat(await tv.nth(0).locator('.meta').evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
    await page.keyboard.press('ArrowRight');
    await expect(tv.nth(1)).toBeFocused();
    expect(await tv.nth(1).evaluate((e) => getComputedStyle(e).transform)).toMatch(/matrix\(1\.08/);
    await expect(page.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('ArrowLeft');
    await expect(tv.nth(0)).toBeFocused();
    await Promise.all([page.waitForURL((u) => u.pathname === `/live/recordings/${a.id}`, { waitUntil: 'commit' }), page.keyboard.press('Enter')]);
  });
});
