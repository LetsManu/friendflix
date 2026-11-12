// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';

// The live player on a TV remote (Task 40, spec §12.2, §12.3): OK with the controls hidden shows them (focus on Play/Pause, the info
// banner with them) and never pauses; OK on the focused Play/Pause pauses; a long OK (>= 600 ms), ChannelList and, in Phase 1, Guide
// open the Senderliste panel on the playing channel; ▲/▼ move in it, OK switches and closes it, Back closes it and gives the focus
// back to the player (controls stay hidden); Back then hides the controls, then leaves for the list (the playing row focused). The
// D-pad alone reaches every control. Desktop: the Senderliste button opens a dialog (Escape / a click outside close it, the focus
// returns to the button); phone: the info sheet has the button. `?tv=1` is the TV preview (html.tv); a fake clock stands at
// Thursday 2026-11-12 20:37:10 (local), `timeShift` makes the mock playlist's date-times follow it.
//
// DOM contract: the control bar is role="group" "Wiedergabesteuerung" (class `hide` while hidden), `.ctlhint` its TV footer line;
// the root carries `data-live-state`; `.lstage` is the stage; `.lbanner` the info banner (class `on` while shown); the panel is
// role="dialog" "Senderliste" with its rows in the list "Senderliste".
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const MIN = 60_000;
const HIDE_TV_MS = 5000; // CONTROLS_HIDE_TV_MS (web/src/lib/player/timing.ts)

const bar = (page: Page) => page.getByRole('group', { name: 'Wiedergabesteuerung' });
const live = (page: Page) => page.locator('[data-live-state]');
const banner = (page: Page) => page.locator('.lbanner');
const panel = (page: Page) => page.getByRole('dialog', { name: 'Senderliste' });
const panelRows = (page: Page) => panel(page).getByRole('list', { name: 'Senderliste' }).getByRole('button');
const focused = (page: Page): Locator => page.locator(':focus');
const paused = (page: Page) => page.evaluate(() => document.querySelector('video')!.paused);
const activeClass = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '');
/** a remote key the browser keyboard cannot type (ChannelList, Guide, …): a keydown on the focused element, as the TV shell sends it */
const remote = (page: Page, key: string) =>
  page.evaluate((key) => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }, key);

