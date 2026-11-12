// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { mockLivePlayer, opensPlayer } from '../helpers.js';
import { asLgApp } from '../mocks/webos.js';
import type { MockChannel } from '../mocks/livetv.js';

// Live TV on a television (Task 37, spec §11.3): the 10-foot list with its favourites row, focusable chips and 96 px rows, the D-pad
// path (arrows, OK, long OK, the star on the right), the shortcuts a remote may send (ChannelUp/Down, digits, a lone 0, Info), the hint
// line that names only keys this device sent, "TV startet mit Live-TV" (/tv, play=last) and the admin switch for it.
// `?tv=1` is the TV preview (html.tv); a fake clock stands at Thursday 2026-11-12 20:37:10 (local) like in live-tab.spec.ts.
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const favs = (page: Page) => page.getByRole('region', { name: 'Läuft gerade bei dir' });
const chips = (page: Page) => page.getByRole('group', { name: 'Sendergruppen' });
const rows = (page: Page) => page.getByRole('list', { name: 'Senderliste' }).getByRole('listitem');
const hint = (page: Page) => page.locator('.hintline');
const focused = (page: Page): Locator => page.locator(':focus');
/** a remote key the browser keyboard cannot type (ChannelUp, Info, …): a keydown on the focused element, as the TV shell sends it */
const remote = (page: Page, key: string) =>
  page.evaluate((key) => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }, key);

/** twenty channels: the six of the mock and fourteen more, so a jump of 8 rows and the scrolling have room */
function longList(api: { livetv: { channels: MockChannel[] } }) {
  const first = api.livetv.channels[0]!;
  api.livetv.channels = [...api.livetv.channels, ...Array.from({ length: 14 }, (_, i) => ({ ...first, id: `ch-x${i}`, number: 40 + i, name: `Zusatz ${i + 1}`, favourite: false }))];
}

