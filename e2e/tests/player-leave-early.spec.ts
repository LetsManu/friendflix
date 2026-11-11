// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes } from '../mocks/fixtures.js';
import { mockPlayer } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Back before the video is ready: the player's late callbacks (the start seek) must not touch the gone element. */
async function leaveEarly(page: Page, tv: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockPlayer(page);
  // a resume position (the start seek) and a media file that answers only after the viewer left
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 600_000_000, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, subtitles: [], audioTracks: [] } }));
  const media = page.route('**/media/p1test.webm', async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.fallback(); });
  void media;
  await page.goto(tv ? '/?tv=1' : '/');
  await page.waitForLoadState('networkidle');
  await page.evaluate((p) => { const a = document.createElement('a'); a.href = p; document.body.appendChild(a); a.click(); a.remove(); }, '/watch/' + episodes[1]!.id);
  await expect(page.locator('.stage video')).toHaveCount(1);
  await page.getByRole('button', { name: 'Zurück', exact: true }).first().click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await page.waitForTimeout(2500);
  expect(errors).toEqual([]);
}

test('Back before the video is ready throws no page error (desktop)', async ({ page, api: _api }) => { await leaveEarly(page, false); });
test('Back before the video is ready throws no page error (TV mode)', async ({ page, api: _api }) => { await leaveEarly(page, true); });