async function arm(page: Page, api: MockState) {
  api.features = { livetv: true };
  api.livetv.dvrPlaylist = true;
  api.livetv.liveStart = Date.now() - 10 * MIN;
  await page.route('**/api/playback/timing', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/cast/config', (r) => r.fulfill({ json: { enabled: false } })); // the player asks for the cast switch once (Task 41)
  api.livetv.timeShift = NOW.getTime() - Date.now();
  await page.clock.install({ time: NOW });
}
async function open(page: Page, id = 'ch-nord', q = 'f=all&tv=1') {
  await page.goto(`/live/watch/${id}?${q}`);
  await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
}
/** lets the controls' auto-hide run out without a key (the fake clock runs `ms`, past CONTROLS_HIDE_TV_MS) */
async function hideByClock(page: Page, ms = HIDE_TV_MS + 200) {
  await page.clock.runFor(ms);
  await expect(bar(page)).toHaveClass(/\bhide\b/);
}
/** presses ArrowRight / ArrowDown until the focused element has this name (at most `max` presses) */
async function moveTo(page: Page, key: 'ArrowRight' | 'ArrowDown', name: string | RegExp, max = 12) {
  for (let i = 0; i < max; i++) {
    const n = await focused(page).getAttribute('aria-label').catch(() => null) ?? await focused(page).textContent().catch(() => '');
    if (typeof name === 'string' ? n === name : name.test(n ?? '')) return;
    await page.keyboard.press(key);
  }
  await expect(focused(page)).toHaveAccessibleName(name);
}

test.describe('live player on a TV remote', () => {
  test.beforeEach(async ({ page, api }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await arm(page, api);
  });

  test('OK shows the controls and the banner with focus on Play/Pause; OK again pauses', async ({ page }) => {
    await open(page);
    await hideByClock(page);
    await expect(banner(page)).not.toHaveClass(/\bon\b/);
    await page.keyboard.press('Enter');
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await expect(focused(page)).toHaveAccessibleName('Pause');
    await expect(banner(page)).toHaveClass(/\bon\b/);
    await expect(banner(page)).toContainText('1 Nordlicht TV');
    expect(await paused(page)).toBe(false);
    await page.keyboard.press('Enter');
    await expect.poll(() => paused(page)).toBe(true);
  });

  test('OK with the controls hidden never pauses', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 5; i++) {
      await hideByClock(page, 6000); // each OK finds the controls hidden: five presses spread over 30 s
      await page.keyboard.press('Enter');
      await expect(bar(page)).not.toHaveClass(/\bhide\b/);
      expect(await paused(page), `press ${i + 1}`).toBe(false);
    }
    const t1 = await page.evaluate(() => document.querySelector('video')!.currentTime);
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(t1 + 0.2);
    expect(await paused(page)).toBe(false);
  });

  test('long OK opens the Senderliste on the playing channel', async ({ page, api }) => {
    await open(page, 'ch-hafen');
    await hideByClock(page);
    await page.keyboard.down('Enter');
    await page.clock.runFor(650);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('aria-modal', 'true');
    // the held key repeats and its keyup switch nothing
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(panel(page)).toBeVisible();
    expect(api.livetv.watches).toEqual(['ch-hafen']);
    // the playing channel's row has the one focus: scale(1.08) and the 3 px white ring
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    await expect(focused(page)).toHaveAttribute('aria-current', 'true');
    const look = await focused(page).evaluate((e) => { const s = getComputedStyle(e); return { w: s.outlineWidth, c: s.outlineColor, t: s.transform, n: document.querySelectorAll(':focus').length }; });
    expect(look).toEqual({ w: '3px', c: 'rgb(255, 255, 255)', t: 'matrix(1.08, 0, 0, 1.08, 0, 0)', n: 1 });
    // the filter chips of the list, on the current one; a TV panel is solid and still
    await expect(panel(page).getByRole('button', { name: 'Alle' })).toHaveAttribute('aria-pressed', 'true');
    expect(await panel(page).evaluate((e) => parseFloat(getComputedStyle(e).transitionDuration))).toBe(0);
  });

  test('panel rows show the data states', async ({ page }) => {
    await open(page);
    await remote(page, 'ChannelList');
    await expect(panelRows(page)).toHaveCount(6);
    const row = (name: string) => panelRows(page).filter({ hasText: name });
    await expect(row('Kanal Wolkenlos')).toContainText('Programm gerade nicht verfügbar');
    await expect(row('Sternwarte 24')).toContainText('Live');
    await expect(row('Bergblick Sport')).toContainText('Gerade keine Übertragung');
    await expect(row('Nordlicht TV')).toContainText('Die Leuchtturmwärter');
    const heights = await panelRows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight)); // layout height (the focused row is scaled)
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeGreaterThanOrEqual(54);
  });

  test('▼ then OK in the panel switches, closes it and shows the banner', async ({ page, api }) => {
    await open(page);
    await hideByClock(page);
    await remote(page, 'ChannelList');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    await page.keyboard.press('ArrowDown');
    await expect(focused(page)).toHaveAccessibleName(/^4 Hafenkanal/);
    expect(api.livetv.watches).toEqual(['ch-nord']); // ▲/▼ inside the panel move, they do not zap
    await page.keyboard.press('Enter');
    await expect(panel(page)).toHaveCount(0);
    await expect(banner(page)).toHaveClass(/\bon\b/);
    await expect(banner(page)).toContainText('4 Hafenkanal');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    // the controls stay hidden after the switch, so ▼ outside the panel zaps again (to the channel before Hafenkanal)
    await expect(bar(page)).toHaveClass(/\bhide\b/);
    await page.keyboard.press('ArrowDown');
    await expect(banner(page)).toContainText('1 Nordlicht TV');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen', 'ch-nord']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    // ◀/▶ change the chip: Favoriten, where Nordlicht TV is a favourite and keeps the focus
    await remote(page, 'ChannelList');
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    await page.keyboard.press('ArrowRight');
    await expect(panel(page).getByRole('button', { name: 'Favoriten' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panelRows(page)).toHaveCount(3);
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    await expect(focused(page)).toHaveAttribute('aria-current', 'true');
  });

  test('closing the panel re-arms the control hiding: a pointer wake behind the panel does not strand the controls', async ({ page, api }) => {
    await open(page);
    await hideByClock(page);
    await remote(page, 'ChannelList');
    await expect(panel(page)).toBeVisible();
    await page.mouse.move(300, 300); // an LG pointer / media session wakes the controls behind the panel
    await page.mouse.move(340, 320);
    await page.keyboard.press('Escape'); // Back closes the panel
    await expect(panel(page)).toHaveCount(0);
    await expect(bar(page)).toHaveClass(/\bhide\b/);
    await page.keyboard.press('ArrowDown'); // so the next ▼ zaps instead of moving the focus
    await expect.poll(() => api.livetv.watches.length).toBe(2);
  });

  test('a held OK after a panel pick (repeat:false) does not reopen the panel', async ({ page }) => {
    await open(page);
    await hideByClock(page);
    await remote(page, 'ChannelList');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.down('Enter'); // the pick; the key stays down
    await expect(panel(page)).toHaveCount(0);
    await remote(page, 'Enter'); // a TV's key repeat that says repeat:false
    await page.clock.runFor(900);
    await expect(panel(page)).toHaveCount(0);
    await page.keyboard.up('Enter');
  });

  test('Back closes the panel and focus returns to the player; Back hides the controls; Back goes to the list with the playing row focused', async ({ page, api }) => {
    await page.goto('/live?tv=1');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    await page.keyboard.press('Enter');
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    // Back closes the panel: the focus is on the stage, the controls stay hidden, the channel plays on
    await remote(page, 'ChannelList');
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    expect(await activeClass(page)).toContain('lstage');
    await expect(bar(page)).toHaveClass(/\bhide\b/);
    expect(api.livetv.watches).toEqual(['ch-kinder']);
    // Back hides the controls (and stays in the player)
    await page.keyboard.press('Enter');
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveClass(/\bhide\b/);
    expect(new URL(page.url()).pathname).toBe('/live/watch/ch-kinder');
    // a switch from the panel, then Back goes to the list with the row of what played
    await remote(page, 'ChannelList');
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => api.livetv.recent[0]).toBe('ch-stern');
    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/live');
    await expect(focused(page)).toHaveAccessibleName(/^21 Sternwarte 24/);
  });

  test('ChannelList opens the panel', async ({ page }) => {
    await open(page, 'ch-kinder');
    await remote(page, 'ChannelList');
    await expect(panel(page)).toBeVisible();
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
  });

  test('Guide opens the panel in Phase 1', async ({ page }) => {
    await open(page, 'ch-kinder', 'f=fav&tv=1');
    await remote(page, 'Guide');
    await expect(panel(page)).toBeVisible();
    // it opens on the player's filter: Favoriten in the person's order
    await expect(panel(page).getByRole('button', { name: 'Favoriten' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panelRows(page)).toHaveCount(3);
    await expect(focused(page)).toHaveAccessibleName(/^12 Kinderinsel/);
  });

  test('the controls\' footer says Lang OK: Senderliste', async ({ page }) => {
    await open(page);
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await expect(page.locator('.ctlhint')).toHaveText('Lang OK: Senderliste');
    await expect(page.locator('.ctlhint')).toBeVisible();
  });

  test('D-pad only reaches Senderliste, Programm and Letzter Sender', async ({ page, api }) => {
    await open(page);
    await hideByClock(page);
    // Senderliste: OK, then ▶ along the bar, OK
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAccessibleName('Pause');
    await moveTo(page, 'ArrowRight', 'Senderliste');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    // Programm: the info panel
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAccessibleName('Pause');
    await moveTo(page, 'ArrowRight', 'Programm');
    await page.keyboard.press('Enter');
    const info = page.getByRole('dialog', { name: 'Programm' });
    await expect(info).toBeVisible();
    // Letzter Sender in the info panel: ▼ to it, OK
    await moveTo(page, 'ArrowDown', 'Zurück zu 12 Kinderinsel');
    await page.keyboard.press('Enter');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-kinder']);
  });

  test('▲ on the visible controls reaches the top bar, ◀ ▶ move in it and ▼ comes back', async ({ page }) => {
    await open(page);
    await hideByClock(page);
    await page.keyboard.press('Enter');
    await expect(focused(page)).toHaveAccessibleName('Pause');
    const zone = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.ltop') ? 'top' : (document.activeElement as HTMLElement | null)?.closest('.ctl') ? 'bar' : 'other');
    const who = () => page.evaluate(() => { const e = document.activeElement as HTMLElement | null; return `${e?.className}|${e?.getAttribute('aria-label') ?? ''}`; });
    await page.keyboard.press('ArrowUp');
    await expect.poll(zone).toBe('top');
    const seen = new Set([await who()]);
    await page.keyboard.press('ArrowLeft');
    expect(await zone()).toBe('top');
    seen.add(await who());
    await page.keyboard.press('ArrowRight');
    expect(await zone()).toBe('top');
    seen.add(await who());
    await page.keyboard.press('ArrowRight');
    expect(await zone()).toBe('top');
    seen.add(await who());
    expect(seen.size, 'the arrows move the focus between the buttons of the top bar').toBeGreaterThan(1);
    await page.keyboard.press('ArrowDown');
    await expect.poll(zone).toBe('bar');
    expect(await paused(page)).toBe(false);
  });
});

test.describe('live player Senderliste (desktop)', () => {
  test('the Senderliste button opens the dialog; Escape closes it and focus returns to the button', async ({ page, api }) => {
    await arm(page, api);
    await open(page, 'ch-nord', 'f=all');
    await page.mouse.move(600, 300);
    const btn = bar(page).getByRole('button', { name: 'Senderliste' });
    await btn.click();
    await expect(panel(page)).toBeVisible();
    await expect(focused(page)).toHaveAccessibleName(/^1 Nordlicht TV/);
    // the focus stays in the dialog (Tab wraps)
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(focused(page)).toHaveAccessibleName('Senderliste');
    // a click outside closes it as well; a click on a row switches
    await btn.click();
    await expect(panel(page)).toBeVisible();
    await page.mouse.click(40, 400);
    await expect(panel(page)).toHaveCount(0);
    await btn.click();
    await panelRows(page).filter({ hasText: 'Hafenkanal' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
  });
});

test.describe('live player Senderliste (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the info sheet has Senderliste', async ({ page, api }) => {
    await arm(page, api);
    await open(page, 'ch-nord', 'f=all');
    await expect(bar(page).getByRole('button', { name: 'Senderliste' })).toHaveCount(0); // on phones it lives in the info sheet
    await bar(page).getByRole('button', { name: 'Programm' }).click();
    const info = page.getByRole('dialog', { name: 'Programm' });
    await info.getByRole('button', { name: 'Senderliste' }).click();
    await expect(info).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(panelRows(page)).toHaveCount(6);
  });
});
