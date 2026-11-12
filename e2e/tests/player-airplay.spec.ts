// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes, MOVIE } from '../mocks/fixtures.js';
import { available, castOn, castSessions, mockHls, picks, playOnAirPlay, playOnButton, playOnSheet, srcAtPick, stubAirPlay, wireless } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

const src = (page: Page) => page.evaluate(() => document.querySelector('video')!.src);
const hlsPlaying = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
};

test('AirPlay: "Play on" appears once Safari reports a receiver; its AirPlay row opens the system picker (with the token URL on the element)', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  const btn = playOnButton(page);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBe('allow');
  await expect(btn).toHaveCount(0); // no receiver yet
  await available(page);
  await page.locator('.stage').hover();
  await expect(btn).toBeVisible();
  await btn.click();
  await playOnSheet(page).getByRole('button', { name: /^AirPlay …/ }).click();
  await expect.poll(() => picks(page)).toBe(1);
  expect(await srcAtPick(page)).toContain('#airplay');
});

test('AirPlay: no button while the server has casting off (same gate as Chromecast)', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, false);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(playOnButton(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBeNull();
});

test('Safari-like playback keeps hls.js (MSE + bandwidth samples) until the AirPlay button is used', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  const segTypes: string[] = [];
  await mockHls(page, segTypes);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  expect(await src(page)).toMatch(/^blob:/); // hls.js (MSE), not native HLS
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 3);
  // every fragment came through hls.js' loader (fetch/xhr -> FRAG_LOADED feeds the bandwidth estimate), none as a native media load
  expect(segTypes.length).toBeGreaterThan(2);
  expect(segTypes.every((t) => t === 'xhr' || t === 'fetch')).toBe(true);
  // "Play on" is there, but nothing switched away from hls.js on its own
  await page.locator('.stage').hover();
  await expect(playOnButton(page)).toBeVisible();
  expect(await src(page)).toMatch(/^blob:/);
});

test('AirPlay: tap -> cast token URL on the element FIRST, then the picker; TV -> active without a new token; end -> token revoked, hls.js again', async ({ page, api: _api }) => {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions, deleted } = await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  expect(await src(page)).toMatch(/^blob:/);
  await page.evaluate(() => { document.querySelector('video')!.currentTime = 12; });
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  // the TV was handed the token URL, never the MSE blob or the cookie URL
  expect(await picks(page)).toBe(1);
  expect(await srcAtPick(page)).toContain('#airplay');
  expect(await src(page)).toContain('#airplay');
  expect(sessions).toHaveLength(1); // the wireless event did not fetch a second token
  expect(sessions[0]!.via).toBe('airplay');
  expect(Math.round(Number(sessions[0]!.startTicks) / 10_000_000)).toBe(12); // the phone's position
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBeNull();

  await wireless(page, false);
  await expect(page.getByTestId('airplay-active')).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => src(page)).toMatch(/^blob:/); // hls.js again
  expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('crossorigin'))).toBe('use-credentials');
  expect(sessions).toHaveLength(1); // no automatic token request after the end either

  // the AirPlay event log on /diagnose: the decisions, never a URL / token / cast id
  await page.goto('/diagnose');
  const log = page.getByTestId('airplay-log');
  await expect(page.getByRole('heading', { name: 'AirPlay-Protokoll' })).toBeVisible();
  await expect(log).toContainText('token-ok');
  await expect(log).toContainText('sustained off -> stop');
  const text = (await log.textContent()) ?? '';
  for (const bad of ['p1test', '/media/', 'c'.repeat(32), '127.0.0.1', 'blob:']) expect(text).not.toContain(bad);
  await page.locator('.page > .row').getByRole('button', { name: 'Leeren' }).click();
  await expect(page.getByTestId('airplay-log-empty')).toBeVisible();
});

const JOINED = { items: [{ itemId: 'x', title: 'Folge 1', start: 0, duration: 600 }, { itemId: 'y', title: 'Folge 2', start: 600, duration: 600 }], subtitles: false };

test('AirPlay: an episode asks for a joined token when the admin switch is on', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, true, undefined, { airplayContinuous: true });
  await mockHls(page);
  const { sessions } = await castSessions(page);
  await page.goto('/watch/' + episodes[1]!.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(playOnButton(page)).toBeVisible();
  await playOnButton(page).click();
  await expect(playOnSheet(page).locator('[data-row="continuous"]')).toHaveCount(0); // no per-cast row any more
  await playOnSheet(page).getByRole('button', { name: /^AirPlay …/ }).click();
  await expect.poll(() => sessions.length).toBe(1);
  expect(sessions[0]!.via).toBe('airplay');
  expect(sessions[0]!.continuous).toBe(true);
  expect(sessions[0]!.maxEpisodes).toBe(3);
});

