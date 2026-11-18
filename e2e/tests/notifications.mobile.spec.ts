// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/**
 * The notifications center on a phone (spec 2026-11-17, decision 4): the header has no bell, the avatar links to *Mein Bereich*
 * with the unread count. There the newest 5 groups show inline (reading nothing), and *Alle ({n})* opens the sheet over the
 * whole screen. On touch a row is removed with ✕ (44 px, always shown) or a swipe to the left, both with *Rückgängig*.
 * 390×844, touch; the iPhone's safe areas are forced (Chromium reports 0).
 */
const TOP = 59;
const BOTTOM = 34;
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([t, b]) => {
    const apply = () => { const s = document.documentElement?.style; s?.setProperty('--safe-top', `${t}px`); s?.setProperty('--safe-bottom', `${b}px`); };
    apply();
    document.addEventListener('readystatechange', apply);
  }, [TOP, BOTTOM]);
});

const TV = 'Ein Fernseher wurde mit deinem Konto verbunden';
const mine = (page: Page) => page.getByTestId('me-notes');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Benachrichtigungen' });
const rows = (page: Page) => sheet(page).locator('li.nr');
const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const reads = (log: string[]) => log.filter((l) => l.startsWith('POST /api/notifications/read'));
const hides = (log: string[]) => log.filter((l) => l.startsWith('POST /api/notifications/hide'));

async function openAll(page: Page) {
  await page.goto('/me');
  await mine(page).locator('li.nr').first().waitFor();
  await page.getByRole('button', { name: 'Alle (75)' }).tap();
  await expect(sheet(page)).toBeVisible();
  await expect(rowOf(page, TV)).toBeVisible();
  await expect.poll(() => sheet(page).evaluate((el) => el.getAnimations().length)).toBe(0);
}

/**
 * A finger on the row (touch events through the DevTools protocol: the page sees touch pointers): from 75 % of its width `dx` px to
 * the side in `steps` moves `ms` apart. `hold` runs before the finger lifts.
 */
async function swipe(page: Page, row: Locator, dx: number, o: { steps?: number; ms?: number; dy?: number; hold?: () => Promise<void> } = {}) {
  const { steps = 8, ms = 30, dy = 0 } = o;
  const b = (await row.locator('.main').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x0 = b.x + b.width * 0.75, y0 = b.y + b.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps }] });
    if (ms) await page.waitForTimeout(ms);
  }
  await o.hold?.();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const top = async (l: Locator) => Math.round((await l.boundingBox())!.y);

