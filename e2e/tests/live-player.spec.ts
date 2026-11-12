// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { livePlaylist, patchChannel, type LivetvMock } from '../mocks/livetv.js';

// The live player on a desktop (Task 39, spec §12, §21): it starts and plays a mocked live HLS stream with a rewind buffer
// (mocks/livetv.ts `dvrPlaylist`: a date-time on every segment), pause / −30 s / +30 s / LIVE, Von Anfang an, the info banner, the
// top bar's time left, zapping (debounced, last channel, the list's filter), the error states of F23, the heartbeat, the re-pin of
// a refused token (Review Focus 4) and the stop on pagehide. A fake clock stands at Thursday 2026-11-12 20:37:10 (local);
// `timeShift` makes the playlist's date-times follow it.
//
// DOM contract used here: the control bar is role="group" named "Wiedergabesteuerung" (class `hide` while hidden); the root carries
// `data-live-state` = LiveUi.k; `.ltop` is the top bar (`.left` its time left); `.lbanner` the aria-hidden info banner;
// `.restartslot` the reserved slot of Von Anfang an.
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const MIN = 60_000;
const REFUSED = /Failed to load resource: the server responded with a status of (403|404|409|410|502|503)/;
const FORBIDDEN = 'Dieser Sender ist für dich nicht mehr verfügbar.';

const bar = (page: Page) => page.getByRole('group', { name: 'Wiedergabesteuerung' });
const pill = (page: Page) => bar(page).getByRole('button', { name: /^(Live|\d+:\d\d hinter live)$/ });
const restart = (page: Page) => bar(page).getByRole('button', { name: 'Von Anfang an' });
const banner = (page: Page) => page.locator('.lbanner');
const topBar = (page: Page) => page.locator('.ltop');
const live = (page: Page) => page.locator('[data-live-state]');
const time = (page: Page) => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
const opacity = (loc: Locator) => loc.evaluateAll((els) => (els.length ? getComputedStyle(els[0] as Element).opacity : '0'));

/** live TV on, a buffer of `dvrMin` minutes from a stream running for `runningMin` minutes, the fake clock at NOW */
async function arm(page: Page, api: MockState, o: { dvrMin?: number; runningMin?: number } = {}) {
  api.features = { livetv: true };
  api.livetv.dvrPlaylist = true;
  if (o.dvrMin !== undefined) api.livetv.dvrSeconds = o.dvrMin * 60;
  api.livetv.liveStart = Date.now() - (o.runningMin ?? 10) * MIN;
  await mockLivePlayer(page);
  api.livetv.timeShift = NOW.getTime() - Date.now();
  await page.clock.install({ time: NOW });
}
async function open(page: Page, id = 'ch-nord', f = 'all') {
  await page.goto(`/live/watch/${id}?f=${f}`);
  await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
}
/** stops the page clock a hair ahead of now: from here only runFor moves it */
async function holdClock(page: Page) {
  const t = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(t + 200);
}
/**
 * Moves the held clock in half-second steps until `done()` holds (at most `maxMs`). Network answers arrive between the timers runFor
 * fires, so one long runFor would also run every timer the answer starts (e.g. the forbidden card's way back to the list); small
 * steps stop right after the moment the test looks for.
 */
async function stepUntil(page: Page, done: () => boolean | Promise<boolean>, maxMs: number) {
  for (let t = 0; t < maxMs; t += 500) {
    if (await done()) return;
    await page.clock.runFor(500);
  }
  expect(await done()).toBe(true);
}
const stepUntilVisible = (page: Page, loc: Locator, maxMs: number) => stepUntil(page, () => loc.isVisible(), maxMs).then(() => expect(loc).toBeVisible());
let wiggle = 0;
/** a mouse move over the stage shows the controls */
async function showControls(page: Page) {
  wiggle = (wiggle + 1) % 2;
  await page.mouse.move(600 + wiggle * 20, 300 + wiggle * 10);
  await expect(bar(page)).not.toHaveClass(/\bhide\b/);
}
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
/** the Jetzt programme of a channel started `ago` minutes before NOW and runs `len` minutes */
function startedAgo(st: LivetvMock, id: string, ago: number, len = 60) {
  patchChannel(st, id, { now: { title: 'Die Leuchtturmwärter', start: new Date(NOW.getTime() - ago * MIN).toISOString(), end: new Date(NOW.getTime() + (len - ago) * MIN).toISOString() } });
}
/** waits until the element's own and its children's transitions are done */
const settled = (loc: Locator) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))).then(() => undefined));
function sameBox(a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null) {
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a![k] - b![k]), k).toBeLessThan(0.5);
}

