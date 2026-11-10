// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes } from '../mocks/fixtures.js';
import { available, castOn, castSessions, fakeCastSdk, mockHls, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** Shared setup of the cast remote screen specs (desktop + mobile): the watch page as the TV's remote. */

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
 * Returns the SDK fake plus `sessions` (POST /api/cast/session bodies) and `deleted` (revoked castIds).
 */
export async function chromecastRemote(page: Page, o: { fail?: () => boolean; queue?: boolean; tracks?: boolean } = {}) {
  await mockPlayer(page);
  if (o.tracks) await infoWithTracks(page);
  if (o.queue) await nextAfterFirst(page); // before the cast: the engine asks for the queue at the first position update
  await castOn(page);
  const sdk = await fakeCastSdk(page, { queue: o.queue });
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
  await page.getByRole('button', { name: 'Auf AirPlay-Gerät abspielen' }).click();
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
