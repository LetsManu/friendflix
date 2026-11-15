// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { available, castOn, picks, playOnButton, playOnSheet, srcAtPick, stubAirPlay, wireless } from '../mocks/cast.js';
import { mockRecording } from '../mocks/livetv.js';

// AirPlay of a recording (W-I9), like a live channel: the AirPlay row mints a `via: 'airplay'` token (two addresses: this device and
// the TV), puts its `/media/r/` URL on the element (native HLS, the TV is handed the element's URL) and opens the system picker. The
// local token ends. When the route leaves the TV, the recording plays here again with a fresh local token.
const pos = (page: Page) => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);

test('AirPlay plays a recording on the TV with its own token', async ({ page, api }) => {
  const r = mockRecording({ positionS: 8, durationS: 30 });
  const tok = `rtok-${r.id.slice(-4)}`;
  api.features = { livetv: true };
  api.livetv.recordings = [r];
  await stubAirPlay(page, { pickTv: true });
  await mockLivePlayer(page);
  await castOn(page);
  await page.goto(`/live/recordings/${r.id}`);
  await expect.poll(() => pos(page), { timeout: 15_000 }).toBeGreaterThan(8);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBe('allow');
  await page.mouse.move(600, 300);
  await expect(playOnButton(page)).toHaveCount(0); // no Chromecast, no AirPlay receiver yet
  await available(page);
  await page.mouse.move(620, 310);
  await playOnButton(page).click();
  await playOnSheet(page).getByRole('button', { name: /^AirPlay …/ }).click();
  await expect.poll(() => picks(page)).toBe(1);
  expect(await srcAtPick(page)).toBe(new URL(`/media/r/${tok}-ap/index.m3u8`, page.url()).href);
  expect(api.livetv.recPlays).toEqual([{ id: r.id, via: '' }, { id: r.id, via: 'airplay' }]);
  await expect.poll(() => api.livetv.stops).toContain(tok); // the local token ended
  expect(api.livetv.stops).not.toContain(`${tok}-ap`);
  await expect(page.getByTestId('airplay-active')).toContainText('Läuft über AirPlay');
  // the route leaves the TV: the recording plays here again, with a fresh local token; the AirPlay token ends
  await wireless(page, false);
  await expect.poll(() => api.livetv.recPlays.length, { timeout: 10_000 }).toBe(3);
  expect(api.livetv.recPlays[2]).toEqual({ id: r.id, via: '' });
  await expect.poll(() => api.livetv.stops).toContain(`${tok}-ap`);
  await expect(page.getByTestId('airplay-active')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.src)).toMatch(/^blob:/);
});