async function airToken(page: Page, id: string, on: boolean) {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, true, undefined, { airplayContinuous: on });
  await mockHls(page);
  const { sessions } = await castSessions(page);
  await page.goto('/watch/' + id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await playOnButton(page).click();
  await playOnSheet(page).getByRole('button', { name: /^AirPlay …/ }).click();
  await expect.poll(() => sessions.length).toBe(1);
  return sessions[0]!;
}

test('AirPlay: a film never asks for a joined token, even with the switch on', async ({ page, api: _api }) => {
  const body = await airToken(page, MOVIE.id, true);
  expect(body.via).toBe('airplay');
  expect(body).not.toHaveProperty('continuous');
  expect(body).not.toHaveProperty('maxEpisodes');
});

test('AirPlay: an episode with the admin switch off asks for a plain token', async ({ page, api: _api }) => {
  const body = await airToken(page, episodes[1]!.id, false);
  expect(body.via).toBe('airplay');
  expect(body).not.toHaveProperty('continuous');
  expect(body).not.toHaveProperty('maxEpisodes');
});

test('AirPlay: the Player reports nothing for a joined token', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, true, undefined, { airplayContinuous: true });
  await mockHls(page);
  const reports: Array<{ kind: string; playSessionId: unknown }> = [];
  await page.route('**/api/playback/{start,progress,stop}', (r) => {
    reports.push({ kind: new URL(r.request().url()).pathname.split('/').pop()!, playSessionId: (r.request().postDataJSON() as Record<string, unknown>).playSessionId });
    return r.fulfill({ status: 204 });
  });
  await castSessions(page, { deliver: () => ({ joined: JOINED, runtimeTicks: 12_000_000_000 }) });
  await page.goto('/watch/' + episodes[1]!.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  await expect.poll(() => srcAtPick(page)).toContain('#airplay');
  // the phone plays the token stream for a moment (before the TV takes over): still nothing is reported for the joined session
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.3);
  await page.evaluate(() => document.querySelector('video')!.pause());
  await page.waitForTimeout(300);
  expect(reports.filter((x) => x.playSessionId === 'a'.repeat(32))).toEqual([]);
});

test('AirPlay: a joined token handed over to the TV is reported by nobody on the page (no start, progress or stop)', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, true, undefined, { airplayContinuous: true });
  await mockHls(page);
  const reports: Array<{ kind: string; playSessionId: unknown }> = [];
  await page.route('**/api/playback/{start,progress,stop}', (r) => {
    reports.push({ kind: new URL(r.request().url()).pathname.split('/').pop()!, playSessionId: (r.request().postDataJSON() as Record<string, unknown>).playSessionId });
    return r.fulfill({ status: 204 });
  });
  const joined = { items: [{ itemId: episodes[1]!.id, title: 'Folge 2', season: 1, episode: 2, start: 0, duration: 600 }, { itemId: episodes[2]!.id, title: 'Folge 3', season: 1, episode: 3, start: 600, duration: 600 }], subtitles: false };
  const { sessions } = await castSessions(page, { deliver: () => ({ joined, runtimeTicks: 12_000_000_000 }) });
  await page.goto('/watch/' + episodes[1]!.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  await expect.poll(() => srcAtPick(page)).toContain('#airplay');
  // the phone plays the joined token stream first (the Player counts it as started, but never reports it) ...
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.3);
  // ... then the TV is picked: the hand-over must not tell the engine a start was sent (it would owe progress and a stop)
  await wireless(page, true);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  const el = 'video[data-cast-engine]';
  await expect(page.locator(el)).toHaveCount(1); // the engine owns the element
  await page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)!.pause(), el);
  await page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)!.play().catch(() => undefined), el);
  await page.waitForFunction((sel) => !document.querySelector<HTMLVideoElement>(sel)!.paused, el); // the TV plays: no start from the engine either
  await page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)!.dispatchEvent(new Event('ended')), el);
  await page.waitForTimeout(600);
  expect(sessions).toHaveLength(1);
  expect(reports.filter((x) => x.playSessionId === 'a'.repeat(32))).toEqual([]);
});

