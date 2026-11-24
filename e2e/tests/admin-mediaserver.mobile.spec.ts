// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { linkMediaJob, mediaStatus, movableMedia, movedMedia } from '../mocks/admin.js';
import { updaterState } from '../mocks/updater.js';

// Admin → Einstellungen → Medienserver on a phone (Task 17): the set-up flow fits 390 px, the choices and the actions are 44 px
// targets, nothing scrolls sideways, and nothing above the progress moves while the first run advances.
const card = (page: Page) => page.getByRole('region', { name: 'Medienserver', exact: true });
/** a box in page coordinates (the page may scroll between two reads) */
const box = (l: ReturnType<Page['locator']>) => l.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
});
const W = 390;
async function fits(l: ReturnType<Page['locator']>, name: string) {
  const b = await l.boundingBox();
  expect(b && b.height >= 44 && b.x >= 0 && b.x + b.width <= W, `${name}: ${JSON.stringify(b)}`).toBe(true);
}

test.describe('admin: Medienserver card (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('choose managed Jellyfin, confirm the base with the code, pick two folders, set up', async ({ page, api }) => {
    const ms = api.admin.media;
    Object.assign(ms, { offer: { managed: true, reason: null }, kinds: { ferrofin: true, jellyfin: true }, status: mediaStatus(), setupSeq: ['first_run', 'libraries', 'done'] });
    api.updater = { ...updaterState(true), downPolls: 0 };
    linkMediaJob(api.updater, ms);
    await page.goto('/admin/settings?tab=media');
    const c = card(page);
    const head = c.getByRole('heading', { level: 2, name: 'Medienserver' });
    const seg = c.getByRole('radiogroup', { name: 'Art des Medienservers' });
    for (const name of ['Ferrofin (eigener)', 'Jellyfin (offiziell, verwaltet)', 'Bestehender Jellyfin/Plex (Adresse)']) await fits(seg.getByRole('radio', { name }), name);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const at = { head: await box(head), seg: await box(seg) };

    await seg.getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' }).click();
    await c.getByLabel('Pfad auf dem Server').fill('/srv/media');
    await c.getByRole('button', { name: 'Code anfordern' }).click();
    await expect(c.getByTestId('media-code-countdown')).toHaveText(/^Gültig noch (30:00|29:[0-5]\d)$/);
    await expect(c.getByTestId('media-code-hint')).toContainText('docker compose logs updater');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await c.getByLabel('Code aus dem Protokoll').fill('ABCD-EFGH-JKMN');
    await c.getByRole('button', { name: 'Bestätigen' }).click();
    await expect(c.getByTestId('media-base-path')).toHaveText('/srv/media');

    const list = c.getByTestId('media-browser');
    await list.locator('[data-entry="Serien"]').getByRole('button', { name: 'Wählen' }).click();
    await list.locator('[data-entry="Filme"]').getByRole('button', { name: 'Wählen' }).click();
    await fits(list.getByRole('button', { name: 'Musik öffnen' }), 'Musik öffnen');
    await c.locator('[data-row="Serien"]').getByLabel('Art').selectOption('tvshows');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    expect({ head: await box(head), seg: await box(seg) }).toEqual(at);

    await fits(c.getByRole('button', { name: 'Einrichten' }), 'Einrichten');
    await c.getByRole('button', { name: 'Einrichten' }).click();
    const progress = c.getByTestId('media-setup');
    const go = c.getByTestId('media-apply');
    const above = { head: await box(head), seg: await box(seg), go: await box(go) };
    await expect.poll(async () => {
      expect({ head: await box(head), seg: await box(seg), go: await box(go) }).toEqual(above);
      return progress.getAttribute('data-setup');
    }, { timeout: 40_000, intervals: [300] }).toBe('done');
    await expect(progress.locator('li[data-state="done"]')).toHaveCount(6);

    // the actions of the running server are 44 px targets inside the screen
    const actions = c.getByTestId('media-actions');
    await expect(actions.getByRole('button', { name: 'Stoppen' })).toBeVisible({ timeout: 15_000 });
    for (const name of ['Stoppen', 'Neu starten', 'Entfernen', 'Protokoll']) await fits(actions.getByRole('button', { name }), name);
    await fits(c.getByTestId('media-backups').getByRole('button', { name: 'Sicherung' }), 'Sicherung');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    expect(ms.calls.find((x) => x.p.endsWith('/apply'))?.body).toMatchObject({ kind: 'jellyfin', folders: [{ rel: 'Serien', type: 'tvshows' }, { rel: 'Filme', type: 'movies' }] });
  });

  test('the move sheet fits the phone: summary, steps and the way back, nothing sideways, 44 px targets', async ({ page, api }) => {
    test.setTimeout(60_000);
    const ms = api.admin.media;
    movableMedia(ms);
    await page.goto('/admin/settings?tab=media');
    const c = card(page);
    await fits(c.getByRole('button', { name: 'Von Jellyfin umziehen' }), 'Von Jellyfin umziehen');
    await c.getByRole('button', { name: 'Von Jellyfin umziehen' }).click();
    const dlg = page.getByRole('dialog', { name: /zu Ferrofin/ });
    const sum = dlg.getByTestId('move-summary');
    await expect(sum).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await fits(sum.getByRole('switch'), 'Trickplay');
    const acts = dlg.getByTestId('move-actions');
    for (const name of ['Abbrechen', 'Umziehen']) await fits(acts.getByRole('button', { name }), name);
    const at = await box(acts);
    await acts.getByRole('button', { name: 'Umziehen' }).click();
    await fits(acts.getByRole('button', { name: 'Umzug abbrechen' }), 'Umzug abbrechen');
    expect(await box(acts)).toEqual(at);
    await expect(dlg.getByTestId('move-steps')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
    expect(await box(acts)).toEqual(at);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    await acts.getByRole('button', { name: 'Schließen' }).click();
    await expect(c.getByTestId('media-moved')).toContainText('Umgezogen von „jellyfin“');
    await fits(c.getByTestId('media-moved').getByRole('button', { name: 'Zurück zu Jellyfin' }), 'Zurück zu Jellyfin');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('the moved state with the request service warning fits the phone', async ({ page, api }) => {
    const ms = api.admin.media;
    movedMedia(ms);
    ms.move.requestsWarning = true;
    await page.goto('/admin/settings?tab=media');
    const c = card(page);
    await expect(c.getByTestId('media-requests-warning')).toContainText('8096');
    await fits(c.getByTestId('media-moved').getByRole('button', { name: 'Zurück zu Jellyfin' }), 'Zurück zu Jellyfin');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
