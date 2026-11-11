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
  // a resume position (the start seek) and a media file that answers only once the test lets it, after the viewer left
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/p1test.webm', hlsUrl: '/media/p1test.webm', resumeTicks: 600_000_000, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, subtitles: [], audioTracks: [] } }));
  let open = () => undefined as void;
  const gate = new Promise<void>((ok) => { open = ok; });
  let asked = false;
  await page.route('**/media/p1test.webm', async (r) => { asked = true; await gate; await r.fallback(); });
  await page.goto(tv ? '/?tv=1' : '/');
  await page.waitForLoadState('networkidle');
  await page.evaluate((p) => { const a = document.createElement('a'); a.href = p; document.body.appendChild(a); a.click(); a.remove(); }, '/watch/' + episodes[1]!.id);
  await expect(page.locator('.stage video')).toHaveCount(1);
  await expect.poll(() => asked).toBe(true); // the player is attached and waits for its first bytes
  // TV: the remote's Back key (the on-screen button only shows once the media has loaded); desktop: the Back button
  if (tv) await page.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 461, bubbles: true, cancelable: true })));
  else await page.getByRole('button', { name: 'Zurück', exact: true }).first().click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('.stage video')).toHaveCount(0);
  open(); // the element answers now, with the page gone
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
}

test('Back before the video is ready throws no page error (desktop)', async ({ page, api: _api }) => { await leaveEarly(page, false); });
test('Back before the video is ready throws no page error (TV mode)', async ({ page, api: _api }) => { await leaveEarly(page, true); });