/** a joined token of episodes 2 and 3 (5 min each, so the 10 min test media reaches into the second) */
const JOINED23 = () => ({ items: [{ itemId: episodes[1]!.id, title: 'Folge 2', season: 1, episode: 2, start: 0, duration: 300 }, { itemId: episodes[2]!.id, title: 'Folge 3', season: 1, episode: 3, start: 300, duration: 300 }], subtitles: false });

test('AirPlay: a re-mint before the TV is picked asks for the episode the phone is in, with this page\'s tracks, and reports that episode', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page, true, undefined, { airplayContinuous: true });
  await mockHls(page);
  const reports: Array<{ kind: string; itemId: unknown; playSessionId: unknown }> = [];
  await page.route('**/api/playback/{start,progress,stop}', (r) => {
    const b = r.request().postDataJSON() as Record<string, unknown>;
    reports.push({ kind: new URL(r.request().url()).pathname.split('/').pop()!, itemId: b.itemId, playSessionId: b.playSessionId });
    return r.fulfill({ status: 204 });
  });
  let n = 0;
  // the first token expires soon (the Player renews it a few seconds later); the renewal is answered with a single token
  const { sessions } = await castSessions(page, { deliver: () => (++n === 1 ? { joined: JOINED23(), runtimeTicks: 6_000_000_000, expiresAt: Date.now() + 10 * 60_000 + 5000 } : undefined) });
  await page.goto('/watch/' + episodes[1]!.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  await expect.poll(() => srcAtPick(page)).toContain('#airplay');
  // the phone plays the joined token into episode 3 (stream second 400 = 100 s into it)
  await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = 400; void v.play().catch(() => undefined); });
  await expect.poll(() => sessions.length, { timeout: 15_000 }).toBe(2);
  const body = sessions[1]!;
  expect(body).toMatchObject({ itemId: episodes[2]!.id, tracksOf: episodes[1]!.id, via: 'airplay' });
  expect(Math.floor(Number(body.startTicks) / 10_000_000)).toBeGreaterThanOrEqual(100);
  expect(Math.floor(Number(body.startTicks) / 10_000_000)).toBeLessThan(115);
  // the stream's last episode: a plain token, never `continuous` with one episode
  expect(body).not.toHaveProperty('continuous');
  expect(body).not.toHaveProperty('maxEpisodes');
  // that single token is reported (not joined), as episode 3
  await expect.poll(() => reports.filter((x) => x.kind === 'start' && x.playSessionId === 'a'.repeat(32)).map((x) => x.itemId)).toEqual([episodes[2]!.id]);
});

