// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';

// Favoriten ordnen (Task 38, spec §11.1): the *Ordnen* sheet of the favourites row. A mouse drag, the keyboard path (Space picks up,
// ↑/↓ move, Space drops, Escape cancels, announced) and *Fertig* saving with PUT /api/livetv/favourites (undo toast); on a TV a move mode
// with D-pad, OK and Back alone that saves at every drop. A fake clock stands at Thursday 2026-11-12 20:37:10 like in live-tab.spec.ts.
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const FIVE = ['ch-nord', 'ch-hafen', 'ch-berg', 'ch-kinder', 'ch-stern'];
const NAMES = ['Nordlicht TV', 'Hafenkanal', 'Bergblick Sport', 'Kinderinsel', 'Sternwarte 24'];
const favs = (page: Page) => page.getByRole('region', { name: 'Läuft gerade bei dir' });
const open = (page: Page) => page.getByRole('button', { name: 'Ordnen' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Favoriten ordnen' });
const order = (page: Page) => sheet(page).locator('.row .name').allTextContents();
const grip = (page: Page, name: string) => sheet(page).getByRole('button', { name });
const live = (page: Page) => sheet(page).locator('p[aria-live="polite"]');
const tileNames = async (page: Page) => (await favs(page).locator('button.tile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))).map((l) => l.replace(/^\d+ /, '').split(',')[0]);
const puts = (api: { livetv: { calls: string[] } }) => api.livetv.calls.filter((c) => c.startsWith('PUT '));
const ids = (...v: string[]) => `PUT /api/livetv/favourites ${JSON.stringify({ ids: v })}`;
/** nothing is left lifted or shifted: no row in the lifted look, no inline transform */
const settled = async (page: Page) => {
  await expect(sheet(page).locator('.lifted')).toHaveCount(0);
  await expect.poll(() => sheet(page).locator('.row').evaluateAll((els) => els.filter((e) => (e as HTMLElement).style.transform !== '').length)).toBe(0);
};

/** a mouse drag of the grip by `rows` rows (negative = up), in small steps like a hand */
async function drag(page: Page, g: Locator, rows: number) {
  const b = (await g.boundingBox())!;
  const pitch = (await sheet(page).locator('.row').nth(1).boundingBox())!.y - (await sheet(page).locator('.row').nth(0).boundingBox())!.y;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(sheet(page).locator('.lifted')).toHaveCount(1);
  // a quarter row past the middle of the target place, so the drop is not a tie
  const reach = (rows + Math.sign(rows) * 0.25) * pitch;
  for (let i = 1; i <= 14; i++) await page.mouse.move(x, y + (reach * i) / 14);
  await page.mouse.up();
}

test.describe('Favoriten ordnen (desktop)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    api.livetv.favourites = [...FIVE];
    await page.clock.install({ time: NOW });
  });

  test('mouse drag reorders and Fertig saves', async ({ page, api }) => {
    await page.goto('/live');
    await expect(favs(page).locator('button.tile')).toHaveCount(5);
    await open(page).click();
    await expect(sheet(page)).toBeVisible();
    expect(await order(page)).toEqual(NAMES);

    // down by two rows
    await drag(page, grip(page, 'Nordlicht TV'), 2);
    expect(await order(page)).toEqual(['Hafenkanal', 'Bergblick Sport', 'Nordlicht TV', 'Kinderinsel', 'Sternwarte 24']);
    await settled(page);
    // and up by three rows
    await drag(page, grip(page, 'Sternwarte 24'), -3);
    expect(await order(page)).toEqual(['Hafenkanal', 'Sternwarte 24', 'Bergblick Sport', 'Nordlicht TV', 'Kinderinsel']);
    await settled(page);
    expect(api.livetv.calls).toEqual([]); // nothing is stored before Fertig

    await sheet(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toEqual([ids('ch-hafen', 'ch-stern', 'ch-berg', 'ch-nord', 'ch-kinder')]);
    // the favourites row uses the new order at once
    await expect.poll(() => tileNames(page)).toEqual(['Hafenkanal', 'Sternwarte 24', 'Bergblick Sport', 'Nordlicht TV', 'Kinderinsel']);
    // the focus is back on *Ordnen*
    await expect(open(page)).toBeFocused();
  });

  test('a drag up to the top and the Favoriten chip follow the new order', async ({ page, api }) => {
    api.livetv.favourites = ['ch-nord', 'ch-hafen', 'ch-kinder'];
    await page.goto('/live');
    await open(page).click();
    await drag(page, grip(page, 'Kinderinsel'), -2);
    expect(await order(page)).toEqual(['Kinderinsel', 'Nordlicht TV', 'Hafenkanal']);
    await settled(page);
    await sheet(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toEqual([ids('ch-kinder', 'ch-nord', 'ch-hafen')]);
    await page.getByRole('group', { name: 'Sendergruppen' }).getByRole('button', { name: 'Favoriten' }).click();
    await expect(page.getByRole('list', { name: 'Senderliste' }).locator('.name')).toHaveText(['Kinderinsel', 'Nordlicht TV', 'Hafenkanal']);
  });

  test('Escape while a mouse drag runs puts the row back and ends the drag', async ({ page, api }) => {
    await page.goto('/live');
    await open(page).click();
    const g = grip(page, 'Nordlicht TV');
    const b = (await g.boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + 20, b.y + 20 + i * 30);
    expect((await order(page))[0]).not.toBe('Nordlicht TV');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => order(page)).toEqual(NAMES);
    await expect(sheet(page)).toBeVisible(); // the sheet stays, only the drag ended
    await settled(page);
    expect(puts(api)).toEqual([]);
  });

  test('a mouse move without a button is the end of the drag (stuck drag)', async ({ page }) => {
    await page.goto('/live');
    await open(page).click();
    const g = grip(page, 'Nordlicht TV');
    const b = (await g.boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) await page.mouse.move(b.x + 20, b.y + 20 + i * 30);
    await expect(sheet(page).locator('.lifted')).toHaveCount(1);
    // the button went up where the page did not see it: the next move says buttons = 0
    await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: x, clientY: y })), { x: b.x + 20, y: b.y + 200 });
    await settled(page);
    await page.mouse.up();
    await settled(page);
  });

  test('keyboard Space ↓ Space saves', async ({ page, api }) => {
    await page.goto('/live');
    await open(page).click();
    const g = grip(page, 'Nordlicht TV');
    await g.focus();
    await page.keyboard.press('Space');
    await expect(live(page)).toHaveText('Nordlicht TV aufgenommen, Position 1 von 5');
    await expect(g).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toHaveText('Position 2 von 5');
    await expect(g).toBeFocused(); // the handle keeps the focus while its row moves
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toHaveText('Position 3 von 5');
    await expect(g).toBeFocused();
    await page.keyboard.press('Space');
    await expect(live(page)).toHaveText('Nordlicht TV abgelegt auf Position 3');
    expect(await order(page)).toEqual(['Hafenkanal', 'Bergblick Sport', 'Nordlicht TV', 'Kinderinsel', 'Sternwarte 24']);
    await settled(page);
    await sheet(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toEqual([ids('ch-hafen', 'ch-berg', 'ch-nord', 'ch-kinder', 'ch-stern')]);
  });

  test('a held Space does not toggle pick and drop', async ({ page }) => {
    await page.goto('/live');
    await open(page).click();
    const g = grip(page, 'Hafenkanal');
    await g.focus();
    await page.keyboard.down('Space');
    await page.keyboard.down('Space'); // repeats
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await expect(g).toHaveAttribute('aria-pressed', 'true');
  });

  test('Escape cancels the move, a second Escape closes the sheet', async ({ page, api }) => {
    await page.goto('/live');
    await open(page).click();
    const g = grip(page, 'Hafenkanal');
    await g.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect((await order(page))[3]).toBe('Hafenkanal');
    await page.keyboard.press('Escape');
    expect(await order(page)).toEqual(NAMES);
    await expect(live(page)).toHaveText('Verschieben abgebrochen');
    await expect(sheet(page)).toBeVisible(); // only the move was cancelled
    await expect(g).toBeFocused();
    await expect(g).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toEqual([]);
    await expect(open(page)).toBeFocused();
  });

  test('Tab away from a lifted row cancels the move', async ({ page }) => {
    await page.goto('/live');
    await open(page).click();
    const g = grip(page, 'Nordlicht TV');
    await g.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await expect.poll(() => order(page)).toEqual(NAMES);
    await expect(live(page)).toHaveText('Verschieben abgebrochen');
  });

  test('undo restores the old order', async ({ page, api }) => {
    await page.goto('/live');
    await open(page).click();
    await grip(page, 'Nordlicht TV').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await sheet(page).getByRole('button', { name: 'Fertig' }).click();
    await expect.poll(() => tileNames(page)).toEqual(['Hafenkanal', 'Nordlicht TV', 'Bergblick Sport', 'Kinderinsel', 'Sternwarte 24']);
    await page.getByRole('region', { name: 'Hinweise' }).getByRole('button', { name: 'Rückgängig' }).click();
    await expect.poll(() => tileNames(page)).toEqual(NAMES);
    expect(puts(api)).toEqual([ids('ch-hafen', 'ch-nord', 'ch-berg', 'ch-kinder', 'ch-stern'), ids(...FIVE)]);
  });

  test.describe('a refused store', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('a failed save keeps the order in the sheet, shows the error and stores nothing', async ({ page, api }) => {
      await page.route('**/api/livetv/favourites', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, json: { error: 'boom' } }) : r.fallback()));
      await page.goto('/live');
      await open(page).click();
      await grip(page, 'Nordlicht TV').focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      await sheet(page).getByRole('button', { name: 'Fertig' }).click();
      await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Serverfehler')).toBeVisible();
      await expect(sheet(page)).toBeVisible();
      expect(await order(page)).toEqual(['Hafenkanal', 'Nordlicht TV', 'Bergblick Sport', 'Kinderinsel', 'Sternwarte 24']);
      expect(await tileNames(page)).toEqual(NAMES); // the page's own order did not change
      expect(api.livetv.favourites).toEqual(FIVE);
    });
  });

  test('a double click on Fertig sends one request', async ({ page, api }) => {
    await page.goto('/live');
    await open(page).click();
    await grip(page, 'Nordlicht TV').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await sheet(page).getByRole('button', { name: 'Fertig' }).dblclick();
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toHaveLength(1);
  });

  test('Fertig without a change closes without a request', async ({ page, api }) => {
    await page.goto('/live');
    await open(page).click();
    await sheet(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toEqual([]);
  });

  test('the sheet is a modal dialog: Tab stays inside, handles are 44 px', async ({ page }) => {
    await page.goto('/live');
    await open(page).click();
    await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
    for (const name of NAMES) {
      const b = (await grip(page, name).boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
  });

  test('the button is absent with one favourite', async ({ page, api }) => {
    api.livetv.favourites = ['ch-nord'];
    await page.goto('/live');
    await expect(favs(page).locator('button.tile')).toHaveCount(1);
    await expect(open(page)).toHaveCount(0);
  });

  test('the head keeps its height with and without the button', async ({ page, api }) => {
    await page.goto('/live');
    const h = async () => (await favs(page).locator('.head').boundingBox())!.height;
    await expect(open(page)).toBeVisible();
    const withBtn = await h();
    api.livetv.favourites = ['ch-nord'];
    await page.reload();
    await expect(open(page)).toHaveCount(0);
    expect(await h()).toBe(withBtn);
  });

  test('reduced motion has no transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/live');
    await open(page).click();
    await expect(sheet(page)).toBeVisible();
    const durations = await sheet(page).locator('.row, .grip, .fo').evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDuration));
    expect(durations.length).toBeGreaterThan(5);
    for (const d of durations) expect(d).toBe('0s');
    // a move switches places at once: no transform is left on any row
    await grip(page, 'Nordlicht TV').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    expect(await sheet(page).locator('.row').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform))).toEqual(['', '', '', '', '']);
  });
});

