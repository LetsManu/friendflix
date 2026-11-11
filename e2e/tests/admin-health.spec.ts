// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { healthOk, loginCheckOk } from '../mocks/admin.js';
import { done, installLogin, loginState, password } from '../mocks/login.js';

const GiB = 1024 ** 3;
const ID = 'ab'.repeat(16);

/** a snapshot with problems: media down, TMDB key invalid, OMDb not set up, downloads 93 % (shares one volume with the previews) */
function troubled(): Record<string, any> {
  const h = healthOk();
  h.services = h.services.map((s: any) => (s.id === 'media' ? { id: 'media', level: 'err', reason: 'down', ms: 3000 }
    : s.id === 'tmdb' ? { id: 'tmdb', level: 'warn', reason: 'invalid_key' }
      : s.id === 'omdb' ? { id: 'omdb', level: 'off', reason: 'not_set' } : s));
  h.disks = [
    { id: 'downloads', level: 'warn', reason: 'full', totalBytes: 1000 * GiB, freeBytes: 70 * GiB, usedPct: 93, ownBytes: 20 * GiB, capBytes: 50 * GiB, sharedWith: 'previews', sharedBytes: 2 * GiB },
    { id: 'database', level: 'ok', ownBytes: 512 * 1024 ** 2 },
  ];
  h.worst = 'err';
  return h;
}

