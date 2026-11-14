// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Einstellungen (/admin/livetv?tab=settings) and the pointer on Admin → Einstellungen: the four LIVETV_* settings
// are edited through the settings API of the settings page, the SRT ports are read-only, and the settings page lists no livetv group.
const setting = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };

test.describe('admin: Live-TV, Einstellungen (desktop)', () => {
  test.use({ allowedConsole: /status of 400/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('the tab follows Live-Status and shows the four settings and the ports read-only', async ({ page }) => {
    await page.goto('/admin/livetv?tab=settings');
    const tabs = page.getByRole('tablist', { name: 'Live-TV-Bereiche' }).getByRole('tab');
    await expect(tabs).toHaveText(['Quellen', 'Kanäle', 'Gruppen & Rechte', 'Programmführer', 'Live-Status', 'Einstellungen']);
    await expect(page.getByRole('tab', { name: 'Einstellungen' })).toHaveAttribute('aria-selected', 'true');
    for (const n of ['Encoder für Live-TV', 'Adresse für gesendete Streams', 'Rückspulpuffer für Live-TV (Minuten)']) await expect(setting(page, n)).toBeVisible();
    await expect(page.getByRole('group', { name: /Bitrate/ })).toBeVisible();
    await expect(page.locator('[data-srt-ports]')).toHaveText('UDP 9000–9009');
    await expect(page.getByText('Ports und Freigabe stehen in der Compose-Datei (LIVETV_SRT_PORTS, LIVETV_SRT_BIND); in Portainer als Umgebungsvariablen des Stacks.')).toBeVisible();
    await expect(page.locator('[data-srt-ports]').locator('xpath=ancestor::section').getByRole('textbox')).toHaveCount(0);
  });

  test('saving LIVETV_DVR_MINUTES sends the same PUT as the settings page', async ({ page, api }) => {
    await page.goto('/admin/livetv?tab=settings');
    const dvr = setting(page, 'Rückspulpuffer für Live-TV (Minuten)');
    await dvr.getByRole('spinbutton').fill('45');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Gespeichert')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { LIVETV_DVR_MINUTES: 45 } }]);
    await expect(dvr.getByRole('spinbutton')).toHaveValue('45');
  });

  test('an invalid SRT host shows the invalid_host copy', async ({ page, api }) => {
    api.settings.saveErrors = { LIVETV_SRT_HOST: 'invalid_host' };
    await page.goto('/admin/livetv?tab=settings');
    const host = setting(page, 'Adresse für gesendete Streams');
    await host.getByRole('textbox').fill('https://x.example.com:9000');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(host.getByText('Nur ein Hostname oder eine IP-Adresse, ohne Schema und Port.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { LIVETV_SRT_HOST: 'https://x.example.com:9000' } }]);
  });

  test('Admin → Einstellungen lists no Live-TV group, only the link, while Live TV is installed', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByRole('group', { name: 'Öffentliche Adresse' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Live-TV', exact: true })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Encoder für Live-TV' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Live-TV-Einstellungen findest du jetzt unter Live-TV.' })).toHaveAttribute('href', '/admin/livetv?tab=settings');
  });

  test('without Live TV the settings page shows no link', async ({ page, api }) => {
    api.admin.livetv.installed = false;
    await page.goto('/admin/settings');
    await expect(page.getByRole('group', { name: 'Öffentliche Adresse' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Live-TV-Einstellungen/ })).toHaveCount(0);
  });
});
