// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { castOn, fakeCastSdk } from '../mocks/cast.js';
import { mockRecording } from '../mocks/livetv.js';

// Casting a recording (Phase 3 Task 10, spec §15.7) with the Cast SDK fake: the recording player's *Abspielen auf …* hands it to the
// cast engine's `loadRecording` (its own `via: 'chromecast'` rec token, `/media/r/…` with the fMP4 segment format, at the local
// position); the player becomes the TV's remote, the local token ends, and the receiver's position goes to the recording's progress.
type Load = { contentId: string; streamType: string | null; currentTime: number; customData: unknown; hlsSegmentFormat: string | null; title: string | null };
/** a link click: the page (and the cast engine with it) stays */
const clientNav = (page: import('@playwright/test').Page, path: string) =>
  page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);

test('cast a recording from its player', async ({ page, api }) => {
  const r = mockRecording({ positionS: 8, durationS: 30 });
  api.features = { livetv: true };
  api.livetv.recordings = [r];
  await mockLivePlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page, { pick: true });
  await page.goto('/live/recordings');
  await page.waitForLoadState('networkidle');
  await clientNav(page, `/live/recordings/${r.id}`);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0), { timeout: 15_000 }).toBeGreaterThan(8);
  await page.mouse.move(600, 300);
  await page.getByRole('button', { name: 'Abspielen auf …' }).click();
  await page.getByRole('dialog', { name: 'Abspielen auf' }).getByRole('button', { name: /^Anderer Fernseher/ }).click();
  await expect.poll(async () => (await sdk.loads()).length).toBe(1);
  const load = (await sdk.loads())[0] as Load;
  const origin = new URL(page.url()).origin;
  expect(load).toMatchObject({ contentId: `${origin}/media/r/rtok-${r.id.slice(-4)}-cc/index.m3u8`, streamType: 'BUFFERED', hlsSegmentFormat: 'fmp4', customData: { ui: { live: false } }, title: 'Die Leuchtturmwärter' });
  expect(load.currentTime).toBeGreaterThanOrEqual(8);
  // one play of its own (local), one for the TV with via chromecast; the local token ended
  expect(api.livetv.recPlays.map((p) => p.via)).toEqual(['', 'chromecast']);
  await expect.poll(() => api.livetv.stops).toContain(`rtok-${r.id.slice(-4)}`);
  expect(api.livetv.stops).not.toContain(`rtok-${r.id.slice(-4)}-cc`);
  // the receiver's position becomes the recording's progress
  await expect.poll(() => api.livetv.recProgress.filter((p) => p.positionS >= 8).length, { timeout: 15_000 }).toBeGreaterThan(1);
});
