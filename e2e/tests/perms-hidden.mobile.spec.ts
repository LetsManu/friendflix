// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { items, SERIES } from '../mocks/fixtures.js';
import { playOnButton } from '../mocks/cast.js';
import { dunmoor, playOnPlayer } from './cast-remote-setup.js';

/** Rights of the acting profile on a phone (390 x 844, touch): what is switched off is not offered at all. German UI. */
dunmoor();

const DENIED = { cast: false, party: false, requests: false, comments: false } as const;
const MOVIE = items.find((i) => i.type === 'Movie')!;
const PARTY = 'Gemeinsam schauen';
const partyEntry = (page: Page) => page.getByRole('menuitem', { name: PARTY }).or(page.getByRole('button', { name: PARTY, exact: true }));

for (const denied of [true, false]) {
  test.describe(denied ? 'rights switched off (phone)' : 'rights on (phone)', () => {
    const shown = (n: number) => (denied ? 0 : n);

    test('detail: the "Mehr" sheet', async ({ page, api }) => {
      if (denied) api.perms = { ...DENIED };
      await page.goto('/item/' + MOVIE.id);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Mehr', exact: true }).tap();
      await expect(page.getByRole('menuitem', { name: 'Merkliste' }).or(page.getByRole('button', { name: /Gesehen/ })).first()).toBeVisible();
      await expect(partyEntry(page)).toHaveCount(shown(1));
    });

    test('/new: wish buttons', async ({ page, api }) => {
      if (denied) api.perms = { ...DENIED };
      await page.goto('/new');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (denied) await expect(page.getByRole('button', { name: /Wünschen/ })).toHaveCount(0);
      else await expect(page.getByRole('button', { name: /Wünschen/ }).first()).toBeVisible();
    });

    test('episode comments', async ({ page, api }) => {
      if (denied) api.perms = { ...DENIED };
      await page.goto('/item/' + SERIES.id);
      await expect(page.locator('li.eprow').first()).toBeVisible();
      if (denied) await expect(page.getByRole('button', { name: 'Kommentare' })).toHaveCount(0);
      else await expect(page.getByRole('button', { name: 'Kommentare' }).first()).toBeVisible();
    });

    test('/me: the Watch-Party link', async ({ page, api }) => {
      if (denied) api.perms = { ...DENIED };
      await page.goto('/me');
      await expect(page.getByRole('link', { name: 'Filmabend' }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Watch-Party' })).toHaveCount(denied ? 0 : 1);
    });

    test('/party', async ({ page, api }) => {
      if (denied) api.perms = { ...DENIED };
      await page.route('**/api/party', (r) => r.fulfill({ json: { rooms: [] } }));
      await page.goto('/party');
      await expect(page.getByText('Watch-Partys sind für dein Konto nicht freigeschaltet.')).toHaveCount(denied ? 1 : 0);
      await expect(page.getByRole('heading', { name: 'Offene Räume' })).toHaveCount(denied ? 0 : 1);
    });

    test('player: "Play on"', async ({ page, api }) => {
      if (denied) api.perms = { ...DENIED };
      await playOnPlayer(page);
      await page.locator('.stage').tap();
      if (denied) { await expect(page.locator('video')).toBeVisible(); await expect(page.locator('.stage .ctl, .stage button').first()).toBeVisible(); await expect(playOnButton(page)).toHaveCount(0); }
      else await expect(playOnButton(page)).toBeVisible();
    });
  });
}
