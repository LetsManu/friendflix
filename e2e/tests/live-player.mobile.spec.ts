// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { castOn, fakeCastSdk } from '../mocks/cast.js';

// The live player on a phone (Task 39, spec §12.3): a horizontal swipe on the centre zone switches the channel (left = next,
// right = previous), the side zones keep brightness (left) and volume (right); with reduced motion (the suite's default) nothing
// transitions and a switch still goes through (it waits for a timer and the watch answer, never for an animation). Real touches
// through CDP, so the pointer events are the browser's own. A fake clock stands at 2026-11-12 20:37:10.
// DOM contract: `.lstage` is the gesture surface, `.lbanner` the info banner, the control bar role="group" "Wiedergabesteuerung".
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const MIN = 60_000;

const banner = (page: Page) => page.locator('.lbanner');
const bar = (page: Page) => page.getByRole('group', { name: 'Wiedergabesteuerung' });
const live = (page: Page) => page.locator('[data-live-state]');

async function arm(page: Page, api: MockState) {
  api.features = { livetv: true };
  api.livetv.dvrPlaylist = true;
  api.livetv.liveStart = Date.now() - 10 * MIN;
  await page.route('**/api/playback/timing', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/cast/config', (r) => r.fulfill({ json: { enabled: false } })); // the player asks for the cast switch once (Task 41)
  api.livetv.timeShift = NOW.getTime() - Date.now();
  await page.clock.install({ time: NOW });
}
async function open(page: Page, id = 'ch-nord', f = 'all') {
  await page.goto(`/live/watch/${id}?f=${f}`);
  await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
}
/** a finger from one point of the stage to another (fractions of its box), in ten steps */
async function touchDrag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator('.lstage').boundingBox())!;
  const pt = (f: [number, number]) => ({ x: box.x + box.width * f[0], y: box.y + box.height * f[1] });
  const a = pt(from), b = pt(to);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
/** the surface's own transition durations and its subtree's running CSS transitions */
const motionOf = (loc: Locator) => loc.evaluate((el) => ({
  durations: getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d)),
  running: el.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).length,
}));
async function stillSurfaces(page: Page, when: string) {
  for (const [name, loc] of [['banner', banner(page)], ['control bar', bar(page)]] as const) {
    const m = await motionOf(loc);
    expect(m.durations.every((d) => d === 0), `${name} transition durations ${when}`).toBe(true);
    expect(m.running, `${name} running transitions ${when}`).toBe(0);
  }
}

test.describe('live player (phone)', () => {
  test('a horizontal swipe on the centre zone switches the channel', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await touchDrag(page, [0.55, 0.35], [0.2, 0.35]); // left = next
    await expect(banner(page)).toContainText('4 Hafenkanal');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await touchDrag(page, [0.45, 0.35], [0.8, 0.35]); // right = previous
    await expect(banner(page)).toContainText('1 Nordlicht TV');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen', 'ch-nord']);
  });

  test('the side zones keep brightness and volume', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    const v0 = await page.evaluate(() => document.querySelector('video')!.volume);
    await touchDrag(page, [0.12, 0.3], [0.12, 0.6]); // left third, down: darker
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.style.filter)).toMatch(/brightness\(0?\.\d+\)/);
    await touchDrag(page, [0.88, 0.3], [0.88, 0.6]); // right third, down: quieter
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.volume)).toBeLessThan(v0);
    await page.waitForTimeout(600); // longer than the switch debounce
    expect(api.livetv.watches).toEqual(['ch-nord']);
  });

  test('reduced motion: no transitions, and the switch still goes through', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    const before = api.livetv.watches.length; // the open's own watch(es); this test is about the switch
    await touchDrag(page, [0.55, 0.35], [0.2, 0.35]);
    await expect(banner(page)).toContainText('4 Hafenkanal');
    await stillSurfaces(page, 'while the switch is pending');
    // exactly one new watch, for the next channel; the message shows the whole list if anything else turns up
    await expect.poll(() => api.livetv.watches.slice(before), { message: `watches after the swipe (all: ${JSON.stringify(api.livetv.watches)})` }).toEqual(['ch-hafen']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await stillSurfaces(page, 'after the switch');
    expect(api.livetv.watches.slice(before), `all watches: ${JSON.stringify(api.livetv.watches)}`).toEqual(['ch-hafen']);
  });

  test('360 px with the cast button: every control of the bar lies inside the screen and Info is clickable', async ({ page, api }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await arm(page, api);
    await castOn(page); // after arm(): the most recent route wins; the Cast button shows when a TV is around
    await fakeCastSdk(page, { pick: true });
    await open(page);
    await expect(bar(page).getByRole('button', { name: 'Abspielen auf …' })).toBeVisible();
    const vw = 360;
    const boxes = await bar(page).getByRole('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { n: e.getAttribute('aria-label'), l: r.left, r: r.right, w: r.width, h: r.height }; }));
    expect(boxes.length).toBeGreaterThanOrEqual(6);
    for (const b of boxes) {
      expect(b.l, `${b.n} left`).toBeGreaterThanOrEqual(0);
      expect(b.r, `${b.n} right`).toBeLessThanOrEqual(vw);
      expect(b.w, `${b.n} width`).toBeGreaterThanOrEqual(44);
      expect(b.h, `${b.n} height`).toBeGreaterThanOrEqual(44);
    }
    // the bar's own content fits it (nothing is clipped by the player)
    expect(await bar(page).evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await bar(page).getByRole('button', { name: 'Programm' }).click();
    await expect(page.getByRole('dialog', { name: 'Programm' })).toBeVisible();
  });
});
