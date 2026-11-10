// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes } from '../mocks/fixtures.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, playOnAirPlay, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** Shared setup of the cast remote screen specs (desktop + mobile): the watch page as the TV's remote. */

/** FriendFlix's own receiver app id of the specs that re-adopt a cast after a reload */
export const RECEIVER = 'ABCD1234';

export const SHOTS = '/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/cast-shots/remote';

/**
 * The fictional series of these specs: Dunmoor, S1 E4 "The Lantern Road" (episode 1 of the fixtures) and S1 E5 "Wrenfield Pier".
 * Call at the top of a spec file; the shared fixtures are put back after every test.
 */
export function dunmoor() {
  const keep = episodes.slice(0, 2).map((e) => ({ ...e }));
  test.beforeEach(() => {
    Object.assign(episodes[0]!, { seriesName: 'Dunmoor', name: 'The Lantern Road', indexNumber: 4 });
    Object.assign(episodes[1]!, { seriesName: 'Dunmoor', name: 'Wrenfield Pier', indexNumber: 5 });
  });
  test.afterEach(() => { keep.forEach((k, i) => Object.assign(episodes[i]!, k)); });
}

async function clientNav(page: Page, path: string) {
  await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
  await expect(page).toHaveURL((u) => u.pathname === path);
}
/** GET /api/items/{id}/next: episode 2 follows episode 1 */
export const nextAfterFirst = (page: Page) => page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: r.request().url().includes(episodes[0]!.id) ? episodes[1] : null } }));

/** the title's tracks (two audio, one subtitle) as the playback info offers them */
const TRACKS = {
  subtitles: [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }],
  audioTracks: [{ index: 1, title: 'Deutsch', language: 'deu', isDefault: true }, { index: 2, title: 'English', language: 'eng', isDefault: false }],
};
/** GET /api/playback/info of the direct-play mock, with the tracks */
const infoWithTracks = (page: Page) => page.route('**/api/playback/info', (r) => r.fulfill({ json: {
  directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, ...TRACKS,
} }));

/**
 * Chromecast: episode 1 cast from its watch page, which stays open as the remote. `queue`: the receiver accepts a queued next
 * episode (the engine queues episode 2 at the first position update); `tracks`: the title has two audio tracks and a subtitle.
 * `survive`: the TV keeps its media over a reload (own receiver app, see `fakeCastSdk`). Returns the SDK fake plus `sessions` (POST /api/cast/session bodies) and `deleted` (revoked castIds).
 */
export async function chromecastRemote(page: Page, o: { fail?: () => boolean; queue?: boolean; tracks?: boolean; survive?: 'join' | 'ask' } = {}) {
  await mockPlayer(page);
  if (o.tracks) await infoWithTracks(page);
  if (o.queue) await nextAfterFirst(page); // before the cast: the engine asks for the queue at the first position update
  await castOn(page, true, o.survive ? RECEIVER : undefined);
  const sdk = await fakeCastSdk(page, { queue: o.queue, survive: o.survive });
  const tokens = await castSessions(page, o);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + episodes[0]!.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.getByTestId('cast-active')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await nextAfterFirst(page);
  return Object.assign(sdk, tokens);
}

/** AirPlay: episode 1 sent to the TV with the player's AirPlay button; the watch page stays the remote */
export async function airplayRemote(page: Page, o: { tracks?: boolean } = {}) {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  if (o.tracks) await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
    resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', roleMaxBitrate: 20_000_000, ...TRACKS,
    hlsUrl: '/media/hls/4000000/out.m3u8', maxBitrate: 4_000_000, transcodeReason: 'network',
  } }));
  await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + episodes[0]!.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').click({ position: { x: 30, y: 200 } });
  await playOnAirPlay(page);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
}

