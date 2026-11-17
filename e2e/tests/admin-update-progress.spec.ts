// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { startRedeploy, updaterState } from '../mocks/updater.js';

// Admin → Update's one step list, driven by the backend's records only: a Portainer redeploy without an updater (the page follows
// the record itself), through the backend's own restart and a reload; the updater card keeping its steps while Portainer recreates
// the updater; an old updater job next to a Portainer stack.
const apply = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Aktualisieren', exact: true });
const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Updater' });
const state = (scope: import('@playwright/test').Locator, step: string) => scope.locator(`[data-step="${step}"]`);

test.describe('admin update progress (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  // the fake backend answers 502 while Portainer recreates it
  test.use({ allowedConsole: /status of 502 \(Bad Gateway\)/ });

  test('without an updater: request → pulling → reconnecting while the backend is recreated → done, then the version is read again', async ({ page, api }) => {
    api.updater = { ...updaterState(false), downPolls: 2 };
    let infoReads = 0;
    page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/admin/update') infoReads++; });
    await page.goto('/admin/update');
    const go = apply(page).getByRole('button', { name: 'Jetzt aktualisieren' });
    await go.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const list = apply(page).locator('[data-redeploy]');
    await expect(state(list, 'request')).toHaveAttribute('data-state', 'ok');
    await expect(list.locator('li[aria-current="step"]')).toHaveCount(1);
    await expect(go).toBeDisabled();
    // the backend away: reconnecting, never a failure; the rows and their place stay
    const y = (await state(list, 'request').boundingBox())!.y;
    await expect(list.locator('[data-reconnecting]')).toContainText('FriendFlix startet neu');
    expect((await state(list, 'request').boundingBox())!.y).toBe(y);
    await expect(list.locator('[data-state="failed"]')).toHaveCount(0);
    await expect(list.locator('[data-result="done"]')).toContainText('Portainer hat den Stack neu deployt', { timeout: 20_000 });
    await expect(list.locator('[data-result="done"] [data-headline]')).toHaveAttribute('role', 'status');
    await expect(list.locator('[data-reconnecting]')).toHaveCount(0);
    for (const st of ['request', 'pulling', 'recreating', 'health']) await expect(state(list, st)).toHaveAttribute('data-state', 'ok');
    // the end reads the version again (the new build shows in the version card)
    await expect.poll(() => infoReads).toBeGreaterThan(1);
    await expect(go).toBeEnabled();
  });

  test('a reload mid-update resumes from the backend\'s record (no page-only state), then it ends', async ({ page, api }) => {
    api.updater = { ...updaterState(false), downPolls: 0 };
    startRedeploy(api.updater, 'latest', false);
    api.updater.redeploy.startedAt = new Date(Date.now() - 42_000).toISOString();
    await page.goto('/admin/update');
    const list = apply(page).locator('[data-redeploy]');
    await expect(list).toBeVisible();
    await expect(list.locator('li[aria-current="step"]')).toHaveCount(1);
    // the elapsed time counts from the redeploy's own start, not from the page load
    await expect(list).toContainText(/Portainer deployt neu \((4\d|5\d) s\)/);
    await page.reload();
    await expect(apply(page).locator('[data-redeploy]')).toBeVisible();
    await expect(apply(page).locator('[data-result="done"]')).toBeVisible({ timeout: 20_000 });
    expect(api.log.filter((l) => l.startsWith('POST /api/admin/update'))).toEqual([]);
  });

  test('a redeploy Portainer refuses at once: the request row failed, the rest skipped, the reason with the step and a retry', async ({ page, api }) => {
    api.updater = updaterState(false);
    api.updater.redeploy = { id: 'abcdef0123456789', mode: 'api', tag: 'latest', phase: 'failed', running: false, startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 59_000).toISOString(), services: null, error: 'portainer', status: 401, step: 'stack', code: null, at: null };
    await page.goto('/admin/update');
    const list = apply(page).locator('[data-redeploy="failed"]');
    await expect(state(list, 'request')).toHaveAttribute('data-state', 'failed');
    for (const st of ['pulling', 'recreating', 'health']) await expect(state(list, st)).toHaveAttribute('data-state', 'skipped');
    const note = list.locator('[data-result="failed"]');
    // an old outcome found on load is a status, not an alert (it is shown for two days)
    await expect(note.locator('[data-headline]')).toHaveAttribute('role', 'status');
    await expect(note).toContainText('Portainer hat das Update abgelehnt (HTTP 401, Schritt Stack-Abfrage).');
    await note.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('alertdialog', { name: /Portal jetzt aktualisieren/ })).toBeVisible();
  });

  test('Portainer recreates the updater too: the card keeps its steps (reconnecting) until the updater answers again, then done', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign', portainer: true, downPolls: 1, awayPolls: 3 };
    await page.goto('/admin/update');
    await card(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await card(page).getByRole('button', { name: 'Ja, starten' }).click();
    const list = card(page).locator('[data-redeploy]');
    await expect(list.locator('[data-count]')).toContainText('2 von 3 Diensten', { timeout: 15_000 });
    // the updater is away now: the steps and buttons stay, reconnecting says why
    await expect(list.locator('[data-reconnecting]')).toBeVisible();
    await expect(card(page).locator('[data-updater]')).toBeVisible();
    await expect(card(page).locator('li[data-step]')).toHaveCount(4);
    await expect(list.locator('[data-result="done"]')).toBeVisible({ timeout: 20_000 });
    await expect(list.locator('[data-reconnecting]')).toHaveCount(0);
  });

  test('a Portainer stack: an old updater job is not shown as the last update; labels say what runs and which channel the target is', async ({ page, api }) => {
    api.updater = { ...updaterState(true), stack: 'foreign', portainer: true };
    api.updater.job = { id: '0123456789abcdef', action: 'update', state: 'succeeded', step: null, from: 'sha-a1b2c3d', to: 'latest', startedAt: '2026-10-21T04:03:00.000Z',
      finishedAt: '2026-10-21T04:04:00.000Z', error: null, steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } };
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-foreign="portainer"]')).toBeVisible();
    await expect(card(page).locator('ol.steps')).toHaveCount(0);
    await expect(card(page).locator('[data-result]')).toHaveCount(0);
    // installed: the build the backend runs (not the updater's record "latest"); no previous build (no rollback on Portainer)
    await expect(card(page).locator('[data-installed]')).toHaveText(/1\.0\.0\s+sha-c0be6c5/);
    await expect(card(page).getByText('Vorherige Version:')).toHaveCount(0);
    await expect(card(page).locator('[data-target]')).toHaveText(/Stabil\s+latest/);
  });

  test('an update whose media server phase failed: a warn bar and note (not red), "Erneut versuchen" links to the media tab', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.mediaserver = { container: { state: 'running' }, desired: { run: true } };
    const media = { check: 'ok', pull: 'failed', verify: 'skipped', snapshot: 'skipped', create: 'skipped', start: 'skipped', health: 'skipped', rollback: 'skipped' };
    api.updater.job = { id: 'fedcba9876543211', action: 'update', state: 'succeeded_mediaserver_failed', step: null, from: 'sha-a1b2c3d', to: 'latest', startedAt: '2026-11-01T10:00:00.000Z',
      finishedAt: '2026-11-01T10:02:00.000Z', error: 'pull_failed', steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' }, media: { step: null, steps: media } };
    await page.goto('/admin/update');
    const flow = card(page).locator('[data-flow="warn"]');
    await expect(flow).toBeVisible();
    await expect(flow.locator('.bar')).toHaveClass(/bar-warn/);
    await expect(state(flow, 'health')).toHaveAttribute('data-state', 'ok');
    await expect(state(flow, 'media-pull')).toHaveAttribute('data-state', 'failed');
    const note = flow.locator('[data-result="succeeded_mediaserver_failed"]');
    await expect(note).toHaveClass(/n-warn/);
    await expect(note).toContainText('FriendFlix aktualisiert, Medienserver nicht. Das Image ließ sich nicht laden. Prüfe die Internetverbindung des Servers.');
    await expect(note).not.toContainText('pull_failed');
    // found on load: a status, not an alert
    await expect(note.locator('[data-headline]')).toHaveAttribute('role', 'status');
    // try again is the media tab's (a link), not the update's confirmation
    await expect(note.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
    await expect(note.getByRole('link', { name: 'Erneut versuchen' })).toHaveAttribute('href', '/admin/settings?tab=media');
  });

  test('a Live TV job is not an update: the card shows no "Update auf … abgeschlossen" for it', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.job = { id: 'fedcba9876543210', action: 'livetv-enable', state: 'succeeded', step: null, from: null, to: 'sha-c0be6c5', startedAt: '2026-11-01T10:00:00.000Z',
      finishedAt: '2026-11-01T10:01:00.000Z', error: null, steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } };
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-updater]')).toBeVisible();
    await expect(card(page).locator('[data-result]')).toHaveCount(0);
    await expect(card(page)).not.toContainText('abgeschlossen');
  });

  test('a Live TV job still running: the update button waits and the card says why (no list of another page\'s job)', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.job = { id: 'fedcba9876543210', action: 'livetv-enable', state: 'running', step: 'pull', from: null, to: 'sha-c0be6c5', startedAt: new Date().toISOString(),
      finishedAt: null, error: null, steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' } };
    api.updater.downPolls = 0;
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-busy]')).toContainText('Es läuft bereits ein Auftrag.');
    await expect(card(page).getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
    await expect(card(page).locator('ol.steps')).toHaveCount(0);
  });

  test('"reload anyway" of the same build: the POST says force, the redeploy ends done (not unchanged or a timeout)', async ({ page, api }) => {
    api.updater = { ...updaterState(false), downPolls: 1 };
    await page.route('**/api/admin/update', (r) => (r.request().method() !== 'GET' ? r.fallback() : r.fulfill({ json: {
      current: { sha: 'c0be6c5deadbeef', builtAt: new Date().toISOString(), version: '1.0.0', codename: 'Arancini' }, release: null, updateAvailable: false,
      latest: { sha: 'c0be6c5deadbeef', date: new Date().toISOString(), runUrl: 'https://example.org/run' }, behind: 0, portainer: { configured: true, mode: 'webhook' }, autoUpdateNote: true, commits: [],
    } })));
    await page.goto('/admin/update');
    const go = apply(page).getByRole('button', { name: 'Jetzt aktualisieren' });
    await expect(go).toBeDisabled(); // up to date
    await apply(page).getByText('trotzdem neu laden').click();
    await go.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await expect.poll(() => api.log.find((l) => l.startsWith('POST /api/admin/update'))).toContain('"force":true');
    await expect(apply(page).locator('[data-result="done"]')).toBeVisible({ timeout: 20_000 });
  });

  test('nothing newer: a neutral note (status, no retry, nothing failed), the rows say Portainer pulled and recreated nothing', async ({ page, api }) => {
    api.updater = { ...updaterState(false), redeployOutcome: 'unchanged' };
    await page.goto('/admin/update');
    await apply(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const note = apply(page).locator('[data-result="unchanged"]');
    await expect(note).toContainText('Portainer ist fertig, hat aber nichts neu erstellt.', { timeout: 15_000 });
    await expect(note.locator('[data-headline]')).toHaveAttribute('role', 'status');
    await expect(note.getByRole('button', { name: 'Erneut versuchen' })).toHaveCount(0);
    const list = apply(page).locator('[data-redeploy]');
    for (const st of ['request', 'pulling']) await expect(state(list, st)).toHaveAttribute('data-state', 'ok');
    for (const st of ['recreating', 'health']) await expect(state(list, st)).toHaveAttribute('data-state', 'skipped');
    await expect(list.locator('[data-state="failed"]')).toHaveCount(0);
  });

  test('the start refused by Portainer (502): a toast, and the recorded refusal on the request row', async ({ page, api }) => {
    api.updater = updaterState(false);
    await page.route('**/api/admin/update', (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      // what the backend does: it records the refusal, then answers 502
      api.updater!.redeploy = { id: 'abcdef0123456789', mode: 'api', tag: 'latest', phase: 'failed', running: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        services: null, error: 'portainer', status: 401, step: 'stack', code: null, at: null };
      return r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"portainer","status":401,"step":"stack"}' });
    });
    await page.goto('/admin/update');
    await apply(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText(/Portainer-Fehler \(HTTP 401\)/)).toBeVisible();
    const list = apply(page).locator('[data-redeploy="failed"]');
    await expect(state(list, 'request')).toHaveAttribute('data-state', 'failed');
    await expect(list.locator('[data-result="failed"]')).toContainText('abgelehnt (HTTP 401, Schritt Stack-Abfrage)');
  });

  test('nothing jumps when the failure lands: the card below keeps its place', async ({ page, api }) => {
    api.updater = { ...updaterState(false), redeployOutcome: 'failed' };
    await page.goto('/admin/update');
    await apply(page).getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    const below = page.getByRole('region', { name: 'Änderungen' });
    await expect(apply(page).locator('li[aria-current="step"]')).toHaveCount(1);
    const y0 = (await below.boundingBox())!.y;
    await expect(apply(page).locator('[data-result="failed"]')).toBeVisible({ timeout: 15_000 });
    expect((await below.boundingBox())!.y).toBe(y0);
  });
});
