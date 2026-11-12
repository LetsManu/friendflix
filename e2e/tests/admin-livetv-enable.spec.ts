// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV (/admin/livetv), Task 11: the optional entry before installation, the enable flow through the updater, the manual
// ways (.env line, Portainer), hiding the offer, "turned on but not running", honest refusals and the off dialog.
const card = (page: Page) => page.getByRole('region', { name: 'Live-TV (optional)' });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Admin-Bereiche' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });

test.describe('admin: Live-TV, enabling and disabling (desktop)', () => {
  // refusals are mocked failures: the browser logs the 4xx answers
  test.use({ allowedConsole: /Failed to load resource: the server responded with a status of (400|409|429)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('enable via the updater shows the job steps, then the area, without a reload', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    // the entry carries the "optional" chip while Live TV is not installed
    await expect(nav(page).getByRole('link', { name: /Live-TV/ })).toContainText('optional');
    const c = card(page);
    await expect(c).toContainText('Fernsehsender aus deiner Anbieterliste oder eigene Streams direkt in FriendFlix.');
    await expect(c).toContainText('Braucht einen zusätzlichen Container (ca. 250 MB). Es wird nichts geladen, bis du es einschaltest.');
    await expect(c.getByText('COMPOSE_PROFILES=livetv in die .env ein', { exact: false })).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __kept: number }).__kept = 1; });
    await c.getByRole('button', { name: 'Live-TV aktivieren' }).click();
    // the job's steps (the update card's component), then the installed view
    await expect(c.locator('ol.steps li')).toHaveCount(4, { timeout: 15_000 });
    await expect(c.locator('li[data-step="pull"]')).toBeVisible();
    await expect(page.getByText('Live-TV läuft.')).toBeVisible({ timeout: 20_000 });
    await expect(c).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
    expect(api.admin.livetv.posts).toEqual([{ path: 'enable', body: {} }]);
    // installed: no chip any more, the entry stays
    await expect(nav(page).getByRole('link', { name: /Live-TV/ })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Live-TV/ })).not.toContainText('optional');
  });

  test('a refused enable says so and never shows "eingeschaltet"', async ({ page, api }) => {
    api.admin.livetv.refuse = { status: 409, error: 'busy' };
    await page.goto('/admin/livetv?tab=status');
    await card(page).getByRole('button', { name: 'Live-TV aktivieren' }).click();
    await expect(card(page).getByRole('alert')).toContainText('Der Updater ist gerade beschäftigt.');
    await expect(card(page)).toContainText('Es wurde nichts eingeschaltet.');
    await expect(page.getByText('Live-TV ist eingeschaltet')).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Wieder starten' })).toHaveCount(0);
    expect(api.admin.livetv.wanted).toBe(false);
  });

  test('a failed first enable that was cleaned up says so with the reason', async ({ page, api }) => {
    api.admin.livetv.outcome = 'rolled_back';
    api.admin.livetv.failCode = 'unhealthy';
    await page.goto('/admin/livetv?tab=status');
    await card(page).getByRole('button', { name: 'Live-TV aktivieren' }).click();
    const res = card(page).locator('[data-result]');
    await expect(res).toContainText('Live-TV ließ sich nicht starten und wurde wieder entfernt.', { timeout: 20_000 });
    await expect(res).toContainText('Der Container startete, wurde aber nicht gesund.');
    // the offer is back, not "turned on but not running"
    await expect(card(page).getByRole('button', { name: 'Live-TV aktivieren' })).toBeEnabled();
    await expect(page.getByText('Der Dienst läuft aber nicht')).toHaveCount(0);
  });

  test('no updater shows the .env line and copies it', async ({ page, api, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    api.admin.livetv.updater = false;
    await page.goto('/admin/livetv?tab=status');
    const c = card(page);
    await expect(c.getByRole('button', { name: 'Live-TV aktivieren' })).toHaveCount(0);
    await expect(c.getByText('Von Hand einschalten')).toBeVisible();
    await expect(c.getByLabel('Füge diese Zeile in die .env deines Stacks ein und starte neu:')).toHaveValue('COMPOSE_PROFILES=livetv');
    await expect(c.getByText('Steht dort schon COMPOSE_PROFILES, hänge ,livetv an.')).toBeVisible();
    await expect(c.getByText('docker compose up -d')).toBeVisible();
    await c.getByRole('button', { name: 'Kopieren' }).click();
    await expect(toasts(page).getByText(/kopiert/i)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('COMPOSE_PROFILES=livetv');
  });

  test('a foreign stack shows the Portainer line', async ({ page, api }) => {
    api.admin.livetv.stack = 'foreign';
    await page.goto('/admin/livetv?tab=status');
    const c = card(page);
    await expect(c.getByText('In Portainer: Umgebungsvariable COMPOSE_PROFILES=livetv im Stack setzen und neu bereitstellen.')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Live-TV aktivieren' })).toHaveCount(0);
  });

  test('Nicht mehr anzeigen hides the entry; the settings switch brings it back', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=status');
    await expect(nav(page).getByRole('link', { name: /Live-TV/ })).toBeVisible();
    await card(page).getByRole('button', { name: 'Nicht mehr anzeigen' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    expect(api.settings.puts).toEqual([{ values: { LIVETV_OFFER_HIDDEN: true } }]);
    await expect(nav(page).getByRole('link', { name: 'Datenquellen' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Live-TV/ })).toHaveCount(0);
    // Einstellungen: the switch is on; switching it off shows the entry again
    await page.goto('/admin/settings');
    const row = page.getByRole('group', { name: 'Optionalen Live-TV-Eintrag ausblenden', exact: true });
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await row.getByRole('switch').click();
    await page.locator('section', { has: row }).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Live-TV/ })).toBeVisible();
    expect(api.settings.puts.at(-1)).toEqual({ values: { LIVETV_OFFER_HIDDEN: false } });
  });

  test('wanted but down shows Wieder starten, which enables again', async ({ page, api }) => {
    api.admin.livetv.wanted = true;
    await page.goto('/admin/livetv?tab=status');
    const c = card(page);
    await expect(c.getByText('Live-TV ist eingeschaltet, der Dienst läuft aber nicht.')).toBeVisible();
    await c.getByRole('button', { name: 'Wieder starten' }).click();
    await expect(page.getByText('Live-TV läuft.')).toBeVisible({ timeout: 20_000 });
    expect(api.admin.livetv.posts.map((p) => p.path)).toEqual(['enable']);
  });

  test('right after the job ended the page says it is checking, then shows the area', async ({ page, api }) => {
    test.setTimeout(60_000);
    api.admin.livetv.detectLag = 2;
    await page.goto('/admin/livetv?tab=status');
    await card(page).getByRole('button', { name: 'Live-TV aktivieren' }).click();
    await expect(card(page).getByText('Live-TV wird geprüft …')).toBeVisible({ timeout: 20_000 });
    // never "turned on but not running" in the gap
    await expect(page.getByText('Der Dienst läuft aber nicht')).toHaveCount(0);
    await expect(page.getByText('Live-TV läuft.')).toBeVisible({ timeout: 25_000 });
  });

  test('an app update running is named next to the disabled enable button; hiding stays possible', async ({ page, api }) => {
    api.admin.livetv.job = { id: 'a1', action: 'update', state: 'running', step: 'pull', from: null, to: 'sha-abc1234', startedAt: new Date().toISOString(), finishedAt: null, error: null, steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' } };
    await page.goto('/admin/livetv?tab=status');
    await expect(card(page).getByText('Ein Update läuft gerade. Danach geht es wieder.')).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Live-TV aktivieren' })).toBeDisabled();
    await expect(card(page).getByRole('button', { name: 'Nicht mehr anzeigen' })).toBeEnabled();
  });

  test('stop_failed and a job that an update dropped are said honestly', async ({ page, api }) => {
    api.admin.livetv.ltState = 'stop_failed';
    api.admin.livetv.ltError = 'unhealthy';
    await page.goto('/admin/livetv?tab=status');
    await expect(card(page)).toContainText('der Container ließ sich aber nicht stoppen. Der nächste Auftrag versucht es noch einmal.');
    await expect(card(page)).toContainText('Der Container startete, wurde aber nicht gesund.');
  });

  test.describe('installed', () => {
    test.beforeEach(({ api }) => {
      const lt = api.admin.livetv;
      lt.installed = true; lt.wanted = true; lt.ltState = 'enabled';
    });

    test('shows the version, no GPU line without advice, and the honest benchmark outcome', async ({ page, api }) => {
      api.admin.livetv.benchmark = 'busy';
      await page.goto('/admin/livetv?tab=status');
      await expect(page.getByText('Live-TV läuft.')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Live-TV', exact: true }).getByText('1.0.0')).toBeVisible();
      await expect(page.getByText('Umwandlungen laufen auf dem Prozessor.')).toHaveCount(0);
      await expect(page.getByText('Die Messung wurde nicht gestartet, weil gerade jemand schaut.')).toBeVisible();
      await expect(page.getByText('Neu messen', { exact: false })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Zu den Umwandlungen' })).toHaveAttribute('href', '/admin/playback');
    });

    test('stop_failed and an update that turned it off are said while it still runs', async ({ page, api }) => {
      api.admin.livetv.ltState = 'stop_failed';
      api.admin.livetv.ltError = 'unhealthy';
      await page.goto('/admin/livetv?tab=status');
      await expect(page.getByText('Live-TV läuft.')).toBeVisible();
      await expect(page.getByText('der Container ließ sich aber nicht stoppen. Der nächste Auftrag versucht es noch einmal.')).toBeVisible();
      await expect(page.getByText('Ein Update hat Live-TV ausgeschaltet. Der Container startete, wurde aber nicht gesund.')).toBeVisible();
    });

    test('an app update running names itself next to the disabled off button', async ({ page, api }) => {
      api.admin.livetv.job = { id: 'a1', action: 'update', state: 'running', step: 'pull', from: null, to: 'sha-abc1234', startedAt: new Date().toISOString(), finishedAt: null, error: null, steps: { pull: 'running', verify: 'pending', restart: 'pending', health: 'pending', rollback: 'skipped' } };
      await page.goto('/admin/livetv?tab=status');
      await expect(page.getByRole('button', { name: 'Live-TV ausschalten …' })).toBeDisabled();
      await expect(page.getByText('Ein Update läuft gerade. Danach geht es wieder.')).toBeVisible();
    });

    test('a foreign stack gets the Portainer wording in the manual off dialog', async ({ page, api }) => {
      api.admin.livetv.stack = 'foreign';
      await page.goto('/admin/livetv?tab=status');
      await page.getByRole('button', { name: 'Live-TV ausschalten …' }).click();
      const dlg = page.getByRole('dialog', { name: 'Live-TV ausschalten?' });
      await expect(dlg).toContainText('im Stack deiner Verwaltung (z. B. Portainer)');
      await expect(dlg.getByLabel('Befehl')).toHaveValue('docker compose stop livetv && docker compose rm -f livetv');
    });

    test('a started benchmark is said as started', async ({ page, api }) => {
      api.admin.livetv.benchmark = 'started';
      await page.goto('/admin/livetv?tab=status');
      await expect(page.getByText('Die Messung der Umwandlungen wurde gestartet.', { exact: false })).toBeVisible();
    });

    test('GPU advice: the five lines, only when the backend has advice', async ({ page, api }) => {
      api.admin.livetv.advice = { level: 'warn', key: 'needsRenderGid' };
      await page.goto('/admin/livetv?tab=status');
      await expect(page.getByText('Live-TV sieht die Grafikeinheit, darf sie aber nicht benutzen: RENDER_GID in der .env setzen.')).toBeVisible();
      api.admin.livetv.advice = { level: 'ok', key: 'both', driver: 'iHD' };
      await page.reload();
      await expect(page.getByText('Grafikeinheit: iHD · auch für Live-TV aktiv.')).toBeVisible();
      api.admin.livetv.advice = { level: 'info', key: 'cpuOnly' };
      await page.reload();
      await expect(page.getByText('Umwandlungen laufen auf dem Prozessor.')).toBeVisible();
    });

    test('disable dialog sends removeImage and removeCache; the cache box is disabled until the image box is checked', async ({ page, api }) => {
      await page.goto('/admin/livetv?tab=status');
      await page.getByRole('button', { name: 'Live-TV ausschalten …' }).click();
      const dlg = page.getByRole('dialog', { name: 'Live-TV ausschalten?' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByText('Aufnahmen bleiben erhalten.')).toBeVisible();
      const image = dlg.getByRole('checkbox', { name: 'Image entfernen' });
      const cache = dlg.getByRole('checkbox', { name: 'Zwischenspeicher löschen' });
      await expect(cache).toBeDisabled();
      await image.check();
      await expect(cache).toBeEnabled();
      await cache.check();
      // unchecking the image takes the cache choice back with it
      await image.uncheck();
      await expect(cache).toBeDisabled();
      await expect(cache).not.toBeChecked();
      await image.check();
      await cache.check();
      await dlg.getByRole('button', { name: 'Ausschalten' }).click();
      await expect(dlg).toHaveCount(0);
      expect(api.admin.livetv.posts).toEqual([{ path: 'disable', body: { removeImage: true, removeCache: true } }]);
      // the steps of the job, then the offer is back
      await expect(page.getByRole('region', { name: 'Live-TV (optional)' })).toBeVisible({ timeout: 20_000 });
      expect(api.admin.livetv.wanted).toBe(false);
    });

    test('Escape closes the dialog without sending anything', async ({ page, api }) => {
      await page.goto('/admin/livetv?tab=status');
      await page.getByRole('button', { name: 'Live-TV ausschalten …' }).click();
      await expect(page.getByRole('dialog', { name: 'Live-TV ausschalten?' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(api.admin.livetv.posts).toEqual([]);
    });

    test('without an updater the dialog shows the manual command instead of the checkboxes', async ({ page, api }) => {
      api.admin.livetv.updater = false;
      await page.goto('/admin/livetv?tab=status');
      await page.getByRole('button', { name: 'Live-TV ausschalten …' }).click();
      const dlg = page.getByRole('dialog', { name: 'Live-TV ausschalten?' });
      await expect(dlg.getByLabel('Befehl')).toHaveValue('docker compose stop livetv && docker compose rm -f livetv');
      await expect(dlg.getByRole('checkbox')).toHaveCount(0);
      expect(api.admin.livetv.posts).toEqual([]);
    });
  });
});