test.describe('Favoriten ordnen (phone)', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  test.beforeEach(async ({ api, page }) => {
    api.features = { livetv: true };
    await page.clock.install({ time: NOW });
  });

  test('Ordnen sits in the carousel head and the sheet fits the screen', async ({ page }) => {
    await page.goto('/live');
    const b = open(page);
    await expect(b).toBeVisible();
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await b.tap();
    await expect(sheet(page)).toBeVisible();
    const box = (await sheet(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});

test.describe('Favoriten ordnen (TV move mode)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.clock.install({ time: NOW });
  });
  /** the TV path: the Ordnen button in the favourites head has the focus, OK opens the sheet */
  async function openOnTv(page: Page) {
    await page.goto('/live?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(open(page)).toBeVisible();
    await open(page).focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Nordlicht TV' })).toBeFocused();
  }

  test('TV move mode: OK ▼ OK saves at the drop, Back closes', async ({ page, api }) => {
    await openOnTv(page);
    expect(await order(page)).toEqual(['Nordlicht TV', 'Hafenkanal', 'Kinderinsel']);
    await page.keyboard.press('Enter'); // picked
    await expect(live(page)).toHaveText('Nordlicht TV aufgenommen, Position 1 von 3');
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toHaveText('Position 2 von 3');
    expect(puts(api)).toEqual([]); // moving does not save
    await page.keyboard.press('Enter'); // dropped
    await expect(live(page)).toContainText('Nordlicht TV abgelegt auf Position 2');
    await expect.poll(() => puts(api)).toEqual([ids('ch-hafen', 'ch-nord', 'ch-kinder')]);
    await expect(sheet(page).getByRole('button', { name: 'Nordlicht TV' })).toBeFocused();
    // the favourites row behind the sheet uses the new order at once
    await expect.poll(() => tileNames(page)).toEqual(['Hafenkanal', 'Nordlicht TV', 'Kinderinsel']);
    // nothing is picked now: Back closes the sheet, the focus goes back to Ordnen
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(open(page)).toBeFocused();
    expect(new URL(page.url()).pathname).toBe('/live'); // and Back did not leave the page
    expect(puts(api)).toHaveLength(1);
  });

  test('TV move mode: Back while picked cancels, a second Back closes', async ({ page, api }) => {
    await openOnTv(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect((await order(page))[2]).toBe('Nordlicht TV');
    await page.keyboard.press('Backspace'); // a remote's Back
    await expect.poll(() => order(page)).toEqual(['Nordlicht TV', 'Hafenkanal', 'Kinderinsel']);
    await expect(live(page)).toHaveText('Verschieben abgebrochen');
    await expect(sheet(page)).toBeVisible();
    expect(puts(api)).toEqual([]);
    await page.keyboard.press('Backspace');
    await expect(sheet(page)).toHaveCount(0);
    await expect(open(page)).toBeFocused();
    expect(puts(api)).toEqual([]);
  });

  test('TV: ▲ ▼ walk the rows when nothing is picked, the focus never leaves the list', async ({ page }) => {
    await openOnTv(page);
    await page.keyboard.press('ArrowDown');
    await expect(sheet(page).getByRole('button', { name: 'Hafenkanal' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // the last row stays
    await expect(sheet(page).getByRole('button', { name: 'Kinderinsel' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // the first row stays
    await expect(sheet(page).getByRole('button', { name: 'Nordlicht TV' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  });

  test('TV: a drop during a save is saved right after it', async ({ page, api }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    await page.route('**/api/livetv/favourites', async (r) => {
      if (r.request().method() === 'PUT' && first) { first = false; await gate; }
      await r.fallback();
    });
    await openOnTv(page);
    await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); // Hafenkanal, Nordlicht TV, Kinderinsel (request 1 waits)
    await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); // Hafenkanal, Kinderinsel, Nordlicht TV
    release();
    await expect.poll(() => puts(api)).toEqual([ids('ch-hafen', 'ch-nord', 'ch-kinder'), ids('ch-hafen', 'ch-kinder', 'ch-nord')]);
    expect(await order(page)).toEqual(['Hafenkanal', 'Kinderinsel', 'Nordlicht TV']);
  });

  test('TV: the sheet is solid and still, rows are 96 px, text is 28 px, the focus has the ring', async ({ page }) => {
    await openOnTv(page);
    const row = (await sheet(page).locator('.row').first().boundingBox())!;
    expect(Math.round(row.height)).toBeGreaterThanOrEqual(96);
    expect(await sheet(page).locator('.row .name').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
    const look = await sheet(page).getByRole('button', { name: 'Nordlicht TV' }).evaluate((e) => { const s = getComputedStyle(e.closest('li')!); return { w: s.outlineWidth, c: s.outlineColor }; });
    expect(look).toEqual({ w: '3px', c: 'rgb(255, 255, 255)' });
    const d = await sheet(page).locator('.row, .fo').evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDuration));
    for (const x of d) expect(x).toBe('0s');
    expect(await sheet(page).getByRole('button', { name: 'Schließen' }).count()).toBe(1);
    expect(await sheet(page).getByRole('button', { name: 'Fertig' }).count()).toBe(0); // each drop saves, no button to reach
  });

  test('TV: a long list keeps the picked row in view while it moves', async ({ page, api }) => {
    const first = api.livetv.channels[0]!;
    const extra = Array.from({ length: 14 }, (_, i) => ({ ...first, id: `ch-x${i}`, number: 40 + i, name: `Zusatz ${i + 1}` }));
    api.livetv.channels = [...api.livetv.channels, ...extra];
    api.livetv.favourites = ['ch-nord', 'ch-hafen', 'ch-kinder', ...extra.map((c) => c.id)];
    await page.goto('/live?tv=1');
    await open(page).focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    const f = (await sheet(page).locator(':focus').boundingBox())!;
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.y + f.height).toBeLessThanOrEqual(1080);
    await page.keyboard.press('Enter');
    await expect.poll(() => puts(api).length).toBe(1);
  });

  test('TV: the button is a focusable part of the favourites head', async ({ page }) => {
    await page.goto('/live?tv=1');
    await expect(open(page)).toBeVisible();
    const b = (await open(page).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(54);
    await favs(page).locator('button.tile').first().focus();
    await page.keyboard.press('ArrowUp');
    await expect(open(page)).toBeFocused();
  });
});

// a kids profile: the same button in the favourites head, a solid and still sheet
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, features: { livetv: true }, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
test.describe('Favoriten ordnen (kids)', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    const kinder = api.livetv.channels.find((c) => c.id === 'ch-kinder')!;
    api.livetv.groups = [{ id: 'g-kinder', name: 'Kinder' }];
    api.livetv.channels = [kinder, { ...kinder, id: 'ch-pixel', number: 13, name: 'Pixel Piraten', favourite: false, running: false }];
    api.livetv.favourites = ['ch-kinder', 'ch-pixel'];
    api.livetv.recent = [];
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(() => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await page.clock.install({ time: NOW });
  });

  test('Ordnen is in the kids favourites head and the order is saved', async ({ page, api }) => {
    await page.goto('/live');
    await expect(open(page)).toBeVisible();
    expect((await open(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open(page).click();
    await expect(sheet(page)).toBeVisible();
    for (const d of await sheet(page).locator('.row, .fo').evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDuration))) expect(d).toBe('0s');
    await grip(page, 'Kinderinsel').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await sheet(page).getByRole('button', { name: 'Fertig' }).click();
    await expect(sheet(page)).toHaveCount(0);
    expect(puts(api)).toEqual([ids('ch-pixel', 'ch-kinder')]);
  });
});
