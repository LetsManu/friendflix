// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes, MOVIE, MOVIE2 } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** The minimal cast bar: shown on every page except /watch/*, /party/* and TV mode while a title plays on a TV. */

/** a client-side navigation by a link click (a full page load would fire pagehide and end the cast) */
const clientNav = (page: Page, path: string) => page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
async function leaveWatch(page: Page) {
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}
/** a Chromecast cast started on the watch page (client-side navigation), then back to the home page; `fail()` -> 429 on a token request */
async function castAndLeave(page: Page, o: { id?: string; fail?: () => boolean } = {}) {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions, deleted } = await castSessions(page, { fail: o.fail });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + (o.id ?? MOVIE.id));
  await expect(page).toHaveURL(/\/watch\//);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await leaveWatch(page);
  return { sdk, sessions, deleted };
}
const castBar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });

test('bar appears after leaving the watch page and pauses the TV', async ({ page, api: _api }) => {
  const { sdk } = await castAndLeave(page);
  const bar = page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await sdk.calls()).filter((c) => c === 'playOrPause')).toHaveLength(1);
});

test('tapping the bar reopens the remote without a new session', async ({ page, api: _api }) => {
  const { sessions } = await castAndLeave(page);
  const bar = page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
  await bar.locator('.title').click();
  await expect(page).toHaveURL(new RegExp('/watch/' + MOVIE.id));
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await expect(page.getByRole('region', { name: 'Jetzt auf dem Fernseher' })).toHaveCount(0);
  expect(sessions).toHaveLength(1);
});

test.describe('token failure', () => {
  test.use({ allowedConsole: /status of 429/ });
  test('a failed token request on a switch shows the reconnect hint; a tap retries once', async ({ page, api: _api }) => {
    let fail = false;
    const { sessions } = await castAndLeave(page, { fail: () => fail });
    // the switch's token request is held until the watch page is left again (there the Player would play on locally)
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/cast/session', async (r) => { if (fail) await gate; return r.fallback(); });
    fail = true;
    await clientNav(page, '/watch/' + MOVIE2.id);
    await expect(page.locator('.castov')).toBeVisible();
    await leaveWatch(page);
    release();
    const bar = castBar(page);
    await expect(bar).toContainText('Verbindung verloren – tippen, um am Fernseher fortzusetzen');
    await expect.poll(() => sessions.length).toBe(2);
    await expect(bar.locator('.pp')).toHaveAttribute('aria-disabled', 'true');
    fail = false;
    await bar.locator('.title').click();
    await expect(page).toHaveURL(/\/$/); // a reconnect, not the remote
    await expect.poll(() => sessions.length).toBe(3);
    await page.waitForTimeout(400);
    expect(sessions).toHaveLength(3); // exactly one retry
    expect(sessions[2]!.itemId).toBe(MOVIE2.id);
    await expect(bar).not.toContainText('Verbindung verloren');
  });
});

test('switching episodes of one series changes the visible bar text', async ({ page, api: _api }) => {
  await castAndLeave(page, { id: episodes[0]!.id });
  const bar = castBar(page);
  await expect(bar).toContainText(episodes[0]!.name);
  await clientNav(page, '/watch/' + episodes[1]!.id);
  await expect(page).toHaveURL(/\/watch\//);
  await expect(page.locator('.castov')).toBeVisible();
  await leaveWatch(page);
  await expect(bar).toContainText(episodes[1]!.name);
  await expect(bar).not.toContainText(episodes[0]!.name);
});
