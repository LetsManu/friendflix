// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Kanäle → Reihenfolge (/admin/livetv?tab=channels), Task 24: the view toggle (one group or one source, at most 500
// rows), the drag handles (mouse, keyboard), the polite announcements, Speichern (PUT /channels/order { ids }) and the calm motion rules.
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const area = (api: MockState) => api.admin.livetv.area;
const puts = (api: MockState) => area(api).calls.filter((c) => c.m === 'PUT' && /\/channels\/order$/.test(c.p));
/** the channels of the group "Sport" are the ones with these numbers (the others go to "Regional"), so the set is small and known */
function seed(api: MockState, numbers: number[]) {
  Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
  for (const c of area(api).channels) c.importGroup = numbers.includes(c.importNumber ?? -1) ? 'g-sport' : c.importGroup === 'g-sport' ? 'g-regional' : c.importGroup;
}
// rows, handles and numbers are scoped to .order: channel-name buttons elsewhere on the page would collide
const order = (page: Page) => page.locator('.order');
const rows = (page: Page) => page.locator('.order ol.list > li.row[data-id]');
const grips = (page: Page) => page.locator('.order ol.list > li.row[data-id] button.grip');
const live = (page: Page) => page.locator('.order p.sr-only[aria-live="polite"]');
const saveBtn = (page: Page) => order(page).getByRole('button', { name: 'Speichern', exact: true });
const names = (page: Page) => rows(page).locator('.name').allTextContents();
const nums = (page: Page) => rows(page).locator('.num').allTextContents();
const pressed = (page: Page) => page.locator('.order button.grip[aria-pressed="true"]');
const activeLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
const transforms = (page: Page) => rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform));
const FIVE = ['Kinderinsel', 'Regionalkanal 7', 'Regionalkanal 9', 'Regionalkanal 11', 'Regionalkanal 12'];

async function open(page: Page, group = 'Sport') {
  await page.goto('/admin/livetv?tab=channels');
  await expect(page.getByRole('table', { name: 'Kanäle' }).getByRole('button', { name: 'Nordlicht TV', exact: true })).toBeVisible();
  await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: group });
  await page.getByRole('radio', { name: 'Reihenfolge' }).click();
  await expect(rows(page).first()).toBeVisible();
}
const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/** a stepped mouse drag of the handle `from` by `rowsDown` rows (negative: up), the release at the end */
async function drag(page: Page, from: number, rowsDown: number) {
  const a = await centre(grips(page).nth(0)), b = await centre(grips(page).nth(1));
  const pitch = b.y - a.y;
  const start = await centre(grips(page).nth(from));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + rowsDown * pitch, { steps: 16 });
  await page.mouse.up();
}