test.describe('live player (desktop)', () => {
  test('starts and plays', async ({ page, api }) => {
    await arm(page, api);
    await page.goto('/live/watch/ch-nord?f=all');
    await expect.poll(() => time(page), { timeout: 15_000 }).toBeGreaterThan(0.5);
    const t1 = await time(page);
    await expect.poll(() => time(page)).toBeGreaterThan(t1 + 0.5);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing');
    expect(api.livetv.watches).toEqual(['ch-nord']);
    await expect.poll(() => api.livetv.recent[0]).toBe('ch-nord'); // PUT /api/livetv/last
    await showControls(page);
    await expect(pill(page)).toHaveText('LIVE');
    await expect(pill(page)).toHaveAccessibleName('Live');
    // channel ▲/▼ name the neighbour in their tooltip
    await expect(bar(page).getByRole('button', { name: 'Nächster Sender' })).toHaveAttribute('title', /Hafenkanal/);
    await expect(bar(page).getByRole('button', { name: 'Vorheriger Sender' })).toHaveAttribute('title', /Kanal Wolkenlos/);
    // no seek bar: the only slider is the volume
    const sliders = await bar(page).getByRole('slider').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(sliders.every((n) => n === 'Lautstärke')).toBe(true);
    // the token lives in memory only
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('tok-ch-nord');
  });

  test('pause shows the behind pill and LIVE returns to the edge', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await showControls(page);
    await expect(pill(page)).toHaveText('LIVE');
    await bar(page).getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
    await expect(pill(page)).toHaveText(/^−0:\d\d$/, { timeout: 20_000 });
    await expect(pill(page)).toHaveAccessibleName(/^0:\d\d hinter live$/);
    await showControls(page);
    await pill(page).click();
    await expect(pill(page)).toHaveText('LIVE');
    await expect(pill(page)).toHaveAccessibleName('Live');
  });

  test('−30 s', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await showControls(page);
    const fwd = bar(page).getByRole('button', { name: '30 Sekunden vor' });
    await expect(fwd).toBeDisabled(); // +30 s is off at the live edge
    await bar(page).getByRole('button', { name: '30 Sekunden zurück' }).click();
    await expect(pill(page)).toHaveText(/^−0:[23]\d$/);
    await showControls(page);
    await expect(fwd).toBeEnabled();
    await fwd.click();
    await expect(pill(page)).toHaveText('LIVE');
  });

  test('Von Anfang an appears when the programme start is in the buffer and seeks there', async ({ page, api }) => {
    await arm(page, api, { dvrMin: 30, runningMin: 31 });
    startedAgo(api.livetv, 'ch-nord', 5);
    await open(page);
    await showControls(page);
    await expect(restart(page)).toBeVisible();
    const slot = await bar(page).locator('.restartslot').boundingBox();
    const btn = await restart(page).boundingBox();
    expect(btn!.width).toBeLessThanOrEqual(slot!.width + 0.5); // the button sits in its reserved slot
    await restart(page).click();
    await expect(pill(page)).toHaveText(/^−5:[23]\d$/);
    await expect(pill(page)).toHaveAccessibleName(/^5:[23]\d hinter live$/);
  });

  test('Von Anfang an seeks into a long buffer', async ({ page, api }) => {
    await arm(page, api, { dvrMin: 120, runningMin: 121 });
    startedAgo(api.livetv, 'ch-nord', 95, 120);
    await open(page);
    await showControls(page);
    await restart(page).click();
    await expect(pill(page)).toHaveText(/^−95:[23]\d$/, { timeout: 15_000 });
  });

  test('Von Anfang an is absent when the start is older than the buffer', async ({ page, api }) => {
    await arm(page, api, { dvrMin: 10, runningMin: 30 }); // Die Leuchtturmwärter began 20:15, 22 minutes ago
    await open(page);
    await showControls(page);
    await expect(pill(page)).toHaveText('LIVE');
    await expect(restart(page)).toHaveCount(0); // absent, not just hidden
    const slot = await bar(page).locator('.restartslot').boundingBox();
    expect(slot!.width).toBeGreaterThanOrEqual(44); // its slot keeps its width
  });

  test('the pause-too-long toast names the buffer', async ({ page, api }) => {
    await arm(page, api, { dvrMin: 60, runningMin: 61 });
    await open(page);
    await showControls(page);
    await bar(page).getByRole('button', { name: 'Pause' }).click();
    await page.clock.fastForward('01:01:00'); // 61 minutes ("61:00" is no valid mm:ss)
    await showControls(page);
    await bar(page).getByRole('button', { name: 'Abspielen' }).click();
    await expect(page.getByText('Die Pause war länger als 60 Minuten – es geht am ältesten gespeicherten Punkt weiter.')).toBeVisible();
  });

  test('the top bar shows noch 23 Min.', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await showControls(page);
    const top = topBar(page);
    await expect(top).toContainText('Nordlicht TV');
    await expect(top).toContainText('1');
    await expect(top).toContainText('Die Leuchtturmwärter');
    await expect(top).toContainText('20:15–21:00');
    await expect(top.locator('.left')).toHaveText('noch 23 Min.');
    await expect(top.locator('.left')).toHaveCSS('font-variant-numeric', /tabular-nums/);
    const before = await top.locator('.left').boundingBox();
    await page.clock.fastForward('01:00');
    await showControls(page);
    await expect(top.locator('.left')).toHaveText('noch 22 Min.');
    sameBox(await top.locator('.left').boundingBox(), before); // reserved width: the value changes, the slot does not move
  });

  test('ArrowUp switches after one watch request for three quick presses', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(banner(page)).toContainText('12 Kinderinsel');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-kinder']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await expect.poll(() => api.livetv.recent[0]).toBe('ch-kinder');
    await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord'); // the old token is revoked
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-kinder']);
  });

  test('zapping follows the filter the list was on', async ({ page, api }) => {
    await arm(page, api);
    await open(page, 'ch-nord', 'fav'); // favourites in the person's order: Nordlicht TV, Hafenkanal, Kinderinsel
    await blur(page);
    await page.keyboard.press('ArrowDown');
    await expect(banner(page)).toContainText('12 Kinderinsel');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-kinder']);
  });

  test('Q jumps to the last channel', async ({ page, api }) => {
    await arm(page, api);
    api.livetv.recent = ['ch-hafen'];
    await open(page);
    await blur(page);
    await page.keyboard.press('q');
    await expect(banner(page)).toContainText('4 Hafenkanal');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    // again: toggles between the two
    await blur(page);
    await page.keyboard.press('q');
    await expect(banner(page)).toContainText('1 Nordlicht TV');
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen', 'ch-nord']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    // the info panel's Letzter Sender button does the same
    await showControls(page);
    await bar(page).getByRole('button', { name: 'Programm' }).click();
    await page.getByRole('button', { name: 'Zurück zu 4 Hafenkanal' }).click();
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen', 'ch-nord', 'ch-hafen']);
  });

  test('the controls hide after CONTROLS_HIDE_MS', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await holdClock(page);
    await page.mouse.move(500, 300);
    await page.mouse.move(520, 310);
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await page.clock.runFor(2_900);
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await page.clock.runFor(200);
    await expect(bar(page)).toHaveClass(/\bhide\b/);
  });

  test('beat every 20 s', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await holdClock(page);
    const b0 = api.livetv.beats.length;
    await page.clock.runFor(20_000);
    await expect.poll(() => api.livetv.beats.length).toBe(b0 + 1);
    await page.clock.runFor(20_000);
    await expect.poll(() => api.livetv.beats.length).toBe(b0 + 2);
    // paused still beats
    await page.evaluate(() => document.querySelector('video')!.pause());
    await page.clock.runFor(20_000);
    await expect.poll(() => api.livetv.beats.length).toBe(b0 + 3);
    expect(new Set(api.livetv.beats)).toEqual(new Set(['tok-ch-nord']));
  });

  test('pagehide sends a keepalive DELETE', async ({ page, api }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __fetches: Array<{ url: string; method: string; keepalive: boolean; body: string | null }> };
      w.__fetches = [];
      const orig = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        w.__fetches.push({ url, method: (init?.method ?? 'GET').toUpperCase(), keepalive: Boolean(init?.keepalive), body: typeof init?.body === 'string' ? init.body : null });
        return orig(input, init);
      };
    });
    await arm(page, api);
    await open(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    const stops = () => page.evaluate(() => (window as unknown as { __fetches: Array<{ url: string; method: string; keepalive: boolean; body: string | null }> }).__fetches
      .filter((f) => f.method === 'DELETE' && f.url.includes('/api/livetv/watch')));
    await expect.poll(async () => (await stops()).length).toBeGreaterThan(0);
    const [f] = await stops();
    expect(f!.keepalive).toBe(true);
    expect(f!.body).toContain('tok-ch-nord');
    await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord');
  });
});

