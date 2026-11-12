// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { castOn, fakeCastSdk } from '../mocks/cast.js';

// Casting a live channel (Task 41, live TV spec §13) with the Cast SDK fake: the live player's *Abspielen auf …* plays the channel on the
// TV through the cast engine's `loadLive` (its own `via: 'chromecast'` token, a LIVE stream, the answer's signed logo), the player becomes
// the TV's remote (live variant), and the cast bar's ▲ outside the player loads the next channel with a new token.

type Load = { contentId: string; contentType: string; streamType: string | null; customData: unknown; title: string | null; subtitle: string | null; images: string[] };
const SIGNED = /^https:\/\/friend\.example\.com\/api\/livetv\/logos\/ch-nord\?exp=\d+&sig=[A-Za-z0-9_-]+$/;
const live = (page: Page) => page.locator('[data-live-state]');
const castBar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
/** a link click: the page (and the cast engine with it) stays; a full load would be a pagehide */
const clientNav = (page: Page, path: string) => page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);

/** live TV on, the Cast SDK fake (picking a TV starts its session), the live player of Nordlicht TV opened from the list */
async function openPlayer(page: Page, api: MockState) {
  api.features = { livetv: true };
  await mockLivePlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page, { pick: true });
  await page.goto('/live');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/live/watch/ch-nord?f=all');
  await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
  return sdk;
}
/** Abspielen auf … → Anderer Fernseher … (the fake picks Wohnzimmer-TV) */
async function castFromPlayer(page: Page) {
  await page.mouse.move(600, 300);
  await page.getByRole('group', { name: 'Wiedergabesteuerung' }).getByRole('button', { name: 'Abspielen auf …' }).click();
  await page.getByRole('dialog', { name: 'Abspielen auf' }).getByRole('button', { name: /^Anderer Fernseher/ }).click();
}

test('Abspielen auf… plays the channel on the TV', async ({ page, api }) => {
  const sdk = await openPlayer(page, api);
  await castFromPlayer(page);
  await expect.poll(async () => (await sdk.loads()).length).toBe(1);
  const load = (await sdk.loads())[0] as Load;
  const origin = new URL(page.url()).origin;
  expect(load).toMatchObject({
    contentId: `${origin}/media/l/tok-ch-nord-cc/index.m3u8`, contentType: 'application/x-mpegURL', streamType: 'LIVE',
    customData: { ui: { live: true } }, title: 'Nordlicht TV', subtitle: 'Die Leuchtturmwärter',
  });
  expect(load.images).toHaveLength(1);
  expect(load.images[0]).toMatch(SIGNED); // the answer's signed absolute logo, as given
  // the cast's own token: one watch via chromecast after the player's own
  expect(api.livetv.watches).toEqual(['ch-nord', 'ch-nord']);
  expect(api.livetv.vias).toEqual(['', 'chromecast']);
  // the player is the TV's remote now (live variant: LIVE pill, channel keys, no scrubber); its own stream is let go
  const remote = page.locator('.castov');
  await expect(remote).toBeVisible();
  await expect(remote.locator('h1')).toHaveText('1 Nordlicht TV');
  await expect(remote).toContainText('Jetzt: Die Leuchtturmwärter');
  await expect(remote.locator('.lpill')).toHaveText('LIVE');
  await expect(remote.getByRole('button', { name: 'Nächster Sender' })).toBeVisible();
  await expect(remote.getByRole('slider', { name: 'Position' })).toHaveCount(0);
  await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord');
  expect(api.livetv.stops).not.toContain('tok-ch-nord-cc');
});

test('the bar\'s ▲ loads the next channel', async ({ page, api }) => {
  const sdk = await openPlayer(page, api);
  await castFromPlayer(page);
  await expect(page.locator('.castov')).toBeVisible();
  // out of the player (back to the list): the cast bar shows the channel with its LIVE pill and no progress line
  await page.getByRole('button', { name: 'Fernbedienung schließen' }).click();
  await expect(page).toHaveURL(/\/live(\?|$)/);
  const bar = castBar(page);
  await expect(bar).toBeVisible();
  await expect(bar.locator('.t1')).toHaveText('LIVE · 1 Nordlicht TV');
  await expect(bar.getByRole('progressbar')).toHaveCount(0);
  await bar.getByRole('button', { name: 'Nächster Sender' }).click();
  // 'Alle' by number: 1 Nordlicht TV → 4 Hafenkanal, with a new token
  await expect.poll(async () => (await sdk.loads()).length).toBe(2);
  const next = (await sdk.loads())[1] as Load;
  expect(next).toMatchObject({ contentId: `${new URL(page.url()).origin}/media/l/tok-ch-hafen-cc/index.m3u8`, streamType: 'LIVE', title: 'Hafenkanal', subtitle: 'Wetter am Hafen' });
  expect(api.livetv.watches.slice(-1)).toEqual(['ch-hafen']);
  expect(api.livetv.vias.slice(-1)).toEqual(['chromecast']);
  await expect(bar.locator('.t1')).toHaveText('LIVE · 4 Hafenkanal');
  await expect.poll(() => api.livetv.stops).toContain('tok-ch-nord-cc');
});