test.describe('admin: Live-TV, Kanäle → Reihenfolge (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('without a group or a source the toggle says why; with one it shows the handles', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await page.goto('/admin/livetv?tab=channels');
    await expect(page.getByRole('table', { name: 'Kanäle' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Liste' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: 'Reihenfolge' }).click();
    await expect(page.getByText('Wähle eine Gruppe oder eine Quelle')).toBeVisible();
    await expect(order(page)).toHaveCount(0);
    await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Sport' });
    await expect(rows(page)).toHaveCount(3);
    expect(await names(page)).toEqual(['Kinderinsel', 'Regionalkanal 7', 'Regionalkanal 9']);
    expect(await nums(page)).toEqual(['4', '5', '6']);
    expect(area(api).chQueries.at(-1)).toBe('group=g-sport&sort=number&dir=asc&limit=500&offset=0');
    // one source works as well; back to the list brings the table back
    await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Alle Gruppen' });
    await expect(page.getByText('Wähle eine Gruppe oder eine Quelle')).toBeVisible();
    await page.getByLabel('Quelle', { exact: true }).selectOption({ label: 'Eigene Streams' });
    await expect(rows(page)).toHaveCount(2);
    await page.getByRole('radio', { name: 'Liste' }).click();
    await expect(page.getByRole('table', { name: 'Kanäle' })).toBeVisible();
    await expect(order(page)).toHaveCount(0);
  });

  test('more than 500 rows: no order view, the reason names the count', async ({ page, api }) => {
    seed(api, [4]);
    const base = area(api).channels[0]!;
    for (let i = 0; i < 520; i++) area(api).channels.push({ ...base, id: `x-${i}`, importName: `Zusatz ${i}`, importNumber: 1000 + i, importGroup: 'g-sport' });
    await page.goto('/admin/livetv?tab=channels');
    await expect(page.getByRole('table', { name: 'Kanäle' })).toBeVisible();
    await page.getByLabel('Gruppe', { exact: true }).selectOption({ label: 'Sport' });
    await page.getByRole('radio', { name: 'Reihenfolge' }).click();
    await expect(page.getByText('521 Sender')).toBeVisible();
    await expect(order(page)).toHaveCount(0);
  });

  test('keyboard reorder saves the new order', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await open(page);
    const first = grips(page).first();
    await first.focus();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(live(page)).toContainText('Kinderinsel aufgenommen, Position 1 von 3');
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toContainText('Position 2 von 3');
    expect(await activeLabel(page)).toBe('Kinderinsel'); // the handle keeps the focus while its row moves
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toContainText('Position 3 von 3');
    expect(await activeLabel(page)).toBe('Kinderinsel');
    await page.keyboard.press('Space');
    await expect(live(page)).toContainText('Kinderinsel abgelegt auf Position 3');
    await expect(pressed(page)).toHaveCount(0);
    expect(await names(page)).toEqual(['Regionalkanal 7', 'Regionalkanal 9', 'Kinderinsel']);
    // the numbers shown are the ones Speichern gives, from the smallest (4, 7, 9 → 4, 5, 6)
    expect(await nums(page)).toEqual(['4', '5', '6']);
    await expect(saveBtn(page)).toBeEnabled();
    await saveBtn(page).click();
    await expect(toasts(page).getByText('Gespeichert')).toBeVisible();
    expect(puts(api).map((c) => c.body)).toEqual([{ ids: ['ch-7', 'ch-9', 'ch-4'] }]);
    await expect(saveBtn(page)).toBeDisabled();
    // the list view shows the stored numbers
    await page.getByRole('radio', { name: 'Liste' }).click();
    const table = page.getByRole('table', { name: 'Kanäle' });
    await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Kinderinsel', exact: true }) }).locator('[data-number]')).toHaveText('6');
  });

  test('Escape cancels and restores the order', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await open(page);
    await grips(page).first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toContainText('Position 2 von 3');
    expect(await names(page)).toEqual(['Regionalkanal 7', 'Kinderinsel', 'Regionalkanal 9']);
    await page.keyboard.press('Escape');
    await expect(live(page)).toContainText('Verschieben abgebrochen');
    expect(await names(page)).toEqual(['Kinderinsel', 'Regionalkanal 7', 'Regionalkanal 9']);
    expect(await nums(page)).toEqual(['4', '5', '6']); // the numbers shown are always the ones Speichern would give
    await expect(saveBtn(page)).toBeDisabled();
    await expect(pressed(page)).toHaveCount(0);
    expect(await activeLabel(page)).toBe('Kinderinsel');
    expect(puts(api)).toHaveLength(0);
  });

  test('Tab away while lifted announces the cancel and puts the row back', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await open(page);
    await grips(page).first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => names(page)).toEqual(['Regionalkanal 7', 'Kinderinsel', 'Regionalkanal 9']);
    await page.keyboard.press('Tab');
    await expect(live(page)).toContainText('Verschieben abgebrochen');
    expect(await names(page)).toEqual(['Kinderinsel', 'Regionalkanal 7', 'Regionalkanal 9']);
    await expect(pressed(page)).toHaveCount(0);
    await expect(saveBtn(page)).toBeDisabled();
  });

  test('mouse drag down by two rows reorders', async ({ page, api }) => {
    seed(api, [4, 7, 9, 11, 12]);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page);
    expect(await names(page)).toEqual(FIVE);
    await drag(page, 0, 2.4);
    await expect.poll(() => names(page)).toEqual(['Regionalkanal 7', 'Regionalkanal 9', 'Kinderinsel', 'Regionalkanal 11', 'Regionalkanal 12']);
    await expect(saveBtn(page)).toBeEnabled();
    await expect(pressed(page)).toHaveCount(0);
    await expect(live(page)).toContainText('Kinderinsel abgelegt auf Position 3');
    expect(await nums(page)).toEqual(['4', '5', '6', '7', '8']);
    await saveBtn(page).click();
    await expect.poll(() => puts(api).length).toBe(1);
    expect(puts(api)[0]!.body).toEqual({ ids: ['ch-7', 'ch-9', 'ch-4', 'ch-11', 'ch-12'] });
  });

  test('mouse drag up by two rows reorders', async ({ page, api }) => {
    seed(api, [4, 7, 9, 11, 12]);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page);
    await drag(page, 4, -2.4);
    await expect.poll(() => names(page)).toEqual(['Kinderinsel', 'Regionalkanal 7', 'Regionalkanal 12', 'Regionalkanal 9', 'Regionalkanal 11']);
    await expect(saveBtn(page)).toBeEnabled();
    await expect(pressed(page)).toHaveCount(0);
    await expect(live(page)).toContainText('Regionalkanal 12 abgelegt auf Position 3');
  });

  test('a swallowed mouse release never leaves a row lifted', async ({ page, api }) => {
    seed(api, [4, 7, 9, 11, 12]);
    await open(page);
    await page.evaluate(() => { (window as any).__pid = 1; addEventListener('pointerdown', (e) => { (window as any).__pid = e.pointerId; }, true); });
    const start = await centre(grips(page).nth(0));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 30, { steps: 4 });
    await expect(pressed(page)).toHaveCount(1);
    // the release got lost (the button state says nothing is pressed any more): the next move ends the drag as a drop
    await page.evaluate((y) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: (window as any).__pid, pointerType: 'mouse', buttons: 0, clientX: 10, clientY: y, bubbles: true })), start.y + 32);
    await expect(pressed(page)).toHaveCount(0);
    await expect(live(page)).toContainText('abgelegt auf Position 1');
    await page.mouse.up();
    await expect(pressed(page)).toHaveCount(0);
    await expect.poll(() => transforms(page)).toEqual(['', '', '', '', '']);
  });

  test('reduced motion has no transitions, full motion glides', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const td = () => rows(page).first().evaluate((e) => getComputedStyle(e).transitionDuration);
    expect(await td()).toBe('0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(td).toBe('0.18s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(td).toBe('0s');
  });

  test.describe('a refused save', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('keeps the order, says so, and Speichern works again', async ({ page, api }) => {
      seed(api, [4, 7, 9]);
      await open(page);
      await page.route('**/api/admin/livetv/channels/order', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
      await grips(page).first().focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      await saveBtn(page).click();
      await expect(toasts(page).getByText('Die Reihenfolge konnte nicht gespeichert werden.')).toBeVisible();
      expect(await names(page)).toEqual(['Regionalkanal 7', 'Kinderinsel', 'Regionalkanal 9']);
      await expect(saveBtn(page)).toBeEnabled();
    });
  });

  test('a double click on Speichern sends one request', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await open(page);
    await grips(page).first().focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await saveBtn(page).dblclick();
    await expect(toasts(page).getByText('Gespeichert')).toBeVisible();
    expect(puts(api)).toHaveLength(1);
  });

  test('a reload of the rows in the middle of a drag leaves no inline transform', async ({ page, api }) => {
    seed(api, [4, 7, 9, 11, 12]);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page);
    const before = area(api).chQueries.length;
    const start = await centre(grips(page).nth(0));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 90, { steps: 8 });
    await expect(pressed(page)).toHaveCount(1);
    // the stage changes under the held mouse: the source filter makes the rows load again
    await page.getByLabel('Quelle', { exact: true }).selectOption({ label: 'Nordlicht Paket' });
    await expect.poll(() => area(api).chQueries.length).toBeGreaterThan(before);
    await expect(pressed(page)).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => transforms(page)).toEqual(['', '', '', '', '']);
    await expect(rows(page).evaluateAll((els) => els.some((e) => (e.getAttribute('style') ?? '').includes('transform')))).resolves.toBe(false);
    expect(await names(page)).toEqual(FIVE);
  });

  test('the handles are at least 44 × 44', async ({ page, api }) => {
    seed(api, [4, 7, 9]);
    await open(page);
    for (let i = 0; i < 3; i++) {
      const b = (await grips(page).nth(i).boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
  });
});
