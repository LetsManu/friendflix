// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { airplayRemote } from './cast-remote-setup.js';

const HINT = 'Untertitel über AirPlay sind neu; manche Fernseher zeigen sie nicht.';

/** Phone without AirPlay / Chromecast receivers: the "Mehr" menu points to the TV mode (<host>/tv + phone as remote) instead. */
test('phone More menu: TV-mode hint when no AirPlay or Chromecast receiver is around', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.pause());
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await page.getByRole('button', { name: 'Mehr' }).tap();
  const hint = page.getByTestId('tv-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(`${new URL(page.url()).host}/tv`);
  await expect(page.getByTestId('playon')).toHaveCount(0);
});

test('AirPlay remote shows the subtitles chip and the hint', async ({ page, api: _api }) => {
  const { sessions } = await airplayRemote(page, { tracks: true });
  const screen = page.getByTestId('airplay-active');
  const line = page.locator('#rs-subs-hint');
  const chip = screen.getByRole('button', { name: /^Untertitel: / });
  await expect(chip).toHaveAccessibleName('Untertitel: Aus');
  await expect(chip).toHaveAccessibleDescription(''); // the invisible hint is not read
  await expect(line).toHaveAttribute('aria-hidden', 'true');
  await expect(line).toHaveCSS('opacity', '0'); // its room is there, it is just not shown yet
  const before = await line.boundingBox();
  await chip.click();
  await screen.getByRole('menuitemradio', { name: 'Deutsch (SDH)' }).click();
  await expect(screen.getByRole('button', { name: 'Untertitel: Deutsch (SDH)' })).toBeVisible();
  await expect(line).toBeVisible();
  await expect(line).toHaveCSS('opacity', '1');
  expect(await line.boundingBox()).toEqual(before); // nothing jumped
  expect(sessions.at(-1)).toMatchObject({ via: 'airplay', subtitleIndex: 3 });
  await expect(page.getByRole('status').filter({ hasText: HINT })).toHaveCount(1); // announced politely
  // off again: a new token without the key, the hint fades out
  await screen.getByRole('button', { name: /^Untertitel: / }).click();
  await screen.getByRole('menuitemradio', { name: 'Aus' }).click();
  await expect(line).toHaveCSS('opacity', '0');
  await expect.poll(() => sessions.length).toBe(3);
  expect('subtitleIndex' in sessions.at(-1)!).toBe(false);
});

test('AirPlay: a server that cannot put subtitles into the stream shows the chip disabled with the reason', async ({ page, api }) => {
  api.serverCaps = { castHlsSubtitles: false }; // as Plex
  const { sessions } = await airplayRemote(page, { tracks: true });
  const screen = page.getByTestId('airplay-active');
  const chip = screen.getByRole('button', { name: 'Untertitel: Aus' });
  await expect(chip).toHaveAttribute('aria-disabled', 'true');
  await expect(chip).toHaveAccessibleDescription('Dieser Server kann noch keine Untertitel an AirPlay senden.');
  const n = sessions.length;
  await chip.click({ force: true }); // aria-disabled: Playwright would wait for it
  await expect(screen.getByRole('menu')).toHaveCount(0);
  expect(sessions).toHaveLength(n);
});

test('AirPlay: the subtitle that was on locally goes into the first token and shows on the remote', async ({ page, api: _api }) => {
  const { sessions } = await airplayRemote(page, { tracks: true, localSub: true });
  const screen = page.getByTestId('airplay-active');
  expect(sessions[0]).toMatchObject({ via: 'airplay', subtitleIndex: 3 });
  await expect(screen.getByRole('button', { name: 'Untertitel: Deutsch (SDH)' })).toBeVisible();
  await expect(page.locator('#rs-subs-hint')).toHaveCSS('opacity', '1');
});
