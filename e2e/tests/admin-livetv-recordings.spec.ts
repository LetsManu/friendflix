// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Aufnahmen (/admin/livetv?tab=recordings, Phase 3 Task 11, spec §9.6, §15.3, §15.9, §26): the storage mode (the
// library modes stay off with the setup steps while the library folder is not mounted), the library select with its folders, *passt*,
// the mismatch warning, *Bibliothek „Aufnahmen“ anlegen*, the visibility note and the §26 warning for a recording role that cannot see
// the library; the usage bar and the registry rows (limit, retention, padding, parallel); the list with *Abbrechen*; *Alle Aufnahmen
// löschen…* behind the typed "LÖSCHEN".
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const mount = (api: MockState) => { api.admin.livetv.rec.storage.library = { mounted: true, writable: true, dedicated: true, freeBytes: 900_000_000_000 }; };

test.describe('admin: Live-TV, Aufnahmen (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('the tab sits before Einstellungen', async ({ page }) => {
    await page.goto('/admin/livetv?tab=recordings');
    await expect(page.getByRole('tablist', { name: 'Live-TV-Bereiche' }).getByRole('tab')).toHaveText(['Quellen', 'Kanäle', 'Gruppen & Rechte', 'Programmführer', 'Live-Status', 'Aufnahmen', 'Einstellungen']);
    await expect(page.getByRole('tab', { name: 'Aufnahmen' })).toHaveAttribute('aria-selected', 'true');
  });

  test('library modes disabled until mounted, with setup lines', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=recordings');
    const c = card(page, 'Speicherort');
    await expect(c.getByRole('radio', { name: /^FriendFlix-Ordner/ })).toBeChecked();
    await expect(c.getByRole('radio', { name: /^Jellyfin-Bibliothek/ })).toBeDisabled();
    await expect(c.getByRole('radio', { name: /^Beides/ })).toBeDisabled();
    await expect(c).toContainText('mkdir -p <media>/Aufnahmen && chown 10001:10001 <media>/Aufnahmen');
    await expect(c).toContainText('RECORDINGS_LIBRARY_PATH');
    await expect(c).toContainText('compose.livetv-library.yaml');
    // mounted: the modes can be chosen, the steps go
    mount(api);
    await page.reload();
    await expect(c.getByRole('radio', { name: /^Jellyfin-Bibliothek/ })).toBeEnabled();
    await expect(c).not.toContainText('mkdir -p');
  });

  test('mismatch warning before saving a library without the folder', async ({ page, api }) => {
    mount(api);
    await page.goto('/admin/livetv?tab=recordings');
    const c = card(page, 'Speicherort');
    await c.getByRole('radio', { name: /^Jellyfin-Bibliothek/ }).check();
    const lib = c.getByLabel('Bibliothek', { exact: true });
    // the library holding /media/Aufnahmen is preselected and marked
    await expect(lib).toHaveValue('lib-rec');
    await expect(c).toContainText('passt');
    await expect(c).toContainText('Aufnahmen in der Bibliothek sieht jede Person, die diese Bibliothek sieht.');
    await expect(c).toContainText('Live-TV darf nur in diesen einen Ordner schreiben.');
    await lib.selectOption('lib-film');
    await c.getByRole('button', { name: 'Speicherort speichern' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Diese Bibliothek enthält den Aufnahmeordner nicht – Jellyfin findet die Aufnahmen dann nicht.');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(api.settings.puts).toEqual([]);
    await c.getByRole('button', { name: 'Speicherort speichern' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Trotzdem speichern' }).click();
    await expect.poll(() => api.settings.puts).toEqual([{ values: { LIVETV_RECORD_STORAGE: 'library', LIVETV_RECORD_LIBRARY_ID: 'lib-film' } }]);
  });

  test('§26: roles with the Mediathek on that lack the recordings library (by name) are named; Live-TV-only roles never are', async ({ page, api }) => {
    mount(api);
    // the role matrix (GET /api/admin/roles): library lists hold NAMES, matched without case (backend libraries.ts)
    const mx = api.admin.matrix;
    const base = mx.roles.find((r) => r.key === 'family')!;
    const role = (key: string, label: string, libraries: unknown) => ({ ...base, key, label, builtinLabel: false, values: { ...base.values, libraries, liveTv: true, liveRecord: true } });
    mx.roles = [...mx.roles.map((r) => ({ ...r, values: { ...r.values, libraries: 'all' } })),
      role('sees', 'Sieht Aufnahmen', ['Filme', 'aufnahmen']), role('blind', 'Nur Filme', ['Filme']), role('liveonly', 'Nur Live-TV', [])];
    await page.goto('/admin/livetv?tab=recordings');
    const c = card(page, 'Speicherort');
    await c.getByRole('radio', { name: /^Beides/ }).check();
    await expect(c.getByLabel('Bibliothek', { exact: true })).toHaveValue('lib-rec');
    await expect(c).toContainText('Diese Rollen dürfen aufnehmen, sehen die Bibliothek „Aufnahmen“ aber nicht: Nur Filme.');
    await expect(c).not.toContainText('Nur Live-TV.');
    await expect(c).not.toContainText('Sieht Aufnahmen');
  });

  test.describe('a failing role list', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('§26: a role list that cannot be read says so instead of staying silent', async ({ page, api }) => {
      mount(api);
      await page.route('**/api/admin/roles', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }));
      await page.goto('/admin/livetv?tab=recordings');
      const c = card(page, 'Speicherort');
      await c.getByRole('radio', { name: /^Beides/ }).check();
      await expect(c).toContainText('Die Rollen konnten nicht geprüft werden.');
    });
  });

  test('a missing recordings library can be created', async ({ page, api }) => {
    mount(api);
    api.admin.livetv.rec.libraries.libraries = api.admin.livetv.rec.libraries.libraries.filter((l) => l.id !== 'lib-rec');
    await page.goto('/admin/livetv?tab=recordings');
    const c = card(page, 'Speicherort');
    await c.getByRole('radio', { name: /^Beides/ }).check();
    await c.getByRole('button', { name: 'Bibliothek „Aufnahmen“ anlegen' }).click();
    await expect.poll(() => api.admin.livetv.rec.calls).toEqual(['POST /api/admin/livetv/recordings/libraries {}']);
    await expect(c.getByLabel('Bibliothek', { exact: true })).toHaveValue('lib-new');
  });

  test('?setting=LIVETV_RECORD_* opens this tab and highlights the row (Systemcheck, settings search)', async ({ page }) => {
    await page.goto('/admin/livetv?tab=recordings&setting=LIVETV_RECORD_MAX_PARALLEL');
    const row = page.locator('#setting-LIVETV_RECORD_MAX_PARALLEL');
    await expect(row).toHaveAttribute('data-flash', /.+/);
    await expect(row.getByRole('spinbutton')).toBeFocused();
    await expect(page).toHaveURL((u) => u.searchParams.get('tab') === 'recordings' && !u.searchParams.has('setting'));
    // the storage mode has no registry row here: its card is the target
    await page.goto('/admin/livetv?tab=recordings&setting=LIVETV_RECORD_STORAGE');
    await expect(page.locator('#setting-LIVETV_RECORD_STORAGE')).toHaveAttribute('data-flash', /.+/);
  });

  test('the settings search sends a recording setting to this tab', async ({ page }) => {
    await page.goto('/admin/settings?setting=LIVETV_RECORD_RETENTION_DAYS');
    await expect(page).toHaveURL((u) => u.pathname === '/admin/livetv' && u.searchParams.get('tab') === 'recordings');
    await expect(page.locator('#setting-LIVETV_RECORD_RETENTION_DAYS')).toHaveAttribute('data-flash', /.+/);
  });

  test('usage bar text', async ({ page }) => {
    await page.goto('/admin/livetv?tab=recordings');
    const c = card(page, 'Speicher und Regeln');
    await expect(c.getByRole('progressbar', { name: 'Aufnahmespeicher belegt' })).toBeVisible();
    await expect(c).toContainText('143 von 200 GB · noch ca. 41 h in HD');
    // the registry rows of the settings page, one store
    for (const n of ['Speichergrenze für Aufnahmen (GB)', 'Aufnahmen nach dem Ansehen löschen (Tage)', 'Vorlauf von Aufnahmen (Minuten)', 'Nachlauf von Aufnahmen (Minuten)', 'Gleichzeitige Aufnahmen (Sender)']) {
      await expect(c.getByRole('group', { name: n, exact: true })).toBeVisible();
    }
    await c.getByRole('group', { name: 'Gleichzeitige Aufnahmen (Sender)', exact: true }).getByRole('spinbutton').fill('3');
    await c.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Gespeichert')).toBeVisible();
  });

  test('the list cancels a planned recording; failed ones show their reason', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=recordings');
    const c = card(page, 'Geplante, laufende und fehlgeschlagene Aufnahmen');
    await expect(c.getByRole('row')).toHaveCount(4); // the head and three recordings
    await expect(c).toContainText('Anna Beispiel');
    await expect(c).toContainText('Fehlgeschlagen · Speicher voll');
    await c.getByRole('row', { name: /Hafenkanal/ }).getByRole('button', { name: 'Abbrechen' }).click();
    await expect.poll(() => api.admin.livetv.rec.calls).toEqual(['DELETE /api/admin/livetv/recordings/00000000-0000-4000-8000-0000000000a2']);
    await expect(c.getByRole('row')).toHaveCount(3);
  });

  test('delete-all needs LÖSCHEN', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=recordings');
    await page.getByRole('button', { name: 'Alle Aufnahmen löschen …' }).click();
    const dlg = page.getByRole('alertdialog');
    const go = dlg.getByRole('button', { name: 'Alle löschen' });
    await expect(go).toBeDisabled();
    await dlg.getByRole('textbox').fill('löschen ja');
    await expect(go).toBeDisabled();
    await dlg.getByRole('textbox').fill('LÖSCHEN');
    await go.click();
    await expect.poll(() => api.admin.livetv.rec.calls).toEqual(['POST /api/admin/livetv/recordings/delete-all {"confirm":"LÖSCHEN"}']);
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('3 Aufnahmen gelöscht')).toBeVisible();
  });
});
