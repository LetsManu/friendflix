// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { episodes } from './fixtures.js';
import { mockPlayer, videoReady } from './scenes.js';

/** Moving on to the next episode inside the player replaces the history entry: ONE Back leaves the player, however many episodes ran. */
const [E1, E2, E3] = [episodes[1]!, episodes[2]!, episodes[3]!];

async function setup(page: Page) {
  await page.clock.install(); // real time keeps flowing; `clickNext` pauses it briefly
  await mockPlayer(page);
  // the episode after the current one
  await page.route('**/api/items/*/next', (r) => {
    const id = /items\/([0-9a-f]+)\/next/.exec(r.request().url())![1];
    const i = episodes.findIndex((e) => e.id === id);
    return r.fulfill({ json: { item: i >= 0 ? episodes[i + 1] ?? null : null } });
  });
  for (const e of episodes) await page.route(`**/api/items/${e.id}`, (r) => r.fulfill({ json: { item: e } }));
}
const path = (page: Page) => new URL(page.url()).pathname;
const watching = (page: Page, id: string) => expect.poll(() => path(page), { timeout: 30_000 }).toBe(`/watch/${id}`);
/** the (new) episode is loaded: the player of the previous one is gone, its video has the duration */
/** the new player's own title block names the episode (desktop `.ttlblock`, phone `.ptitle`): never the previous player's next-up card */
const ready = async (page: Page, ep: { name: string }) => { await expect(page.locator('.stage :is(.ttlblock, .ptitle)')).toContainText(ep.name); await expect(page.locator('.stage video')).toHaveCount(1); await videoReady(page); await expect(page.locator('.stage.pre')).toHaveCount(0); };
/** jumps into the credits (the card shows from 575 s); the Player may still be settling its own start seek, so retry until it sticks */
async function toCredits(page: Page, playing: boolean, frozen = false) {
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.5); // playback has really started
  if (frozen) await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 50); // the chip's 2 s cannot run out before the click
  await expect.poll(() => page.evaluate(() => { const v = document.querySelector('video')!; if (v.currentTime < 575) v.currentTime = 580; return !v.seeking && v.currentTime > 575; })).toBe(true);
  // the mock clip has a frame every 20 s: from here it plays to its end at once (the countdown runs on an ended video); never play() it again, that restarts it
  if (!playing) await page.evaluate(() => document.querySelector('video')!.pause());
}

/**
 * "Nächste Folge" of the next-up card: phones keep the card (`.next`), desktop and TV show the credits sequence's chip
 * (`.cs .chip`, spec 2026-11-08 §4), which gives way to the corner beat after 2 s - `toCredits(page, false, true)` paused the
 * page clock before the seek; it runs again after the click
 */
async function clickNext(page: Page) {
  const go = page.locator('.cs .chip .go, .next .go');
  await expect(go).toBeVisible();
  await go.click();
  await page.clock.resume();
}

export function backTests() {
test('Back after next-episode button and autoplay countdown leaves the player in one step', async ({ page, api: _api }) => {
  await setup(page);
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  const historyBefore = await page.evaluate(() => history.length);

  // 1) the "Nächste Folge" button of the card
  await toCredits(page, false, true);
  await clickNext(page);
  await watching(page, E2.id);
  await ready(page, E2);

  // 2) the autoplay countdown (10 s) runs out by itself
  await toCredits(page, true);
  await watching(page, E3.id);
  await ready(page, E3);

  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  await page.goBack();
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});

test('the control-bar next button and the episode "still watching" card replace the entry too', async ({ page, api: _api }) => {
  await setup(page);
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: 200 } }).catch(() => page.mouse.move(30, 210));
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
  // phones in portrait: the next episode lives in More (spec 2026-11-08 block 4)
  if (await page.locator('.ctl button[aria-label^="Nächste"]').count()) await page.locator('.ctl button[aria-label^="Nächste"]').click();
  else { await page.getByRole('button', { name: 'Mehr', exact: true }).click(); await page.getByRole('dialog', { name: 'Mehr' }).getByRole('button', { name: 'Nächste Folge', exact: true }).click(); }
  await watching(page, E2.id);
  await ready(page, E2);
  await page.goBack();
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});

test('Esc (and the TV back key) after two next episodes also leaves the player in one step', async ({ page, api: _api }) => {
  await setup(page);
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  for (const next of [E2, E3]) {
    await toCredits(page, false, true);
    await clickNext(page);
    await watching(page, next.id);
    await ready(page, next);
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});

test('the "Are you still watching?" card: continue replaces the entry, Back leaves the player', async ({ page, api: _api }) => {
  test.setTimeout(90_000);
  await setup(page);
  // two unattended autoplays in a row are enough to be asked (the pref's minimum)
  await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { stillWatchingEpisodes: 2 } } }));
  await page.goto('/item/' + E1.id);
  await page.getByRole('link', { name: 'Abspielen' }).first().click();
  await watching(page, E1.id);
  await ready(page, E1);
  for (const next of [E2, E3]) {
    await toCredits(page, true);
    await watching(page, next.id);
    await ready(page, next);
  }
  await toCredits(page, false);
  const card = page.locator('.next.still');
  await expect(card).toBeVisible();
  await card.locator('.go').click();
  await watching(page, episodes[4]!.id);
  await ready(page, episodes[4]!);
  await page.goBack();
  await expect.poll(() => path(page)).toBe('/item/' + E1.id);
});
}