/** a joined token of episodes 2 and 3 on the TV, its element moved to stream second `at` */
async function joinedOnTv(page: Page, at: number) {
  await stubAirPlay(page, { pickTv: true });
  await mockPlayer(page);
  await castOn(page, true, undefined, { airplayContinuous: true });
  await mockHls(page);
  await castSessions(page, { deliver: () => ({ joined: JOINED23(), runtimeTicks: 6_000_000_000 }) });
  await page.goto('/watch/' + episodes[1]!.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  const el = 'video[data-cast-engine]';
  await page.waitForFunction((sel) => (document.querySelector<HTMLVideoElement>(sel)?.currentTime ?? 0) > 0.3, el);
  await page.evaluate(([sel, t]) => { document.querySelector<HTMLVideoElement>(sel as string)!.currentTime = t as number; }, [el, at] as const);
  await page.waitForFunction(([sel, t]) => (document.querySelector<HTMLVideoElement>(sel as string)?.currentTime ?? 0) >= (t as number), [el, at] as const);
  return el;
}

/** the start (seconds) of every local playback request from now on */
function infoStarts(page: Page) {
  const starts: number[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/playback/info')) starts.push(Number((r.postDataJSON() as { startTicks?: number }).startTicks ?? 0) / 10_000_000); });
  return starts;
}

test('AirPlay: "continue here" while the TV is in a later episode of the stream plays that episode here, at its offset', async ({ page, api: _api }) => {
  await joinedOnTv(page, 400);
  // the page follows the TV into episode 3 (its Player attaches to the session)
  await expect(page).toHaveURL((u) => u.pathname === '/watch/' + episodes[2]!.id);
  const starts = infoStarts(page);
  const box = page.getByTestId('airplay-active');
  await box.getByRole('button', { name: 'Läuft über AirPlay, Fernseher wechseln' }).click();
  await playOnSheet(page).getByRole('button', { name: /^Hier weiterschauen/ }).click();
  // the hand-back asks for the episode's position (100 s in), never the stream's (400 s)
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toBeGreaterThanOrEqual(100);
  expect(starts[0]).toBeLessThan(130);
  await expect(page).toHaveURL((u) => u.pathname === '/watch/' + episodes[2]!.id);
});

test('AirPlay: a joined stream that ended leaves the page on its last episode, ended there (no local playback)', async ({ page, api: _api }) => {
  const el = await joinedOnTv(page, 590);
  await expect(page).toHaveURL((u) => u.pathname === '/watch/' + episodes[2]!.id);
  const starts = infoStarts(page);
  await page.evaluate((sel) => document.querySelector<HTMLVideoElement>(sel)!.dispatchEvent(new Event('ended')), el);
  await expect(page.locator(el)).toHaveCount(0, { timeout: 15_000 }); // the session ended (ENDED_HIDE_MS later): its element is gone
  await page.waitForTimeout(500);
  await expect(page).toHaveURL((u) => u.pathname === '/watch/' + episodes[2]!.id && !u.searchParams.has('t'));
  expect(starts).toEqual([]); // the episode is over: nothing plays again here
});

test('AirPlay: picker did not lead to a TV yet -> prompt "Fernseher auswählen" opens it from a fresh tap; then TV -> active', async ({ page, api: _api }) => {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const { sessions } = await castSessions(page);
  await page.goto('/watch/' + MOVIE.id);
  await hlsPlaying(page);
  await available(page);
  await page.locator('.stage').hover();
  await playOnAirPlay(page);
  const prompt = page.getByTestId('airplay-ready');
  await expect(prompt).toContainText('Jetzt den Fernseher in der Liste auswählen');
  expect(await srcAtPick(page)).toContain('#airplay');
  await prompt.getByRole('button', { name: 'Fernseher auswählen' }).click();
  expect(await picks(page)).toBe(2);
  expect(await srcAtPick(page)).toContain('#airplay');
  await page.locator('.stage').hover();
  await playOnAirPlay(page); // the AirPlay row does the same while waiting: picker, no new token
  expect(await picks(page)).toBe(3);
  await wireless(page, true);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  await expect(prompt).toHaveCount(0);
  expect(sessions).toHaveLength(1);
});

test.describe('AirPlay token failure', () => {
  test.use({ allowedConsole: /status of 429/ });
  test('AirPlay: token request fails before any TV is chosen -> toast, normal stream, no picker, no AirPlay overlay', async ({ page, api: _api }) => {
    await stubAirPlay(page, { pickTv: true });
    await mockPlayer(page);
    await castOn(page);
    await mockHls(page);
    const { sessions } = await castSessions(page, { fail: () => true });
    await page.goto('/watch/' + MOVIE.id);
    await hlsPlaying(page);
    await available(page);
    await page.locator('.stage').hover();
    await playOnAirPlay(page);
    await expect(page.locator('.toast')).toContainText('Maximal 1 gleichzeitiger Stream erlaubt.');
    await expect.poll(() => src(page)).toMatch(/^blob:/); // hls.js again
    expect(sessions).toHaveLength(1);
    expect(await picks(page)).toBe(0); // the TV never saw a URL it cannot load
    await expect(page.getByTestId('airplay-active')).toHaveCount(0);
    await expect(page.getByTestId('airplay-ready')).toHaveCount(0);
  });

  test('AirPlay: a TV route without our token (Control Center) and the token request fails -> error with Retry, no fallback to the cookie stream', async ({ page, api: _api }) => {
    await stubAirPlay(page);
    await mockPlayer(page);
    await castOn(page);
    await mockHls(page);
    let fail = true;
    await castSessions(page, { fail: () => fail, castId: 'e'.repeat(32) });
    await page.goto('/watch/' + MOVIE.id);
    await hlsPlaying(page);
    await available(page);
    await wireless(page, true);
    const box = page.getByTestId('airplay-active');
    await expect(box).toContainText('Übertragung per AirPlay fehlgeschlagen.');
    await expect(box).toContainText('dieses Gerät wählen');
    expect(await src(page)).not.toMatch(/^blob:/); // no hls.js / cookie stream comes back while the TV is the target
    fail = false;
    await box.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(box).toContainText('Läuft über AirPlay');
    await expect.poll(() => src(page)).toContain('#airplay');
  });
});

test('Chromium without the AirPlay API: no AirPlay button', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await castOn(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await available(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.ctl')).toBeVisible();
  await expect(playOnButton(page)).toHaveCount(0);
});