/** the screen's visible buttons, each at least 44 x 44 px */
export async function targetsOk(page: Page) {
  const small = await page.getByTestId(/^(cast|airplay)-active$/).evaluate((root) => [...root.querySelectorAll<HTMLElement>('button, [role=slider], input')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).opacity !== '0' && !el.closest('[inert]'); })
    .map((el) => ({ n: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((b) => b.w < 44 || b.h < 44));
  expect(small).toEqual([]);
}

/** the device row: one line, inside the 16 px gutters */
export async function rowFits(page: Page) {
  const r = await page.getByTestId('cast-row').evaluate((row) => {
    const vw = document.documentElement.clientWidth;
    const kids = [...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    return { h: row.getBoundingClientRect().height, tops: kids.map((k) => Math.round(k.top)), left: Math.min(...kids.map((k) => k.left)), right: Math.max(...kids.map((k) => k.right)), vw };
  });
  expect(r.h).toBeLessThanOrEqual(48);
  expect(new Set(r.tops).size).toBe(1);
  expect(r.left).toBeGreaterThanOrEqual(16);
  expect(r.right).toBeLessThanOrEqual(r.vw - 16);
}

export const BAR_SHOTS = '/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/cast-shots/bar';
export type BarState = 'playing' | 'connecting' | 'reconnect' | 'detached';
/**
 * Dunmoor S1 E4 on Wohnzimmer-TV, the remote closed, the bar on `/` in the given state (for the screenshots: call `dunmoor()` and
 * allow the 429 console error): connecting = the next episode's token is on its way, reconnect = that token request failed,
 * detached = the page reloaded and the browser did not join the TV again.
 */
export async function barIn(page: Page, state: BarState) {
  let fail = false;
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} })); // the home page's hero (full motion): no clip
  await chromecastRemote(page, { queue: state === 'playing', fail: () => fail, survive: state === 'detached' ? 'ask' : undefined });
  if (state === 'connecting') await page.route('**/api/cast/session', async (r) => { await new Promise((ok) => setTimeout(ok, 60_000)); await r.fallback(); });
  if (state === 'reconnect') fail = true;
  if (state === 'connecting' || state === 'reconnect') await page.getByRole('button', { name: 'Nächste Folge', exact: true }).click();
  await page.getByRole('button', { name: 'Fernbedienung schließen' }).click();
  await expect(page).toHaveURL(/\/$/);
  const bar = page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
  await expect(bar).toBeVisible();
  if (state === 'detached') {
    await page.reload();
    await expect(bar).toContainText('Verbindung verloren', { timeout: 9000 });
  }
  if (state === 'connecting') await expect(bar).toContainText('Verbinde mit Wohnzimmer-TV');
  if (state === 'reconnect') await expect(bar).toContainText('Verbindung verloren');
  await page.waitForTimeout(700); // risen in, the progress line settled
  return bar;
}

export const SHEET_SHOTS = '/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/cast-shots/sheet';
/**
 * The player with a Chromecast TV remembered (`ff-cast-last`), Cast devices in reach and an AirPlay target (Safari stubbed):
 * every row of the "Play on" sheet is there. Returns the SDK fake and the token mocks.
 */
export async function playOnPlayer(page: Page, o: { remembered?: boolean; hls?: boolean } = {}) {
  if (o.remembered !== false) await page.addInitScript(() => localStorage.setItem('ff-cast-last', 'Wohnzimmer-TV'));
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  if (o.hls) await mockHls(page);
  const sdk = await fakeCastSdk(page);
  const tokens = await castSessions(page);
  await page.goto('/watch/' + episodes[0]!.id);
  if (o.hls) await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  else await videoReady(page);
  await available(page);
  return Object.assign(sdk, tokens);
}

export const DIAG_SHOTS = '/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/cast-shots/diagnose';
export type LogSeed = { at: number; level: 'info' | 'warn' | 'error'; tag: string; text: string };
/** puts entries into the on-device cast log (`ff-castlog`) and TV names into its device list before the page loads */
export async function seedCastLog(page: Page, entries: LogSeed[], devices: string[] = []) {
  await page.addInitScript(([e, d]) => {
    if (localStorage.getItem('ff-castlog')) return; // a reload keeps what the page wrote since
    localStorage.setItem('ff-castlog', JSON.stringify(e));
    localStorage.setItem('ff-castlog-devices', JSON.stringify(d));
  }, [entries, devices] as const);
}
/** the cast keeps playing while the remote closes and the app navigates (client-side) to `path` */
export async function leaveRemoteTo(page: Page, path: string) {
  await page.getByRole('button', { name: 'Fernbedienung schließen' }).click();
  await expect(page).toHaveURL(/\/$/);
  await clientNav(page, path);
}
