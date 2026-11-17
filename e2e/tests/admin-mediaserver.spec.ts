// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { linkMediaJob, mediaStatus, runningMedia, type MediaMock } from '../mocks/admin.js';
import { updaterState } from '../mocks/updater.js';

// Admin → Einstellungen → Medienserver (Task 17): the three choices, the base folder with its code, the folder browser, the first run's
// progress (nothing above it moves), the reasons a choice is disabled, removing with data, the encrypted download and the log.
const card = (page: Page) => page.getByRole('region', { name: 'Medienserver', exact: true });
const addressCard = (page: Page) => page.getByRole('heading', { level: 2, name: 'Mediaserver', exact: true });
const choices = (page: Page) => card(page).getByRole('radiogroup', { name: 'Art des Medienservers' });
/** a box in page coordinates (the page may scroll between two reads) */
const box = (l: ReturnType<Page['locator']>) => l.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
});

/** the flow every viewport runs: choose managed Jellyfin, confirm the base, pick two folders, set up */
async function setUpManagedJellyfin(page: Page, ms: MediaMock): Promise<void> {
  const c = card(page);
  const head = c.getByRole('heading', { level: 2, name: 'Medienserver' });
  const seg = choices(page);
  await expect(seg.getByRole('radio', { name: 'Bestehender Jellyfin/Plex (Adresse)' })).toHaveAttribute('aria-checked', 'true');
  await expect(addressCard(page)).toBeVisible();
  const at = { head: await box(head), seg: await box(seg) };

  await seg.getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' }).click();
  await expect(seg.getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' })).toHaveAttribute('aria-checked', 'true');
  // Ferrofin carries *Test* while it is a trial
  await expect(seg.getByRole('radio', { name: /Ferrofin \(eigener\)/ })).toContainText('Test');

  await c.getByLabel('Pfad auf dem Server').fill('/srv/media');
  await c.getByRole('button', { name: 'Code anfordern' }).click();
  // the code step: the countdown and where the updater wrote the line
  await expect(c.getByTestId('media-code-countdown')).toHaveText(/^Gültig noch (30:00|29:[0-5]\d)$/);
  await expect(c.getByTestId('media-code-hint')).toContainText('docker compose logs updater | grep "media folder"');
  await expect(c.getByTestId('media-code-hint')).toContainText('Portainer → Containers → updater → Logs');
  const count = await box(c.getByTestId('media-code-countdown'));
  // a first path can be changed while its code is pending
  await expect(c.getByRole('button', { name: 'Abbrechen' })).toBeVisible();
  // a new code that is refused (the updater's limit) keeps the pending code, its countdown and the hint
  ms.refuse = { status: 429, error: 'rate_limited' };
  await c.getByRole('button', { name: 'Neuen Code anfordern' }).click();
  await expect(c.getByRole('alert').filter({ hasText: 'Zu oft hintereinander.' })).toBeVisible();
  await expect(c.getByLabel('Code aus dem Protokoll')).toBeVisible();
  await expect(c.getByTestId('media-code-hint')).toBeVisible();
  expect(await box(c.getByTestId('media-code-countdown'))).toEqual(count);
  await c.getByLabel('Code aus dem Protokoll').fill('ZZZZ-ZZZZ-ZZZZ');
  await c.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(c.getByRole('alert').filter({ hasText: 'Der Code stimmt nicht.' })).toBeVisible();
  // the refusal had its room: the countdown did not move
  expect(await box(c.getByTestId('media-code-countdown'))).toEqual(count);
  await c.getByLabel('Code aus dem Protokoll').fill('abcd-efgh-jkmn');
  await c.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(c.getByTestId('media-base-path')).toHaveText('/srv/media');

  // the browser: one level at a time, a symlink shown but not selectable, an unreadable folder marked
  const list = c.getByTestId('media-browser');
  await expect(list.locator('[data-entry="Verknüpfung"]')).toContainText('Verknüpfung, nicht wählbar');
  await expect(list.locator('[data-entry="Verknüpfung"]').getByRole('button')).toHaveCount(0);
  await expect(list.locator('[data-entry="Privat"]')).toContainText('nicht lesbar');
  await list.locator('[data-entry="Serien"]').getByRole('button', { name: 'Wählen' }).click();
  await list.getByRole('button', { name: 'Filme öffnen' }).click();
  await expect(c.getByRole('navigation', { name: 'Ordner unter dem Basisordner' })).toContainText('Filme');
  await list.locator('[data-entry="Klassiker"]').getByRole('button', { name: 'Wählen' }).click();
  const serien = c.locator('[data-row="Serien"]');
  await expect(serien.getByLabel('Name der Bibliothek')).toHaveValue('Serien');
  await serien.getByLabel('Art').selectOption('tvshows');
  await expect(c.locator('[data-row="Filme/Klassiker"]').getByLabel('Name der Bibliothek')).toHaveValue('Klassiker');
  await expect(c.getByTestId('media-gpu-found')).toContainText('Intel (renderD128)');
  expect({ head: await box(head), seg: await box(seg) }).toEqual(at);

  await c.getByRole('button', { name: 'Einrichten' }).click();
  const progress = c.getByTestId('media-setup');
  await expect(progress.locator('li[data-step="applying"]')).toHaveAttribute('data-state', /running|done/);
  // the job's steps come through the shared step list
  await expect(c.getByTestId('media-job').locator('li[data-step="media-check"]')).toBeVisible();
  // the progress advances through the first run's steps; nothing above it moves meanwhile
  const go = c.getByTestId('media-apply');
  const above = { head: await box(head), seg: await box(seg), base: await box(c.getByTestId('media-base-path')), go: await box(go) };
  const seen = new Set<string>();
  await expect.poll(async () => {
    seen.add((await progress.getAttribute('data-setup')) ?? '');
    expect({ head: await box(head), seg: await box(seg), base: await box(c.getByTestId('media-base-path')), go: await box(go) }).toEqual(above);
    return seen.has('done');
  }, { timeout: 40_000, intervals: [300] }).toBe(true);
  expect(seen.has('first_run') || seen.has('libraries')).toBe(true);
  await expect(progress.locator('li[data-state="done"]')).toHaveCount(6);
  await expect(progress).toContainText('Der Medienserver ist eingerichtet.');
  await expect(c.getByTestId('media-job')).toHaveAttribute('data-job-state', 'succeeded', { timeout: 15_000 });

  const apply = ms.calls.find((x) => x.p.endsWith('/apply'));
  expect(apply?.body).toEqual({
    kind: 'jellyfin', folders: [{ rel: 'Serien', name: 'Serien', type: 'tvshows' }, { rel: 'Filme/Klassiker', name: 'Klassiker', type: 'movies' }],
    uid: 1000, gid: 1000, gpu: 'dri', mediaGid: null, egress: true,
  });
  // managed now: the address card is gone, the actions fit the running server
  await expect(addressCard(page)).toHaveCount(0);
  await expect(c.getByTestId('media-actions').getByRole('button', { name: 'Stoppen' })).toBeVisible();
}

test.describe('admin: Medienserver card (desktop)', () => {
  // a wrong base code is a mocked 409 the browser logs
  test.use({ allowedConsole: /status of (409|429)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('choose managed Jellyfin, confirm the base with the code, pick two folders, set up', async ({ page, api }) => {
    const ms = api.admin.media;
    Object.assign(ms, { offer: { managed: true, reason: null }, kinds: { ferrofin: true, jellyfin: true }, status: mediaStatus(), setupSeq: ['first_run', 'libraries', 'done'] });
    api.updater = { ...updaterState(true), downPolls: 0 };
    linkMediaJob(api.updater, ms);
    await page.goto('/admin/settings?tab=media');
    await setUpManagedJellyfin(page, ms);
    // *Aktualisieren* is not offered while the image matches the pin
    await expect(card(page).getByTestId('media-actions').getByRole('button', { name: 'Aktualisieren' })).toHaveCount(0);
  });

  test('disabled choices say why', async ({ page, api }) => {
    const ms = api.admin.media;
    Object.assign(ms, { offer: { managed: false, reason: 'ids_in_use' }, kinds: { ferrofin: true, jellyfin: true }, status: mediaStatus() });
    await page.goto('/admin/settings?tab=media');
    const seg = choices(page);
    await expect(seg.getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' })).toBeDisabled();
    await expect(seg.getByRole('radio', { name: /Ferrofin \(eigener\)/ })).toBeDisabled();
    await expect(seg.getByRole('radio', { name: 'Bestehender Jellyfin/Plex (Adresse)' })).toBeEnabled();
    await expect(card(page).getByTestId('media-reasons')).toContainText('Umzug von deinem Jellyfin: kommt mit Stufe 2');
    ms.offer = { managed: false, reason: 'plex' };
    await page.reload();
    await expect(card(page).getByTestId('media-reasons')).toContainText('Wechsel von Plex: kommt mit Stufe 4');
    await expect(choices(page).getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' })).toBeDisabled();
    // a build without a Ferrofin image: only that choice is off, with its reason
    Object.assign(ms, { offer: { managed: true, reason: null }, kinds: { ferrofin: false, jellyfin: true } });
    await page.reload();
    await expect(choices(page).getByRole('radio', { name: /Ferrofin \(eigener\)/ })).toBeDisabled();
    await expect(choices(page).getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' })).toBeEnabled();
    await expect(card(page).getByTestId('media-reasons')).toContainText('Für diesen FriendFlix-Stand gibt es kein Image dieses Servers.');
  });

  test('remove with data asks for the kind\'s name', async ({ page, api }) => {
    const ms = api.admin.media;
    runningMedia(ms);
    await page.goto('/admin/settings?tab=media');
    const c = card(page);
    await expect(choices(page).getByRole('radio', { name: 'Jellyfin (offiziell, verwaltet)' })).toHaveAttribute('aria-checked', 'true');
    await expect(c.getByTestId('media-status')).toContainText('läuft');
    await expect(addressCard(page)).toHaveCount(0);
    await c.getByTestId('media-actions').getByRole('button', { name: 'Entfernen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Medienserver entfernen?' });
    await expect(dlg).toContainText('die Adresse deines Servers musst du dort wieder eintragen');
    const remove = dlg.getByRole('button', { name: 'Entfernen' });
    await expect(remove).toBeEnabled();
    const height = (await dlg.boundingBox())!.height;
    await dlg.getByRole('switch', { name: 'Daten löschen' }).click();
    // the typed confirmation had its room: the dialog keeps its height
    expect((await dlg.boundingBox())!.height).toBe(height);
    await expect(remove).toBeDisabled();
    const typed = dlg.getByLabel('Zur Bestätigung „Jellyfin“ eintippen');
    await typed.fill('Ferrofin');
    await expect(remove).toBeDisabled();
    await typed.fill('jellyfin');
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(dlg).toHaveCount(0);
    expect(ms.calls.filter((x) => x.p.endsWith('/action')).map((x) => x.body)).toEqual([{ op: 'remove', data: true }]);
    // FriendFlix switched to the existing server: the external choice and the address card
    await expect(choices(page).getByRole('radio', { name: 'Bestehender Jellyfin/Plex (Adresse)' })).toHaveAttribute('aria-checked', 'true');
    await expect(addressCard(page)).toBeVisible();
  });

  test('download asks for the passphrase twice', async ({ page, api }) => {
    runningMedia(api.admin.media);
    // the fallback path (a Blob link): Chromium's save picker would open a native dialog
    await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
    let header: string | undefined;
    page.on('request', (r) => { if (r.url().includes('/backups/') && r.url().endsWith('/download')) header = r.headers()['x-ff-backup-passphrase']; });
    await page.goto('/admin/settings?tab=media');
    const backups = card(page).getByTestId('media-backups');
    await backups.locator('[data-backup="jellyfin-20261117-0300-10.11.0"]').getByRole('button', { name: 'Herunterladen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Sicherung herunterladen' });
    await expect(dlg).toContainText('age');
    const go = dlg.getByRole('button', { name: 'Herunterladen' });
    await dlg.getByLabel('Passphrase (mindestens 12 Zeichen)').fill('zu kurz');
    await dlg.getByLabel('Passphrase wiederholen').fill('zu kurz');
    const at = await box(go);
    await go.click();
    await expect(dlg).toContainText('Mindestens 12 Zeichen.');
    // the error lines had their room: the button did not move
    expect(await box(go)).toEqual(at);
    await dlg.getByLabel('Passphrase (mindestens 12 Zeichen)').fill('Ein langer Satz eins');
    await dlg.getByLabel('Passphrase wiederholen').fill('Ein langer Satz zwei');
    await go.click();
    await expect(dlg).toContainText('Die beiden Eingaben stimmen nicht überein.');
    expect(await box(go)).toEqual(at);
    for (const f of await dlg.locator('input[type=password]').all()) await expect(f).toHaveAttribute('autocomplete', 'off');
    expect(header).toBeUndefined();
    await dlg.getByLabel('Passphrase wiederholen').fill('Ein langer Satz eins');
    const download = page.waitForEvent('download');
    await go.click();
    expect((await download).suggestedFilename()).toBe('jellyfin-20261117-0300-10.11.0.tar.gz.age');
    await expect(dlg).toHaveCount(0);
    expect(header).toBe(Buffer.from('Ein langer Satz eins', 'utf8').toString('base64url'));
  });

  test('deleting a kept library counts its references first, then the row is gone', async ({ page, api }) => {
    const ms = api.admin.media;
    runningMedia(ms);
    ms.managed.libraries.push({ slug: 'alt', name: 'Alt', type: 'mixed', rel: 'Alt', created: true });
    ms.libraries = [{ slug: 'alt', name: 'Alt', type: 'mixed', rel: 'Alt', created: true, references: { lists: 2, resume: 3, recordings: 1 } }];
    await page.goto('/admin/settings?tab=media');
    const c = card(page);
    const kept = c.locator('ul.kept li').filter({ hasText: 'Alt' });
    await expect(kept).toHaveCount(1);
    await kept.getByRole('button', { name: 'Bibliothek löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Bibliothek „Alt“ löschen?' });
    await expect(dlg).toContainText('2 Listeneinträge, 3 Fortsetzungspunkte und 1 Aufnahmen');
    await dlg.getByRole('button', { name: 'Bibliothek löschen' }).click();
    // the card reads the view again: the kept row is gone, nothing can be deleted twice
    await expect(kept).toHaveCount(0);
    expect(ms.calls.filter((x) => x.m === 'DELETE').map((x) => x.p)).toEqual(['/api/admin/mediaserver/libraries/alt']);
  });

  test('log dialog shows redacted lines and copies them', async ({ page, api, context }) => {
    runningMedia(api.admin.media);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/admin/settings?tab=media');
    await card(page).getByTestId('media-actions').getByRole('button', { name: 'Protokoll' }).click();
    const dlg = page.getByRole('dialog', { name: 'Protokoll' });
    const log = dlg.getByTestId('media-log');
    await expect(log).toContainText('GET /Items?api_key=… 200');
    await expect(log).toContainText('Startup complete');
    expect(api.admin.media.calls.find((x) => x.p.endsWith('/logs'))?.body).toEqual({ tail: 300 });
    await dlg.getByRole('button', { name: 'Kopieren' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' })).toContainText('Protokoll kopiert.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(api.admin.media.logs.join('\n'));
    await dlg.getByRole('button', { name: 'Schließen' }).click();
    await expect(dlg).toHaveCount(0);
  });
});
