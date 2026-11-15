// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { done, identify, installLogin, loginState, password } from '../mocks/login.js';
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
    await expect(setting(page, 'Öffentliche Adresse').getByText(/Auch gespeichert/)).toBeVisible();
    await page.getByRole('tab', { name: 'Medien' }).click();
    const req = setting(page, 'Adresse des Anfragen-Dienstes');
    await expect(req.getByText(/REQUESTS_URL und REQUESTS_URL_FILE aus der \.env/)).toBeVisible();
    expect(await page.locator('main').innerText()).not.toMatch(/seerr/i);
  });

  test('secret row shows set/unset, Replace sends the value, Clear sends null, the page never renders a secret value', async ({ page, api }) => {
    const stored: string[] = [];
    page.on('console', (m) => { if (m.text().startsWith('ss:')) stored.push(m.text()); });
    await page.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) { console.log(`ss:${k}=${v}`); return set.call(this, k, v); };
    });
    await page.goto('/admin/settings?tab=media');
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
    await page.goto('/admin/settings?tab=media');
    const key = setting(page, 'Jellyfin-API-Schlüssel (Admin)');
    await expect(key.getByText('Gespeicherter Wert nicht lesbar – bitte neu eingeben.')).toBeVisible();
  });

  test('saving a restart setting shows the restart banner; API_COMPRESSION applies live', async ({ page, api }) => {
    await page.goto('/admin/settings');
    await expect(page.getByText('docker compose restart backend')).toHaveCount(0);
    await expect(setting(page, 'API-Antworten komprimieren')).toBeVisible();
    await expect(setting(page, 'API-Antworten komprimieren').getByText('Neustart nötig')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Wiedergabe' }).click();
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
    await page.goto('/admin/settings?tab=media');
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
    await page.goto('/admin/settings?tab=media');
    const media = card(page, 'Mediaserver');
    await setting(page, 'Jellyfin-Adresse').getByRole('textbox').fill('http://jellyfin.lan:8096');
    await media.getByRole('button', { name: 'Speichern' }).click();
    await expect(media.getByRole('alert')).toContainText('Zugang abgelehnt');
    await expect(media.getByRole('button', { name: 'Trotzdem speichern' })).toHaveCount(0);
  });

  test('only changed fields are sent: the redacted ntfy URL never goes back', async ({ page, api }) => {
    await page.goto('/admin/settings?tab=notifications');
    await expect(setting(page, 'ntfy-Kanal für Ankündigungen').getByRole('textbox')).toHaveValue('https://ntfy.example.com/friendflix?auth=redacted');
    await setting(page, 'ntfy-Server für persönliche Nachrichten').getByRole('textbox').fill('https://ntfy.example.com');
    await card(page, 'Benachrichtigungen').getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    expect(api.settings.puts).toEqual([{ values: { NTFY_BASE_URL: 'https://ntfy.example.com' } }]);
    // typing back the shown value is no change
    await page.getByRole('tab', { name: 'Wiedergabe' }).click();
    const f = setting(page, 'Gleichzeitige Vorbereitungen').getByRole('spinbutton');
    await f.fill('2');
    await f.fill('1');
    await expect(card(page, 'Downloads').getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  test('a refused value shows its error at the field', async ({ page, api }) => {
    api.settings.saveErrors = { DOWNLOAD_PREP_CONCURRENCY: 'too_big' };
    await page.goto('/admin/settings?tab=playback');
    await setting(page, 'Gleichzeitige Vorbereitungen').getByRole('spinbutton').fill('9');
    await card(page, 'Downloads').getByRole('button', { name: 'Speichern' }).click();
    await expect(setting(page, 'Gleichzeitige Vorbereitungen').getByRole('alert')).toHaveText('Der Wert ist zu groß.');
    expect(api.settings.puts).toEqual([{ values: { DOWNLOAD_PREP_CONCURRENCY: 9 } }]);
  });

  test('Test runs the group probe with the unsaved values', async ({ page, api }) => {
    await page.goto('/admin/settings?tab=signin');
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
    await page.goto('/admin/settings?tab=signin');
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
    await expect(page).toHaveURL(/\/admin\/settings\?tab=signin$/);
    expect(await page.evaluate(() => sessionStorage.getItem('ff_settings_pending'))).toBeNull();
  });

  test('re-authentication in place: closing the dialog saves nothing more and keeps what was typed', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    await installLogin(page.context(), loginState({ starts: [{ body: password('admin') }] }));
    await page.goto('/admin/settings?tab=signin');
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

  test('the dialog\'s "confirm with a passkey instead" runs in the dialog when the provider offers one: the pending change is kept, saved once more, and it ends on this page', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    await page.addInitScript(() => {
      navigator.credentials.get = () => Promise.resolve({ toJSON: () => ({ id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'YQ', signature: 'cw', userHandle: null } }) } as any);
    });
    const opts = { challenge: 'ZmFrZS1jaGFsbGVuZ2U', rpId: 'localhost', allowCredentials: [], userVerification: 'required', timeout: 30000 };
    const st = loginState({
      starts: [{ body: { ...password('admin'), passkeyAlt: true, passkeyStep: identify({ passkey: opts }) } }],
      answers: [() => { api.settings.reauthRequired = false; return { body: done('') }; }],
    });
    await installLogin(page.context(), st);
    let redirected = false;
    await page.route('**/auth/reauth?**', (r) => { redirected = true; return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>left</p>' }); });
    await page.goto('/admin/settings?tab=signin');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await dlg.getByRole('button', { name: 'Stattdessen mit Passkey bestätigen' }).click();
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    await expect(dlg).toHaveCount(0);
    expect(st.calls.filter((c) => c.path === '/auth/flow/start').map((c) => c.body)).toEqual([{ kind: 'reauth' }]);
    expect(st.calls.filter((c) => c.path === '/auth/flow/answer').map((c) => ({ stage: c.body.stage, alt: c.body.alt }))).toEqual([{ stage: 'identify', alt: true }]);
    expect(api.settings.puts).toHaveLength(2);
    expect(api.settings.puts[1]).toEqual(api.settings.puts[0]);
    expect(JSON.stringify(api.settings.puts[1])).toContain('ff-admins');
    await expect(page).toHaveURL(/\/admin\/settings\?tab=signin$/);
    expect(redirected).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('ff_settings_pending'))).toBeNull();
  });

  test('the dialog offers no passkey option when the provider offers none (no passkeyAlt)', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    await installLogin(page.context(), loginState({ starts: [{ body: password('admin') }] }));
    await page.goto('/admin/settings?tab=signin');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    const dlg = page.getByRole('dialog', { name: 'Erneut anmelden' });
    await expect(dlg.getByLabel('Passwort', { exact: true })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Stattdessen mit Passkey bestätigen' })).toHaveCount(0);
  });

  test('each request opens a fresh dialog: closed once, the next save starts a new sign-in', async ({ page, api }) => {
    api.settings.reauthRequired = true;
    const st = loginState({ starts: [() => ({ body: password('admin') })] });
    await installLogin(page.context(), st);
    await page.goto('/admin/settings?tab=signin');
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
    await page.goto('/admin/settings?tab=signin');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => next).toBe('/admin/settings?tab=signin&resume=1');
    await expect(toasts(page).getByText('Einstellungen gespeichert.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=signin$/);
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
    await page.goto('/admin/settings?tab=signin');
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

  test('the server group notes where roles are changed now, while ROLE_TEMPLATES is listed', async ({ page, api }) => {
    const note = 'Rollen lassen sich jetzt unter Personen → Rollen & Rechte ändern; .env-Werte gelten weiter darunter.';
    await page.goto('/admin/settings');
    await expect(card(page, 'Server').getByText(note)).toBeVisible();
    const server = api.settings.groups.find((g) => g.id === 'server')!;
    server.items = server.items.filter((i) => i.key !== 'ROLE_TEMPLATES');
    await page.reload();
    await expect(card(page, 'Server').getByText('PORT', { exact: true })).toBeVisible();
    await expect(page.getByText(note)).toHaveCount(0);
  });

  test('an edited ntfy URL that still carries the redaction marker is refused at the field, nothing is sent', async ({ page, api }) => {
    await page.goto('/admin/settings?tab=notifications');
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
    await page.goto('/admin/settings?tab=media');
    await setting(page, 'Jellyfin-Adresse').getByRole('textbox').fill('http://jellyfin.lan:8096');
    const media = card(page, 'Mediaserver');
    await media.getByRole('button', { name: 'Testen' }).click();
    await expect.poll(() => next).toBe('/admin/settings?tab=media&resume=1');
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
    await page.goto('/admin/settings?tab=media');
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
    await page.goto('/admin/settings?tab=signin');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Die erneute Anmeldung hat nicht gereicht' })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=signin$/);
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
    await page.goto('/admin/settings?tab=signin');
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

// Settings tabs and deep links (Systemcheck Stage 4, Task 10): `?tab=`, `?setting=<KEY>`, the old `#settings-<group>` links.
test.describe('admin: settings tabs and deep links', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Bereiche der Einstellungen' }).getByRole('tab', { name });

  test('six tabs, Allgemein without a parameter, each tab shows its groups; arrows, Home and End move between them', async ({ page }) => {
    await page.goto('/admin/settings');
    const tabs = page.getByRole('tablist', { name: 'Bereiche der Einstellungen' }).getByRole('tab');
    await expect(tabs).toHaveText(['Allgemein', 'Anmeldung', 'Medien', 'Wiedergabe', 'Updates', 'Benachrichtigungen']);
    await expect(tab(page, 'Allgemein')).toHaveAttribute('aria-selected', 'true');
    for (const h of ['Allgemein', 'Systemzustand', 'Sitzungen', 'Server']) await expect(card(page, h)).toBeVisible();
    await expect(card(page, 'Mediaserver')).toHaveCount(0);
    await tab(page, 'Medien').click();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=media$/);
    for (const h of ['Mediaserver', 'Anfragen', 'Datenquellen', 'Empfehlungen']) await expect(card(page, h)).toBeVisible();
    await expect(card(page, 'Server')).toHaveCount(0);
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'set-tab-media');
    await tab(page, 'Medien').press('ArrowRight');
    await expect(tab(page, 'Wiedergabe')).toBeFocused();
    await expect(card(page, 'Downloads')).toBeVisible();
    await page.keyboard.press('End');
    await expect(tab(page, 'Benachrichtigungen')).toHaveAttribute('aria-selected', 'true');
    await expect(card(page, 'Push-Mitteilungen')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(tab(page, 'Allgemein')).toHaveAttribute('tabindex', '0');
    await expect(tab(page, 'Medien')).toHaveAttribute('tabindex', '-1');
  });

  test('?setting=AUTHENTIK_API_TOKEN opens Anmeldung, the row is in view and focused, data-flash set', async ({ page }) => {
    await page.goto('/admin/settings?setting=AUTHENTIK_API_TOKEN');
    await expect(tab(page, 'Anmeldung')).toHaveAttribute('aria-selected', 'true');
    const row = page.locator('#setting-AUTHENTIK_API_TOKEN');
    // the e2e browser asks for reduced motion: a static outline until the next interaction
    await expect(row).toHaveAttribute('data-flash', 'static');
    await expect(row).toBeInViewport();
    await expect(row.getByRole('button', { name: 'Authentik-API-Token ersetzen' })).toBeFocused();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=signin$/);
    await page.keyboard.press('Shift');
    await expect(row).not.toHaveAttribute('data-flash');
  });

  test('an env-locked key is highlighted the same: its row opens, its Move button has the focus', async ({ page }) => {
    await page.goto('/admin/settings?tab=media&setting=PUBLIC_URL');
    await expect(tab(page, 'Allgemein')).toHaveAttribute('aria-selected', 'true');
    const row = page.locator('#setting-PUBLIC_URL');
    await expect(row).toHaveAttribute('data-flash', 'static');
    await expect(row.getByRole('textbox')).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Öffentliche Adresse: in die Einstellungen übernehmen' })).toBeFocused();
  });

  test('?setting=UNKNOWN opens Allgemein without error and highlights nothing', async ({ page }) => {
    await page.goto('/admin/settings?tab=updates&setting=UNKNOWN_KEY');
    await expect(tab(page, 'Allgemein')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(card(page, 'Server')).toBeVisible();
    await expect(page.locator('[data-flash]')).toHaveCount(0);
  });

  test('#settings-recommendations opens Medien at the card', async ({ page }) => {
    await page.goto('/admin/settings#settings-recommendations');
    await expect(tab(page, 'Medien')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'Empfehlungen' })).toBeInViewport();
    await expect(page).toHaveURL(/\/admin\/settings\?tab=media$/);
  });

  test('edits survive a tab switch and the tab shows the unsaved dot', async ({ page, api }) => {
    await page.goto('/admin/settings?tab=signin');
    const signin = tab(page, 'Anmeldung');
    const width = (await signin.boundingBox())!.width;
    await expect(signin.locator('.dot')).toHaveCSS('opacity', '0');
    await setting(page, 'Admin-Gruppe').getByRole('textbox').fill('ff-admins');
    await expect(signin).toHaveAccessibleName('Anmeldung (ungespeicherte Änderungen)');
    await expect(signin.locator('.dot')).toHaveCSS('opacity', '1');
    // the dot's place was kept: the tab did not grow
    expect((await signin.boundingBox())!.width).toBeCloseTo(width, 0);
    await tab(page, 'Updates').click();
    await expect(setting(page, 'Admin-Gruppe')).toHaveCount(0);
    await expect(tab(page, 'Updates')).toHaveAccessibleName('Updates');
    await signin.click();
    await expect(setting(page, 'Admin-Gruppe').getByRole('textbox')).toHaveValue('ff-admins');
    await card(page, 'Anmeldung').getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => api.settings.puts).toEqual([{ values: { ADMIN_GROUP: 'ff-admins' } }]);
    await expect(signin).toHaveAccessibleName('Anmeldung');
  });

  test('a Live-TV key on the settings page goes to Live-TV → Einstellungen', async ({ page, api }) => {
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    await page.goto('/admin/settings?setting=LIVETV_ENCODER');
    await expect(page).toHaveURL(/\/admin\/livetv\?tab=settings$/);
    await expect(page.locator('#setting-LIVETV_ENCODER')).toHaveAttribute('data-flash', 'static');
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('the highlight animates only opacity, then goes', async ({ page }) => {
      await page.goto('/admin/settings?setting=RECO_ENGINE');
      const row = page.locator('#setting-RECO_ENGINE');
      await expect(row).toHaveAttribute('data-flash', '');
      const props = await page.evaluate(() => document.getAnimations()
        .map((a) => a.effect as KeyframeEffect)
        .filter((e) => e.pseudoElement === '::after' && (e.target as HTMLElement | null)?.id === 'setting-RECO_ENGINE')
        .map((e) => [...new Set(e.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k))));
      expect(props).toEqual([['opacity']]);
      await expect(row).not.toHaveAttribute('data-flash', { timeout: 4_000 });
    });
  });
});
