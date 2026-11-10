// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** A Chromecast cast survives the tab: after a reload the bar comes back (the SDK joins, or Reconnect asks the browser); Stop ends it. */

const RECEIVER = 'ABCD1234'; // FriendFlix's own receiver: it carries the cast's public handle, which the reloaded page re-adopts
const castBar = (page: Page) => page.getByRole('region', { name: 'Jetzt auf dem Fernseher' });
async function clientNav(page: Page, path: string) {
  await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, path);
  await expect(page).toHaveURL((u) => u.pathname === path);
}
/** a cast started on the watch page, then back on `/`; the TV keeps its media over a reload */
async function castThenHome(page: Page, survive: 'join' | 'ask') {
  await mockPlayer(page);
  await castOn(page, true, RECEIVER);
  const sdk = await fakeCastSdk(page, { survive });
  const tokens = await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clientNav(page, '/watch/' + MOVIE.id);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await page.getByRole('button', { name: 'Fernbedienung schließen' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(castBar(page)).toBeVisible();
  return { sdk, ...tokens };
}

test('reload keeps the cast; the bar comes back; Stop ends it', async ({ page, api: _api }) => {
  const { deleted } = await castThenHome(page, 'join');
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.reload();
  await page.waitForLoadState('networkidle');
  const bar = castBar(page);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Wohnzimmer-TV');
  await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(deleted).toEqual([]);
  expect(writes.filter((w) => w.startsWith('DELETE') || w.includes('/api/playback/stop'))).toEqual([]);
  await bar.getByRole('button', { name: 'Übertragung beenden', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Wiedergabe auf Wohnzimmer-TV beenden', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]);
  await expect.poll(() => writes.filter((w) => w.endsWith('/api/playback/stop')).length).toBe(1); // exactly one stop report
  expect(writes.filter((w) => w.startsWith('DELETE'))).toHaveLength(1);
});

test('no auto-join: detached bar, Reconnect asks the browser', async ({ page, api: _api }) => {
  test.setTimeout(30_000);
  const { sdk } = await castThenHome(page, 'ask');
  await page.reload();
  await page.waitForLoadState('networkidle');
  const bar = castBar(page);
  await expect(bar).toContainText('Verbindung verloren', { timeout: 9000 }); // after ~5 s without a joined session
  expect(await sdk.calls()).not.toContain('requestSession');
  await bar.getByRole('button', { name: 'Neu verbinden' }).click();
  await expect.poll(async () => (await sdk.calls()).filter((c) => c === 'requestSession').length).toBe(1);
  await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(bar).not.toContainText('Verbindung verloren');
});