test.describe('Live TV on a TV', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    await mockLivePlayer(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.clock.install({ time: NOW });
  });

  test('layout: 360 px tiles, a focusable chip row, 96 px rows, text of 28 px, one focus with the ring and scale 1.08', async ({ page }) => {
    await page.goto('/live?tv=1');
    await expect(page.locator('html.tv')).toHaveCount(1);
    await expect(rows(page)).toHaveCount(6);
    const tile = (await favs(page).locator('button.tile').first().boundingBox())!;
    expect(Math.round(tile.width)).toBe(360);
    expect(Math.abs(tile.width / tile.height - 16 / 9)).toBeLessThan(0.03);
    const row = (await rows(page).first().boundingBox())!;
    expect(Math.round(row.height)).toBe(96);
    expect(Math.round((await rows(page).first().locator('.logo').boundingBox())!.width)).toBe(72);
    const fs = await rows(page).first().locator('.name').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(fs).toBeGreaterThanOrEqual(28);
    // the chips are buttons the D-pad can reach
    await expect(chips(page).getByRole('button')).toHaveText(['Alle', 'Favoriten', 'Zuletzt gesehen', 'Allgemein', 'Sport', 'Kinder']);
    // the last watched row has the one focus: a 3 px white ring and scale(1.08)
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    const look = await focused(page).evaluate((e) => { const s = getComputedStyle(e); return { w: s.outlineWidth, c: s.outlineColor, t: s.transform, n: document.querySelectorAll(':focus').length }; });
    expect(look).toEqual({ w: '3px', c: 'rgb(255, 255, 255)', t: 'matrix(1.08, 0, 0, 1.08, 0, 0)', n: 1 });
    // calm and still: nothing in the list animates
    expect(await rows(page).first().evaluate((e) => parseFloat(getComputedStyle(e.querySelector('.main')!).transitionDuration))).toBeLessThan(0.001);
  });

  test('spatial navigation and ChannelDown jumps 8 rows', async ({ page, api }) => {
    longList(api);
    await page.goto('/live?tv=1');
    await expect(rows(page)).toHaveCount(20);
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    // ▲ ▲ ▲ to the first row, ▼ to the second
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    await page.keyboard.press('ArrowDown');
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    // ChannelDown: 8 rows on (index 1 -> 9), ChannelUp: back
    await remote(page, 'ChannelDown');
    await expect(focused(page)).toHaveAccessibleName(/^43 Zusatz 4/);
    // the focused row stays in the middle third of the screen
    const mid = async () => { const b = (await focused(page).boundingBox())!; return b.y + b.height / 2; };
    expect(await mid()).toBeGreaterThan(1080 / 3 - 6);
    expect(await mid()).toBeLessThan((1080 * 2) / 3 + 6);
    await remote(page, 'ChannelUp');
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    // a jump stops at the end of the list
    await remote(page, 'ChannelDown'); await remote(page, 'ChannelDown'); await remote(page, 'ChannelDown');
    await expect(focused(page)).toHaveAccessibleName(/^53 Zusatz 14/);
    // ▲ from the first row goes to the chip row (the chosen chip), ▲ again to the favourites, ▼ back to the chip, ▼ into the list
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp'); // 19 rows up, then the chip row
    await expect(focused(page)).toHaveText('Alle');
    await page.keyboard.press('ArrowRight');
    await expect(focused(page)).toHaveText('Favoriten');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await expect(favs(page).locator('button.tile').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(chips(page).locator(':focus')).toHaveCount(1); // the chip below the tile
    await page.keyboard.press('ArrowDown');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    // ◀ from a row opens the rail
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('nav.rail')).toHaveClass(/open/);
  });

  test('the hint line names only keys this device sent', async ({ page, api }) => {
    longList(api);
    await page.goto('/live?tv=1');
    await expect(hint(page)).toHaveText('OK: ansehen · Lang OK: Favorit');
    await expect(hint(page)).not.toContainText('CH');
    // nothing about the hint moves the list: a hint line of reserved height
    const spot = async () => ({ h: await hint(page).boundingBox(), r: await rows(page).nth(5).evaluate((e) => e.getBoundingClientRect().top + scrollY) });
    await page.keyboard.press('ArrowUp'); // to a row with room around it, scroll position settled
    const before = await spot();
    await remote(page, 'ChannelDown');
    await expect(hint(page)).toHaveText('OK: ansehen · Lang OK: Favorit · CH ▲▼: 8 Zeilen');
    const after = await spot();
    expect(after).toEqual(before);
    // kept for this device: after a reload it is still there
    await page.reload();
    await expect(hint(page)).toContainText('CH ▲▼: 8 Zeilen');
    await expect(hint(page)).not.toContainText('letzter Sender');
    // a digit adds the 0 hint
    await page.keyboard.press('4');
    await expect(hint(page)).toHaveText('OK: ansehen · Lang OK: Favorit · CH ▲▼: 8 Zeilen · 0: letzter Sender');
  });

  /** D-pad to the ▶ star of Bergblick Sport (7), which is no favourite yet */
  async function toBergStar(page: Page) {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp'); // Nordlicht TV
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // Bergblick Sport (7)
    await expect(focused(page)).toHaveAccessibleName(/^7 Bergblick Sport/);
    await page.keyboard.press('ArrowRight');
    await expect(focused(page)).toHaveAccessibleName('Zu Favoriten: Bergblick Sport');
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'false');
  }
  /** holds every favourite request of the page until `release()`; `seen` counts the requests that reached the network */
  async function holdStars(page: Page) {
    const seen: string[] = [];
    const gates: Array<() => void> = [];
    await page.route('**/api/livetv/favourites/*', async (r) => {
      seen.push(r.request().method());
      await new Promise<void>((res) => gates.push(res));
      await r.fallback();
    });
    return { seen, release: () => { gates.shift()?.(); } };
  }

  test('D-pad only: ▶ star and OK toggle favourite (no long press)', async ({ page, api }) => {
    await toBergStar(page);
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'true');
    // the request is recorded (and answered) before the next step, so nothing here races the save
    await expect.poll(() => api.livetv.calls.length).toBe(1);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-berg']);
    await expect(favs(page).locator('button.tile')).toHaveCount(4);
    // ◀ goes back to the row, nothing was opened
    await page.keyboard.press('ArrowLeft');
    await expect(focused(page)).toHaveAccessibleName(/^7 Bergblick Sport/);
    expect(new URL(page.url()).pathname).toBe('/live');
    // OK on the star again takes the favourite away
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => api.livetv.calls.length).toBe(2);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-berg', 'DELETE /api/livetv/favourites/ch-berg']);
    await expect(favs(page).locator('button.tile')).toHaveCount(3);
  });

  test('OK twice in quick succession (R27): the second press is not lost, the final state is stored with 2 requests', async ({ page, api }) => {
    await toBergStar(page);
    const held = await holdStars(page);
    await page.keyboard.press('Enter');
    await expect.poll(() => held.seen.length).toBe(1); // the first save is on the wire and held
    await page.keyboard.press('Enter'); // a press during the running save
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'false'); // the star shows the latest press at once
    held.release();
    await expect.poll(() => held.seen).toEqual(['POST', 'DELETE']); // exactly one more request, for the second press
    held.release();
    await expect.poll(() => api.livetv.calls.length).toBe(2);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-berg', 'DELETE /api/livetv/favourites/ch-berg']);
    expect(api.livetv.favourites).not.toContain('ch-berg');
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(favs(page).locator('button.tile')).toHaveCount(3);
  });

  test('OK three times quickly: the final state, at most 2 requests', async ({ page, api }) => {
    await toBergStar(page);
    const held = await holdStars(page);
    await page.keyboard.press('Enter');
    await expect.poll(() => held.seen.length).toBe(1);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'true');
    held.release();
    await expect(favs(page).locator('button.tile')).toHaveCount(4);
    await expect.poll(() => api.livetv.favourites.includes('ch-berg')).toBe(true);
    await page.waitForTimeout(300); // nothing more may follow
    expect(held.seen.length).toBeLessThanOrEqual(2);
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-berg']);
    await expect(focused(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test.describe('a refused save', () => {
    test.use({ allowedConsole: /Failed to load resource/ });
    test('rolls the star back and shows the error toast', async ({ page, api }) => {
      await toBergStar(page);
      await page.route('**/api/livetv/favourites/*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'error' }) }));
      await page.keyboard.press('Enter');
      await expect(page.getByRole('region', { name: 'Hinweise' })).toContainText(/\S/); // the error toast
      await expect(focused(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(favs(page).locator('button.tile')).toHaveCount(3);
      expect(api.livetv.calls).toEqual([]);
    });
  });

  test('OK on a row watches it', async ({ page }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    await opensPlayer(page, () => page.keyboard.press('Enter'), 'ch-kinder');
  });

  test('digits 4 then OK focus Hafenkanal', async ({ page }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    await page.keyboard.press('4');
    const card = page.getByRole('status').filter({ hasText: 'Hafenkanal' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('4');
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    await expect(card).toHaveCount(0);
    // an unknown number says so for 2 s
    await page.keyboard.press('9'); await page.keyboard.press('9'); await page.keyboard.press('9');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Kein Sender 999' })).toBeVisible();
    await page.clock.runFor(2100);
    await expect(page.getByRole('status').filter({ hasText: 'Kein Sender 999' })).toHaveCount(0);
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    // 2 s without input commits the typed number
    await page.keyboard.press('2'); await page.keyboard.press('1');
    await page.clock.runFor(2100);
    await expect(focused(page)).toHaveAccessibleName(/^21 Sternwarte 24/);
  });

  test('a lone 0 focuses the last watched row', async ({ page, api }) => {
    api.livetv.recent = ['ch-hafen', 'ch-kinder'];
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    await page.keyboard.press('ArrowUp');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    await page.keyboard.press('0');
    await expect(page.getByRole('status').filter({ hasText: '0 · Letzter Sender: 4 Hafenkanal' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    // Back closes the number card first and stays on the list
    await page.keyboard.press('0');
    await expect(page.getByRole('status').filter({ hasText: 'Letzter Sender' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('status').filter({ hasText: 'Letzter Sender' })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/live');
  });

  test('long OK toggles favourite', async ({ page, api }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp'); // Nordlicht TV
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // Bergblick Sport
    await expect(focused(page)).toHaveAccessibleName(/^7 Bergblick Sport/);
    await page.keyboard.down('Enter');
    await page.clock.runFor(650);
    await page.keyboard.up('Enter');
    await expect(rows(page).filter({ hasText: 'Bergblick Sport' }).locator('.star')).toHaveAttribute('aria-pressed', 'true');
    expect(api.livetv.calls).toEqual(['POST /api/livetv/favourites/ch-berg']);
    expect(new URL(page.url()).pathname).toBe('/live'); // a long OK does not watch
    // a short OK still does
    await opensPlayer(page, () => page.keyboard.press('Enter'), 'ch-berg');
  });

  test('entering focuses the last channel', async ({ page, api }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    // the player committed another channel: back on the list that row has the focus
    api.livetv.recent = ['ch-nord', 'ch-kinder'];
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    // nothing watched yet: the first row
    api.livetv.recent = [];
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
  });

  test('Info opens the info panel of the focused channel, Back closes it and gives the focus back', async ({ page }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    await remote(page, 'Info');
    const panel = page.getByRole('dialog', { name: 'Kinderinsel' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Abenteuer Wattenmeer');
    await expect(panel).toContainText('Sternstunde Physik');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    expect(new URL(page.url()).pathname).toBe('/live');
  });

  test('Info opens the panel, OK on its Close button closes it and the focus returns to the row', async ({ page }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    await remote(page, 'Info');
    const panel = page.getByRole('dialog', { name: 'Kinderinsel' });
    await expect(panel).toBeVisible();
    await expect(focused(page)).toHaveText('Schließen');
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    // a pointer click on Close works as well
    await remote(page, 'Info');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Schließen' }).click();
    await expect(panel).toHaveCount(0);
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    expect(new URL(page.url()).pathname).toBe('/live');
  });

  test('play=last opens the player and Back returns to the list, Back again goes home', async ({ page, api }) => {
    await page.goto('/live?play=last&tv=1');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/live/watch/ch-kinder');
    expect(new URL(page.url()).searchParams.has('play')).toBe(false); // the redirect replaced the play=last entry
    await expect(page.locator('[data-live-state]')).toBeVisible(); // the real player, loaded on the shared mocks
    // the player committed PUT /last for what it played
    api.livetv.recent = ['ch-hafen', 'ch-kinder'];
    await page.goBack();
    await expect(rows(page)).toHaveCount(6);
    const u = new URL(page.url());
    expect(u.pathname).toBe('/live');
    expect(u.searchParams.has('play')).toBe(false);
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });

  test('play=last without a last channel shows the list', async ({ page, api }) => {
    api.livetv.recent = [];
    await page.goto('/live?play=last&tv=1');
    await expect(rows(page)).toHaveCount(6);
    expect(new URL(page.url()).pathname).toBe('/live');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
  });
});

test.describe('TV startet mit Live-TV', () => {
  test.beforeEach(async ({ page, api }) => {
    api.features = { livetv: true };
    await mockLivePlayer(page);
    await page.routeWebSocket(/\/ws\/remote/, () => {});
  });

  test('/tv with startLive replaces to /live?play=last', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, startLive: true, features: { livetv: true } } }));
    const to = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname === '/live' && new URL(r.url()).search === '?play=last');
    await page.goto('/tv');
    await to;
    await expect.poll(() => new URL(page.url()).pathname).toBe('/live/watch/ch-kinder');
  });

  test('/tv without startLive goes home', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, startLive: false, features: { livetv: true } } }));
    await page.goto('/tv');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });
});

test.describe('admin devices: TV startet mit Live-TV', () => {
  test.use({ allowedConsole: /status of 500/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  const tvDevice = { user_id: 'u1', device_id: 'tv-0123456789abcdef', label: 'LG webOS TV', approved: true, last_seen: new Date().toISOString(), name: 'Anna Beispiel' };

  test('the toggle sends { startLive: true } for a TV only', async ({ page, api }) => {
    api.admin.devices.push({ ...tvDevice });
    await page.goto('/admin/devices');
    const sw = page.getByRole('switch', { name: 'TV startet mit Live-TV' });
    await expect(sw).toHaveCount(1); // the other devices are no TVs (their ids do not start with tv-)
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => api.log.filter((l) => l.startsWith('PATCH /api/admin/devices/'))).toEqual(['PATCH /api/admin/devices/u1/tv-0123456789abcdef {"startLive":true} -> 200']);
    expect(api.admin.devices.find((d) => d.device_id.startsWith('tv-'))!.startLive).toBe(true);
    // and off again
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => api.admin.devices.find((d) => d.device_id.startsWith('tv-'))!.startLive).toBe(false);
  });

  test('a refused change puts the switch back', async ({ page, api }) => {
    api.admin.devices.push({ ...tvDevice });
    await page.route('**/api/admin/devices/u1/tv-*', (r) => (r.request().method() === 'PATCH' ? r.fulfill({ status: 500, json: { error: 'boom' } }) : r.fallback()));
    await page.goto('/admin/devices');
    const sw = page.getByRole('switch', { name: 'TV startet mit Live-TV' });
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

// Samsung and LG remotes (Task 43, spec §12.3, §14): the keys come with `key: 'Unidentified'` and only a keyCode. Tizen registers its live
// keys when the Live area opens and maps their codes (`getKey(name).code`); LG has no CH keys in web apps (▲/▼ zap), but maps 457 (Info),
// the colour keys and, when a TV sends them, PageUp/PageDown (33/34). The hint line names a CH key only after it arrived.
const MIN = 60_000;
/** a remote key as the TV sends it: no usable `key`, only the keyCode */
const press = (page: Page, keyCode: number) =>
  page.evaluate((keyCode) => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { keyCode, key: 'Unidentified', bubbles: true, cancelable: true } as KeyboardEventInit)); }, keyCode);
async function armPlayer(page: Page, api: MockState) {
  api.features = { livetv: true };
  api.livetv.dvrPlaylist = true;
  api.livetv.liveStart = Date.now() - 10 * MIN;
  await page.route('**/api/playback/timing', (r) => r.fulfill({ status: 204 }));
  api.livetv.timeShift = NOW.getTime() - Date.now();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.clock.install({ time: NOW });
}
const playing = (page: Page) => expect(page.locator('[data-live-state]')).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });

test.describe('Samsung remote (Tizen)', () => {
  test('registers its live keys and ChannelList opens the Senderliste', async ({ page, api }) => {
    await armPlayer(page, api);
    await page.addInitScript(() => {
      const w = window as unknown as { __reg: string[]; tizen: unknown };
      w.__reg = [];
      const codes: Record<string, number> = { ChannelUp: 427, ChannelDown: 428, PreviousChannel: 10190, Info: 457, ColorF0Red: 403, ColorF3Blue: 406, ChannelList: 10073 };
      w.tizen = { tvinputdevice: {
        registerKey: (n: string) => { w.__reg.push(n); },
        getKey: (n: string) => ({ code: codes[n] ?? 48 }),
        getSupportedKeys: () => ['ChannelList'].map((name) => ({ name, code: codes[name] })), // no Guide on this TV
      } };
    });
    await page.goto('/live/watch/ch-kinder?f=all&tv=1&ff_app=tizen');
    await playing(page);
    const reg = await page.evaluate(() => (window as unknown as { __reg: string[] }).__reg);
    expect(reg).toEqual(expect.arrayContaining(['ChannelUp', 'ChannelDown', 'PreviousChannel', 'Info', '0', '9', 'ColorF0Red', 'ColorF3Blue', 'ChannelList']));
    expect(reg).not.toContain('Guide');
    await press(page, 10073);
    const panel = page.getByRole('dialog', { name: 'Senderliste' });
    await expect(panel).toBeVisible();
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
  });
});

test.describe('LG remote (webOS)', () => {
  test.beforeEach(async ({ page, api }) => {
    await armPlayer(page, api);
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true, features: { livetv: true } } }));
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await asLgApp(page);
  });

  test('▲ switches the channel up without any CH key', async ({ page, api }) => {
    await page.goto('/live/watch/ch-nord?f=all&tv=1&ff_app=webos');
    await playing(page);
    await page.clock.runFor(5200); // the controls hide by themselves, so ▲ zaps instead of moving the focus
    await expect(page.getByRole('group', { name: 'Wiedergabesteuerung' })).toHaveClass(/\bhide\b/);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.lbanner')).toContainText('4 Hafenkanal');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
  });

  test('keyCode 33 also switches up when the TV sends it', async ({ page, api }) => {
    await page.goto('/live/watch/ch-nord?f=all&tv=1&ff_app=webos');
    await playing(page);
    await press(page, 33);
    await expect(page.locator('.lbanner')).toContainText('4 Hafenkanal');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
  });

  test('457 opens the info panel', async ({ page }) => {
    await page.goto('/live/watch/ch-nord?f=all&tv=1&ff_app=webos');
    await playing(page);
    await press(page, 457);
    await expect(page.getByRole('dialog', { name: 'Programm' })).toBeVisible();
  });

  test('Red jumps to the last channel', async ({ page, api }) => {
    api.livetv.recent = ['ch-hafen'];
    await page.goto('/live/watch/ch-nord?f=all&tv=1&ff_app=webos');
    await playing(page);
    await press(page, 403);
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    await expect(page.locator('.lbanner')).toContainText('4 Hafenkanal');
  });

  test('the list\'s hint line shows no CH hint until a PageUp/PageDown arrived', async ({ page }) => {
    await page.goto('/live?tv=1&ff_app=webos');
    await expect(rows(page)).toHaveCount(6);
    await expect(hint(page)).toHaveText('OK: ansehen · Lang OK: Favorit');
    await press(page, 33);
    await expect(hint(page)).toContainText('CH ▲▼: 8 Zeilen');
  });
});
