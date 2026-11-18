// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { updaterState } from '../mocks/updater.js';

const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Updater' });
const steps = (page: import('@playwright/test').Page) => card(page).locator('ol.steps li');

test.describe('admin update with the opt-in updater (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  // the fake backend answers 502 while it "restarts" during a job
  test.use({ allowedConsole: /status of 502 \(Bad Gateway\)/ });

  test('without an updater the page keeps the manual steps', async ({ page }) => {
    await page.goto('/admin/update');
    await expect(page.getByRole('region', { name: 'Update-Kanal' }).getByLabel('Zeile in der .env')).toHaveValue('FF_TAG=latest');
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Aktualisieren', exact: true })).toBeVisible();
  });

  test('update now: inline confirmation, live steps through the backend restart, result', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const c = card(page);
    await expect(c).toContainText('Installiert:');
    await expect(c.locator('[data-updater]')).toContainText('sha-a1b2c3d');
    // the updater installs the channel: no .env snippet, a note instead
    const channel = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(channel.locator('[data-snippet]')).toHaveCount(0);
    await expect(channel.locator('[data-updater-note]')).toContainText('keine Änderung an der .env');
    await expect(page.getByRole('region', { name: 'Aktualisieren', exact: true })).toHaveCount(0);

    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const confirm = c.getByRole('group', { name: /Jetzt auf latest aktualisieren/ });
    await expect(confirm).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0); // inline, no pop-up
    await confirm.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(steps(page)).toHaveCount(4); // the rollback row only once a rollback starts (its room is kept)
    // the running row is the current step; the primary button is busy while it runs
    await expect(c.locator('li[aria-current="step"]')).toHaveCount(1);
    await expect(c.getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
    await expect(c.locator('[data-reconnecting]')).toContainText('FriendFlix startet neu');
    await expect(c.locator('[data-result="succeeded"]')).toContainText('Update auf latest abgeschlossen.', { timeout: 20_000 });
    for (const s of ['pull', 'verify', 'restart', 'health']) await expect(c.locator(`li[data-step="${s}"]`)).toHaveAttribute('data-state', 'ok');
    await expect(c.locator('[data-reconnecting]')).toHaveCount(0);
    await expect(c.locator('li[aria-current="step"]')).toHaveCount(0);
    await expect(c.getByRole('progressbar', { name: 'Fortschritt des Updates' })).toHaveAttribute('aria-valuenow', '100');
    expect(api.updater.posts).toEqual(['update']);
  });

  test('picking another channel says what still runs until the update', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const channel = page.getByRole('region', { name: 'Update-Kanal' });
    await expect(channel.locator('[data-updater-note]')).toContainText('FF_TAG=latest');
    await expect(channel.locator('[data-pending-switch]')).toHaveCount(0);
    await channel.getByRole('radio', { name: 'Nightly' }).click();
    await expect(channel.locator('[data-pending-switch]')).toContainText('Es läuft noch: Stabil');
    await expect(channel.locator('[data-updater-note]')).toContainText('FF_TAG=nightly');
  });

  test('an unhealthy new version: the rollback step shows and the result says rolled back', async ({ page, api }) => {
    api.updater = { ...updaterState(true), outcome: 'rolled_back', downPolls: 0 };
    await page.goto('/admin/update');
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect(card(page).locator('[data-result="rolled_back"]')).toContainText('zurückgerollt auf sha-c0be6c5', { timeout: 20_000 });
    await expect(card(page).locator('[data-result="rolled_back"]')).toContainText('Fehlercode: unhealthy');
    await expect(card(page).locator('[data-result="rolled_back"]').getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();
    await expect(card(page).locator('li[data-step="health"]')).toHaveAttribute('data-state', 'failed');
    await expect(card(page).locator('li[data-step="rollback"]')).toHaveAttribute('data-state', 'ok');
  });

  test('back to the previous version; cancel leaves everything as it was; without a previous build the button is off', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const back = card(page).getByRole('button', { name: 'Zurück zur vorherigen Version' });
    await back.click();
    await card(page).getByRole('button', { name: 'Abbrechen' }).click();
    expect(api.updater.posts).toEqual([]);
    await back.click();
    await expect(card(page).getByRole('group', { name: /Zurück zu sha-a1b2c3d/ })).toBeVisible();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect(card(page).locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });
    expect(api.updater.posts).toEqual(['rollback']);

    api.updater = { ...updaterState(true), previous: null };
    await page.reload();
    await expect(card(page).getByRole('button', { name: 'Zurück zur vorherigen Version' })).toBeDisabled();
  });

  test('a start needs no second sign-in: the job starts right away, no dialog, no redirect', async ({ page, api }) => {
    api.updater = updaterState(true);
    let reauth = 0;
    page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p === '/auth/reauth' || p.startsWith('/auth/flow/')) reauth++; });
    await page.goto('/admin/update');
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect.poll(() => api.updater!.posts).toEqual(['update']);
    await expect(page.getByRole('dialog', { name: 'Erneut anmelden' })).toHaveCount(0);
    expect(reauth).toBe(0);
  });

  test('a running job is picked up after a reload; the updater itself; automatic updates', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.job = { id: '0123456789abcdef', action: 'update', state: 'running', step: 'pull', from: 'sha-c0be6c5', to: 'latest', startedAt: new Date().toISOString(), finishedAt: null, error: null,
      steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' } };
    api.updater.downPolls = 0;
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });

    await card(page).getByText('Updater selbst').click();
    await card(page).getByRole('button', { name: 'Updater aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect.poll(() => api.updater!.posts).toEqual(['self-update']);
    await expect(card(page).locator('li[data-step]')).toHaveCount(3); // no health step for the updater itself

    await card(page).getByLabel('Automatische Updates').selectOption('nightly-window');
    await card(page).getByLabel('Uhrzeit').fill('03:30');
    await card(page).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Automatische Updates gespeichert.')).toBeVisible();
    expect(api.settings.puts.at(-1)).toEqual({ values: { AUTO_UPDATE: 'nightly-window', AUTO_UPDATE_TIME: '03:30' } });
  });

  test('a fixed version: the form opens, a bad version is refused, a good one is saved with the channel', async ({ page, api }) => {
    api.updater = updaterState(true);
    await page.goto('/admin/update');
    const channel = page.getByRole('region', { name: 'Update-Kanal' });
    await channel.getByRole('radio', { name: 'Feste Version' }).click();
    expect(api.settings.puts).toEqual([]);
    const field = channel.getByLabel('Version (X.Y.Z)');
    await field.fill('latest');
    await channel.getByRole('button', { name: 'Version speichern' }).click();
    await expect(channel).toContainText('Bitte eine Version wie 1.2.3 eingeben.');
    await field.fill('1.2.3');
    await channel.getByRole('button', { name: 'Version speichern' }).click();
    await expect(toasts(page).getByText('Kanal Feste Version 1.2.3 gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { UPDATE_CHANNEL: 'pinned', UPDATE_VERSION: '1.2.3' } }]);
    await expect(channel.getByRole('radio', { name: 'Feste Version' })).toHaveAttribute('aria-checked', 'true');
    await expect(card(page).locator('[data-updater]')).toContainText('1.2.3');
  });

  test('a Portainer stack without the webhook: the page says so up front, nothing can be started here', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign' };
    await page.goto('/admin/update');
    const note = card(page).locator('[data-foreign="manual"]');
    await expect(note).toHaveAttribute('role', 'alert');
    await expect(note).toContainText('von Portainer (oder einem anderen Werkzeug) verwaltet');
    await expect(note).toContainText('Admin → Einstellungen → Updates');
    await expect(card(page).getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
    await expect(card(page).getByRole('button', { name: 'Zurück zur vorherigen Version' })).toBeDisabled();
    await card(page).getByText('Updater selbst').click();
    await expect(card(page).getByRole('button', { name: 'Updater aktualisieren' })).toBeDisabled();
    expect(api.updater.posts).toEqual([]);
  });

  test('a Portainer stack with the webhook: "update now" redeploys through Portainer', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign', portainer: true };
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-foreign="portainer"]')).toContainText('über Portainer neu');
    await expect(card(page).getByRole('button', { name: 'Zurück zur vorherigen Version' })).toBeDisabled();
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await expect(card(page).getByRole('group', { name: /über Portainer neu deployen/ })).toBeVisible();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect(toasts(page).getByText('Portainer deployt den Stack neu.')).toBeVisible();
    expect(api.updater.posts).toEqual(['update']);
    // the redeploy is followed like a job: Portainer pulls, recreates (n of 3 on the new build), the backend restarts, health, done
    const progress = card(page).locator('[data-redeploy]');
    await expect(progress.locator('[data-step="recreating"]')).toHaveAttribute('data-state', 'running');
    await expect(progress.locator('[data-count]')).toContainText('1 von 3 Diensten auf dem neuen Build');
    await expect(progress.locator('[data-step="pulling"]')).toHaveAttribute('data-state', 'ok');
    await expect(progress.getByRole('heading', { name: 'Update über Portainer' })).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
    const before = (await progress.locator('[data-step="pulling"]').boundingBox())!.y;
    await expect(card(page).locator('[data-reconnecting]')).toBeVisible();
    // "reconnecting" has its line reserved: the steps do not move
    expect((await progress.locator('[data-step="pulling"]').boundingBox())!.y).toBe(before);
    await expect(card(page).locator('[data-result="done"]')).toContainText('Portainer hat den Stack neu deployt', { timeout: 20_000 });
    await expect(progress.locator('[data-step="health"]')).toHaveAttribute('data-state', 'ok');
    await expect(card(page).locator('[data-reconnecting]')).toHaveCount(0);
    await expect(card(page).locator('ol.steps')).toHaveCount(1); // no updater job, only the redeploy
  });

  test('a redeploy Portainer refuses after "started" is shown as failed with the HTTP status; a reload while it runs resumes it', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign', portainer: true, redeployOutcome: 'failed' };
    api.updater.redeploy = { id: 'abcdef0123456789', mode: 'api', tag: 'latest', phase: 'pulling', running: true, startedAt: new Date(Date.now() - 30_000).toISOString(), finishedAt: null,
      services: null, error: null, status: null, step: null, code: null, at: null };
    await page.goto('/admin/update'); // found running: the page follows it without a click
    const result = card(page).locator('[data-result="failed"]');
    // accepted, then failed while pulling: the note says so with the row's label, never "abgelehnt", never the API step code
    await expect(result).toContainText('Portainer hat das Update begonnen, es brach aber bei „Portainer lädt die Images“ ab (HTTP 500).', { timeout: 15_000 });
    await expect(result).not.toContainText('abgelehnt');
    await expect(result).not.toContainText('Neu-Deployen');
    // only the one-sentence headline is the alert (seen happening); the advice is folded away, outside it
    await expect(result.locator('[data-headline]')).toHaveAttribute('role', 'alert');
    await expect(result.getByRole('alert').locator('[data-advice]')).toHaveCount(0);
    const advice = result.locator('[data-advice]');
    await expect(advice).toBeHidden();
    // opening "Was tun?" moves neither the toggle nor anything above it: its text appears below
    const toggle = result.getByRole('button', { name: 'Was tun?' });
    // positions on the page (a click may scroll the viewport)
    const top = (l: import('@playwright/test').Locator) => l.evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
    const pos = async () => ({ toggle: await top(toggle), head: await top(result.locator('[data-headline]')), retry: await top(result.getByRole('button', { name: 'Erneut versuchen' })) });
    const before = await pos();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(advice).toContainText('Die Logs des Stacks in Portainer nennen den Grund');
    expect(await pos()).toEqual(before);
    expect(await top(advice)).toBeGreaterThan(before.toggle);
    // refused while Portainer pulled (after "started"): the request went through, the pull failed, the rest never ran
    const progress = card(page).locator('[data-redeploy="failed"]');
    await expect(progress.locator('[data-step="request"]')).toHaveAttribute('data-state', 'ok');
    await expect(progress.locator('[data-step="pulling"]')).toHaveAttribute('data-state', 'failed');
    for (const st of ['recreating', 'health']) await expect(progress.locator(`[data-step="${st}"]`)).toHaveAttribute('data-state', 'skipped');
    await expect(card(page).getByRole('button', { name: 'Jetzt aktualisieren' })).toBeEnabled();
    expect(api.updater.posts).toEqual([]);
    // try again: the same inline confirmation as the button
    await result.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(card(page).getByRole('group', { name: /über Portainer neu deployen/ })).toBeVisible();
  });

  test('the Portainer API set up only in part: the page names the missing setting and where the stack ID is', async ({ page, api }) => {
    api.updater = { ...updaterState(true), missing: ['PORTAINER_STACK_ID'] }; // an updater that cannot tell the stack
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-foreign="manual"]')).toContainText('PORTAINER_STACK_ID');
    const note = card(page).locator('[data-portainer-missing]');
    await expect(note).toHaveAttribute('role', 'alert');
    await expect(note).toContainText('Es fehlt PORTAINER_STACK_ID');
    await expect(note).toContainText('?id=12');
    await expect(card(page).getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
  });

  test('our own stack started from another directory: the note names both directories and UPDATER_PROJECT_DIR, not Portainer', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign', stackReason: 'working_dir', stackDir: '/volume1/docker/friendflix', projectDir: '/project' };
    await page.goto('/admin/update');
    const note = card(page).locator('[data-foreign="workdir"]');
    await expect(note).toContainText('aus /volume1/docker/friendflix gestartet');
    await expect(note).toContainText('/project');
    await expect(note).toContainText('UPDATER_PROJECT_DIR=/volume1/docker/friendflix');
    await expect(note).not.toContainText('Portainer');
    await expect(card(page).getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
  });

  test('an updater without the stack field and the Portainer webhook set: the update goes through Portainer', async ({ page, api }) => {
    api.updater = { ...updaterState(true), portainer: true };
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-foreign="portainer"]')).toBeVisible();
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    await expect(toasts(page).getByText('Portainer deployt den Stack neu.')).toBeVisible();
  });

  test('a job refused because the ports would change says so', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.job = { id: '0123456789abcdef', action: 'update', state: 'failed', step: 'pull', from: 'sha-c0be6c5', to: 'latest', startedAt: '2026-10-20T02:00:00.000Z',
      finishedAt: '2026-10-20T02:00:05.000Z', error: 'config_mismatch', steps: { pull: 'failed', verify: 'skipped', restart: 'skipped', health: 'skipped', rollback: 'skipped' } };
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-result="failed"]')).toContainText('andere Ports oder Netzwerke');
  });

  test('an updater that refuses the signature is reported', async ({ page, api }) => {
    api.updater = updaterState('unauthorized');
    await page.goto('/admin/update');
    await expect(card(page).getByRole('alert')).toContainText('INTERNAL_SECRET');
  });

  test('per service under Installiert: what the registry has, after the update its report or "alles unverändert"; the rows never move', async ({ page, api }) => {
    const D = (c: string) => `sha256:${c.repeat(64)}`;
    const svc = (service: string, c: string, registry: string | null) => ({ service, state: 'running', health: 'healthy', sha: `sha-${c.repeat(7)}`, version: service === 'backend' ? '1.0.0' : null,
      commit: c.repeat(40), digest: D(c), registry, changed: registry === null ? null : registry !== D(c) });
    const services = () => [svc('bootstrap', '1', D('1')), svc('backend', '1', D('1')), svc('gateway', '2', null), svc('web', '3', D('9')), svc('updater', '4', D('4'))];
    api.updater = { ...updaterState(true), downPolls: 0, services: services(), report: { backend: 'unchanged', gateway: 'unchanged', web: 'updated' } };
    await page.goto('/admin/update');
    const c = card(page);
    const rows = c.locator('[data-services] tr');
    await expect(rows).toHaveCount(4); // bootstrap follows the backend
    await expect(rows.nth(0)).toContainText('backend');
    await expect(rows.nth(0)).toContainText('1111111');
    await expect(rows.nth(0)).toContainText('unverändert');
    await expect(c.locator('tr[data-service="gateway"] td.st')).toHaveText(''); // the registry did not answer: no text, the same room
    await expect(c.locator('tr[data-service="web"]')).toContainText('Update verfügbar');
    await expect(c.locator('tr[data-service="updater"]')).toContainText('unverändert');
    const heights = async () => Promise.all([0, 1, 2, 3].map(async (i) => (await rows.nth(i).boundingBox())!.height));
    const h0 = await heights();
    expect(new Set(h0).size).toBe(1);
    const below = c.getByRole('heading', { name: 'Automatische Updates' });
    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await c.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(c.locator('[data-step="verify"]')).toHaveAttribute('data-state', 'running');
    const y0 = (await below.boundingBox())!.y;
    await expect(c.locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });
    await expect(c.locator('tr[data-service="web"]')).toContainText('aktualisiert');
    await expect(c.locator('tr[data-service="backend"]')).toContainText('unverändert');
    expect(await heights()).toEqual(h0);
    expect((await below.boundingBox())!.y).toBe(y0);

    // nothing changed: one "alles unverändert" over the job's rows, the updater keeps its own row; still the same heights
    api.updater = { ...updaterState(true), downPolls: 0, services: services().map((x) => ({ ...x, registry: x.digest, changed: x.service === 'gateway' ? null : false })),
      report: { backend: 'unchanged', gateway: 'unchanged', web: 'unchanged' } };
    await page.reload();
    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await c.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(c.locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });
    await expect(c.locator('[data-services] [data-all]')).toHaveText('alles unverändert');
    await expect(c.locator('[data-services] [data-all]')).toHaveAttribute('rowspan', '3');
    await expect(c.locator('tr[data-service="updater"]')).toContainText('unverändert');
    expect(await heights()).toEqual(h0);
  });

  test('after an update by digests (no sha tag recorded) the rollback stays: the images before the last update', async ({ page, api }) => {
    api.updater = { ...updaterState(true), previous: null, rollback: { available: true } };
    await page.goto('/admin/update');
    const c = card(page);
    await expect(c.locator('[data-previous]')).toHaveText('Images vor dem letzten Update');
    await c.getByRole('button', { name: 'Zurück zur vorherigen Version' }).click();
    await expect(c.getByRole('group', { name: 'Zurück zu den Images vor dem letzten Update? FriendFlix startet kurz neu.' })).toBeVisible();
    await c.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(c.locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });
    expect(api.updater.posts).toEqual(['rollback']);
  });

  test('the rollback row: an update without one never shows it and the card keeps its height; a rollback appears in the kept slot, nothing below moves', async ({ page, api }) => {
    api.updater = { ...updaterState(true), downPolls: 0 };
    await page.goto('/admin/update');
    const c = card(page);
    const below = c.getByRole('heading', { name: 'Automatische Updates' });
    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await c.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(c.locator('li[aria-current="step"]')).toHaveCount(1);
    await expect(c.locator('[data-step="verify"]')).toHaveAttribute('data-state', 'running');
    const h0 = (await c.boundingBox())!.height, y0 = (await below.boundingBox())!.y;
    await expect(c.locator('[data-result="succeeded"]')).toBeVisible({ timeout: 20_000 });
    await expect(c.locator('li[data-step="rollback"]')).toHaveCount(0);
    expect((await c.boundingBox())!.height).toBe(h0);
    expect((await below.boundingBox())!.y).toBe(y0);

    api.updater = { ...updaterState(true), outcome: 'rolled_back', downPolls: 0 };
    await page.reload();
    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await c.getByRole('button', { name: 'Ja, starten' }).click();
    await expect(c.locator('[data-step="verify"]')).toHaveAttribute('data-state', 'running');
    await expect(c.locator('li[data-step="rollback"]')).toHaveCount(0);
    const y1 = (await below.boundingBox())!.y;
    await expect(c.locator('li[data-step="rollback"]')).toBeVisible({ timeout: 20_000 });
    await expect(c).toContainText('Schritt 4 von 4');
    expect((await below.boundingBox())!.y).toBe(y1);
    await expect(c.locator('[data-result="rolled_back"]')).toBeVisible({ timeout: 20_000 });
    expect((await below.boundingBox())!.y).toBe(y1);
  });
});
