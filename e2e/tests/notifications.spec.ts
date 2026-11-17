// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { addNote, prevMonthLabel } from '../mocks/notes.js';

/**
 * The notifications center (spec 2026-11-17, variant B): the bell opens a right-hand sheet with sections, groups and filter chips;
 * opening reads nothing; a group opens in place; the next page loads into reserved room at the end; a clear can be undone;
 * new entries show as a pill in its reserved slot; nothing above the reading position moves. 1440×900, the suite's motion.
 */
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(({ api }) => { api.notes.legacyFromFeed = true; }); // the bell's count follows the feed (8 unread)

const bell = (page: Page) => page.locator('[data-desk-bar]').getByRole('button', { name: /Benachrichtigungen/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Benachrichtigungen' });
const rows = (page: Page) => sheet(page).locator('li.nr');
const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const TV = 'Ein Fernseher wurde mit deinem Konto verbunden';
const END = /Das waren alle\. Mitteilungen werden nach 90 Tagen entfernt\./;

async function box(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}
const scrollList = (page: Page, top: number | 'end') => sheet(page).locator('.list').evaluate((el, t) => { el.scrollTop = t === 'end' ? el.scrollHeight : t; }, top);
const reads = (log: string[]) => log.filter((l) => l.startsWith('POST /api/notifications/read'));

async function open(page: Page) {
  await page.goto('/watchlist');
  await bell(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(rowOf(page, TV)).toBeVisible();
  // the sheet's own slide or fade has ended (the skeleton shimmer below it runs forever)
  await expect.poll(() => sheet(page).evaluate((el) => el.getAnimations().length)).toBe(0);
}

test.describe('notifications center', () => {
  test('the bell opens the sheet with sections, groups and chips; the header stays put', async ({ page }) => {
    await open(page);
    const s = sheet(page);
    await expect(s).toHaveAttribute('aria-modal', 'true');
    await expect(s.getByRole('heading', { level: 3, name: 'Heute' })).toBeVisible();
    await expect(s.getByRole('heading', { level: 3, name: 'Diese Woche' })).toBeVisible();
    await expect(s.getByRole('heading', { level: 3, name: prevMonthLabel() })).toHaveCount(1);
    // six "TV connected" entries are one row with a count, unread
    await expect(rowOf(page, TV)).toHaveCount(1);
    await expect(rowOf(page, TV).locator('.cnt')).toHaveText('6×');
    await expect(rowOf(page, TV).locator('button.main')).toHaveAccessibleName(new RegExp(`^${TV}, 6, neu, `));
    await expect(rowOf(page, TV).getByRole('link', { name: `Geräte prüfen: ${TV}` })).toHaveAttribute('href', '/devices');
    // a single entry with a link is that link (its action pill is for the pointer only); a read one without a link is plain text
    const dl = rowOf(page, 'Nordlicht ist bereit');
    await expect(dl.getByRole('link', { name: /^Nordlicht ist bereit, neu, / })).toHaveAttribute('href', '/downloads');
    await expect(dl.getByRole('link', { name: 'Ansehen: Nordlicht ist bereit' })).toHaveCount(0);
    await expect(dl.locator('a.act')).toHaveAttribute('tabindex', '-1');
    const still = rowOf(page, 'Neues Achievement: Nachteule');
    await expect(still.getByRole('link')).toHaveCount(0);
    await expect(still.getByRole('button', { name: /Nachteule, / })).toHaveCount(0);
    await expect(still.locator('.main')).toContainText('Fünf Filme nach Mitternacht.');
    // Alle, Ungelesen, then the categories with entries (none in "Sonstiges")
    await expect(s.getByRole('group', { name: 'Benachrichtigungen' }).getByRole('button')).toHaveText(['Alle', 'Ungelesen', 'Downloads', 'Geräte', 'Serien & Filme', 'Achievements', 'Live TV', 'System', 'Wünsche', 'Freunde']);
    await expect(s.getByRole('button', { name: 'Alle', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(s.getByTestId('notes-unread')).toHaveText('8 neu');
    await expect(s.getByRole('link', { name: 'Einstellungen' })).toHaveAttribute('href', '/settings#push');
    await expect(s.getByRole('button', { name: 'Alles leeren' })).toBeEnabled();

    const head = await box(s.locator('header'));
    const chips = await box(s.getByRole('group', { name: 'Benachrichtigungen' }));
    await expect.poll(async () => { await scrollList(page, 'end'); return s.getByText(END).isVisible(); }).toBe(true);
    await expect(rows(page)).toHaveCount(70);
    expect(await box(s.locator('header'))).toEqual(head);
    expect(await box(s.getByRole('group', { name: 'Benachrichtigungen' }))).toEqual(chips);
  });

  test('opening no longer marks everything read', async ({ page, api }) => {
    await open(page);
    await page.waitForTimeout(400);
    expect(reads(api.log)).toEqual([]);
    await expect(rowOf(page, TV).locator('.udot')).toHaveCount(1);
    await expect(bell(page).locator('.dot')).toHaveText('8');
  });

  test('a group opens in place and lists its entries', async ({ page, api }) => {
    await open(page);
    const tv = rowOf(page, TV);
    const main = tv.locator('button.main');
    const below = await box(rowOf(page, 'Nordlicht ist bereit'));
    await expect(main).toHaveAttribute('aria-expanded', 'false');
    await main.click();
    await expect(main).toHaveAttribute('aria-expanded', 'true');
    await expect(tv.locator('.items li')).toHaveCount(6);
    await expect(tv.locator('.items li').first()).toContainText('Ein Fernseher');
    // opening it reads the group (not everything)
    await expect(main).not.toHaveAccessibleName(/, neu, /);
    await expect.poll(() => reads(api.log).length).toBe(1);
    expect(reads(api.log)[0]).toContain('"groups"');
    await expect(sheet(page).getByTestId('notes-unread')).toHaveText('2 neu');
    await expect(bell(page).locator('.dot')).toHaveText('2'); // the layout reloaded the count
    // the rows below make room, the row itself stays where it was
    expect((await box(rowOf(page, 'Nordlicht ist bereit'))).y).toBeGreaterThan(below.y);
    await main.click();
    await expect(tv.locator('.items')).toHaveCount(0);
    expect(await box(rowOf(page, 'Nordlicht ist bereit'))).toEqual(below);
  });

  test('scrolling loads more below; rows above keep their position', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/notifications\/feed\?.*cursor=30/, async (r) => { await gate; await r.fallback(); });
    await open(page);
    const s = sheet(page);
    await expect(rows(page)).toHaveCount(30);
    await scrollList(page, 'end');
    // the next page's room: two skeleton rows at the end, already there
    await expect(s.locator('.tail .sk')).toHaveCount(2);
    const tail = await box(s.locator('.tail'));
    const first = await box(rows(page).first());
    const last = await box(rowOf(page, 'Folge 41')); // the 30th group, the last of page 1
    release();
    await expect(rows(page)).toHaveCount(60);
    expect(await box(rows(page).first())).toEqual(first);
    expect(await box(rowOf(page, 'Folge 41'))).toEqual(last);
    // page 3, then the end text in the same room as the skeleton rows
    await expect.poll(async () => { await scrollList(page, 'end'); return rows(page).count(); }).toBe(70);
    await expect(s.getByText(END)).toBeVisible();
    await expect(s.locator('.tail .sk')).toHaveCount(0);
    expect((await box(s.locator('.tail'))).h).toBe(tail.h);
  });

  test('clearing a category shows Rückgängig and undo brings it back', async ({ page, api }) => {
    await open(page);
    const s = sheet(page);
    await s.getByRole('button', { name: 'Geräte', exact: true }).click();
    await expect(s.getByRole('button', { name: 'Geräte', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(1);
    const before = await box(rowOf(page, TV));
    await s.getByRole('button', { name: 'Geräte leeren' }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(s.getByText('Keine Mitteilungen')).toBeVisible();
    expect(api.log.some((l) => l.startsWith('POST /api/notifications/hide {"category":"devices"}'))).toBe(true);
    await expect(toasts(page).getByText('6 Mitteilungen entfernt')).toBeVisible();
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
    await expect(rowOf(page, TV)).toBeVisible();
    expect(await box(rowOf(page, TV))).toEqual(before);
    await expect(sheet(page)).toBeVisible();
    expect(api.notes.entries.filter((e) => e.hidden)).toEqual([]);
  });

  test('a single row is removed with ✕ and can be undone', async ({ page, api }) => {
    await open(page);
    const row = rowOf(page, 'Nordlicht ist bereit');
    const before = await box(row);
    await row.hover();
    await row.getByRole('button', { name: 'Entfernen: Nordlicht ist bereit' }).click();
    await expect(row).toHaveCount(0);
    await expect(toasts(page).getByText('1 Mitteilung entfernt')).toBeVisible();
    expect(api.notes.entries.find((e) => e.title === 'Nordlicht ist bereit')!.hidden).toBe(true);
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
    await expect(row).toBeVisible();
    expect(await box(row)).toEqual(before);
  });

  test('an unread entry without a link: pressing it reads it, then it is plain text and the focus stays in the row', async ({ page, api }) => {
    api.notes.entries.push({ id: 900, kind: 'achievement', category: 'achievements', title: 'Neues Achievement: Frühaufsteher', body: null, link: null, at: new Date().toISOString(), read: false, hidden: false });
    await open(page);
    const row = rowOf(page, 'Frühaufsteher');
    await row.getByRole('button', { name: /^Neues Achievement: Frühaufsteher, neu, / }).click();
    await expect(row.locator('div.main')).toBeVisible();
    await expect(row.getByRole('button', { name: /Frühaufsteher, neu/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Entfernen: Neues Achievement: Frühaufsteher' })).toBeFocused();
    await expect.poll(() => reads(api.log).length).toBe(1);
    expect(api.notes.entries.find((e) => e.id === 900)!.read).toBe(true);
  });

  test('clearing everything brings the counts and chips up to date; undo brings them back', async ({ page }) => {
    await open(page);
    const s = sheet(page);
    const chips = s.getByRole('group', { name: 'Benachrichtigungen' }).getByRole('button');
    await s.getByRole('button', { name: 'Alles leeren' }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(s.getByTestId('notes-unread')).toHaveCount(0);
    await expect(s.getByRole('button', { name: 'Alle gelesen' })).toBeDisabled();
    await expect(chips).toHaveText(['Alle', 'Ungelesen']);
    await expect(toasts(page).getByText('75 Mitteilungen entfernt')).toBeVisible();
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).click();
    await expect(rowOf(page, TV)).toBeVisible();
    await expect(s.getByTestId('notes-unread')).toHaveText('8 neu');
    await expect(chips).toHaveCount(10);
    await expect(s.getByRole('button', { name: 'Alle gelesen' })).toBeEnabled();
  });

  test('Alle gelesen reads everything; the badge follows', async ({ page, api }) => {
    await open(page);
    await sheet(page).getByRole('button', { name: 'Alle gelesen' }).click();
    await expect(sheet(page).locator('.udot')).toHaveCount(0);
    await expect(sheet(page).getByTestId('notes-unread')).toHaveCount(0);
    await expect(sheet(page).getByRole('button', { name: 'Alle gelesen' })).toBeDisabled();
    expect(reads(api.log)).toEqual(['POST /api/notifications/read {} -> 200']);
    await expect(bell(page).locator('.dot')).toHaveCount(0);
  });

  test('new entries show a pill, not rows', async ({ page, api }) => {
    await open(page);
    const s = sheet(page);
    await scrollList(page, 200); // reading further down
    const head = await box(s.locator('header'));
    const first = await box(rows(page).first());
    const slot = await box(s.locator('.slot'));
    addNote(api.notes);
    await page.evaluate(() => window.dispatchEvent(new Event('ff-notes')));
    const pill = s.getByRole('button', { name: '1 neu' });
    await expect(pill).toBeVisible();
    await expect(bell(page).locator('.dot')).toHaveText('9');
    // in the reserved slot: nothing moved
    const p = await box(pill);
    expect(p.y).toBeGreaterThanOrEqual(slot.y);
    expect(p.y + p.h).toBeLessThanOrEqual(slot.y + slot.h);
    expect(await box(rows(page).first())).toEqual(first);
    expect(await box(s.locator('header'))).toEqual(head);
    await expect(rowOf(page, 'Hafenkanal ist bereit')).toHaveCount(0);
    // the pill: back to the top, the first page again
    await pill.click();
    await expect(rows(page).first()).toContainText('Hafenkanal ist bereit');
    await expect(pill).toHaveCount(0);
    expect(await s.locator('.list').evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('at the top with no group open, new entries are put in place without a pill', async ({ page, api }) => {
    await open(page);
    addNote(api.notes);
    await page.evaluate(() => window.dispatchEvent(new Event('ff-notes')));
    await expect(rows(page).first()).toContainText('Hafenkanal ist bereit');
    await expect(sheet(page).locator('.pill')).toHaveCount(0);
  });

  test('Escape closes and focus returns to the bell', async ({ page }) => {
    await open(page);
    await expect(sheet(page)).toBeFocused();
    // Shift+Tab from the dialog itself stays inside: the last control
    await page.keyboard.press('Shift+Tab');
    await expect(sheet(page).getByRole('button', { name: 'Alles leeren' })).toBeFocused();
    await sheet(page).focus();
    await page.keyboard.press('Tab');
    await expect(sheet(page).getByRole('link', { name: 'Einstellungen' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(bell(page)).toBeFocused();
    await expect(bell(page)).toHaveAttribute('aria-expanded', 'false');
    // the dim closes it too
    await bell(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.mouse.click(200, 450);
    await expect(sheet(page)).toHaveCount(0);
  });

  test.describe('failed loads', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('a failed first page shows the error with Nochmal', async ({ page }) => {
      let fail = true;
      await page.route(/\/api\/notifications\/feed\?/, (r) => (fail ? r.fulfill({ status: 500, json: { error: 'boom' } }) : r.fallback()));
      await page.goto('/watchlist');
      await bell(page).click();
      const s = sheet(page);
      await expect(s.getByRole('alert')).toContainText('Mitteilungen konnten nicht geladen werden.');
      fail = false;
      await s.getByRole('button', { name: 'Nochmal' }).click();
      await expect(rowOf(page, TV)).toBeVisible();
    });
    test('a failed next page shows Nochmal in the reserved room and is not retried on its own', async ({ page }) => {
      let fail = true, asked = 0;
      await page.route(/\/api\/notifications\/feed\?.*cursor=30/, (r) => { asked++; return fail ? r.fulfill({ status: 500, json: { error: 'boom' } }) : r.fallback(); });
      await open(page);
      const s = sheet(page);
      const tail = await box(s.locator('.tail'));
      await scrollList(page, 'end');
      await expect(s.locator('.tail').getByRole('alert')).toContainText('Mitteilungen konnten nicht geladen werden.');
      expect((await box(s.locator('.tail'))).h).toBe(tail.h);
      await page.waitForTimeout(500);
      expect(asked).toBe(1);
      fail = false;
      await s.locator('.tail').getByRole('button', { name: 'Nochmal' }).click();
      await expect(rows(page)).toHaveCount(60);
    });
  });

  test('kids profile: no bell', async ({ page, api }) => {
    const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(() => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await page.goto('/');
    await expect(page).toHaveURL(/\/kids$/);
    await expect(page.getByRole('button', { name: /Benachrichtigungen/ })).toHaveCount(0);
    expect(api.log.filter((l) => l.includes('/api/notifications'))).toEqual([]);
  });
});