test.describe('live player: the info banner (motion allowed)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the banner shows on a switch and fades 4 s after the first frame', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    // settle: past the first frame's 4 s and the controls' 3 s
    await page.clock.fastForward(5_000);
    await expect.poll(() => opacity(banner(page))).toBe('0');
    await page.mouse.move(600, 300);
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await settled(bar(page));
    const before = await bar(page).boundingBox();

    await blur(page);
    await page.keyboard.press('ArrowUp');
    await expect(banner(page)).toContainText('4 Hafenkanal');
    await expect.poll(() => opacity(banner(page))).toBe('1');
    const fade = await banner(page).evaluate((el) => { const s = getComputedStyle(el); return { p: s.transitionProperty, d: s.transitionDuration }; });
    expect(fade.p).toMatch(/opacity|all/);
    expect(fade.d.split(',').some((d) => parseFloat(d) > 0)).toBe(true); // it fades
    await settled(bar(page));
    sameBox(await bar(page).boundingBox(), before); // the banner overlays: the bar does not move

    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await holdClock(page);
    await page.clock.runFor(2_000);
    expect(await opacity(banner(page))).toBe('1'); // first frame + < 4 s
    await page.clock.runFor(3_000);
    await expect.poll(() => opacity(banner(page))).toBe('0'); // first frame + > 4 s, controls hidden

    await page.mouse.move(620, 310);
    await expect(bar(page)).not.toHaveClass(/\bhide\b/);
    await settled(bar(page));
    sameBox(await bar(page).boundingBox(), before);
  });
});

