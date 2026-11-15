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
    await expect(list.locator('[data-result="done"]')).toHaveAttribute('role', 'status');
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
    await expect(note).toHaveAttribute('role', 'alert');
    await expect(note).toContainText('(HTTP 401, Schritt Stack-Abfrage)');
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

  test('a Live TV job is not an update: the card shows no "Update auf … abgeschlossen" for it', async ({ page, api }) => {
    api.updater = updaterState(true);
    api.updater.job = { id: 'fedcba9876543210', action: 'livetv-enable', state: 'succeeded', step: null, from: null, to: 'sha-c0be6c5', startedAt: '2026-11-01T10:00:00.000Z',
      finishedAt: '2026-11-01T10:01:00.000Z', error: null, steps: { pull: 'ok', verify: 'ok', restart: 'ok', health: 'ok', rollback: 'skipped' } };
    await page.goto('/admin/update');
    await expect(card(page).locator('[data-updater]')).toBeVisible();
    await expect(card(page).locator('[data-result]')).toHaveCount(0);
    await expect(card(page)).not.toContainText('abgeschlossen');
  });
});