test.describe('notifications on a phone', () => {
  test('the header has no bell; the avatar links to Mein Bereich with the unread count', async ({ page }) => {
    await page.goto('/watchlist');
    const head = page.locator('header.nav.m');
    await expect(head.getByRole('link', { name: 'Mein Bereich, 8 neue Benachrichtigungen' })).toHaveAttribute('href', '/me');
    await expect(head.locator('a.avatar .dot')).toHaveText('8');
    await expect(page.getByRole('button', { name: /Benachrichtigungen/ })).toHaveCount(0);
  });

  test('above 99 the avatar dot shows 99+; its name keeps the real number', async ({ page }) => {
    await page.route(/\/api\/notifications\/feed\?limit=0$/, (r) => r.fulfill({ json: { unread: 150, categories: [{ key: 'devices', n: 150 }] } }));
    await page.goto('/watchlist');
    const head = page.locator('header.nav.m');
    await expect(head.locator('a.avatar .dot')).toHaveText('99+');
    await expect(head.getByRole('link', { name: 'Mein Bereich, 150 neue Benachrichtigungen' })).toBeVisible();
  });

  test('larger text: the rows of Mein Bereich grow instead of overflowing', async ({ page }) => {
    await page.goto('/me');
    const list = mine(page).locator('li.nr');
    await expect(list).toHaveCount(5);
    await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
    const fits = await mine(page).locator('li.nr .main').evaluateAll((els) => els.map((el) => el.scrollHeight <= el.clientHeight + 1));
    expect(fits).toEqual([true, true, true, true, true]);
    expect((await list.first().boundingBox())!.height).toBeGreaterThan(64);
  });

  test.describe('a failed load', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('Mein Bereich shows the error with Nochmal in the same room', async ({ page }) => {
      let fail = true;
      await page.route(/\/api\/notifications\/feed\?.*limit=5/, (r) => (fail ? r.fulfill({ status: 500, json: { error: 'x' } }) : r.fallback()));
      await page.goto('/me');
      const err = mine(page).getByRole('alert');
      await expect(err).toContainText('Benachrichtigungen konnten nicht geladen werden.');
      await expect(mine(page).getByText('Keine Benachrichtigungen')).toHaveCount(0);
      const box = (await mine(page).boundingBox())!;
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(5 * 64 + 12);
      const again = err.getByRole('button', { name: 'Nochmal' });
      expect((await again.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      fail = false;
      await again.tap();
      await expect(mine(page).locator('li.nr')).toHaveCount(5);
      const after = (await mine(page).boundingBox())!;
      expect([Math.round(after.y), Math.round(after.height)]).toEqual([Math.round(box.y), Math.round(box.height)]);
    });
  });

  test('Mein Bereich shows the newest 5 groups and does not mark read', async ({ page, api }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/notifications\/feed\?.*limit=5/, async (r) => { await gate; await r.fallback(); });
    await page.goto('/me');
    // the room of five rows is there while they load: the rows and what is below them do not move when they come
    await expect(mine(page).locator('.nsk')).toHaveCount(5);
    const box = (await mine(page).boundingBox())!;
    release();
    const list = mine(page).locator('li.nr');
    await expect(list).toHaveCount(5);
    await expect(list.locator('.ti')).toHaveText([TV, 'Nordlicht ist bereit', 'Anna Beispiel lädt dich zur Watch-Party ein', 'Neues Achievement: Nachteule', 'Version 1.4 ist da']);
    const after = (await mine(page).boundingBox())!;
    expect([Math.round(after.y), Math.round(after.height)]).toEqual([Math.round(box.y), Math.round(box.height)]);
    await expect(list.filter({ hasText: TV }).locator('.cnt')).toHaveText('6×');
    await expect(list.locator('button.x')).toHaveCount(0); // nothing removes a row here
    await expect(page.getByRole('button', { name: 'Alle (75)' })).toBeVisible();
    // seeing them reads nothing; opening a group reads that group only
    await page.waitForTimeout(400);
    expect(reads(api.log)).toEqual([]);
    await expect(page.locator('header.nav.m a.avatar .dot')).toHaveText('8');
    const tv = list.filter({ hasText: TV }).locator('button.main');
    await tv.tap();
    await expect(tv).toHaveAttribute('aria-expanded', 'true');
    await expect(list.filter({ hasText: TV }).locator('.items li')).toHaveCount(6);
    await expect.poll(() => reads(api.log).length).toBe(1);
    expect(reads(api.log)[0]).toContain('"groups"');
    await expect(page.locator('header.nav.m a.avatar .dot')).toHaveText('2');
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('no notifications: the same room, the empty text', async ({ page, api }) => {
    api.notes.entries = [];
    await page.goto('/me');
    await expect(mine(page).getByText('Keine Benachrichtigungen')).toBeVisible();
    expect((await mine(page).boundingBox())!.height).toBeGreaterThanOrEqual(5 * 64);
    await expect(page.getByRole('button', { name: /^Alle \(/ })).toHaveCount(0);
  });

  test('Alle opens the full-height sheet: 44-px targets, no horizontal scroll', async ({ page }) => {
    await openAll(page);
    const s = sheet(page);
    const vp = page.viewportSize()!;
    const b = (await s.boundingBox())!;
    expect(b).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
    // its content keeps clear of the status bar and the home indicator: the viewport height minus the safe areas
    const head = (await s.locator('header').boundingBox())!;
    const foot = s.locator('footer');
    const lastBtn = (await foot.getByRole('button').last().boundingBox())!;
    expect(head.y).toBeGreaterThanOrEqual(TOP);
    expect(lastBtn.y + lastBtn.height).toBeLessThanOrEqual(vp.height - BOTTOM);
    // every control is a 44-px target: header, chips, the ✕ of each row, the footer
    const targets = s.locator('header a, header button, .chips button, li.nr button.x, footer button');
    const n = await targets.count();
    expect(n).toBeGreaterThan(15);
    for (let i = 0; i < n; i++) {
      const t = targets.nth(i);
      if (!(await t.isVisible())) continue;
      const tb = (await t.boundingBox())!;
      expect(tb.height, (await t.getAttribute('aria-label')) ?? (await t.innerText())).toBeGreaterThanOrEqual(44);
    }
    // the ✕ is always shown on touch (not only on hover or focus)
    await expect(rowOf(page, 'Nordlicht ist bereit').locator('button.x')).toHaveCSS('opacity', '1');
    expect(await noHorizontalOverflow(page)).toBe(true);
    // closing goes back to Mein Bereich, focus on Alle
    await s.getByRole('button', { name: 'Schließen' }).tap();
    await expect(s).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Alle (75)' })).toBeFocused();
  });

  test('✕ removes one group with undo', async ({ page, api }) => {
    await openAll(page);
    const row = rowOf(page, 'Nordlicht ist bereit');
    await row.getByRole('button', { name: 'Entfernen: Nordlicht ist bereit' }).tap();
    await expect(row).toHaveCount(0);
    await expect(toasts(page).getByText('1 Benachrichtigung entfernt')).toBeVisible();
    expect(api.notes.entries.find((e) => e.title === 'Nordlicht ist bereit')!.hidden).toBe(true);
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).tap();
    await expect(row).toBeVisible();
    expect(api.notes.entries.find((e) => e.title === 'Nordlicht ist bereit')!.hidden).toBe(false);
  });

  test('swipe left removes one group with undo; a short swipe springs back; a scroll is no swipe', async ({ page, api }) => {
    await openAll(page);
    const row = rowOf(page, 'Nordlicht ist bereit');
    const next = rowOf(page, 'Anna Beispiel lädt dich zur Watch-Party ein');
    const w = (await row.boundingBox())!.width;
    const nextY = await top(next);
    // short (20 % of the width), slowly: it follows the finger by transform only, then springs back; nothing is removed or opened
    await swipe(page, row, -w * 0.2, {
      hold: async () => {
        await expect(row).toHaveCSS('transform', /^matrix\(1, 0, 0, 1, -\d+/);
        expect(await top(next)).toBe(nextY);
      },
    });
    await expect(row).toHaveCSS('transform', 'none');
    await page.waitForTimeout(300);
    expect(hides(api.log)).toEqual([]);
    await expect(page).toHaveURL(/\/me$/); // the drag was no tap on the row's link
    // a vertical move is the list's scroll, the row stays where it is
    await swipe(page, row, -12, { dy: 120, hold: () => page.waitForTimeout(300) }); // (held still: no fling scroll goes on after it)
    await expect(row).toHaveCSS('transform', 'none');
    expect(hides(api.log)).toEqual([]);
    await sheet(page).locator('.list').evaluate((el) => { el.scrollTop = 0; });
    // past 40 % of the width, held still before letting go (no fling): gone, with Rückgängig
    await swipe(page, row, -w * 0.5, { hold: () => page.waitForTimeout(150) });
    await expect(row).toHaveCount(0);
    await expect.poll(() => hides(api.log).length).toBe(1);
    expect(hides(api.log)[0]).toContain('"groups"');
    await expect(toasts(page).getByText('1 Benachrichtigung entfernt')).toBeVisible();
    await expect(page).toHaveURL(/\/me$/);
    await toasts(page).getByRole('button', { name: 'Rückgängig' }).tap();
    await expect(row).toBeVisible();
    await expect(row).toHaveCSS('transform', 'none');
  });

  test('a fling removes a row; with motion it slides out first', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openAll(page);
    const row = rowOf(page, 'Nordlicht ist bereit');
    const w = (await row.boundingBox())!.width;
    // 25 % of the width (under 40 %), but fast: a fling
    await swipe(page, row, -w * 0.25, { steps: 3, ms: 0 });
    await expect(row).toHaveCount(0);
    await expect.poll(() => hides(api.log).length).toBe(1);
    await expect(toasts(page).getByText('1 Benachrichtigung entfernt')).toBeVisible();
  });
});
