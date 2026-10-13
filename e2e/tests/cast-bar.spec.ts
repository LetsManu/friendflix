// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { castOn, castSessions, fakeCastSdk } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** The minimal cast bar: shown on every page except /watch/*, /party/* and TV mode while a title plays on a TV. */

/** a Chromecast cast started on the watch page (client-side navigation), then back to the home page */
async function castAndLeave(page: Page) {
  await mockPlayer(page);
  await castOn(page);
  const sdk = await fakeCastSdk(page);
  const { sessions } = await castSessions(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.appendChild(a); a.click(); a.remove(); }, '/watch/' + MOVIE.id);
  await expect(page).toHaveURL(/\/watch\//);
  await videoReady(page);
  await sdk.start();
  await expect(page.locator('.castov')).toContainText('Wird auf Wohnzimmer-TV abgespielt');
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Zurück', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  return { sdk, sessions };
}

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
