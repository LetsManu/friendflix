// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Live-Status on a phone (Task 26): the tables become cards, nothing scrolls sideways, the targets are 44 px.
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test.describe('admin: Live-TV, Live-Status (phone)', () => {
  // the mocked failing first load is a 500 (stop: 503): the browser logs it
  test.use({ allowedConsole: /Failed to load resource: the server responded with a status of (500|503)/ });
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    api.admin.livetv.status.ingest = [{ channelId: 'ch-wolkenlos', name: 'Kanal Wolkenlos', port: 9001, state: 'receiving', since: Date.now() - 20 * 60_000, bitrate: 2_000_000, rejected1h: 2 }];
  });

  test('the cards fit 390 px and the menu and buttons are 44 px', async ({ page }) => {
    await page.goto('/admin/livetv?tab=status');
    await expect(card(page, 'Laufende Sender').getByText('Nordlicht TV')).toBeVisible();
    await expect(card(page, 'Gesendete Streams').getByText('Kanal Wolkenlos')).toBeVisible();
    await expect(card(page, 'Ereignisse').getByText('Eingang verloren · 12 s bis zur Wiederverbindung')).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(wide).toBe(false);
    for (const loc of [page.getByRole('button', { name: 'Aktionen für Nordlicht TV' }), page.getByRole('button', { name: 'Live-TV ausschalten …' })]) {
      const b = await loc.boundingBox();
      expect(b!.height).toBeGreaterThanOrEqual(44);
      expect(b!.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('Stoppen from the menu sheet confirms', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    await page.getByRole('button', { name: 'Aktionen für Hafenkanal' }).click();
    await page.getByRole('dialog', { name: 'Hafenkanal' }).getByRole('button', { name: 'Stoppen' }).click();
    await page.getByRole('alertdialog', { name: '„Hafenkanal“ stoppen?' }).getByRole('button', { name: 'Stoppen' }).click();
    await expect(card(page, 'Laufende Sender').getByText('Hafenkanal')).toHaveCount(0);
    expect(api.admin.livetv.status.stops).toEqual(['ch-hafenkanal']);
  });

  // R24: *Ereignisse* is a fixed box on a phone: the list scrolls inside it, the pager sits in it. y is measured from the top of the page.
  async function places(page: Page) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = async (loc: ReturnType<typeof card>) => { const b = (await loc.boundingBox())!; return { y: b.y, h: b.height }; };
    return { events: await box(card(page, 'Ereignisse')), next: await box(card(page, 'Live-TV')) };
  }
  const events = (n: number) => Array.from({ length: n }, (_, i) => ({ at: Date.now() - (i + 1) * 60_000, level: 'warn' as const, code: 'input_lost', channelId: 'ch-hafenkanal', n: 12 }));

  test('the events card is one fixed height under 30rem, and nothing below it moves', async ({ page, api }) => {
    // no push feeds: Gesendete Streams has no place before the answer, so the Live-TV card is the one below *Ereignisse*
    api.admin.livetv.status.ingest = [];
    api.admin.livetv.status.failFirst = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/livetv/status', async (route) => { await gate; await route.fallback(); });
    await page.goto('/admin/livetv?tab=status');
    await expect(page.locator('[data-events] tr.sk').first()).toBeVisible();
    const skeleton = await places(page);
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(skeleton.events.h).toBeLessThan(30 * rem);
    release();
    // a failed first load, then the retry: the first answer
    await expect(card(page, 'Laufende Sender').getByRole('alert')).toContainText('Der Live-Status ließ sich nicht laden.');
    expect(await places(page)).toEqual(skeleton);
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(card(page, 'Laufende Sender').getByText('Nordlicht TV')).toBeVisible();
    await expect(page.locator('[data-events] tbody tr')).toHaveCount(3);
    expect(await places(page)).toEqual(skeleton);
    // a poll that brings 9 events: the list scrolls inside the box, the card keeps its height, the pager is inside it
    api.admin.livetv.status.events = events(9);
    await expect(page.locator('[data-events] tbody tr')).toHaveCount(9, { timeout: 15_000 });
    expect(await places(page)).toEqual(skeleton);
    const box = page.locator('[data-events]');
    await expect(box).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('group', { name: 'Ereignisse' })).toHaveCount(1);
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto' && getComputedStyle(el).overscrollBehaviorY === 'contain')).toBe(true);
    // more than one page: the pager is there, inside the box, and the card still has its height
    api.admin.livetv.status.events = events(14);
    await expect(box.locator('.pager')).toBeVisible({ timeout: 15_000 });
    expect(await places(page)).toEqual(skeleton);
    const pager = (await box.locator('.pager').boundingBox())!, inner = (await box.boundingBox())!;
    expect(pager.y + pager.height).toBeLessThanOrEqual(inner.y + inner.height + 1);
    expect(pager.y).toBeGreaterThanOrEqual(inner.y);
  });
});
