// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect } from '../fixtures.js';
import { episodes, items, MOVIE, SERIES } from './fixtures.js';
import { MOVIE_END } from './postplay.js';
import { mockPlayer, videoReady } from './scenes.js';

/** Credits sequence (spec 2026-11-08 §4): shared by desk-credits.spec.ts and tv-credits.spec.ts. The test video runs 600 s. */
export const EP = episodes[1]!, NEXT = episodes[2]!;
/** outro segment 570–600 s: the credits (and the sequence) start at 570 */
export const CREDITS_AT = 570;
/** the episode's post-play data: state 'next' with a first row of six titles (the sequence shows five) */
export const EP_NEXT = {
  state: 'next', current: EP, next: NEXT, nextAirDate: null, sequel: null, canWish: false, remind: null, hero: null, suggestions: true,
  rows: [{ kind: 'because', title: SERIES.name, reason: { seed: { id: SERIES.id, name: SERIES.name } }, items: items.filter((i) => i.type === 'Movie').slice(1, 7) }],
};

async function mockCredits(page: Page) {
  await mockPlayer(page);
  await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: [{ type: 'Outro', start: CREDITS_AT, end: 600 }] } }));
}
/** an episode with a next episode; the clock is installed first so the beats only move on with `page.clock.runFor` */
export async function openEpisode(page: Page) {
  await page.clock.install();
  await mockCredits(page);
  await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: NEXT } }));
  await page.route(`**/api/items/${EP.id}`, (r) => r.fulfill({ json: { item: EP } }));
  await page.route(`**/api/items/${EP.id}/postplay`, (r) => r.fulfill({ json: EP_NEXT }));
  await page.goto('/watch/' + EP.id);
  await videoReady(page);
}
/** a film: suggestions and the post-play headline, no countdown */
export async function openMovie(page: Page) {
  await page.clock.install();
  await mockCredits(page);
  await page.route(`**/api/items/${MOVIE.id}/postplay`, (r) => r.fulfill({ json: MOVIE_END }));
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
}
/**
 * `clock.install()` keeps real time flowing: once the chip is up, the page clock is paused so the beats (and the countdown) only
 * move with `page.clock.runFor` (resume it before a navigation is expected)
 */
export async function freeze(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
}
/** seeks into the credits and freezes the clock as soon as the chip is up (beat 1) */
export async function toChip(page: Page) {
  await seekPlaying(page, CREDITS_AT + 5);
  await expect(page.locator('.cs .chip')).toBeVisible();
  await freeze(page);
}
/** jumps to `t` while the video keeps playing (the countdown only runs while it plays); resolves once the seek is done */
export async function seekPlaying(page: Page, t: number) {
  // playback has really started (the Player's own start seek is over), else it would undo this seek
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(0.5);
  await page.evaluate((to) => new Promise<void>((res) => {
    const v = document.querySelector('video')!;
    v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = to;
  }), t);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
}
