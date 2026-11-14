// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { syscheckOk, syscheckTroubled, syscheckWith } from '../mocks/syscheck.js';

/** the catalogue in display order (backend/src/syscheck/types.ts CHECK_IDS) */
const CATALOGUE = [
  'core.publicUrl', 'core.database', 'core.redis', 'core.gateway', 'core.disk.downloads', 'core.disk.previews', 'core.disk.database', 'core.env',
  'signin.oidc', 'signin.authentik', 'signin.flows', 'signin.issuerHost', 'signin.passkeys', 'signin.mail',
  'media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder',
  'livetv.container', 'livetv.encoder', 'livetv.sources', 'livetv.guides',
  'updates.updater', 'updates.path', 'updates.portainer',
  'proxy.forwardedProto', 'proxy.peer', 'proxy.websocket', 'proxy.buffering', 'proxy.upload', 'proxy.headers',
];

test.describe('Systemcheck on Admin → Status', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.syscheck.result = syscheckTroubled();
  });

  test('shows six groups and every catalogue line in order', async ({ page }) => {
    await page.goto('/admin/status');
    const sc = page.locator('#systemcheck');
    await expect(sc.getByRole('heading', { level: 2, name: 'Systemcheck' })).toBeVisible();
    await expect(sc.getByRole('group')).toHaveCount(6);
    await expect(sc.getByRole('group').locator('h3')).toHaveText(['Grundlagen', 'Anmeldung', 'Medien', 'Live-TV', 'Updates', 'Reverse Proxy']);
    await expect(sc.locator('li[data-id][data-status="problem"]')).toHaveCount(2);
    expect(await sc.locator('li[data-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(CATALOGUE);
    // lines the server does not answer yet are "Nicht geprüft", never empty or raw
    await expect(sc.locator('li[data-id="updates.path"]')).toContainText('Nicht geprüft');
    await expect(sc).not.toContainText(/core\.|signin\.|\{|undefined/);
    // the counts: problems first, every pill with icon + word
    await expect(sc.locator('.counts')).toContainText('2 Probleme');
    await expect(sc.locator('.counts')).toContainText('1 Warnung');
    // the pills count what the list shows, the lines without a result included
    await expect(sc.locator('.counts')).toContainText('13 nicht geprüft');
    for (const pill of await sc.locator('.pill').all()) await expect(pill.locator('svg')).toHaveCount(1);
  });

  test('a problem line shows cause, fix and Zur Einstellung linking to the setting', async ({ page }) => {
    await page.goto('/admin/status');
    const line = page.locator('#systemcheck li[data-id="signin.authentik"]');
    await expect(line.locator('.pill.err')).toHaveText('Problem');
    await expect(line).toContainText('Authentik-API');
    await expect(line).toContainText('Authentik lehnt das Dienst-Token ab.');
    await expect(line).toContainText('Ein neues Dienst-Token eintragen');
    await expect(line.getByRole('link', { name: 'Zur Einstellung' })).toHaveAttribute('href', '/admin/settings?setting=AUTHENTIK_API_TOKEN');
    // an ok line is one compact row without actions
    const ok = page.locator('#systemcheck li[data-id="core.database"]');
    await expect(ok.locator('.pill.ok')).toHaveText('In Ordnung');
    await expect(ok.getByRole('link')).toHaveCount(0);
  });

  test('a setting from the environment says so; docs open the guide in a new tab', async ({ page, api }) => {
    api.syscheck.result = syscheckWith([
      { id: 'core.publicUrl', status: 'warning', cause: 'public_url_http', fix: 'public_url_http', settingKey: 'PUBLIC_URL', settingGroup: 'general', locked: true },
      { id: 'core.env', status: 'warning', cause: 'removed_env', fix: 'removed_env', params: { n: 2 }, docs: 'operations.md' },
    ]);
    await page.goto('/admin/status');
    const pub = page.locator('#systemcheck li[data-id="core.publicUrl"]');
    await expect(pub).toContainText('PUBLIC_URL steht in der .env');
    await expect(pub.getByRole('link', { name: 'Zur Einstellung' })).toHaveAttribute('href', '/admin/settings?setting=PUBLIC_URL');
    const docs = page.locator('#systemcheck li[data-id="core.env"]').getByRole('link', { name: /Anleitung/ });
    await expect(docs).toHaveAttribute('href', 'https://github.com/LetsManu/friendflix/blob/main/docs/operations.md');
    await expect(docs).toHaveAttribute('target', '_blank');
    await expect(docs).toHaveAttribute('rel', /noopener/);
  });

  test('a not_set_up line is neutral and has no red pill', async ({ page }) => {
    await page.goto('/admin/status');
    const line = page.locator('#systemcheck li[data-id="media.requests"]');
    await expect(line.locator('.pill.muted')).toHaveText('Nicht eingerichtet');
    await expect(line.locator('.pill.err, .pill.warn')).toHaveCount(0);
    await expect(line).toContainText('Kein Wunsch-Dienst eingerichtet.');
    await expect(line.getByRole('link', { name: 'Zur Einstellung' })).toHaveAttribute('href', '/admin/settings?setting=REQUESTS_URL');
  });

  test('Jetzt prüfen sends refresh=1, shows the new state and time, and reloads the banner', async ({ page, api }) => {
    api.syscheck.result = syscheckTroubled('2026-11-14T08:05:00.000Z');
    await page.goto('/admin/status');
    const sc = page.locator('#systemcheck');
    await expect(sc.locator('li[data-id="media.server"] .pill.err')).toBeVisible();
    const before = await sc.locator('.at').innerText();
    api.syscheck.refreshed = syscheckOk('2026-11-14T09:47:00.000Z');
    const bannerCalls = api.admin.bannerCalls;
    await sc.getByRole('button', { name: 'Jetzt prüfen' }).click();
    await expect(sc.locator('li[data-id="media.server"] .pill.ok')).toBeVisible();
    await expect(sc.locator('.at')).not.toHaveText(before);
    await expect(sc.locator('.counts')).toContainText('0 Probleme');
    await expect(sc.locator('.counts .pill.err')).toHaveCount(0);
    expect(api.syscheck.calls.filter((q) => q === '?refresh=1')).toHaveLength(1);
    await expect.poll(() => api.admin.bannerCalls).toBeGreaterThan(bannerCalls);
  });

  test.describe('rate limit', () => {
    test.use({ allowedConsole: /status of 429/ });
    test('429 keeps the list and shows the toast', async ({ page, api }) => {
      await page.goto('/admin/status');
      const sc = page.locator('#systemcheck');
      await expect(sc.locator('li[data-id="signin.authentik"] .pill.err')).toBeVisible();
      api.syscheck.refreshStatus = 429;
      await sc.getByRole('button', { name: 'Jetzt prüfen' }).click();
      await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Zu oft geprüft: bitte in einer Minute noch einmal.')).toBeVisible();
      await expect(sc.locator('li[data-id="signin.authentik"] .pill.err')).toBeVisible();
      await expect(sc.locator('li[data-id]')).toHaveCount(CATALOGUE.length);
    });
  });

  test('skeleton and loaded list have the same height', async ({ page, api }) => {
    api.syscheck.result = syscheckOk();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/systemcheck', async (r) => { await gate; await r.fallback(); });
    await page.goto('/admin/status');
    const sc = page.locator('#systemcheck');
    await expect(sc.locator('li[data-id] .skeleton').first()).toBeVisible();
    await expect(sc.locator('li[data-id]')).toHaveCount(CATALOGUE.length);
    const before = (await sc.boundingBox())!;
    release();
    await expect(sc.locator('li[data-id="core.database"] .pill.ok')).toBeVisible();
    await expect(sc.locator('li[data-id] .skeleton')).toHaveCount(0);
    const after = (await sc.boundingBox())!;
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  });

  test('Details of a sign-in line scrolls to the sign-in card (#login)', async ({ page }) => {
    await page.goto('/admin/status');
    const details = page.locator('#systemcheck li[data-id="signin.flows"]').getByRole('link', { name: 'Details' });
    await expect(details).toHaveAttribute('href', '/admin/status#login');
    await expect(page.locator('#systemcheck li[data-id="signin.flows"]')).toContainText('Der Ablauf „Passwort vergessen“ fehlt bei Authentik.');
    await expect(page.locator('#systemcheck li[data-id="signin.flows"]')).toContainText('Dazu 1 weiterer Hinweis auf der Anmelde-Karte.');
    await details.click();
    await expect(page).toHaveURL(/\/admin\/status#login$/);
    await expect(page.getByRole('region', { name: 'Anmeldung', exact: true })).toBeInViewport();
  });

  test.describe('load failure', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('a failing first load says so, keeps the rows and retries', async ({ page, api }) => {
      api.syscheck.status = 500;
      await page.goto('/admin/status');
      const sc = page.locator('#systemcheck');
      const alert = sc.getByRole('alert');
      await expect(alert).toContainText('Der Systemcheck konnte nicht geladen werden.');
      await expect(sc.locator('li[data-id]')).toHaveCount(CATALOGUE.length);
      api.syscheck.status = null;
      await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
      await expect(sc.locator('li[data-id="signin.authentik"] .pill.err')).toBeVisible();
      await expect(alert).toBeHidden();
    });
  });

  test('page HTML never shows a secret-looking value or an internal host', async ({ page }) => {
    await page.goto('/admin/status');
    await expect(page.locator('#systemcheck li[data-id="media.server"] .pill.err')).toBeVisible();
    const html = await page.locator('#systemcheck').innerHTML();
    expect(html).not.toMatch(/http:\/\/|jellyfin:8096|sekret/);
  });
});

test.describe('Systemcheck summary on the admin overview', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('overview shows "2 Probleme" first in the strip and links to /admin/status#systemcheck', async ({ page, api }) => {
    api.syscheck.result = syscheckTroubled();
    await page.goto('/admin');
    const strip = page.getByRole('region', { name: 'Systemzustand' });
    const item = strip.getByRole('link', { name: /Systemcheck/ });
    await expect(item).toContainText('2 Probleme');
    await expect(item.locator('.pill.err svg')).toHaveCount(1);
    await expect(item).toHaveAttribute('href', '/admin/status#systemcheck');
    await expect(strip.getByRole('listitem').first()).toContainText('Systemcheck');
    // never a fresh run from the overview: the cached answer only
    expect(api.syscheck.calls).toEqual(['']);
    await item.click();
    await expect(page).toHaveURL(/\/admin\/status#systemcheck$/);
    await expect(page.locator('#systemcheck')).toBeInViewport();
  });

  test('warnings only → "1 Warnung"; only not_set_up lines → "Alles in Ordnung"', async ({ page, api }) => {
    api.syscheck.result = syscheckWith([{ id: 'media.requests', status: 'warning', cause: 'requests_down', fix: 'requests_down', settingKey: 'REQUESTS_URL' }]);
    await page.goto('/admin');
    const item = page.getByRole('region', { name: 'Systemzustand' }).getByRole('link', { name: /Systemcheck/ });
    await expect(item.locator('.pill.warn')).toHaveText('1 Warnung');
    api.syscheck.result = syscheckWith([
      { id: 'media.requests', status: 'not_set_up', cause: 'requests_not_set', fix: 'requests_not_set', settingKey: 'REQUESTS_URL' },
      { id: 'media.tmdb', status: 'not_set_up', cause: 'source_not_set', fix: 'source_not_set', settingKey: 'TMDB_API_KEY' },
      { id: 'signin.passkeys', status: 'not_set_up', cause: 'passkeys_off', fix: 'passkeys_off', settingKey: 'PASSKEYS_IN_APP' },
    ]);
    await page.reload();
    await expect(item.locator('.pill.ok')).toHaveText('Alles in Ordnung');
  });

  test.describe('failing', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('systemcheck 500 → muted "unbekannt", the other strip items still render', async ({ page, api }) => {
      api.syscheck.status = 500;
      await page.goto('/admin');
      const strip = page.getByRole('region', { name: 'Systemzustand' });
      const item = strip.getByRole('link', { name: /Systemcheck/ });
      await expect(item.locator('.pill.muted')).toHaveText('Unbekannt');
      await expect(strip.getByRole('link', { name: /Medienserver/ })).toBeVisible();
      await expect(strip.getByRole('link', { name: /Version/ })).toBeVisible();
    });
  });
});
