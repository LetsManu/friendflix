// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { items, SERIES } from '../mocks/fixtures.js';
import { MOVIE as WATCH_MOVIE } from '../mocks/fixtures.js';
import { available, castOn, castSessions, mockHls, playOnAirPlay, playOnButton, stubAirPlay } from '../mocks/cast.js';
import { mockPlayer } from '../mocks/scenes.js';
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

test.describe('AirPlay follows the cast right', () => {
  test('denied: no AirPlay probe, no token request, no entry', async ({ page, api }) => {
    api.perms = { ...DENIED };
    await stubAirPlay(page);
    await mockPlayer(page);
    await castOn(page);
    const { sessions } = await castSessions(page);
    await page.goto('/watch/' + WATCH_MOVIE.id);
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
    await available(page);
    await page.locator('.stage').hover();
    await expect(playOnButton(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('video')!.getAttribute('x-webkit-airplay'))).toBeNull();
    expect(await page.locator('video.airprobe').count()).toBe(0);
    expect(sessions).toEqual([]);
  });

  test.describe('refused anyway', () => {
    test.use({ allowedConsole: /status of 403/ });
    test('a 403 cast_forbidden shows the refusal text, not the generic failure', async ({ page, api: _api }) => {
      await stubAirPlay(page, { pickTv: true });
      await mockPlayer(page);
      await castOn(page);
      await mockHls(page);
      await castSessions(page);
      await page.route('**/api/cast/session', (r) => r.fulfill({ status: 403, json: { error: 'cast_forbidden' } }));
      await page.goto('/watch/' + WATCH_MOVIE.id);
      await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
      await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
      await available(page);
      await page.locator('.stage').hover();
      await playOnAirPlay(page);
      await expect(page.locator('.toast')).toContainText('Übertragen ist für dein Konto nicht freigeschaltet.');
      await expect(page.locator('.toast')).not.toContainText('fehlgeschlagen');
    });
  });
});

test.describe('the boot hint holds a rights list per profile', () => {
  const HINT = (noPerms: unknown) => JSON.stringify({ approved: true, multi: true, tv: false, noPerms });
  const commentButtons = (page: Page) => page.locator('button.cmbtn');
  /** the tab ran with `active`; /api/me is held back so the first paint comes from the hint alone */
  async function firstPaint(page: Page, active: string, noPerms: unknown) {
    await page.addInitScript(([h, a]) => { localStorage.setItem('ff-boot-hint', h!); sessionStorage.setItem('ff-active-profile', a!); sessionStorage.setItem('ff-profile-picked', '1'); }, [HINT(noPerms), active]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/me', async (r) => { await held; return r.fallback(); });
    await page.goto('/item/' + SERIES.id, { waitUntil: 'commit' });
    await expect(page.locator('li.eprow').first()).toBeVisible();
    return release;
  }

  test('a correct hint: denied from the first paint and it stays so', async ({ page, api }) => {
    api.perms = { comments: false };
    const release = await firstPaint(page, 'p1', { p1: ['comments'] });
    await expect(commentButtons(page)).toHaveCount(0);
    release();
    await page.waitForLoadState('networkidle');
    await expect(commentButtons(page)).toHaveCount(0);
  });

  test('the tab runs p1, the hint also holds p2: only p1 applies, from the first paint', async ({ page, api }) => {
    api.perms = {};
    const release = await firstPaint(page, 'p1', { p2: ['comments'] });
    await expect(commentButtons(page).first()).toBeVisible();
    release();
  });
});

test.describe('/party when the right arrives late', () => {
  test('a stale hint denied it, /api/me allows it: the form and the ?item= pick load', async ({ page }) => {
    await page.addInitScript((h) => { localStorage.setItem('ff-boot-hint', h); sessionStorage.setItem('ff-active-profile', 'p1'); sessionStorage.setItem('ff-profile-picked', '1'); }, JSON.stringify({ approved: true, multi: true, tv: false, noPerms: { p1: ['party'] } }));
    let rooms = 0;
    await page.route('**/api/party', (r) => { if (r.request().method() === 'GET') rooms++; return r.fulfill({ json: { rooms: [] } }); });
    await page.goto('/party?item=' + MOVIE.id);
    await expect(page.getByText('Watch-Partys sind für dein Konto nicht freigeschaltet.')).toHaveCount(0);
    await expect(page.getByText(MOVIE.name).first()).toBeVisible();
    expect(rooms).toBe(1);
  });
});

test.describe('the requests right folds into the request service flag (layout boot)', () => {
  test('only requests off: the page that never re-reads /api/me loses its upcoming link, the rest stays', async ({ page, api }) => {
    api.perms = { requests: false };
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Filmabend' })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'Watch-Party' })).toBeVisible(); // party stays on
    await expect(footer.getByRole('link', { name: 'Demnächst' })).toHaveCount(0);
  });
  test('requests on: the link is there', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Demnächst' })).toBeVisible();
  });
});
