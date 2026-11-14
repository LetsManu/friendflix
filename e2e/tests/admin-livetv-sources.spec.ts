// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Quellen (/admin/livetv), Task 21: the installed area's tabs, the provider-list cards, the add/edit sheet with
// Prüfen before Speichern, the refresh with its spinner and toast, deleting, and own feeds with the one-time push result.
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const writes = (api: MockState, m: string, p: RegExp) => api.admin.livetv.area.calls.filter((c) => c.m === m && p.test(c.p));
const LIST_URL = 'https://iptv.example.com/get.php?username=anna&password=geheim123&type=m3u_plus';

async function menu(page: Page, source: string, item: string) {
  await page.getByRole('button', { name: `Aktionen für ${source}` }).click();
  await page.getByRole('dialog', { name: source }).getByRole('button', { name: item }).click();
}

test.describe('admin: Live-TV, Quellen (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('the area opens on Quellen with its tabs, the list card and the own streams', async ({ page }) => {
    await page.goto('/admin/livetv');
    const tabs = page.getByRole('tablist', { name: 'Live-TV-Bereiche' });
    await expect(tabs.getByRole('tab')).toHaveText(['Quellen', 'Kanäle', 'Gruppen & Rechte', 'Programmführer', 'Live-Status']);
    await expect(tabs.getByRole('tab', { name: 'Quellen' })).toHaveAttribute('aria-selected', 'true');
    const c = card(page, 'Nordlicht Paket');
    await expect(c).toContainText('Anbieterliste');
    await expect(c).toContainText('https://iptv.example.com/…');
    await expect(c.locator('[data-state]')).toHaveText('Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6.812 Sendungen');
    await expect(c).toContainText('2 neue Gruppen warten auf Freigabe');
    await expect(c.getByLabel('Aktualisieren', { exact: true })).toHaveValue('24h');
    const own = card(page, 'Eigene Streams');
    await expect(own.locator('[data-ports]')).toHaveText('Gesendete Streams kommen über UDP 9000–9009 an. Nur diese Ports in der Firewall öffnen.');
    const wolkenlos = own.locator('li', { hasText: 'Kanal Wolkenlos' });
    await expect(wolkenlos).toContainText('Port 9001');
    await expect(wolkenlos).toContainText('ff-QW7RT5…');
    await expect(wolkenlos.locator('[data-state="receiving"]')).toHaveText('Sendet');
    await expect(wolkenlos).toContainText('2 abgelehnte Versuche (1 Std.)');
    await expect(own.locator('li', { hasText: 'Hafenkanal' })).toContainText('Abgeholt · HLS');
    // the status tab shows the installed Live TV (Task 26: its card keeps the version and the off button)
    await tabs.getByRole('tab', { name: 'Live-Status' }).click();
    await expect(page).toHaveURL(/\?tab=status$/);
    await expect(page.getByText('Live-TV läuft.')).toBeVisible();
  });

  test('with no source yet, Quelle hinzufügen is a full-size button (a global .bar style once clipped it to a 3-px line)', async ({ page, api }) => {
    api.admin.livetv.area.sources = [];
    await page.goto('/admin/livetv');
    await expect(page.getByText('Noch keine Quelle.', { exact: false })).toBeVisible();
    const add = page.getByRole('button', { name: 'Quelle hinzufügen' });
    await expect(add).toBeVisible();
    const box = await add.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // not clipped by its row: the point in the middle of the button hits the button (a 3-px overflow-hidden row would hide it)
    expect(await add.evaluate((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && b.contains(hit); })).toBe(true);
    await add.click();
    await expect(page.getByRole('dialog', { name: 'Quelle hinzufügen' })).toBeVisible();
  });

  test('add a list source: Prüfen then Speichern', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    await expect(dlg.getByRole('radio', { name: 'Anbieterliste' })).toHaveAttribute('aria-checked', 'true');
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
    const url = dlg.getByLabel('Senderliste (M3U-Adresse)');
    await expect(url).toHaveAttribute('type', 'password');
    await url.fill(LIST_URL);
    // the M3U and the XMLTV address are both password-type with their own "anzeigen"
    await expect(dlg.getByLabel('Programmführer (XMLTV-Adresse)')).toHaveAttribute('type', 'password');
    await dlg.getByRole('button', { name: 'anzeigen' }).first().click();
    await expect(url).toHaveAttribute('type', 'text');
    const save = dlg.getByRole('button', { name: 'Speichern' });
    await expect(save).toBeDisabled();
    await expect(dlg).toContainText('Erst prüfen, dann speichern.');
    await dlg.getByRole('button', { name: 'Prüfen' }).click();
    await expect(dlg.locator('[data-test-result]')).toHaveText('412 Sender in 18 Gruppen · EPG: 398 Kanäle');
    await expect(dlg).toContainText('Zum Beispiel: Nordlicht TV, Hafenkanal, Bergblick Sport, Kinderinsel, Sternwarte 24');
    await expect(save).toBeEnabled();
    // another address needs another check
    await url.fill(`${LIST_URL}&x=1`);
    await expect(save).toBeDisabled();
    await url.fill(LIST_URL);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dlg).toHaveCount(0);
    await expect(toasts(page).getByText('Quelle hinzugefügt.')).toBeVisible();
    expect(writes(api, 'POST', /\/sources\/test$/)[0]!.body).toEqual({ url: LIST_URL, epgUrl: null, allowLan: false });
    const post = writes(api, 'POST', /\/sources$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toMatchObject({ name: 'Hafen Paket', url: LIST_URL, allowLan: false, refresh: '24h', skipGroups: [], enabled: true });
    const c = card(page, 'Hafen Paket');
    await expect(c).toContainText('https://iptv.example.com/…');
    await expect(c).toContainText('Noch nicht aktualisiert');
    expect(post[0]!.body.epgUrl).toBeNull();
    await expect(page.getByText('geheim123')).toHaveCount(0);
  });


  test('edit leaves the url empty and PATCH has none', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await menu(page, 'Nordlicht Paket', 'Bearbeiten');
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    const url = dlg.getByLabel('Senderliste (M3U-Adresse)');
    await expect(url).toHaveValue('');
    await expect(url).toHaveAttribute('placeholder', 'unverändert lassen');
    await expect(dlg).toContainText('Gespeichert: https://iptv.example.com/…');
    await expect(dlg.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Nordlicht Paket');
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Nordlicht Plus');
    // nothing about the fetch changed: no new check needed
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    const patch = writes(api, 'PATCH', /\/sources\/src-nordlicht$/);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body).toEqual({ name: 'Nordlicht Plus' });
    expect('url' in patch[0]!.body).toBe(false);
    await expect(card(page, 'Nordlicht Plus')).toContainText('https://iptv.example.com/…');
  });

  test('Jetzt aktualisieren shows the spinner and a toast', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    const c = card(page, 'Nordlicht Paket');
    const btn = c.getByRole('button', { name: 'Jetzt aktualisieren' });
    const before = await btn.boundingBox();
    await btn.click();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    const during = await btn.boundingBox();
    expect(during?.width).toBe(before?.width);
    await expect(toasts(page).getByText('Aktualisiert: 415 Sender (+3 / −0)')).toBeVisible();
    await expect(btn).not.toHaveAttribute('aria-busy', 'true');
    await expect(c.locator('[data-state]')).toContainText('415 Sender (+3 / −0)');
    expect(writes(api, 'POST', /\/sources\/src-nordlicht\/refresh$/)).toHaveLength(1);
  });

  test('a failed refresh says the error in words', async ({ page, api }) => {
    api.admin.livetv.area.refreshOutcome = { error: 'timeout' };
    await page.goto('/admin/livetv');
    const c = card(page, 'Nordlicht Paket');
    await c.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
    await expect(toasts(page).getByText('Aktualisieren fehlgeschlagen: Zeitüberschreitung')).toBeVisible();
    await expect(c.locator('[data-state]')).toContainText('Zeitüberschreitung · Zuletzt aktualisiert heute 06:12');
  });

  test('delete confirm names 412 channels', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await menu(page, 'Nordlicht Paket', 'Löschen');
    const dlg = page.getByRole('alertdialog', { name: '„Nordlicht Paket“ löschen?' });
    await expect(dlg).toContainText('Die 412 Sender dieser Quelle werden gelöscht, ihre Änderungen auch.');
    await dlg.getByRole('button', { name: 'Löschen' }).click();
    await expect(card(page, 'Nordlicht Paket')).toHaveCount(0);
    await expect(toasts(page).getByText('Quelle gelöscht.')).toBeVisible();
    expect(writes(api, 'DELETE', /\/sources\/src-nordlicht$/)).toHaveLength(1);
  });

  test('turning a source off and choosing the interval write at once', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    const c = card(page, 'Nordlicht Paket');
    await c.getByLabel('Aktualisieren', { exact: true }).selectOption('6h');
    await expect.poll(() => writes(api, 'PATCH', /\/sources\/src-nordlicht$/).map((w) => w.body)).toEqual([{ refresh: '6h' }]);
    await menu(page, 'Nordlicht Paket', 'Deaktivieren');
    await expect(c).toContainText('Deaktiviert');
    await expect(c.getByRole('button', { name: 'Jetzt aktualisieren' })).toBeDisabled();
    expect(writes(api, 'PATCH', /\/sources\/src-nordlicht$/).map((w) => w.body)[1]).toEqual({ enabled: false });
  });

  test('push feed shows the one-time result', async ({ page, api, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/admin/livetv');
    const own = card(page, 'Eigene Streams');
    await own.getByRole('button', { name: 'Stream hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Stream hinzufügen' });
    await expect(dlg.getByRole('radio', { name: 'FriendFlix holt den Stream' })).toHaveAttribute('aria-checked', 'true');
    await dlg.getByRole('radio', { name: 'Encoder sendet an FriendFlix' }).click();
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Sternwarte 24');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();

    const res = page.getByRole('dialog', { name: 'Zugangsdaten für Sternwarte 24' });
    await expect(res.getByLabel('Server', { exact: true })).toHaveValue('friend.example.com');
    await expect(res.getByLabel('Port', { exact: true })).toHaveValue('9000');
    await expect(res.getByLabel('Stream-ID', { exact: true })).toHaveValue('ff-AB12CDEFGH2345JK');
    await expect(res.getByLabel('Passphrase', { exact: true })).toHaveValue('Zq3xV9mB2nK7pL4wR8tY6uH1jG5fD0sA');
    await expect(res.getByLabel('SRT-Adresse', { exact: true })).toHaveValue('srt://friend.example.com:9000?streamid=ff-AB12CDEFGH2345JK&passphrase=Zq3xV9mB2nK7pL4wR8tY6uH1jG5fD0sA&pbkeylen=32&mode=caller&latency=200000');
    await expect(res.getByRole('button', { name: 'Kopieren' })).toHaveCount(5);
    await expect(res).toContainText('Die Passphrase wird nur jetzt angezeigt.');
    await expect(res).toContainText('Die Firewall bzw. der Router muss UDP-Port 9000 an den Server weiterleiten.');
    await res.getByText('OBS/Encoder einrichten').click();
    await expect(res).toContainText('Server = die SRT-Adresse, Streamschlüssel leer lassen.');
    await res.getByRole('button', { name: 'Kopieren' }).nth(3).click();
    await expect(toasts(page).getByText('In die Zwischenablage kopiert.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Zq3xV9mB2nK7pL4wR8tY6uH1jG5fD0sA');
    expect(writes(api, 'POST', /\/channels$/)[0]!.body).toEqual({ ingest: 'push', name: 'Sternwarte 24' });

    await res.getByRole('button', { name: 'Fertig' }).click();
    await expect(res).toHaveCount(0);
    const row = own.locator('li', { hasText: 'Sternwarte 24' });
    await expect(row).toContainText('ff-AB12CD…');
    await expect(row).toContainText('Port 9000');
    await expect(row.locator('[data-state="idle"]')).toHaveText('Keine Übertragung');
    // the rejected line had its row before the ingest state came, and stays empty at 0
    await expect(row.locator('[data-rejected]')).toHaveText('');
    // the values never come back
    await expect(page.getByText('Zq3xV9mB2nK7pL4wR8tY6uH1jG5fD0sA')).toHaveCount(0);
    expect(await page.locator('input').evaluateAll((els) => els.some((e) => (e as HTMLInputElement).value.includes('Zq3x')))).toBe(false);
  });

  test('new credentials ask first and show the one-time result again', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await menu(page, 'Kanal Wolkenlos', 'Zugangsdaten neu erzeugen');
    const ask = page.getByRole('alertdialog', { name: 'Zugangsdaten neu erzeugen' });
    await expect(ask).toContainText('Der Encoder muss danach die neuen Daten bekommen.');
    await ask.getByRole('button', { name: 'Zugangsdaten neu erzeugen' }).click();
    const res = page.getByRole('dialog', { name: 'Zugangsdaten für Kanal Wolkenlos' });
    await expect(res.getByLabel('Port', { exact: true })).toHaveValue('9001');
    await res.getByRole('button', { name: 'Fertig' }).click();
    await expect(res).toHaveCount(0);
    expect(writes(api, 'POST', /\/channels\/ch-wolkenlos\/push-credentials$/)).toHaveLength(1);
  });

  test('a pulled feed takes its kind from the URL', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await card(page, 'Eigene Streams').getByRole('button', { name: 'Stream hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Stream hinzufügen' });
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Bergblick Sport');
    const url = dlg.getByLabel('Stream-Adresse');
    await expect(url).toHaveAttribute('type', 'password');
    await url.fill('srt://192.0.2.10:9000?streamid=bergblick');
    await expect(dlg.getByLabel('Art', { exact: true })).toHaveValue('srt');
    await url.fill('http://192.0.2.10:8080/bergblick.ts');
    await expect(dlg.getByLabel('Art', { exact: true })).toHaveValue('ts');
    await url.fill('https://iptv.example.com/live/bergblick.m3u8');
    await expect(dlg.getByLabel('Art', { exact: true })).toHaveValue('hls');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'POST', /\/channels$/)[0]!.body).toEqual({ ingest: 'pull', name: 'Bergblick Sport', url: 'https://iptv.example.com/live/bergblick.m3u8', kind: 'hls', allowLan: false });
    await expect(card(page, 'Eigene Streams').locator('li', { hasText: 'Bergblick Sport' })).toContainText('Abgeholt · HLS');
  });


  test('closing a sheet with input asks first', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
    await page.keyboard.press('Escape');
    const ask = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await ask.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dlg.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Hafen Paket');
    await dlg.getByRole('button', { name: 'Schließen' }).click();
    await ask.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Quelle hinzufügen' })).toBeFocused();
  });

  test('push feed states, the range and a port that left it', async ({ page, api }) => {
    const a = api.admin.livetv.area;
    a.ports = Array.from({ length: 8 }, (_, i) => 9002 + i); // LIVETV_SRT_PORTS moved: 9001 is out
    a.feeds.push({ id: 'ch-stern', sourceId: 'src-feeds', name: 'Sternwarte 24', number: 803, streamKind: 'srt', push: { port: 9003, hint: 'ff-ST3RN2' }, ingest: null });
    await page.goto('/admin/livetv');
    const own = card(page, 'Eigene Streams');
    await expect(own.locator('[data-ports]')).toHaveText('Gesendete Streams kommen über UDP 9002–9009 an. Nur diese Ports in der Firewall öffnen.');
    const stern = own.locator('li', { hasText: 'Sternwarte 24' });
    await expect(stern.locator('[data-state="pending"]')).toHaveText('Noch nicht bereit');
    const wolkenlos = own.locator('li', { hasText: 'Kanal Wolkenlos' });
    await expect(wolkenlos.locator('[data-state="out_of_range"]')).toHaveText('Port außerhalb des Bereichs');
    await expect(wolkenlos).toContainText('Port 9001 liegt nicht mehr im Bereich');
    await menu(page, 'Kanal Wolkenlos', 'Neuen Port zuweisen');
    await expect(toasts(page).getByText('Neuer Port: 9002')).toBeVisible();
    await expect(wolkenlos.locator('[data-state="receiving"]')).toHaveText('Sendet');
    await expect(wolkenlos).toContainText('Port 9002');
    await expect(wolkenlos).not.toContainText('liegt nicht mehr im Bereich');
    expect(writes(api, 'POST', /\/channels\/ch-wolkenlos\/push-port$/)).toHaveLength(1);
  });

  test('an unknown range shows no ports line and every push feed as unknown', async ({ page, api }) => {
    api.admin.livetv.area.portsKnown = false;
    await page.goto('/admin/livetv');
    const own = card(page, 'Eigene Streams');
    const wolkenlos = own.locator('li', { hasText: 'Kanal Wolkenlos' });
    await expect(wolkenlos.locator('[data-state="error"]')).toHaveText('Zustand unbekannt');
    await expect(wolkenlos).not.toContainText('liegt nicht mehr im Bereich');
    await expect(own.locator('[data-ports]')).toHaveText('');
  });

  test('without a known host the result leaves out Server and SRT-Adresse and says what to set', async ({ page, api }) => {
    api.admin.livetv.area.host = null;
    await page.goto('/admin/livetv');
    await card(page, 'Eigene Streams').getByRole('button', { name: 'Stream hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Stream hinzufügen' });
    await dlg.getByRole('radio', { name: 'Encoder sendet an FriendFlix' }).click();
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Sternwarte 24');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    const res = page.getByRole('dialog', { name: 'Zugangsdaten für Sternwarte 24' });
    await expect(res.getByRole('button', { name: 'Kopieren' })).toHaveCount(3);
    await expect(res.getByLabel('Server', { exact: true })).toHaveCount(0);
    await expect(res.getByLabel('SRT-Adresse', { exact: true })).toHaveCount(0);
    await expect(res).toContainText('Der Servername ist noch unbekannt. Setze LIVETV_SRT_HOST oder PUBLIC_URL und erzeuge danach neue Zugangsdaten.');
  });

  test('choosing Eigene Streams with typed input asks first', async ({ page }) => {
    await page.goto('/admin/livetv');
    await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
    await dlg.getByRole('radio', { name: 'Eigene Streams' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await ask.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dlg.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Hafen Paket');
    await expect(page.getByRole('dialog', { name: 'Stream hinzufügen' })).toHaveCount(0);
    await dlg.getByRole('radio', { name: 'Eigene Streams' }).click();
    await ask.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page.getByRole('dialog', { name: 'Stream hinzufügen' })).toBeVisible();
    await expect(dlg).toHaveCount(0);
  });

  test('removing the guide on edit checks without it and saves epgUrl null', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await menu(page, 'Nordlicht Paket', 'Bearbeiten');
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    const remove = dlg.getByRole('button', { name: 'Programmführer entfernen' });
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await remove.click();
    await expect(dlg).toContainText('Wird beim Speichern entfernt.');
    await dlg.getByRole('button', { name: 'Prüfen' }).click();
    await expect(dlg.locator('[data-test-result]')).toBeVisible();
    expect(writes(api, 'POST', /\/sources\/test$/)[0]!.body).toEqual({ epgUrl: null, allowLan: false, sourceId: 'src-nordlicht' });
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'PATCH', /\/sources\/src-nordlicht$/)[0]!.body).toEqual({ epgUrl: null });
    await expect(card(page, 'Nordlicht Paket')).toContainText('Kein Programmführer');
  });

  test('a refresh that already runs is not started twice; its outcome still comes', async ({ page, api }) => {
    api.admin.livetv.area.refreshing['src-nordlicht'] = 2;
    await page.goto('/admin/livetv');
    const c = card(page, 'Nordlicht Paket');
    const btn = c.getByRole('button', { name: 'Jetzt aktualisieren' });
    await btn.click();
    await expect(toasts(page).getByText('Die Quelle wird gerade schon aktualisiert.')).toBeVisible();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    await expect(toasts(page).getByText('Aktualisiert: 415 Sender (+3 / −0)')).toBeVisible();
    await expect(btn).not.toHaveAttribute('aria-busy', 'true');
  });

  test('a write livetv has not taken yet says so; a hidden feed is off; an in-range port is not moved', async ({ page, api }) => {
    const a = api.admin.livetv.area;
    a.synced = false;
    a.feeds.push({ id: 'ch-insel', sourceId: 'src-feeds', name: 'Kinderinsel', number: 804, streamKind: 'srt', push: { port: 9004, hint: 'ff-K1ND3R' }, ingest: { state: 'idle', rejected1h: 0 }, hidden: true });
    await page.goto('/admin/livetv');
    const own = card(page, 'Eigene Streams');
    await expect(own.locator('li', { hasText: 'Kinderinsel' }).locator('[data-state="off"]')).toHaveText('Abgeschaltet');
    // Kanal Wolkenlos (9001) is in the range: no "Neuen Port zuweisen"
    await page.getByRole('button', { name: 'Aktionen für Kanal Wolkenlos' }).click();
    const m = page.getByRole('dialog', { name: 'Kanal Wolkenlos' });
    await expect(m.getByRole('button', { name: 'Zugangsdaten neu erzeugen' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Neuen Port zuweisen' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await own.getByRole('button', { name: 'Stream hinzufügen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Stream hinzufügen' });
    await dlg.getByRole('radio', { name: 'Encoder sendet an FriendFlix' }).click();
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Sternwarte 24');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    const res = page.getByRole('dialog', { name: 'Zugangsdaten für Sternwarte 24' });
    await expect(res.locator('[data-syncing]')).toHaveText('Wird an Live-TV übertragen …');
    await res.getByRole('button', { name: 'Fertig' }).click();

    await menu(page, 'Kinderinsel', 'Löschen');
    await page.getByRole('alertdialog', { name: '„Kinderinsel“ löschen?' }).getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Stream gelöscht. Wird an Live-TV übertragen …')).toBeVisible();
  });

  test('a push row keeps its height when the ingest state arrives (600 and 1280 px)', async ({ page }) => {
    // the ingest answer waits for a gate, so the row is measured with the skeleton chip and again with the real one
    let release: () => void = () => undefined;
    await page.context().route('**/api/admin/livetv/ingest', async (route) => {
      await new Promise<void>((r) => { release = r; });
      await route.fallback();
    });
    for (const width of [600, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/livetv');
      const own = card(page, 'Eigene Streams');
      for (const name of ['Kanal Wolkenlos', 'Hafenkanal']) await expect(own.locator('li', { hasText: name })).toBeVisible();
      const rows = own.locator('li');
      await expect(own.locator('[data-state]')).toHaveCount(0);
      const before = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      release();
      await expect(own.locator('li', { hasText: 'Kanal Wolkenlos' }).locator('[data-state="receiving"]')).toBeVisible();
      await expect(own.locator('[data-ports]')).not.toHaveText('');
      const after = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(after, `row heights at ${width} px`).toEqual(before);
    }
  });


  test.describe('refusals', () => {
    // mocked refusals: the browser logs the 4xx answers
    test.use({ allowedConsole: /Failed to load resource: the server responded with a status of (400|409|422|503)/ });

    test('a failed Prüfen says why and keeps Speichern off', async ({ page, api }) => {
      api.admin.livetv.area.test = { error: 'denied' };
      await page.goto('/admin/livetv');
      await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
      await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
      await dlg.getByLabel('Senderliste (M3U-Adresse)').fill(LIST_URL);
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.getByRole('alert')).toHaveText('Zugang abgelehnt (Benutzername oder Passwort?)');
      await expect(dlg.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    });

    test('a failed guide still lets the list be saved; a single-label host and an unreached livetv are refused', async ({ page, api }) => {
      api.admin.livetv.area.test = { channels: 412, groups: [{ name: 'DE | Sport', channels: 300 }, { name: 'DE | Regional', channels: 112 }], samples: ['Nordlicht TV'], epgChannels: null, epgError: 'incomplete' };
      await page.goto('/admin/livetv');
      await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
      await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
      const url = dlg.getByLabel('Senderliste (M3U-Adresse)');
      await url.fill('http://backend/list.m3u');
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.getByRole('alert')).toHaveText('Adresse nicht erlaubt (internes Netz)');
      await url.fill(LIST_URL);
      await dlg.getByLabel('Programmführer (XMLTV-Adresse)').fill('https://iptv.example.com/xmltv.php');
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.locator('[data-test-result]')).toHaveText('412 Sender in 2 Gruppen');
      await expect(dlg.locator('[data-test-epg-error]')).toHaveText('Programm: Unvollständig übertragen');
      await expect(dlg.getByRole('button', { name: 'Speichern' })).toBeEnabled();
      api.admin.livetv.area.test = { error: 'livetv_unreachable', status: 503 };
      await url.fill(`${LIST_URL}&x=1`);
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.getByRole('alert')).toHaveText('Live-TV-Dienst nicht erreichbar');
      await expect(dlg.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    });

    test('a check that still runs says so and Prüfen stays usable', async ({ page, api }) => {
      api.admin.livetv.area.testBusy = true;
      await page.goto('/admin/livetv');
      await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
      await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
      await dlg.getByLabel('Senderliste (M3U-Adresse)').fill(LIST_URL);
      const check = dlg.getByRole('button', { name: 'Prüfen' });
      await check.click();
      await expect(dlg.getByRole('alert')).toHaveText('Eine Prüfung läuft gerade schon. Versuch es gleich noch einmal.');
      await expect(check).toBeEnabled();
      await check.click();
      await expect(dlg.locator('[data-test-result]')).toHaveText('412 Sender in 18 Gruppen · EPG: 398 Kanäle');
      await expect(dlg.getByRole('button', { name: 'Speichern' })).toBeEnabled();
    });

    test('a kind that does not fit the address says why', async ({ page, api }) => {
      api.admin.livetv.area.calls.length = 0;
      await page.goto('/admin/livetv');
      await card(page, 'Eigene Streams').getByRole('button', { name: 'Stream hinzufügen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Stream hinzufügen' });
      await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Bergblick Sport');
      await dlg.getByLabel('Stream-Adresse').fill('https://iptv.example.com/live/bergblick.m3u8');
      await dlg.getByLabel('Art', { exact: true }).selectOption('srt');
      await dlg.getByRole('button', { name: 'Anlegen' }).click();
      await expect(dlg.getByRole('alert')).toHaveText('Die Art passt nicht zur Adresse: SRT nur mit srt://, HLS und MPEG-TS nur mit http:// oder https://.');
    });

    test('ports full shows the message', async ({ page, api }) => {
      const a = api.admin.livetv.area;
      for (const port of a.ports.filter((p) => p !== 9001)) a.feeds.push({ id: `ch-p${port}`, sourceId: 'src-feeds', name: `Kinderinsel ${port}`, number: null, streamKind: 'srt', push: { port, hint: 'ff-ZZ22ZZ' }, ingest: { state: 'idle', rejected1h: 0 } });
      await page.goto('/admin/livetv');
      await card(page, 'Eigene Streams').getByRole('button', { name: 'Stream hinzufügen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Stream hinzufügen' });
      await dlg.getByRole('radio', { name: 'Encoder sendet an FriendFlix' }).click();
      await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Sternwarte 24');
      await dlg.getByRole('button', { name: 'Anlegen' }).click();
      await expect(dlg.getByRole('alert')).toHaveText('Alle 10 Ports für gesendete Streams sind belegt. Vergrößere LIVETV_SRT_PORTS in der .env.');
      await expect(dlg.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Sternwarte 24');
      await expect(page.getByRole('dialog', { name: /Zugangsdaten/ })).toHaveCount(0);
    });
  });
});
