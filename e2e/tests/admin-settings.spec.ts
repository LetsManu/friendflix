// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { done, installLogin, loginState, password } from '../mocks/login.js';
import { LEAK } from '../mocks/settings.js';

// Admin → Einstellungen (/admin/settings): the settings store (Block 25, spec Part I). Secrets are write-only, env rows are locked,
// a save sends only the fields that changed. A re-authentication happens in place (the in-app dialog) when GET /auth/flow/config
// says `app`; the tests without that mock (the config is not answered) cover the classic redirect through /auth/reauth.
type Page = import('@playwright/test').Page;
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const card = (page: Page, name: string) => page.locator('section', { has: page.getByRole('heading', { level: 2, name, exact: true }) });
const setting = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
/** the classic sign-in mode: GET /auth/flow/config answers `authentik`, so a re-authentication goes through /auth/reauth */
const classicSignIn = (page: import('@playwright/test').Page) => page.route('**/auth/flow/config', (r) => r.fulfill({ json: { mode: 'authentik', recovery: false, enroll: false } }));

test.describe('admin: settings', () => {
  test.use({ allowedConsole: /status of (400|401)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('env row is locked and shows "from environment"; Move into settings shows the hint naming KEY and KEY_FILE', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const row = setting(page, 'Öffentliche Adresse');
    await expect(row.getByText('Aus der Umgebung', { exact: true })).toBeVisible();
    await expect(row.getByRole('textbox')).toBeDisabled();
    await expect(row.getByRole('textbox')).toHaveValue('https://friend.example.com');
    await row.getByRole('button', { name: 'Öffentliche Adresse: in die Einstellungen übernehmen' }).click();
    await expect(row.getByText(/Auch gespeichert\. Du kannst jetzt PUBLIC_URL und PUBLIC_URL_FILE aus der \.env entfernen/)).toBeVisible();
    expect(api.settings.imports).toEqual([['PUBLIC_URL']]);
    // still locked: env wins until it is removed
    await expect(row.getByRole('textbox')).toBeDisabled();
    await expect(row.getByRole('button', { name: /übernehmen/ })).toHaveCount(0);
  });

  test('Move all moves every env row and names KEY and KEY_FILE to remove', async ({ page, api }) => {
    await page.goto('/admin/settings');
    await page.getByRole('button', { name: 'Alle übernehmen' }).click();
    expect(api.settings.imports).toEqual(['all']);
    const req = setting(page, 'Adresse des Anfragen-Dienstes');
    await expect(req.getByText(/REQUESTS_URL und REQUESTS_URL_FILE aus der \.env/)).toBeVisible();
    await expect(setting(page, 'Öffentliche Adresse').getByText(/Auch gespeichert/)).toBeVisible();
    expect(await page.locator('main').innerText()).not.toMatch(/seerr/i);
  });

  test('secret row shows set/unset, Replace sends the value, Clear sends null, the page never renders a secret value', async ({ page, api }) => {
    const stored: string[] = [];
    page.on('console', (m) => { if (m.text().startsWith('ss:')) stored.push(m.text()); });
    await page.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) { console.log(`ss:${k}=${v}`); return set.call(this, k, v); };
    });
    await page.goto('/admin/settings');
    const tmdb = setting(page, 'TMDB-API-Schlüssel');
    // the mock seeds a canary as the value of secret rows (TMDB, DATABASE_URL); the page ignores it
    await expect(tmdb.getByText('Gesetzt · …abcd')).toBeVisible();
    expect(await page.content()).not.toContain(LEAK);
    const omdb = setting(page, 'OMDb-API-Schlüssel');
    await expect(tmdb.getByText('Gesetzt · …abcd')).toBeVisible();
    await expect(omdb.getByText('Nicht gesetzt', { exact: true })).toBeVisible();
    await expect(omdb.getByRole('button', { name: 'OMDb-API-Schlüssel entfernen' })).toBeDisabled();
    // Replace opens an empty write-only field
    await tmdb.getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' }).click();
    const field = tmdb.getByLabel('Neuer Wert');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    // page.content() does not serialise an input's live value: read every field's value property, with Replace open
    const values = await page.locator('input, textarea').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(values.length).toBeGreaterThan(0);
    expect(values.join('\n')).not.toContain(LEAK);
    await field.fill('sekret-tmdb-key-wxyz');
    const sources = card(page, 'Datenquellen');
    await sources.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { TMDB_API_KEY: 'sekret-tmdb-key-wxyz' } }]);
    await expect(tmdb.getByText('Gesetzt · …wxyz')).toBeVisible();
    await expect(tmdb.getByLabel('Neuer Wert')).toHaveCount(0);
    expect(await page.content()).not.toContain('sekret-tmdb-key-wxyz');
    // Clear marks it; Save sends null
    await tmdb.getByRole('button', { name: 'TMDB-API-Schlüssel entfernen' }).click();
    await expect(tmdb.getByText('Wird beim Speichern entfernt.')).toBeVisible();
    await sources.getByRole('button', { name: 'Speichern' }).click();
    await expect(tmdb.getByText('Nicht gesetzt', { exact: true })).toBeVisible();
    expect(api.settings.puts[1]).toEqual({ values: { TMDB_API_KEY: null } });
    expect(stored.join('\n')).not.toContain('sekret-tmdb-key-wxyz');
  });

  test('an undecryptable secret asks to enter it again', async ({ page }) => {
    await page.goto('/admin/settings');
    const key = setting(page, 'Jellyfin-API-Schlüssel (Admin)');
    await expect(key.getByText('Gespeicherter Wert nicht lesbar – bitte neu eingeben.')).toBeVisible();
  });

  test('saving a restart setting shows the restart banner; API_COMPRESSION applies live', async ({ page, api }) => {
    await page.goto('/admin/settings');
    await expect(page.getByText('docker compose restart backend')).toHaveCount(0);
    await expect(setting(page, 'API-Antworten komprimieren').getByText('Neustart nötig')).toHaveCount(0);
    const row = setting(page, 'Downloads pro Stunde');
    await expect(row.getByText('Neustart nötig')).toBeVisible();
    await row.getByRole('spinbutton').fill('7');
    await card(page, 'Downloads').getByRole('button', { name: 'Speichern' }).click();
    expect(api.settings.puts).toEqual([{ values: { DOWNLOAD_CREATE_PER_HOUR: 7 } }]);
    const banner = page.getByRole('status').filter({ hasText: 'docker compose restart backend' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Downloads pro Stunde');
  });

  test('probe unreachable → Save anyway saves with force: true', async ({ page, api }) => {
    api.settings.probeFail = { ok: false, code: 'unreachable', detail: 'upstream_error' };
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await setting(page, 'Jellyfin-Adresse').getByRole('textbox').fill('http://jellyfin.lan:8096');
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('alert')).toContainText('Dienst nicht erreichbar.');
    await media.getByRole('button', { name: 'Trotzdem speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([
      { values: { JELLYFIN_URL: 'http://jellyfin.lan:8096' } },
      { values: { JELLYFIN_URL: 'http://jellyfin.lan:8096' }, force: true },
    ]);
  });

  test('a hard probe failure offers no Save anyway', async ({ page, api }) => {
    api.settings.probeFail = { ok: false, code: 'unauthorized' };
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await setting(page, 'Jellyfin-Adresse').getByRole('textbox').fill('http://jellyfin.lan:8096');
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('alert')).toContainText('Zugang abgelehnt');
    await expect(media.getByRole('button', { name: 'Trotzdem speichern' })).toHaveCount(0);
  });

  test('only changed fields are sent: the redacted ntfy URL never goes back', async ({ page, api }) => {
    await page.goto('/admin/settings');
    await expect(setting(page, 'ntfy-Kanal für Ankündigungen').getByRole('textbox')).toHaveValue('https://ntfy.example.com/friendflix?auth=redacted');
    await setting(page, 'ntfy-Server für persönliche Nachrichten').getByRole('textbox').fill('https://ntfy.example.com');
    await card(page, 'Benachrichtigungen').getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { NTFY_BASE_URL: 'https://ntfy.example.com' } }]);
    // typing back the shown value is no change
    const f = setting(page, 'Gleichzeitige Vorbereitungen').getByRole('spinbutton');
    await f.fill('2');
    await f.fill('1');
    await expect(card(page, 'Downloads').getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  test('a refused value shows its error at the field', async ({ page, api }) => {
    api.settings.saveErrors = { DOWNLOAD_PREP_CONCURRENCY: 'too_big' };
    await page.goto('/admin/settings');
    await setting(page, 'Gleichzeitige Vorbereitungen').getByRole('spinbutton').fill('9');
    await card(page, 'Downloads').getByRole('button', { name: 'Speichern' }).click();
    await expect(setting(page, 'Gleichzeitige Vorbereitungen').getByRole('alert')).toHaveText('Der Wert ist zu groß.');
    expect(api.settings.puts).toEqual([{ values: { DOWNLOAD_PREP_CONCURRENCY: 9 } }]);
  });

  test('Test runs the group probe with the unsaved values', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const signin = card(page, 'Anmeldung');
    await signin.getByRole('button', { name: 'Testen' }).click();
    await expect(signin.getByRole('status')).toHaveText('Verbindung funktioniert.');
    api.settings.testResult = { ok: false, code: 'issuer_mismatch' };
    await setting(page, 'OIDC-Client-ID').getByRole('textbox').fill('other-client');
    await signin.getByRole('button', { name: 'Testen' }).click();
    await expect(signin.getByRole('alert')).toContainText('anderen Issuer');
    expect(api.settings.tests).toEqual([{ group: 'signin', values: {} }, { group: 'signin', values: { OIDC_CLIENT_ID: 'other-client' } }]);
    expect(api.settings.puts).toEqual([]);
  });

  test('re-authentication in place: the sign-in dialog, then exactly that save once more (a secret included), no redirect', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    const st = loginState({ starts: [{ body: password('admin') }], answers: [() => { api.settings.reauthRequired = false; return { body: done('') }; }] });
    await installLogin(page.context(), st);
    let classic = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/auth/reauth') classic++; });
    await page.goto('/admin/settings');
    await setting(page, 'Authentik-API-Token').getByRole('button', { name: 'Authentik-API-Token ersetzen' }).click();
    await setting(page, 'Authentik-API-Token').getByLabel('Neuer Wert').fill('very-secret-token-1234');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await dlg.getByLabel('Passwort', { exact: true }).fill('hunter2-fixture');
    await dlg.getByRole('button', { name: 'Anmelden' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    await expect(dlg).toHaveCount(0);
    expect(st.calls.filter((c) => c.path === '/auth/flow/start').map((c) => c.body)).toEqual([{ kind: 'reauth' }]);
    expect(api.settings.puts).toHaveLength(2);
    expect(api.settings.puts[1]).toEqual(api.settings.puts[0]);
    expect(JSON.stringify(api.settings.puts[1])).toContain('very-secret-token-1234');
    expect(classic).toBe(0);
    await expect(page).toHaveURL(/\/admin\/settings$/);
    expect(await page.evaluate(() => sessionStorage.getItem('ff_settings_pending'))).toBeNull();
  });

  test('re-authentication in place: closing the dialog saves nothing more and keeps what was typed', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    await installLogin(page.context(), loginState({ starts: [{ body: password('admin') }] }));
    await page.goto('/admin/settings');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(api.settings.puts).toHaveLength(1);
    await expect(setting(page, 'Admin-Gruppe').getByRole('textbox')).toHaveValue('ff-admins');
    expect(await page.evaluate(() => sessionStorage.getItem('ff_settings_pending'))).toBeNull();
  });

  test('re-authentication in place for "Generate": confirmed once, signed in, generated once more (no second confirmation)', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    await installLogin(page.context(), loginState({ starts: [{ body: password('admin') }], answers: [() => { api.settings.reauthRequired = false; return { body: done('') }; }] }));
    let generates = 0, confirms = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/admin/settings/generate') generates++; });
    await page.goto('/admin/settings');
    const row = setting(page, 'Webhook-Geheimnis');
    await row.getByRole('button', { name: 'Webhook-Geheimnis: Neu erzeugen' }).click();
    const ask = page.getByRole('alertdialog');
    await ask.getByRole('button', { name: 'Neu erzeugen' }).click();
    confirms++;
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await dlg.getByLabel('Passwort', { exact: true }).fill('hunter2-fixture');
    await dlg.getByRole('button', { name: 'Anmelden' }).click();
    await expect(row.getByLabel('Neues Webhook-Geheimnis')).toHaveValue(/^0f1e2d3c/);
    await expect(ask).toHaveCount(0);
    expect([generates, confirms]).toEqual([2, 1]);
  });

  test('the dialog\'s "confirm with a passkey instead" goes through /auth/reauth back to this page, the change kept for it', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    await installLogin(page.context(), loginState({ starts: [{ body: password('admin') }] }));
    let next: string | null = null;
    await page.route('**/auth/reauth?**', (r) => {
      next = new URL(r.request().url()).searchParams.get('next');
      return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>sign in</p>' });
    });
    await page.goto('/admin/settings');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    const stash = page.evaluate(() => sessionStorage.getItem('ff_settings_pending'));
    expect(await stash).toContain('ff-admins');
    await page.getByRole('dialog', { name: 'Erneut anmelden' }).getByRole('button', { name: 'Stattdessen mit Passkey bestätigen' }).click();
    await expect.poll(() => next).toBe('/admin/settings?resume=1');
  });

  test('each request opens a fresh dialog: closed once, the next save starts a new sign-in', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    const st = loginState({ starts: [() => ({ body: password('admin') })] });
    await installLogin(page.context(), st);
    await page.goto('/admin/settings');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    for (let i = 1; i <= 2; i++) {
      await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
      await expect(dlg.getByLabel('Passwort', { exact: true })).toHaveValue('');
      await dlg.getByLabel('Passwort', { exact: true }).fill(`typed-${i}`);
      await page.keyboard.press('Escape');
      await expect(dlg).toHaveCount(0);
    }
    expect(st.calls.filter((c) => c.path === '/auth/flow/start')).toHaveLength(2);
    expect(api.settings.puts).toHaveLength(2);
  });

  test('re-authentication (classic): a non-secret change is restored and saved after the sign-in', async ({ page, api }) => {
    await classicSignIn(page);
    api.settings.reauthRequired = true;
    let next: string | null = null;
    await page.route('**/auth/reauth?**', (r) => {
      next = new URL(r.request().url()).searchParams.get('next');
      api.settings.reauthRequired = false;
      return r.fulfill({ status: 302, headers: { location: next ?? '/' } });
    });
    await page.goto('/admin/settings');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => next).toBe('/admin/settings?resume=1');
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    expect(api.settings.puts).toEqual([{ values: { ADMIN_GROUP: 'ff-admins' } }, { values: { ADMIN_GROUP: 'ff-admins' } }]);
    await expect(setting(page, 'Admin-Gruppe').getByRole('textbox')).toHaveValue('ff-admins');
  });

  test('re-authentication (classic): a secret is never kept; the person enters it again', async ({ page, api }) => {
    await classicSignIn(page);
    api.settings.reauthRequired = true;
    const stored: string[] = [];
    page.on('console', (m) => { if (m.text().startsWith('ss:')) stored.push(m.text()); });
    await page.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) { console.log(`ss:${k}=${v}`); return set.call(this, k, v); };
    });
    await page.route('**/auth/reauth?**', (r) => {
      api.settings.reauthRequired = false;
      return r.fulfill({ status: 302, headers: { location: new URL(r.request().url()).searchParams.get('next') ?? '/' } });
    });
    await page.goto('/admin/settings');
    await setting(page, 'Authentik-API-Token').getByRole('button', { name: 'Authentik-API-Token ersetzen' }).click();
    await setting(page, 'Authentik-API-Token').getByLabel('Neuer Wert').fill('very-secret-token-1234');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Geheime Werte werden nicht zwischengespeichert' })).toBeVisible();
    await expect(setting(page, 'Admin-Gruppe').getByRole('textbox')).toHaveValue('ff-admins');
    expect(api.settings.puts).toHaveLength(1); // no automatic retry without the secret
    expect(stored.join('\n')).not.toContain('very-secret-token-1234');
    expect(stored.join('\n')).toContain('ff-admins');
  });

  test('generate: the new webhook secret is shown once', async ({ page }) => {
    await page.goto('/admin/settings');
    const row = setting(page, 'Webhook-Geheimnis');
    await row.getByRole('button', { name: 'Webhook-Geheimnis: Neu erzeugen' }).click();
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await dlg.getByRole('button', { name: 'Neu erzeugen' }).click();
    await expect(row.getByLabel('Neues Webhook-Geheimnis')).toHaveValue(/^0f1e2d3c/);
    await expect(row.getByText(/Wird nur jetzt angezeigt/)).toBeVisible();
  });

  test('server group is read-only and never shows a credential', async ({ page }) => {
    await page.goto('/admin/settings');
    const server = card(page, 'Server');
    await expect(server.getByText('PORT', { exact: true })).toBeVisible();
    await expect(server.getByText('3000')).toBeVisible();
    await expect(server.getByText('DATABASE_URL', { exact: true })).toBeVisible();
    await expect(server.getByRole('textbox')).toHaveCount(0);
    await expect(server.getByRole('button')).toHaveCount(0);
  });

  test('an edited ntfy URL that still carries the redaction marker is refused at the field, nothing is sent', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const row = setting(page, 'ntfy-Kanal für Ankündigungen');
    await row.getByRole('textbox').fill('https://ntfy.example.com/other-topic?auth=redacted');
    await card(page, 'Benachrichtigungen').getByRole('button', { name: 'Speichern' }).click();
    await expect(row.getByRole('alert')).toContainText('Platzhalter „redacted“');
    expect(api.settings.puts).toEqual([]);
    // with the token entered again it is saved
    await row.getByRole('textbox').fill('https://ntfy.example.com/other-topic?auth=tk_new');
    await card(page, 'Benachrichtigungen').getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { NTFY_URL: 'https://ntfy.example.com/other-topic?auth=tk_new' } }]);
  });

  test('re-authentication (classic) for a Test repeats the test, never a save', async ({ page, api }) => {
    await classicSignIn(page);
    api.settings.reauthRequired = true;
    let next: string | null = null;
    await page.route('**/auth/reauth?**', (r) => {
      next = new URL(r.request().url()).searchParams.get('next');
      api.settings.reauthRequired = false;
      return r.fulfill({ status: 302, headers: { location: next ?? '/' } });
    });
    await page.goto('/admin/settings');
    await setting(page, 'Jellyfin-Adresse').getByRole('textbox').fill('http://jellyfin.lan:8096');
    const media = card(page, 'Mediaserver');
    await media.getByRole('button', { name: 'Testen' }).click();
    await expect.poll(() => next).toBe('/admin/settings?resume=1');
    await expect(media.getByRole('status')).toHaveText('Verbindung funktioniert.');
    expect(api.settings.tests).toEqual([{ group: 'media', values: { JELLYFIN_URL: 'http://jellyfin.lan:8096' } }]);
    expect(api.settings.puts).toEqual([]);
    await expect(setting(page, 'Jellyfin-Adresse').getByRole('textbox')).toHaveValue('http://jellyfin.lan:8096');
  });

  test('"Save anyway" keeps force across a re-authentication (classic)', async ({ page, api }) => {
    await classicSignIn(page);
    api.settings.probeFail = { ok: false, code: 'timeout' };
    await page.route('**/auth/reauth?**', (r) => {
      api.settings.reauthRequired = false;
      return r.fulfill({ status: 302, headers: { location: new URL(r.request().url()).searchParams.get('next') ?? '/' } });
    });
    await page.goto('/admin/settings');
    const media = card(page, 'Mediaserver');
    await setting(page, 'Jellyfin-Adresse').getByRole('textbox').fill('http://jellyfin.lan:8096');
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('alert')).toContainText('Keine Antwort');
    api.settings.reauthRequired = true; // the sign-in window ran out meanwhile
    await media.getByRole('button', { name: 'Trotzdem speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([
      { values: { JELLYFIN_URL: 'http://jellyfin.lan:8096' } },
      { values: { JELLYFIN_URL: 'http://jellyfin.lan:8096' }, force: true },
      { values: { JELLYFIN_URL: 'http://jellyfin.lan:8096' }, force: true },
    ]);
  });

  test('(classic) a resumed action that still needs a sign-in shows an error instead of another round trip', async ({ page, api }) => {
    await classicSignIn(page);
    api.settings.reauthRequired = true;
    let reauths = 0;
    await page.route('**/auth/reauth?**', (r) => {
      reauths++;
      return r.fulfill({ status: 302, headers: { location: new URL(r.request().url()).searchParams.get('next') ?? '/' } });
    });
    await page.goto('/admin/settings');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Die erneute Anmeldung hat nicht gereicht' })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    expect(reauths).toBe(1);
    expect(api.settings.puts).toHaveLength(2);
    expect(await page.evaluate(() => sessionStorage.getItem('ff_settings_pending'))).toBeNull();
    await expect(setting(page, 'Admin-Gruppe').getByRole('textbox')).toHaveValue('ff-admins');
  });

  test('a failed re-authentication drops the kept change', async ({ page }) => {
    await page.goto('/admin/settings');
    await page.evaluate(() => sessionStorage.setItem('ff_settings_pending', JSON.stringify({ action: 'save', group: 'signin', edits: { ADMIN_GROUP: 'x' }, force: false, dropped: false, at: Date.now() })));
    await page.goto('/me/account?reauth=failed');
    await expect(page.getByRole('alert').first()).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('ff_settings_pending'))).toBeNull();
  });

  test('nav: Einstellungen under Betrieb, active on /admin/settings', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(nav.getByRole('link', { name: 'Einstellungen' })).toHaveAttribute('aria-current', 'page');
  });
  test('LOGIN_UI starts with "Automatisch" and offers FriendFlix / Authentik; clearing it sends null', async ({ page, api }) => {
    await page.goto('/admin/settings');
    const row = setting(page, 'Anmeldeseite');
    const sel = row.getByRole('combobox');
    await expect(sel).toHaveValue('');
    await expect(sel.locator('option')).toHaveText(['Automatisch', 'FriendFlix', 'Authentik']);
    await sel.selectOption('authentik');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts.length).toBe(1);
    expect(api.settings.puts[0]!.values).toEqual({ LOGIN_UI: 'authentik' });
    await sel.selectOption('');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts.length).toBe(2);
    expect(api.settings.puts[1]!.values).toEqual({ LOGIN_UI: null });
  });
});
