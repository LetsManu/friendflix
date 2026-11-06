// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { settingsState } from '../mocks/settings.js';

// One app for both media servers: /api/me server.kind picks the texts that name the server (i18n serverText) and the pull
// command of Admin → Update (a Plex stack keeps compose.plex.yaml). Without a kind (older backend) or on Jellyfin nothing changes.
type Page = import('@playwright/test').Page;
const setting = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const PLEX_PULL = 'docker compose -f compose.prod.yaml -f compose.plex.yaml -f compose.no-updater.yaml pull && docker compose -f compose.prod.yaml -f compose.plex.yaml -f compose.no-updater.yaml up -d';
const JF_PULL = 'docker compose -f compose.prod.yaml -f compose.no-updater.yaml pull && docker compose -f compose.prod.yaml -f compose.no-updater.yaml up -d';

test.describe('media server kind in the app (Plex)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('Admin → Update: the pull command keeps the Plex override; Jellyfin and an unknown kind keep the plain one', async ({ page, api }) => {
    api.serverKind = 'plex';
    await page.goto('/admin/update');
    const card = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(card.getByLabel('Befehl')).toHaveValue(PLEX_PULL);
    api.serverKind = 'jellyfin';
    await page.reload();
    await expect(page.getByRole('region', { name: 'Update-Kanal' }).getByLabel('Befehl')).toHaveValue(JF_PULL);
    api.serverKind = undefined;
    await page.reload();
    await expect(page.getByRole('region', { name: 'Update-Kanal' }).getByLabel('Befehl')).toHaveValue(JF_PULL);
  });

  test('playback check: the empty-video hint names Plex, never Jellyfin', async ({ page, api }) => {
    api.serverKind = 'plex';
    const row = (i: number) => ({ itemId: String(i).repeat(32), name: 'Film ' + i, type: 'Movie', ok: false, status: 200, ms: 800, bytes: 0, error: 'HTTP 200 empty body' });
    await page.route('**/api/admin/playback-check', (r) => (r.request().method() === 'GET'
      ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ running: false, done: 3, total: 3, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results: [row(1), row(2), row(3)] }) })
      : r.fallback()));
    await page.goto('/admin/playback');
    await expect(page.getByTestId('empty-media-hint')).toHaveText('Medienserver liefert leere Videostücke – Plex neu starten; hilft das nicht, Hardware-Beschleunigung prüfen');
  });

  test('settings: engine v1 is "klassisch" on Plex, and the media group shows only the Plex keys', async ({ page, api }) => {
    api.serverKind = 'plex';
    api.settings = settingsState('plex');
    await page.goto('/admin/settings');
    await expect(setting(page, 'Empfehlungs-Engine').getByRole('combobox').locator('option')).toHaveText(['v1 (klassisch)', 'v2 (eigenes Geschmacksmodell)', 'Shadow (v2 neben v1)']);
    await expect(setting(page, 'Plex-Adresse')).toBeVisible();
    await expect(setting(page, 'Jellyfin-Adresse')).toHaveCount(0);
  });
});
