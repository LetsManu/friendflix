// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Quellen, Task 22: the group picker under the Prüfen result (all ticked, unticked groups become skipGroups, search with
// Alle / Keine on the shown groups), the Import section (numbering, logo preference, programme-time offset) and the card's selection and
// pending lines.
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const install = (api: MockState) => { Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' }); };
const writes = (api: MockState, m: string, p: RegExp) => api.admin.livetv.area.calls.filter((c) => c.m === m && p.test(c.p));
const LIST_URL = 'https://iptv.example.com/get.php?username=anna&password=geheim123&type=m3u_plus';

async function menu(page: Page, source: string, item: string) {
  await page.getByRole('button', { name: `Aktionen für ${source}` }).click();
  await page.getByRole('dialog', { name: source }).getByRole('button', { name: item }).click();
}
/** a new list source, checked with Prüfen */
async function checked(page: Page): Promise<Locator> {
  await page.goto('/admin/livetv');
  await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
  await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Hafen Paket');
  await dlg.getByLabel('Senderliste (M3U-Adresse)').fill(LIST_URL);
  await dlg.getByRole('button', { name: 'Prüfen' }).click();
  await expect(dlg.locator('[data-picker]')).toBeVisible();
  return dlg;
}
const row = (dlg: Locator, text: string) => dlg.getByRole('checkbox', { name: text, exact: true });

test.describe('admin: Live-TV, Gruppenauswahl und Import (desktop)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; install(api); });

  test('Prüfen shows the groups with counts, all ticked', async ({ page }) => {
    const dlg = await checked(page);
    const picker = dlg.locator('[data-picker]');
    await expect(picker.getByRole('heading', { name: '18 Gruppen gefunden – welche übernehmen?' })).toBeVisible();
    await expect(row(dlg, 'DE | Sport · 42 Sender')).toBeChecked();
    await expect(picker.getByRole('checkbox')).toHaveCount(18);
    for (const c of await picker.getByRole('checkbox').all()) await expect(c).toBeChecked();
    await expect(picker.locator('[data-picker-total]')).toHaveText('412 von 412 Sendern werden übernommen');
    await expect(picker).toContainText('Neue Gruppen bleiben verborgen, bis du sie unter Gruppen & Rechte freigibst.');
    // 18 groups: the search field is there
    await expect(picker.getByRole('searchbox', { name: 'Gruppe suchen' })).toBeVisible();
  });

  test('unticking a group sends skipGroups', async ({ page, api }) => {
    const dlg = await checked(page);
    await row(dlg, 'Erwachsene · 100 Sender').uncheck();
    await expect(dlg.locator('[data-picker-total]')).toHaveText('312 von 412 Sendern werden übernommen');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    const post = writes(api, 'POST', /\/sources$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toMatchObject({ name: 'Hafen Paket', skipGroups: ['Erwachsene'], numbering: 'chno', numberBase: 1, logoPref: 'm3u', epgShiftMin: 0 });
    await expect(card(page, 'Hafen Paket')).toContainText('Ohne 1 Gruppe');
  });

  test('a list with a few groups has no search field', async ({ page, api }) => {
    api.admin.livetv.area.test = { channels: 30, groups: [{ name: 'Nordlicht', channels: 10 }, { name: 'Hafen', channels: 20 }], samples: ['Nordlicht TV'], epgChannels: null, epgError: null };
    const dlg = await checked(page);
    await expect(dlg.locator('[data-picker]').getByRole('heading', { name: '2 Gruppen gefunden – welche übernehmen?' })).toBeVisible();
    await expect(dlg.getByRole('searchbox')).toHaveCount(0);
    await expect(dlg.locator('[data-picker-total]')).toHaveText('30 von 30 Sendern werden übernommen');
  });

  test('search then Keine unticks only the shown groups', async ({ page, api }) => {
    const dlg = await checked(page);
    const picker = dlg.locator('[data-picker]');
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('sport');
    await expect(picker.getByRole('checkbox')).toHaveCount(3);
    await picker.getByRole('button', { name: 'Keine', exact: true }).click();
    // the counter counts every group, the search does not matter
    await expect(picker.locator('[data-picker-total]')).toHaveText('350 von 412 Sendern werden übernommen');
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('');
    await expect(picker.getByRole('checkbox')).toHaveCount(18);
    await expect(row(dlg, 'DE | Sport · 42 Sender')).not.toBeChecked();
    await expect(row(dlg, 'AT | Sport · 12 Sender')).not.toBeChecked();
    await expect(row(dlg, 'Bergblick Sport · 8 Sender')).not.toBeChecked();
    await expect(row(dlg, 'DE | Nachrichten · 30 Sender')).toBeChecked();
    // Alle on the same search ticks them again
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('SPORT');
    await picker.getByRole('button', { name: 'Alle', exact: true }).click();
    await expect(picker.locator('[data-picker-total]')).toHaveText('412 von 412 Sendern werden übernommen');
    // nothing matches: a line says so
    await picker.getByRole('searchbox', { name: 'Gruppe suchen' }).fill('zzzz');
    await expect(picker).toContainText('Keine Gruppe passt.');
    void api;
  });

  test('import options save', async ({ page, api }) => {
    await page.goto('/admin/livetv');
    await menu(page, 'Nordlicht Paket', 'Bearbeiten');
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    const imp = dlg.getByRole('region', { name: 'Import' });
    await expect(imp.getByRole('radio', { name: 'Aus der Liste (tvg-chno)' })).toHaveAttribute('aria-checked', 'true');
    await expect(imp.getByRole('radio', { name: 'Aus der Senderliste zuerst' })).toHaveAttribute('aria-checked', 'true');
    await expect(imp.locator('[data-shift]')).toHaveText('0');
    await expect(imp).toContainText('Eigene Nummern aus Kanäle bleiben erhalten.');
    await expect(imp).toContainText('Ein eigenes Logo geht immer vor.');
    await expect(imp).toContainText('Für Programmführer, deren Zeiten um Stunden daneben liegen.');
    const base = imp.getByRole('spinbutton', { name: 'Erste Nummer' });
    await expect(base).toBeHidden();
    await imp.getByRole('radio', { name: 'Nach Reihenfolge ab' }).click();
    await expect(base).toBeVisible();
    await base.fill('100');
    await imp.getByRole('radio', { name: 'Aus dem Programmführer zuerst' }).click();
    const less = imp.getByRole('button', { name: 'Um 30 Minuten verringern' });
    await less.click();
    await expect(imp.locator('[data-shift]')).toHaveText('−0,5 Std.');
    await less.click();
    await expect(imp.locator('[data-shift]')).toHaveText('−1 Std.');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    const patch = writes(api, 'PATCH', /\/sources\/src-nordlicht$/);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body).toEqual({ numbering: 'order', numberBase: 100, logoPref: 'xmltv', epgShiftMin: -60 });
  });

  test('the offset stops at +14 h and the first number must be 1–99 999', async ({ page, api }) => {
    api.admin.livetv.area.sources[0]!.epgShiftMin = 810;
    await page.goto('/admin/livetv');
    await menu(page, 'Nordlicht Paket', 'Bearbeiten');
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    const imp = dlg.getByRole('region', { name: 'Import' });
    await expect(imp.locator('[data-shift]')).toHaveText('+13,5 Std.');
    await imp.getByRole('button', { name: 'Um 30 Minuten erhöhen' }).click();
    await expect(imp.locator('[data-shift]')).toHaveText('+14 Std.');
    await expect(imp.getByRole('button', { name: 'Um 30 Minuten erhöhen' })).toBeDisabled();
    await imp.getByRole('radio', { name: 'Nach Reihenfolge ab' }).click();
    await imp.getByRole('spinbutton', { name: 'Erste Nummer' }).fill('100000');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(imp).toContainText('1–99.999');
    await expect(dlg).toBeVisible();
    expect(writes(api, 'PATCH', /\/sources\//)).toHaveLength(0);
  });

  test('the card shows the selection and Auswahl ändern reopens the picker with a new Prüfen', async ({ page, api }) => {
    const skip = ['DE | Kinder', 'Musik', 'Filme', 'Serien', 'Wetter', 'Erwachsene'];
    api.admin.livetv.area.sources[0]!.skipGroups = skip;
    await page.goto('/admin/livetv');
    const c = card(page, 'Nordlicht Paket');
    await expect(c.locator('[data-skipped]')).toHaveText('Ohne 6 Gruppen · Auswahl ändern');
    const change = c.getByRole('button', { name: 'Auswahl ändern' });
    expect((await change.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await change.click();
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    // Prüfen ran at once, for the stored list
    await expect(dlg.locator('[data-picker]')).toBeVisible();
    expect(writes(api, 'POST', /\/sources\/test$/).map((w) => w.body)).toEqual([{ allowLan: false, sourceId: 'src-nordlicht' }]);
    await expect(dlg.getByRole('checkbox')).toHaveCount(18);
    for (const n of ['DE | Kinder · 20 Sender', 'Musik · 22 Sender', 'Filme · 30 Sender', 'Serien · 28 Sender', 'Wetter · 5 Sender', 'Erwachsene · 100 Sender']) await expect(row(dlg, n)).not.toBeChecked();
    await expect(row(dlg, 'DE | Sport · 42 Sender')).toBeChecked();
    await expect(dlg.locator('[data-picker-total]')).toHaveText('207 von 412 Sendern werden übernommen');
    // ticking one back saves the rest
    await row(dlg, 'Musik · 22 Sender').check();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    const patch = writes(api, 'PATCH', /\/sources\/src-nordlicht$/);
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body).toEqual({ skipGroups: ['DE | Kinder', 'Erwachsene', 'Filme', 'Serien', 'Wetter'] });
    await expect(card(page, 'Nordlicht Paket').locator('[data-skipped]')).toHaveText('Ohne 5 Gruppen · Auswahl ändern');
  });

  test('a skipped group the list does not have stays skipped: a note, not dirty, an explicit save still sends it', async ({ page, api }) => {
    api.admin.livetv.area.sources[0]!.skipGroups = ['Erwachsene', 'Alte Gruppe'];
    await page.goto('/admin/livetv');
    await card(page, 'Nordlicht Paket').getByRole('button', { name: 'Auswahl ändern' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    await expect(dlg.locator('[data-picker-total]')).toHaveText('312 von 412 Sendern werden übernommen');
    await expect(dlg.locator('[data-picker-kept]')).toHaveText('1 ausgeschlossene Gruppe ist in dieser Liste gerade nicht dabei – sie bleibt ausgeschlossen.');
    // untouched: not dirty, so Abbrechen closes without asking and nothing is written
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'PATCH', /\/sources\//)).toHaveLength(0);
    // a change of what is visible saves the union
    await card(page, 'Nordlicht Paket').getByRole('button', { name: 'Auswahl ändern' }).click();
    await expect(dlg.locator('[data-picker]')).toBeVisible();
    await row(dlg, 'Musik · 22 Sender').uncheck();
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'PATCH', /\/sources\/src-nordlicht$/)[0]!.body).toEqual({ skipGroups: ['Erwachsene', 'Musik', 'Alte Gruppe'] });
  });

  test('an untouched selection sends no skipGroups, so the kept name stays as stored', async ({ page, api }) => {
    api.admin.livetv.area.sources[0]!.skipGroups = ['Erwachsene', 'Alte Gruppe'];
    await page.goto('/admin/livetv');
    await card(page, 'Nordlicht Paket').getByRole('button', { name: 'Auswahl ändern' }).click();
    const dlg = page.getByRole('dialog', { name: 'Quelle bearbeiten' });
    await expect(dlg.locator('[data-picker-kept]')).toBeVisible();
    // a rename makes the sheet dirty; the unchanged selection sends no skipGroups, the stored list stays whole on the server
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Nordlicht Neu');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes(api, 'PATCH', /\/sources\/src-nordlicht$/)[0]!.body).toEqual({ name: 'Nordlicht Neu' });
    expect(api.admin.livetv.area.sources[0]!.skipGroups).toEqual(['Erwachsene', 'Alte Gruppe']);
  });

  test('a card without skipped groups shows no selection line', async ({ page }) => {
    await page.goto('/admin/livetv');
    await expect(card(page, 'Nordlicht Paket').locator('[data-state]')).toBeVisible();
    await expect(card(page, 'Nordlicht Paket').locator('[data-skipped]')).toHaveCount(0);
  });

  test("the card's pending line links to the groups tab", async ({ page }) => {
    await page.goto('/admin/livetv');
    const link = card(page, 'Nordlicht Paket').getByRole('link', { name: '2 neue Gruppen warten auf Freigabe' });
    await expect(link).toHaveAttribute('href', '/admin/livetv?tab=groups&pending=1');
    await link.click();
    await expect(page).toHaveURL(/\/admin\/livetv\?tab=groups&pending=1$/);
    await expect(page.getByRole('tab', { name: 'Gruppen & Rechte' })).toHaveAttribute('aria-selected', 'true');
  });

  test.describe('refusals', () => {
    test.use({ allowedConsole: /status of (422|409)/ }); // the mocked refusals

    test('a failed new Prüfen keeps the result, the picker and the selection, and says why', async ({ page, api }) => {
      const dlg = await checked(page);
      await row(dlg, 'Erwachsene · 100 Sender').uncheck();
      const before = await dlg.locator('.foot').boundingBox();
      api.admin.livetv.area.testBusy = true;
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.getByRole('alert')).toContainText('Eine Prüfung läuft gerade schon.');
      await expect(dlg.locator('[data-picker]')).toBeVisible();
      await expect(dlg.getByRole('checkbox')).toHaveCount(18);
      await expect(row(dlg, 'Erwachsene · 100 Sender')).not.toBeChecked();
      await expect(dlg.locator('[data-picker-total]')).toHaveText('312 von 412 Sendern werden übernommen');
      expect(await dlg.locator('.foot').boundingBox()).toEqual(before);
    });

    test('Prüfen refusals say what is wrong: too big, or another check running', async ({ page, api }) => {
      api.admin.livetv.area.test = { error: 'too_big' };
      await page.goto('/admin/livetv');
      await page.getByRole('button', { name: 'Quelle hinzufügen' }).click();
      const dlg = page.getByRole('dialog', { name: 'Quelle hinzufügen' });
      await dlg.getByLabel('Senderliste (M3U-Adresse)').fill(LIST_URL);
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.getByRole('alert')).toContainText('Liste zu groß (über 50 MB, 2.000 Gruppen oder 200.000 Einträge)');
      await expect(dlg.locator('[data-picker]')).toHaveCount(0);
      // another check of this admin still runs: try again, it works
      api.admin.livetv.area.test = { channels: 5, groups: [{ name: 'Hafen', channels: 5 }], samples: [], epgChannels: null, epgError: null };
      api.admin.livetv.area.testBusy = true;
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.getByRole('alert')).toContainText('Eine Prüfung läuft gerade schon.');
      await dlg.getByRole('button', { name: 'Prüfen' }).click();
      await expect(dlg.locator('[data-picker]')).toBeVisible();
      await expect(dlg.getByRole('alert')).toHaveCount(0);
    });
  });

  test('a new Prüfen keeps the selection already made', async ({ page }) => {
    const dlg = await checked(page);
    await row(dlg, 'Erwachsene · 100 Sender').uncheck();
    await dlg.getByRole('button', { name: 'Prüfen' }).click();
    await expect(dlg.locator('[data-test-result]')).toBeVisible();
    await expect(row(dlg, 'Erwachsene · 100 Sender')).not.toBeChecked();
    await expect(dlg.locator('[data-picker-total]')).toHaveText('312 von 412 Sendern werden übernommen');
  });
});