test.describe('admin health page', () => {
  test.use({ allowedConsole: /status of 500/ });
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.admin.health = troubled();
    api.admin.streams = {
      streams: [
        { userId: 'u2', userName: 'Anna Beispiel', profileName: 'Anna', device: 'Chrome auf Windows', title: 'Hearth', seriesName: null, source: 'portal', method: 'transcode', reason: 'videoCodec', videoCodec: 'h264', audioCodec: 'aac', hardware: true, paused: false },
        { userId: 'u3', userName: 'Ben Test', profileName: null, device: 'Infuse · iPad', title: 'Pilot', seriesName: 'Sundial', source: 'app', method: 'direct', reason: null, videoCodec: null, audioCodec: null, hardware: null, paused: true },
      ],
      totals: { direct: 1, remux: 0, transcode: 1 }, details: true,
      failed: [{ itemId: ID, title: 'Kaputter Film', count: 4, lastAt: new Date(Date.now() - 600e3).toISOString(), code: 'bufferStalledError' }],
    };
    api.admin.errors = {
      entries: [
        // internal fields that must never reach the page: samples can carry addresses
        { source: 'server', code: 'GET /api/items/:id 500', count: 12, firstAt: new Date(Date.now() - 7200e3).toISOString(), lastAt: new Date().toISOString(), release: 'abc1234', sample: 'fetch failed http://jellyfin:8096/Items?api_key=secret' },
        { source: 'client', code: 'resource Failed to load <script> http://intern.example/x.js', count: 3, firstAt: new Date().toISOString(), lastAt: new Date().toISOString(), sample: 'x (/browse)' },
        { source: 'job', code: 'hygiene', count: 1, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() },
      ],
      overflow: 0,
    };
  });

  test('services: media red "Nicht erreichbar", TMDB yellow "Schlüssel ungültig", OMDb off "Nicht eingerichtet"; every pill has icon + text', async ({ page }) => {
    await page.goto('/admin/status');
    const health = page.getByRole('region', { name: 'Systemzustand' });
    const media = health.getByRole('link', { name: /Medienserver/ });
    await expect(media).toContainText('Nicht erreichbar');
    await expect(media.locator('.pill.err svg')).toHaveCount(1);
    await expect(health.getByRole('link', { name: /TMDB/ }).locator('.pill.warn')).toHaveText('Schlüssel ungültig');
    await expect(health.getByRole('link', { name: /OMDb/ }).locator('.pill.muted')).toHaveText('Nicht eingerichtet');
    // worst first
    await expect(health.locator('li').first()).toContainText('Medienserver');
    for (const pill of await health.locator('.pill').all()) {
      await expect(pill.locator('svg')).toHaveCount(1);
      expect((await pill.innerText()).trim().length).toBeGreaterThan(0);
    }
  });

  test('recommendation index tile: size and age; building, not built and unsupported are worded', async ({ page, api }) => {
    await page.goto('/admin/status');
    const tile = page.getByText('Empfehlungs-Index').locator('xpath=ancestor::*[contains(@class,"tile")][1]');
    await expect(tile).toContainText('1.234');
    await expect(tile).toContainText('Aktualisiert');
    api.admin.recoIndex = { supported: true, running: true, items: 0, updatedAt: null };
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(tile).toContainText('Wird aufgebaut');
    api.admin.recoIndex = { supported: true, running: false, items: 0, updatedAt: null };
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(tile).toContainText('Noch nicht aufgebaut');
    api.admin.recoIndex = { supported: false, running: false, items: 0, updatedAt: null };
    await page.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(tile).toContainText('Vom Medienserver nicht unterstützt');
  });

  test('Jetzt prüfen calls ?refresh=1 once, shows the new state and reloads the banner', async ({ page, api }) => {
    await page.goto('/admin/status');
    const health = page.getByRole('region', { name: 'Systemzustand' });
    await expect(health.getByRole('link', { name: /Medienserver/ })).toContainText('Nicht erreichbar');
    api.admin.healthRefreshed = healthOk();
    const bannerCalls = api.admin.bannerCalls;
    await health.getByRole('button', { name: 'Jetzt prüfen' }).click();
    await expect(health.getByRole('link', { name: /Medienserver/ })).toContainText('Läuft');
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Neu geprüft.')).toBeVisible();
    expect(api.admin.healthCalls.filter((q) => q === '?refresh=1')).toHaveLength(1);
    await expect.poll(() => api.admin.bannerCalls).toBeGreaterThan(bannerCalls);
  });

  test('disks: downloads 93 % warn with "davon FriendFlix", database size only; shared volume shown once', async ({ page }) => {
    await page.goto('/admin/status');
    const disks = page.getByRole('region', { name: 'Speicher' });
    const items = disks.getByRole('listitem');
    await expect(items).toHaveCount(2);
    const dl = items.filter({ hasText: 'Downloads und Vorschauen' });
    await expect(dl.locator('.pill.warn')).toHaveText('Fast voll');
    await expect(dl.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '93');
    await expect(dl).toContainText('· 93 %');
    await expect(dl).toContainText('davon FriendFlix 22 GB');
    await expect(dl).toContainText('Downloads 20 GB · Vorschauen 2 GB');
    const db = items.filter({ hasText: 'Datenbank' });
    await expect(db).toContainText('Größe 512 MB');
    await expect(db.getByRole('progressbar')).toHaveCount(0);
  });

  test('suggestions card: counts per type, hints for "all in the library" and "no starting titles"', async ({ page, api }) => {
    const base = { anchors: 6, seeds: 9, seedsWithoutTmdb: 1, seedsFoundByName: 2, recommendations: 40, inLibrary: 12, inLibraryByTvdb: 3, lookupFailures: 0, seedSearchFailures: 0, ageFiltered: 4, final: 24 };
    api.newPage.suggestions.debug = {
      movie: base,
      series: { ...base, anchors: 0, seeds: 0, seedsWithoutTmdb: 0, seedsFoundByName: 0, recommendations: 0, inLibrary: 0, inLibraryByTvdb: 0, ageFiltered: 0, final: 0 },
    };
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Vorschläge (Noch nicht bei uns)' });
    const movie = card.locator('[data-type="movie"]'), series = card.locator('[data-type="series"]');
    await expect(movie.getByRole('heading', { name: 'Filme' })).toBeVisible();
    await expect(movie.locator('dt')).toHaveCount(11);
    await expect(movie.locator('[data-field="recommendations"]')).toHaveText('40');
    await expect(movie.locator('[data-field="inLibrary"]')).toHaveText('12');
    await expect(movie.locator('[data-field="final"]')).toHaveText('24');
    await expect(movie.getByRole('note')).toHaveCount(0);
    await expect(series.getByRole('heading', { name: 'Serien' })).toBeVisible();
    await expect(series.getByRole('note')).toContainText('Keine Ausgangstitel');
    // nearly everything recommended is already here
    api.newPage.suggestions.debug = { movie: { ...base, recommendations: 40, inLibrary: 39, final: 1 }, series: base };
    await page.reload();
    await expect(card.locator('[data-type="movie"]').getByRole('note')).toContainText('schon in der Bibliothek');
    await expect(card.locator('[data-type="series"]').getByRole('note')).toHaveCount(0);
  });

  test.describe('suggestions card without counts', () => {
    test.use({ allowedConsole: /status of (500|404)/ }); // the 404 requests_disabled is the answer under test
    test('suggestions card: without counts (not the owner profile) and without a request service it says so', async ({ page, api }) => {
      await page.goto('/admin/status');
      const card = page.getByRole('region', { name: 'Vorschläge (Noch nicht bei uns)' });
      await expect(card).toContainText('nur für den Admin auf dem Besitzer-Profil');
      api.newPage.suggestions.error = 'disabled';
      await page.reload();
      await expect(card).toContainText('Kein Wunsch-Dienst eingerichtet');
    });
  });

  test('streams: transcode row shows reason "Videoformat" and "Hardware"; details false → muted hint', async ({ page, api }) => {
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Wiedergaben' });
    const row = card.getByRole('listitem').filter({ hasText: 'Hearth' });
    await expect(row.locator('.pill.warn')).toHaveText('Umgewandelt');
    await expect(row.getByText('Videoformat')).toBeVisible();
    await expect(row.getByText('Hardware')).toBeVisible();
    await expect(row).toContainText('Anna Beispiel');
    await expect(card.getByRole('listitem').filter({ hasText: 'Sundial · Pilot' })).toContainText('Andere App');
    await expect(card).toContainText('1 direkt · 0 umverpackt · 1 umgewandelt');
    await expect(card.getByText(/keine Details/)).toHaveCount(0);
    api.admin.streams = { ...api.admin.streams, details: false };
    await page.reload();
    await expect(page.getByRole('region', { name: 'Wiedergaben' }).getByText('Der Medienserver liefert gerade keine Details (Formate, Hardware).')).toBeVisible();
  });

  test('failed playbacks link to /item/<id>; errors list shows source and count', async ({ page }) => {
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Wiedergaben' });
    await expect(card.getByRole('link', { name: 'Kaputter Film' })).toHaveAttribute('href', `/item/${ID}`);
    await expect(card.getByRole('listitem').filter({ hasText: 'Kaputter Film' })).toContainText('4-mal');
    const errs = page.getByRole('region', { name: 'Fehler (24 Std.)' });
    const first = errs.getByRole('listitem').first();
    await expect(first).toContainText('Server');
    await expect(first).toContainText('GET /api/items/:id 500');
    await expect(first).toContainText('12-mal');
    await expect(first).toContainText('Version abc1234');
    await expect(errs.getByRole('listitem').filter({ hasText: 'hygiene' })).toContainText('Hintergrund');
  });

  test('page HTML contains no "http://" from the mocks\' internal fields', async ({ page }) => {
    await page.goto('/admin/status');
    await expect(page.getByRole('region', { name: 'Fehler (24 Std.)' }).getByRole('listitem')).toHaveCount(3);
    const html = await page.locator('main').innerHTML();
    expect(html).not.toContain('http://');
    expect(html).not.toContain('api_key');
    expect(html).not.toContain('jellyfin:8096');
  });

  test('overview strip uses the snapshot (media red there too)', async ({ page }) => {
    await page.goto('/admin');
    const health = page.getByRole('region', { name: 'Systemzustand' });
    const media = health.getByRole('link', { name: /Medienserver/ });
    await expect(media).toContainText('Nicht erreichbar');
    await expect(media.locator('.pill.err')).toBeVisible();
  });

  test('failing health: error with retry in the services section, numbers still shown', async ({ page }) => {
    let fail = true;
    await page.route('**/api/admin/health', (r) => (fail ? r.fulfill({ status: 500, json: { error: 'x' } }) : r.fallback()));
    await page.goto('/admin/status');
    const alert = page.getByRole('alert').filter({ hasText: 'Der Zustand konnte nicht geladen werden.' });
    await expect(alert).toBeVisible();
    await expect(page.getByRole('region', { name: 'Zahlen' }).getByRole('link', { name: /Geräte warten/ })).toBeVisible();
    fail = false;
    await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('region', { name: 'Systemzustand' }).getByRole('link', { name: /Medienserver/ })).toBeVisible();
  });
  test('sign-in card: flows, warnings with texts, and the cover switch saves LOGIN_COVER_WALL through the settings', async ({ page, api }) => {
    api.admin.loginCheck = {
      ...loginCheckOk(), authCodeGrant: false, passkeys: 'sign-in page', passkeysReason: 'forwarded_host_ignored',
      warnings: ['flow_missing:recovery', 'auth_code_grant', 'passkeys:forwarded_host_ignored'],
      flows: [{ kind: 'login', slug: 'default-authentication-flow', state: 'ok', stages: [] }, { kind: 'recovery', slug: 'default-recovery-flow', state: 'missing', stages: [] }],
    };
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Anmeldung', exact: true });
    await expect(card).toContainText('FriendFlix (eigene Bildschirme)');
    await expect(card.getByRole('listitem').filter({ hasText: 'Passwort vergessen' }).locator('.pill.err')).toHaveText('Fehlt');
    await expect(card.getByRole('listitem').filter({ hasText: 'Anmelden' }).first().locator('.pill.ok')).toHaveText('In Ordnung');
    await expect(card.getByText('Der Ablauf „Passwort vergessen“ fehlt bei Authentik.')).toBeVisible();
    await expect(card.getByText(/Grant-Typ „authorization_code“/)).toBeVisible();
    await expect(card.getByText(/AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS/)).toBeVisible();
    // the switch: PUT /api/admin/settings {values:{LOGIN_COVER_WALL:false}}
    const sw = card.getByRole('switch', { name: 'Titelbilder hinter der Anmeldung' });
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    expect(api.settings.puts).toEqual([{ values: { LOGIN_COVER_WALL: false } }]);
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Gespeichert.')).toBeVisible();
  });

  test('sign-in card: passkey sign-in not offered names the missing stage and its fix; a wrong host names AUTHENTIK_URL', async ({ page, api }) => {
    api.admin.loginCheck = { ...loginCheckOk(), passkeySignIn: 'no_stage', warnings: ['passkeys:no_stage'] };
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Anmeldung', exact: true });
    await expect(card.locator('[data-check="passkey-sign-in"]')).toHaveText('Nicht angeboten (Stage fehlt)');
    await expect(card.getByText(/default-authentication-identification/)).toBeVisible();
    await expect(card.getByText(/WebAuthn Authenticator Validation Stage/)).toBeVisible();
    api.admin.loginCheck = { ...loginCheckOk(), passkeySignIn: 'rp_mismatch', warnings: ['passkeys:rp_mismatch'] };
    await page.reload();
    await expect(card.locator('[data-check="passkey-sign-in"]')).toHaveText('Nicht angeboten (falscher Host)');
    await expect(card.getByText(/RP-ID passt nicht.*AUTHENTIK_URL/)).toBeVisible();
  });

  test('sign-in card: the passkey user verification setting is shown, and the warning says sign-in itself may not verify the person', async ({ page, api }) => {
    const card = page.getByRole('region', { name: 'Anmeldung', exact: true });
    for (const [uv, label] of [['required', 'Erforderlich'], ['preferred', 'Bevorzugt (nicht erzwungen)'], ['discouraged', 'Unerwünscht (nicht erzwungen)'], ['unknown', 'Nicht gesetzt (FriendFlix verlangt sie)']] as const) {
      api.admin.loginCheck = { ...loginCheckOk(), passkeyUv: uv, warnings: uv === 'required' ? [] : ['passkeys:uv_not_required'] };
      await page.goto('/admin/status');
      await expect(card.locator('[data-check="passkey-uv"]')).toHaveText(label);
      if (uv === 'required') await expect(card.getByText('Schon die Anmeldung selbst prüft die Person womöglich nicht')).toHaveCount(0);
      else await expect(card.getByText('Schon die Anmeldung selbst prüft die Person womöglich nicht')).toBeVisible();
    }
    // no passkey challenge: no row
    api.admin.loginCheck = { ...loginCheckOk(), passkeyUv: null };
    await page.goto('/admin/status');
    await expect(card.locator('[data-check="passkey-sign-in"]')).toBeVisible();
    await expect(card.locator('[data-check="passkey-uv"]')).toHaveCount(0);
  });

  test('Repair sets the passkey check only when "Anmeldung mit Passkey anbieten" is ticked, and says it affects other applications', async ({ page, api }) => {
    api.admin.loginCheck = { ...loginCheckOk(), passkeySignIn: 'no_stage', warnings: ['passkeys:no_stage'] };
    await page.goto('/admin/status');
    const form = page.getByRole('form', { name: 'Authentik-Einrichtung reparieren' });
    const box = form.getByRole('checkbox', { name: 'Anmeldung mit Passkey anbieten (ohne Passwort)' });
    await expect(box).not.toBeChecked();
    await expect(form.getByText(/jede Anwendung, die die Standard-Anmeldung von Authentik nutzt/)).toBeVisible();
    await box.check();
    await form.getByLabel('Authentik-Admin-Token (Superuser, einmalig)').fill('ak-admin-placeholder-e2e');
    await form.getByRole('button', { name: 'Reparieren' }).click();
    await expect(form.getByRole('status')).toBeVisible();
    expect(api.admin.repairs).toEqual([{ token: 'ak-admin-placeholder-e2e', passkeySignIn: true }]);
  });

  test('sign-in card: a refused service token, the executor check, the last error and the one-click repair', async ({ page, api }) => {
    api.admin.loginCheck = {
      ...loginCheckOk(), warnings: ['token:invalid', 'executor:non_json'],
      serviceToken: { token: 'invalid', missing: [] },
      executor: { ok: false, cls: 'non_json', status: 200, endpoint: 'api/v3/flows/executor/default-authentication-flow/' },
      lastFailures: [{ area: 'api', cls: 'token_invalid', status: 403, endpoint: 'api/v3/core/users/', at: '2026-10-18T08:00:00.000Z' }],
    };
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Anmeldung', exact: true });
    await expect(card.getByText('Von Authentik abgelehnt')).toBeVisible();
    await expect(card.getByText(/Fehler: keine JSON-Antwort .* \(HTTP 200\) bei api\/v3\/flows\/executor\/default-authentication-flow\//)).toBeVisible();
    await expect(card.getByText(/Authentik-API: Token abgelehnt \(HTTP 403\), api\/v3\/core\/users\//)).toBeVisible();
    await expect(card.getByText(/Authentik lehnt das Dienst-Token \(AUTHENTIK_API_TOKEN\) ab/)).toBeVisible();
    await expect(card.getByText(/Prüf, ob AUTHENTIK_URL die Adresse ist/)).toBeVisible();
    const form = card.getByRole('form', { name: 'Authentik-Einrichtung reparieren' });
    const run = form.getByRole('button', { name: 'Reparieren' });
    await expect(run).toBeDisabled();
    await form.getByLabel('Authentik-Admin-Token (Superuser, einmalig)').fill('ak-admin-placeholder-e2e');
    await run.click();
    await expect(form.getByRole('status')).toHaveText('Authentik-Einrichtung repariert. Das neue Dienst-Token wurde gespeichert.');
    await expect(form.getByRole('list')).toContainText('Dienstkonto für Einladungen');
    await expect(form.getByLabel('Authentik-Admin-Token (Superuser, einmalig)')).toHaveValue(''); // used once, never kept
    expect(api.admin.repairs).toEqual([{ token: 'ak-admin-placeholder-e2e', passkeySignIn: false }]);
    // the card shows the state after the repair
    await expect(card.getByText('Alles in Ordnung.')).toBeVisible();
    await expect(card.getByText('Von Authentik abgelehnt')).toHaveCount(0);
  });

  test('sign-in card: a cover switch from the environment is locked', async ({ page, api }) => {
    api.settings.groups.find((g) => g.id === 'general')!.items.find((i) => i.key === 'LOGIN_COVER_WALL')!.source = 'env';
    await page.goto('/admin/status');
    const card = page.getByRole('region', { name: 'Anmeldung', exact: true });
    await expect(card.getByRole('switch', { name: 'Titelbilder hinter der Anmeldung' })).toBeDisabled();
    await expect(card.getByText('Gesperrt (kommt aus der Umgebung)')).toBeVisible();
    await expect(card.getByText('Alles in Ordnung.')).toBeVisible();
  });
});

test.describe('Authentik repair: re-authentication', () => {
  test.use({ allowedConsole: /status of 401/ });
  const refuseOnce = async (page: import('@playwright/test').Page) => {
    let first = true;
    await page.route('**/api/admin/authentik/repair', (r) => {
      if (!first) return r.fallback();
      first = false;
      return r.fulfill({ status: 401, json: { error: 'reauth_required' } });
    });
  };
  const runRepair = async (page: import('@playwright/test').Page) => {
    const form = page.getByRole('region', { name: 'Anmeldung', exact: true }).getByRole('form', { name: 'Authentik-Einrichtung reparieren' });
    await form.getByLabel('Authentik-Admin-Token (Superuser, einmalig)').fill('ak-admin-placeholder-e2e');
    await form.getByRole('button', { name: 'Reparieren' }).click();
    return form;
  };
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    api.admin.loginCheck = { ...loginCheckOk(), warnings: ['token:invalid'], serviceToken: { token: 'invalid', missing: [] } };
  });

  test('in place: the sign-in dialog, then the repair runs once with the typed token', async ({ page, api }) => {
    await refuseOnce(page);
    await installLogin(page.context(), loginState({ starts: [{ body: password('admin') }], answers: [{ body: done('') }] }));
    await page.goto('/admin/status');
    const form = await runRepair(page);
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await dlg.getByLabel('Passwort', { exact: true }).fill('hunter2-fixture');
    await dlg.getByRole('button', { name: 'Anmelden' }).click();
    await expect(form.getByRole('status')).toHaveText('Authentik-Einrichtung repariert. Das neue Dienst-Token wurde gespeichert.');
    expect(api.admin.repairs).toEqual([{ token: 'ak-admin-placeholder-e2e', passkeySignIn: false }]);
  });

  test('classic sign-in mode: the forced sign-in at /auth/reauth, back to /admin/status (never the plain sign-in page)', async ({ page }) => {
    await refuseOnce(page);
    await page.route('**/auth/flow/config', (r) => r.fulfill({ json: { mode: 'authentik', recovery: false, enroll: false } }));
    let next: string | null = null;
    await page.route('**/auth/reauth?**', (r) => { next = new URL(r.request().url()).searchParams.get('next'); return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>sign in</p>' }); });
    await page.goto('/admin/status');
    await runRepair(page);
    await expect.poll(() => next).toBe('/admin/status');
  });
});
