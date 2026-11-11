// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { items, SERIES } from '../mocks/fixtures.js';
import { playOnButton } from '../mocks/cast.js';
import { dunmoor, playOnPlayer } from './cast-remote-setup.js';

/** Rights of the acting profile (/api/me `perms`): what is switched off is not offered at all. German UI. */
dunmoor();

const DENIED = { cast: false, party: false, requests: false, comments: false } as const;
const MOVIE = items.find((i) => i.type === 'Movie')!;
const PARTY = 'Gemeinsam schauen';

async function openMore(page: Page) {
  await page.getByRole('button', { name: 'Mehr', exact: true }).click();
}
const partyEntry = (page: Page) => page.getByRole('menuitem', { name: PARTY }).or(page.getByRole('button', { name: PARTY, exact: true }));

test.describe('rights switched off', () => {
  test('detail page: no party action', async ({ page, api }) => {
    api.perms = { ...DENIED };
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await openMore(page);
    await expect(page.getByRole('menuitem', { name: 'Merkliste' }).or(page.getByRole('button', { name: /Gesehen/ })).first()).toBeVisible();
    await expect(partyEntry(page)).toHaveCount(0);
  });

  test('player: no "Play on" entry', async ({ page, api }) => {
    api.perms = { ...DENIED };
    await playOnPlayer(page);
    await page.locator('.stage').hover();
    await expect(page.getByRole('button', { name: 'Vollbild' }).first()).toBeVisible();
    await expect(playOnButton(page)).toHaveCount(0);
  });

  test('/new: no wish buttons', async ({ page, api }) => {
    api.perms = { ...DENIED };
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /Wünschen/ })).toHaveCount(0);
  });

  test('episode comments: no button, no region, no request', async ({ page, api }) => {
    api.perms = { ...DENIED };
    const asked: string[] = [];
    await page.route('**/api/items/*/comments**', (r) => { asked.push(r.request().url()); return r.fulfill({ status: 403, json: { error: 'comments_forbidden' } }); });
    await page.goto('/item/' + SERIES.id);
    await expect(page.locator('li.eprow').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kommentare' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Kommentare von Freunden' })).toHaveCount(0);
    expect(asked).toEqual([]);
  });

  test('footer menu: no Watch-Party link, the others stay', async ({ page, api }) => {
    api.perms = { ...DENIED };
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Filmabend' })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Watch-Party' })).toHaveCount(0);
  });

  test('/party shows the refusal text instead of the form', async ({ page, api }) => {
    api.perms = { ...DENIED };
    await page.goto('/party');
    await expect(page.getByText('Watch-Partys sind für dein Konto nicht freigeschaltet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Party erstellen' })).toHaveCount(0);
  });
});

test.describe('rights not sent (older backend) or on', () => {
  test('everything shows as before', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByRole('button', { name: /Wünschen/ }).first()).toBeVisible();
    await page.goto('/item/' + SERIES.id);
    await expect(page.getByRole('button', { name: 'Kommentare' }).first()).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Watch-Party' })).toBeVisible();
  });

  test('detail page: the party action is there', async ({ page }) => {
    await page.goto('/item/' + MOVIE.id);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await openMore(page);
    await expect(partyEntry(page)).toBeVisible();
  });

  test('player: "Play on" is offered', async ({ page }) => {
    await playOnPlayer(page);
    await page.locator('.stage').hover();
    await expect(playOnButton(page)).toBeVisible();
  });
});