test.describe('live player: refusals and errors (desktop)', () => {
  // the 4xx / 5xx answers are mocked refusals: the browser logs them
  test.use({ allowedConsole: REFUSED });

  test('live_full sheet lists running channels and a tap joins', async ({ page, api }) => {
    await arm(page, api);
    const run = (id: string) => { const c = api.livetv.channels.find((x) => x.id === id)!; return { id: c.id, number: c.number, name: c.name, logo: c.logo, now: c.now }; };
    api.livetv.watchError = { status: 503, body: { error: 'live_full', running: [run('ch-nord'), run('ch-hafen')] }, only: 'ch-stern' };
    await page.goto('/live/watch/ch-stern?f=all');
    const sheet = page.getByRole('dialog', { name: 'Gerade sind alle Live-Plätze belegt' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Diese Sender laufen schon und gehen sofort:');
    await expect(sheet).toContainText('Die Leuchtturmwärter');
    await expect(sheet.getByRole('button', { name: 'Nordlicht TV ansehen' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Hafenkanal ansehen' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await expect(topBar(page)).toContainText('Hafenkanal');
    expect(api.livetv.watches).toEqual(['ch-stern', 'ch-hafen']);
  });

  test('502 shows Sender gerade nicht erreichbar and reconnects', async ({ page, api }) => {
    await arm(page, api);
    api.livetv.watchError = { status: 502, body: { error: 'channel_unreachable' } };
    await page.goto('/live/watch/ch-nord?f=all');
    await expect(page.getByText('Sender gerade nicht erreichbar')).toBeVisible();
    await expect(page.getByText('Verbinde neu …')).toBeVisible();
    await expect(live(page)).toHaveAttribute('data-live-state', 'unreachable');
    await holdClock(page);
    expect(api.livetv.watches).toEqual(['ch-nord']);
    await page.clock.runFor(1_000);
    expect(api.livetv.watches).toEqual(['ch-nord']);
    api.livetv.watchError = null;
    await page.clock.runFor(1_200); // 2 s after the refusal: a new watch
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-nord']);
    await page.clock.resume();
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await expect(page.getByText('Sender gerade nicht erreichbar')).toHaveCount(0);
  });

  test('livetv_off shows the off message and never retries', async ({ page, api }) => {
    await arm(page, api);
    api.livetv.watchError = { status: 404, body: { error: 'livetv_off' } };
    await page.goto('/live/watch/ch-nord?f=all');
    await expect(page.getByText('Live-TV ist gerade ausgeschaltet. Ein Admin kann es wieder einschalten.')).toBeVisible();
    await expect(live(page)).toHaveAttribute('data-live-state', 'off');
    await expect(page.getByText('Verbinde neu …')).toHaveCount(0);
    await holdClock(page);
    await page.clock.runFor('02:00');
    expect(api.livetv.watches).toEqual(['ch-nord']);
  });

  test('not_receiving waits and starts when the feed sends', async ({ page, api }) => {
    await arm(page, api);
    api.livetv.watchError = { status: 409, body: { error: 'not_receiving' }, only: 'ch-berg' };
    await page.goto('/live/watch/ch-berg?f=all');
    await expect(banner(page)).toContainText('7 Bergblick Sport');
    await expect(banner(page)).toContainText('Gerade keine Übertragung');
    await expect(live(page)).toHaveAttribute('data-live-state', 'notReceiving');
    await holdClock(page);
    expect(api.livetv.watches).toEqual(['ch-berg']);
    api.livetv.watchError = null;
    await page.clock.runFor(10_000);
    await expect.poll(() => api.livetv.watches).toEqual(['ch-berg', 'ch-berg']);
    await page.clock.resume();
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
  });

  // A right taken away mid-play (spec §12.5): the gateway refuses the token on the next media request; the player beats once at
  // once (the refusal may only be a moved address, Review Focus 4), the beat still answers, the playlist is refused again, so the
  // player asks for one new watch, and that watch is refused with 403: the card, then back to the list.
  test('403 during play shows nicht mehr verfügbar and goes back to the list', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await holdClock(page);
    api.livetv.mediaStatus = 403; // the gateway refuses the token from now on
    api.livetv.watchError = { status: 403, body: { error: 'forbidden' } }; // and a new watch is refused: the right is gone
    await stepUntilVisible(page, page.getByText(FORBIDDEN), 10_000);
    await expect(live(page)).toHaveAttribute('data-live-state', 'forbidden');
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-nord']); // exactly one new watch decided it
    expect(new URL(page.url()).pathname).toBe('/live/watch/ch-nord'); // the card shows in the player first
    await page.clock.resume();
    await expect(page).toHaveURL((u) => u.pathname === '/live', { timeout: 15_000 });
  });

  // Review Focus 4: a phone moves from Wi-Fi to mobile data; the gateway refuses the token pinned to the old address until a beat
  // from the same session re-pins it. The player must beat at once and carry on, not give the token up.
  test('a media 403 that the next beat re-pins keeps playing', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await holdClock(page);
    const b0 = api.livetv.beats.length;
    const loads0 = api.livetv.playlistLoads;
    api.livetv.beatRepins = true; // a beat re-pins the token to the new address
    api.livetv.mediaStatus = 403; // the new address is not the pinned one yet
    await stepUntil(page, () => api.livetv.beats.length > b0, 6_000); // the refusal makes the player beat at once (not after 20 s)
    expect(api.livetv.mediaStatus).toBe(200);
    await page.clock.resume();
    await expect.poll(() => api.livetv.playlistLoads, { timeout: 15_000 }).toBeGreaterThan(loads0); // loading carried on
    const t0 = await time(page);
    await expect.poll(() => time(page), { timeout: 15_000 }).toBeGreaterThan(t0 + 1);
    await expect(live(page)).toHaveAttribute('data-live-state', /^(playing|buffering)$/);
    expect(api.livetv.watches).toEqual(['ch-nord']); // no new watch
    expect(api.livetv.stops).not.toContain('tok-ch-nord'); // the token was never given up
    await expect(page.getByText(FORBIDDEN)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/live/watch/ch-nord');
  });

  // The heartbeat only ever answers 410 when the token is gone (backend beatLiveToken); the one new watch then decides: refused
  // with 403, the right is gone.
  test('beat 410 then a refused watch shows nicht mehr verfügbar and goes back to the list', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await holdClock(page);
    api.livetv.beatAnswers = [{ status: 410, body: { error: 'gone' } }];
    api.livetv.watchError = { status: 403, body: { error: 'forbidden' } };
    await page.clock.runFor(19_000);
    await stepUntilVisible(page, page.getByText(FORBIDDEN), 4_000);
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-nord']);
    expect(new URL(page.url()).pathname).toBe('/live/watch/ch-nord');
    await page.clock.resume();
    await expect(page).toHaveURL((u) => u.pathname === '/live', { timeout: 15_000 });
    await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord'); // the refused token is let go
  });

  test('410 at beat re-watches once', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    await holdClock(page);
    expect(api.livetv.watches).toEqual(['ch-nord']);
    api.livetv.beatAnswers = [{ status: 410, body: { error: 'gone' } }];
    await page.clock.runFor(20_000);
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-nord']);
    await page.clock.runFor(20_000);
    await expect.poll(() => api.livetv.beats.length).toBeGreaterThanOrEqual(2);
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-nord']);
    await expect(page.getByText(FORBIDDEN)).toHaveCount(0);
    await page.clock.resume();
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing');
  });
});

// A switch whose watch is still out (`startPending`): the backend let the channel before go as the new watch arrived (spec §12.2),
// so that channel's media, its beat and its stream fail for as long as the new watch is out. None of that may act on the switch:
// no second watch of the new channel (it would discard the first answer and stop a stream that is just starting), no lost card,
// no forbidden card. If the switch is refused and the channel before stays, what it missed is checked then.
test.describe('live player: a pending switch (desktop)', () => {
  test.use({ allowedConsole: REFUSED });
  const BAD = ['lost', 'unreachable', 'retry', 'forbidden'];

  /** every data-live-state the player passes through, from the page's start */
  async function recordStates(page: Page) {
    await page.addInitScript(() => {
      const w = window as unknown as { __states: string[] };
      w.__states = [];
      new MutationObserver(() => {
        const s = document.querySelector('[data-live-state]')?.getAttribute('data-live-state');
        if (s && w.__states[w.__states.length - 1] !== s) w.__states.push(s);
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-live-state'], childList: true });
    });
  }
  const states = (page: Page) => page.evaluate(() => (window as unknown as { __states: string[] }).__states);
  async function switchedToHafen(page: Page, api: MockState) {
    await expect.poll(() => api.livetv.watches, { timeout: 10_000 }).toEqual(['ch-nord', 'ch-hafen']);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
    await expect(topBar(page)).toContainText('Hafenkanal');
  }

  test('the old channel refusing its media while the new watch is out starts nothing', async ({ page, api }) => {
    await recordStates(page);
    await arm(page, api);
    await open(page);
    api.livetv.watchHold = { only: 'ch-hafen', gate: true, release: { token: 'tok-ch-nord', media: 410, beat: true } };
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => api.livetv.goneLoads, { timeout: 10_000 }).toBeGreaterThan(0); // the old channel's media is refused while the watch is out
    api.livetv.release();
    await switchedToHafen(page, api);
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']); // exactly one watch of the new channel
    expect(api.livetv.stops).not.toContain('tok-ch-hafen'); // its stream was never let go
    expect((await states(page)).filter((s) => BAD.includes(s))).toEqual([]);
    await expect(page.getByText(FORBIDDEN)).toHaveCount(0);
    const t0 = await time(page);
    await expect.poll(() => time(page), { timeout: 15_000 }).toBeGreaterThan(t0 + 1);
  });

  test('a beat of the old token while the new watch is out starts nothing', async ({ page, api }) => {
    await recordStates(page);
    await arm(page, api);
    await open(page);
    await holdClock(page);
    api.livetv.watchHold = { only: 'ch-hafen', gate: true, release: { token: 'tok-ch-nord', media: 0, beat: true } };
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await page.clock.runFor(500); // the switch commits 400 ms after the press
    await expect.poll(() => api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    const b0 = api.livetv.beats.length;
    await page.clock.runFor(20_000); // a beat falls due while the watch is out
    expect(api.livetv.calls.filter((c) => c.endsWith('/ch-hafen/watch'))).toEqual([]); // the watch is still out
    expect(api.livetv.beats.length).toBe(b0); // and the old token was not beaten
    await page.clock.resume();
    api.livetv.release();
    await switchedToHafen(page, api);
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    expect(api.livetv.stops).not.toContain('tok-ch-hafen');
    expect((await states(page)).filter((s) => BAD.includes(s))).toEqual([]);
  });

  test('a fatal error of the old stream while the new watch is out shows no lost card', async ({ page, api }) => {
    await recordStates(page);
    await arm(page, api);
    await open(page);
    // not a refusal: a broken playlist, which hls.js gives up on (fatal)
    api.livetv.watchHold = { only: 'ch-hafen', gate: true, release: { token: 'tok-ch-nord', media: 200 } };
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => api.livetv.goneLoads, { timeout: 10_000 }).toBeGreaterThan(0);
    api.livetv.release();
    await switchedToHafen(page, api);
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    expect(api.livetv.stops).not.toContain('tok-ch-hafen');
    expect((await states(page)).filter((s) => BAD.includes(s))).toEqual([]);
  });

  // pagehide (the back/forward cache) while a watch is out: the late answer of that watch is stopped, not attached; coming back from
  // the cache (pageshow, persisted) starts the channel again.
  test('pagehide while a watch is out stops the late answer, pageshow from the cache starts again', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    api.livetv.watchHold = { only: 'ch-hafen', gate: true };
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => api.livetv.watches, { timeout: 10_000 }).toEqual(['ch-nord', 'ch-hafen']);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord');
    api.livetv.release();
    await expect.poll(() => api.livetv.stops, { timeout: 10_000 }).toContain('tok-ch-hafen'); // the late answer is let go
    api.livetv.watchHold = null;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => api.livetv.watches, { timeout: 10_000 }).toHaveLength(3);
    await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
  });

  const runningNord = (api: MockState) => {
    const c = api.livetv.channels.find((x) => x.id === 'ch-nord')!;
    return { id: c.id, number: c.number, name: c.name, logo: c.logo, now: c.now };
  };

  // A switch that is refused keeps the channel before, which must not have gone deaf: its refusals are checked again (one beat,
  // which re-pins, and loading carries on).
  test('a refused switch checks the refusal the channel before met meanwhile', async ({ page, api }) => {
    await arm(page, api);
    await open(page);
    api.livetv.watchError = { status: 503, body: { error: 'live_full', running: [runningNord(api)] }, only: 'ch-hafen' };
    api.livetv.watchHold = { only: 'ch-hafen', gate: true, release: { token: 'tok-ch-nord', media: 410 } };
    api.livetv.beatRepins = true;
    const b0 = api.livetv.beats.length;
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => api.livetv.goneLoads, { timeout: 10_000 }).toBeGreaterThan(0);
    api.livetv.release(); // the switch is refused only now
    await expect(page.getByRole('dialog', { name: 'Gerade sind alle Live-Plätze belegt' })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => api.livetv.beats.length, { timeout: 5_000 }).toBeGreaterThan(b0); // checked at once, not after 20 s
    expect(api.livetv.beats.slice(b0)).toEqual(['tok-ch-nord']);
    const loads0 = api.livetv.playlistLoads;
    await expect.poll(() => api.livetv.playlistLoads, { timeout: 15_000 }).toBeGreaterThan(loads0); // loading carried on
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    expect(api.livetv.stops).not.toContain('tok-ch-nord');
    await expect(live(page)).toHaveAttribute('data-live-state', /^(playing|buffering)$/);
  });

  // hls.js gives a stream up after a fatal error and fires nothing more for it: the error the channel before met while the watch
  // was out is acted on once the switch is refused and it stays (the lost card and its new watch), never a frozen "playing".
  test('a refused switch acts on the fatal error the channel before met meanwhile', async ({ page, api }) => {
    await recordStates(page);
    await arm(page, api);
    await open(page);
    api.livetv.watchError = { status: 503, body: { error: 'live_full', running: [runningNord(api)] }, only: 'ch-hafen' };
    api.livetv.watchHold = { only: 'ch-hafen', gate: true, release: { token: 'tok-ch-nord', media: 200 } };
    await blur(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => api.livetv.goneLoads, { timeout: 10_000 }).toBeGreaterThan(0);
    api.livetv.release(); // the switch is refused only now
    await expect(page.getByRole('dialog', { name: 'Gerade sind alle Live-Plätze belegt' })).toBeVisible({ timeout: 10_000 });
    await expect(live(page)).toHaveAttribute('data-live-state', 'lost', { timeout: 2_000 });
    await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord'); // the broken stream is let go
    expect(api.livetv.watches).toEqual(['ch-nord', 'ch-hafen']);
    expect((await states(page)).filter((s) => s === 'forbidden')).toEqual([]);
  });
});

test.describe('the mocked DVR playlist (mocks/livetv.ts)', () => {
  test('every segment carries a date-time, the window holds the buffer, a payload restart is a discontinuity', async ({ api }) => {
    const st = api.livetv;
    st.dvrPlaylist = true;
    st.dvrSeconds = 120;
    st.timeShift = 5_000;
    st.liveStart = 1_000_000;
    const text = livePlaylist(st, 1_000_000 + 600_000); // 10 min in: segments 0..299 finished, 60 kept
    expect(text.match(/#EXTINF/g)).toHaveLength(60);
    expect(text.match(/#EXT-X-PROGRAM-DATE-TIME/g)).toHaveLength(60);
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:240');
    expect(text).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:16');
    expect(text.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(3); // before 255, 270, 285
    expect(text).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(1_000_000 + 5_000 + 240 * 2000).toISOString()}\n#EXTINF:2.000000,\ns240.m4s`);
    expect(text.trimEnd().endsWith('s299.m4s')).toBe(true);
    expect(text).not.toContain('#EXT-X-ENDLIST');
  });
});
