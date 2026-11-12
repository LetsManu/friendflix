// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { adminState, auid } from '../mocks/admin.js';

const ANNA = auid(2);
const CLARA = auid(4);
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const logged = (api: { log: string[] }, re: RegExp) => api.log.some((l) => re.test(l));
const menu = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: 'Aktionen', exact: true }).click();
  return page.getByRole('dialog', { name: 'Anna Beispiel' });
};

test.describe('admin user detail (desktop)', () => {
  test.use({ allowedConsole: /status of (400|404|409|500|501|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('detail shows header and totals', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByRole('link', { name: 'Anna Beispiel' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${ANNA}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByRole('heading', { level: 2, name: 'Anna Beispiel' })).toBeVisible();
    await expect(head).toContainText('anna@example.org');
    await expect(head).toContainText('Freund');
    await expect(head.getByText('Aktiv', { exact: true })).toBeVisible();
    await expect(head.getByText('Authenticator-App')).toBeVisible();
    await expect(head.getByText('Wiederherstellungscodes')).toBeVisible();

    const totals = page.getByRole('region', { name: 'Nutzung' });
    await expect(totals).toContainText('Letzte 7 Tage');
    await expect(totals).toContainText('3,5 Std.');
    await expect(totals).toContainText('15 Streams');
    await expect(totals).toContainText('140 Std.');
    await expect(totals).toContainText('Wünsche');
    const linked = page.getByRole('region', { name: 'Verknüpfte Konten' });
    await expect(linked).toContainText('Verbunden');
    await expect(linked.getByRole('button', { name: /Reparieren/ })).toHaveCount(0);
    const body = page.locator('main, body').first();
    await expect(body).not.toContainText('undefined');
    await expect(body).not.toContainText('Seerr');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('linked accounts: unknown is neutral, broken offers Repair', async ({ page, api }) => {
    api.admin.linkedOk = { jellyfin: null, requests: false };
    await page.goto(`/admin/users/${ANNA}`);
    const linked = page.getByRole('region', { name: 'Verknüpfte Konten' });
    await expect(linked.getByRole('listitem').filter({ hasText: 'Medienserver' })).toContainText('Unbekannt');
    await expect(linked.getByRole('listitem').filter({ hasText: 'Medienserver' })).not.toContainText('Gestört');
    const req = linked.getByRole('listitem').filter({ hasText: 'Wunschliste' });
    await expect(req).toContainText('Gestört');
    await linked.getByRole('button', { name: 'Verknüpfungen reparieren' }).click();
    await expect(toasts(page).getByText('Verknüpfungen repariert.')).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/repair`))).toBe(true);
    await expect(req).toContainText('Verbunden');
    await expect(linked.getByRole('button', { name: 'Verknüpfungen reparieren' })).toHaveCount(0);
  });

  test('activity tab loads only when opened', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}`);
    await expect(page.getByRole('region', { name: 'Nutzung' })).toBeVisible();
    await page.getByRole('tab', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\?tab=profiles$/);
    expect(api.admin.activityCalls).toBe(0);
    await page.getByRole('tab', { name: 'Verlauf' }).click();
    await expect(page).toHaveURL(/\?tab=activity$/);
    const panel = page.getByRole('tabpanel', { name: 'Verlauf' });
    await expect(panel.getByText('Das Ansehen wird im Audit-Log festgehalten.')).toBeVisible();
    await expect(panel.getByText('Hearth')).toBeVisible();
    await expect(panel.getByText('Sundial')).toBeVisible();
    await expect(panel.getByRole('row', { name: /Hearth/ })).toContainText('45 %');
    await expect(panel.getByRole('row', { name: /Pilot/ })).toContainText('Gesehen');
    expect(api.admin.activityCalls).toBe(1);
    await page.getByRole('tab', { name: 'Übersicht' }).click();
    await page.getByRole('tab', { name: 'Verlauf' }).click();
    await expect(panel.getByText('Hearth')).toBeVisible();
    expect(api.admin.activityCalls).toBe(2);
  });

  // ---- Rechte ----
  const BEN = auid(3);
  const rightsPuts = (api: { log: string[] }, id: string) => api.log.filter((l) => l.startsWith(`PUT /api/admin/users/${id}/rights`))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'), l.lastIndexOf(' -> '))) as Record<string, unknown>);
  const rightsPanel = (page: import('@playwright/test').Page) => page.getByRole('tabpanel', { name: 'Rechte' });
  const rowOf = (page: import('@playwright/test').Page, name: string) => rightsPanel(page).getByRole('listitem').filter({ has: page.getByRole('radiogroup', { name, exact: true }) });
  const saveBar = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
  const saveViaReview = async (page: import('@playwright/test').Page) => {
    await saveBar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    await page.getByRole('dialog', { name: 'Änderungen prüfen' }).getByRole('button', { name: 'Speichern' }).click();
  };

  test('3-way switch: Übertragen -> Verbieten stages, saves only that key, chip says Ausnahme', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    await expect(page.getByRole('tab', { name: 'Rechte' })).toHaveAttribute('aria-selected', 'true');
    const panel = rightsPanel(page);
    await expect(panel.getByRole('heading', { level: 3, name: 'Übertragen' })).toBeVisible();
    const row = rowOf(page, 'Auf Fernseher übertragen');
    await expect(row.getByRole('radio', { name: 'Wie Rolle' })).toBeChecked();
    await expect(row).toContainText('Rolle: erlaubt');
    await expect(row.getByText('Rolle', { exact: true })).toBeVisible();
    // an existing exception shows as such
    const party = rowOf(page, 'Watch-Partys');
    await expect(party.getByRole('radio', { name: 'Verbieten' })).toBeChecked();
    await expect(party).toContainText('Ausnahme');
    await expect(saveBar(page)).toHaveCount(0);

    await row.getByText('Verbieten', { exact: true }).click();
    await expect(row.getByRole('radio', { name: 'Verbieten' })).toBeChecked();
    await expect(saveBar(page)).toContainText('1 Änderung an den Rechten von Anna Beispiel');
    await saveViaReview(page);
    await expect(toasts(page).getByText('Rechte von Anna Beispiel gespeichert.')).toBeVisible();
    await expect(saveBar(page)).toHaveCount(0);
    expect(rightsPuts(api, ANNA)).toEqual([{ overrides: { cast: false } }]);
    await expect(row).toContainText('Ausnahme');
    await expect(row.getByRole('radio', { name: 'Verbieten' })).toBeChecked();

    // back to the role: null, the exception goes
    await row.getByText('Wie Rolle', { exact: true }).click();
    await saveViaReview(page);
    await expect.poll(() => rightsPuts(api, ANNA).length).toBe(2);
    await expect(toasts(page).getByText('Rechte von Anna Beispiel gespeichert.').last()).toBeVisible();
    expect(rightsPuts(api, ANNA)[1]).toEqual({ overrides: { cast: null } });
    await expect(row).not.toContainText('Ausnahme');
  });

  test('3-way switch is a radiogroup: arrow keys move the selection; discard drops the staging', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    const row = rowOf(page, 'Auf Fernseher übertragen');
    await row.getByRole('radio', { name: 'Wie Rolle' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(row.getByRole('radio', { name: 'Erlauben' })).toBeChecked();
    await expect(row.getByRole('radio', { name: 'Erlauben' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(row.getByRole('radio', { name: 'Verbieten' })).toBeChecked();
    await expect(saveBar(page)).toBeVisible();
    await saveBar(page).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(row.getByRole('radio', { name: 'Wie Rolle' })).toBeChecked();
    await expect(saveBar(page)).toHaveCount(0);
  });

  test('numbers: role value shown, a changed number and the reset save as one body', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    const panel = rightsPanel(page);
    const streams = panel.getByRole('spinbutton', { name: 'Gleichzeitige Streams' });
    const row = panel.getByRole('listitem').filter({ has: page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' }) });
    await expect(streams).toHaveValue('3');
    await expect(row).toContainText('Rolle: 2');
    await streams.fill('4');
    await expect(saveBar(page)).toBeVisible();
    await row.getByRole('button', { name: 'Wie Rolle' }).click();
    await expect(streams).toHaveValue('2');
    await saveViaReview(page);
    await expect(toasts(page).getByText('Rechte von Anna Beispiel gespeichert.')).toBeVisible();
    expect(rightsPuts(api, ANNA)).toEqual([{ overrides: { maxStreams: null } }]);
    await expect(row).not.toContainText('Ausnahme');
  });

  test('note: typed, counted, saved; the list shows it as a tooltip after a reload', async ({ page, api }) => {
    await page.goto(`/admin/users/${BEN}?tab=rights`);
    const note = rightsPanel(page).getByRole('textbox', { name: 'Notiz' });
    await expect(rightsPanel(page)).toContainText('0 / 200');
    await note.fill('Gast von Oma Inge');
    await expect(rightsPanel(page)).toContainText('17 / 200');
    await saveViaReview(page);
    await expect(toasts(page).getByText('Rechte von Ben Test gespeichert.')).toBeVisible();
    expect(rightsPuts(api, BEN)).toEqual([{ overrides: {}, note: 'Gast von Oma Inge' }]);
    await page.goto('/admin/users');
    const ben = page.getByRole('row', { name: /Ben Test/ });
    const btn = ben.getByRole('button', { name: 'Notiz' });
    await expect(btn).toBeVisible();
    // Ben's row sits at the bottom edge: a click would scroll it into view and the tip closes on that scroll. Scroll first, let it settle, click once.
    await btn.scrollIntoViewIfNeeded();
    await expect.poll(async () => { const y = (await btn.boundingBox())?.y; await page.waitForTimeout(100); return y === (await btn.boundingBox())?.y; }).toBe(true);
    await btn.click();
    await expect(page.getByRole('note')).toHaveText('Gast von Oma Inge');
  });

  test('old ?tab=limits opens Rechte', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=limits`);
    await expect(page.getByRole('tab', { name: 'Rechte' })).toHaveAttribute('aria-selected', 'true');
    await expect(rightsPanel(page).getByRole('radiogroup', { name: 'Auf Fernseher übertragen' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Limits' })).toHaveCount(0);
  });

  test('a missing library shows as not available and can be removed', async ({ page, api }) => {
    api.admin.users.find((u) => u.id === BEN)!.ov = { libraries: ['Filme', 'Altes Archiv'] };
    await page.goto(`/admin/users/${BEN}?tab=rights`);
    const libs = rightsPanel(page).getByRole('listitem').filter({ has: page.getByRole('group', { name: 'Bibliotheken' }) });
    await expect(libs.getByRole('checkbox', { name: 'Altes Archiv' })).toBeChecked();
    await expect(libs.getByText('nicht mehr vorhanden')).toBeVisible();
    await expect(libs.getByText('Altes Archiv', { exact: true }).first()).toBeVisible();
    // taken out of the list, it leaves the checklist and the flag with it
    await libs.getByRole('checkbox', { name: 'Altes Archiv' }).click();
    await expect(libs.getByRole('checkbox', { name: 'Altes Archiv' })).toHaveCount(0);
    await expect(libs.getByText('nicht mehr vorhanden')).toHaveCount(0);
    await saveViaReview(page);
    await expect(toasts(page).getByText('Rechte von Ben Test gespeichert.')).toBeVisible();
    expect(rightsPuts(api, BEN)).toEqual([{ overrides: { libraries: ['Filme'] } }]);
    await expect(libs.getByText('nicht mehr vorhanden')).toHaveCount(0);
  });

  test('policy_partial: the rights are stored, the bar offers Erneut anwenden (repair)', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    const streams = rightsPanel(page).getByRole('spinbutton', { name: 'Gleichzeitige Streams' });
    await streams.fill('5');
    await saveViaReview(page);
    await expect(saveBar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    await expect(rightsPanel(page).getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toHaveValue('5');
    api.admin.matrix.policyPartial = false;
    await saveBar(page).getByRole('button', { name: 'Erneut anwenden' }).click();
    await expect(toasts(page).getByText('Rechte von Anna Beispiel erneut angewendet.')).toBeVisible();
    await expect(saveBar(page)).toHaveCount(0);
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/repair`))).toBe(true);
  });

  test('policy_partial: Erneut anwenden that fails again keeps the bar and says how many accounts', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    await rightsPanel(page).getByRole('spinbutton', { name: 'Gleichzeitige Streams' }).fill('5');
    await saveViaReview(page);
    await expect(saveBar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    await saveBar(page).getByRole('button', { name: 'Erneut anwenden' }).click();
    await expect.poll(() => logged(api, new RegExp(`POST /api/admin/users/${ANNA}/repair .*-> 200`))).toBe(true);
    await expect(saveBar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    await expect(toasts(page).getByText('erneut angewendet')).toHaveCount(0);
    await expect(saveBar(page).getByRole('button', { name: 'Erneut anwenden' })).toBeVisible();
  });

  test('mock: every test starts from its own seed (a save in one test never reaches the next one in the worker)', () => {
    const a = adminState(), b = adminState();
    const anna = (st: typeof a) => st.users.find((u) => u.id === ANNA)!;
    anna(a).ov!.maxStreams = 5;
    anna(a).perms!.party = true;
    expect(anna(b).ov).toEqual({ maxStreams: 3 });
    expect(anna(b).perms).toEqual({ party: false });
  });

  test('policy_partial: the error shows once with its final buttons, Erneut anwenden stays put through the reload', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    await rightsPanel(page).getByRole('spinbutton', { name: 'Gleichzeitige Streams' }).fill('5');
    // hold the reload after the 502 until the test lets it go
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    await page.route(`**/api/admin/users/${ANNA}/rights`, async (r) => {
      if (r.request().method() === 'GET') { held = true; await gate; }
      await r.fallback();
    });
    // every set of bar buttons the page shows, in order, with where *Erneut anwenden* stands
    await page.evaluate(() => {
      const w = window as unknown as { __sets: string[] };
      w.__sets = [];
      const read = () => {
        const bs = [...document.querySelectorAll('.sb .acts button')];
        const again = bs.find((b) => b.textContent?.trim() === 'Erneut anwenden')?.getBoundingClientRect();
        const s = bs.map((b) => b.textContent?.trim()).join(' | ') + (again ? ` @${Math.round(again.left)},${Math.round(again.top)}` : '');
        if (w.__sets.at(-1) !== s) w.__sets.push(s);
      };
      new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await saveViaReview(page);
    await expect.poll(() => held).toBe(true);
    // the reload runs: the bar shows the save running, no buttons to mis-hit
    await expect(saveBar(page).getByRole('button')).toHaveCount(0);
    const reloaded = page.waitForResponse((r) => r.url().endsWith(`/api/admin/users/${ANNA}/rights`) && r.request().method() === 'GET');
    release();
    await reloaded;
    const again = saveBar(page).getByRole('button', { name: 'Erneut anwenden' });
    await expect(again).toBeVisible();
    await expect(rightsPanel(page).getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toHaveValue('5');
    // from its first frame on, the error state is one set of buttons in one place
    const sets = await page.evaluate(() => (window as unknown as { __sets: string[] }).__sets);
    const from = sets.findIndex((s) => s.includes('Erneut anwenden'));
    expect(from).toBeGreaterThanOrEqual(0);
    expect(sets.slice(from)).toHaveLength(1);
    expect(sets[from]).toMatch(/^Schließen \| Erneut anwenden @/);
  });

  test('a library the server no longer has: the save says what to do and offers no retry', async ({ page, api }) => {
    api.admin.users.find((u) => u.id === BEN)!.ov = { libraries: ['Filme', 'Altes Archiv'] };
    await page.goto(`/admin/users/${BEN}?tab=rights`);
    const libs = rightsPanel(page).getByRole('listitem').filter({ has: page.getByRole('group', { name: 'Bibliotheken' }) });
    await libs.getByRole('checkbox', { name: 'Serien' }).check();
    await saveViaReview(page);
    await expect(libs.getByRole('alert')).toContainText('Nimm den markierten Eintrag');
    await expect(saveBar(page).getByRole('button', { name: 'Erneut anwenden' })).toHaveCount(0);
    // the edit stays staged; taking the library out lets it through and clears the message
    await libs.getByRole('checkbox', { name: 'Altes Archiv' }).click();
    await expect(libs.getByRole('alert')).toHaveCount(0);
    await saveViaReview(page);
    await expect(toasts(page).getByText('Rechte von Ben Test gespeichert.')).toBeVisible();
    expect(rightsPuts(api, BEN).at(-1)).toEqual({ overrides: { libraries: ['Filme', 'Serien'] } });
  });

  test('staged edits: leaving the tab or the page asks first', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    const row = rowOf(page, 'Auf Fernseher übertragen');
    await row.getByText('Verbieten', { exact: true }).click();
    await page.getByRole('tab', { name: 'Profile' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await expect(ask).toContainText('ungespeicherte Änderungen an den Rechten von Anna Beispiel');
    await ask.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page).toHaveURL(/\?tab=rights$/);
    await expect(row.getByRole('radio', { name: 'Verbieten' })).toBeChecked();
    await page.getByRole('link', { name: /Zurück zur Nutzerliste/ }).click();
    await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
  });

  /** /admin → Nutzer → Anna → Rechte (the tab replaces its entry), one switch staged; the history length there */
  async function stagedViaLinks(page: import('@playwright/test').Page): Promise<number> {
    await page.goto('/admin');
    await page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: 'Nutzer' }).click();
    await page.getByRole('link', { name: 'Anna Beispiel' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${ANNA}$`));
    await page.getByRole('tab', { name: 'Rechte' }).click();
    await expect(page).toHaveURL(/\?tab=rights$/);
    await rowOf(page, 'Auf Fernseher übertragen').getByText('Verbieten', { exact: true }).click();
    await expect(saveBar(page)).toBeVisible();
    return page.evaluate(() => history.length);
  }
  const historyLength = (page: import('@playwright/test').Page) => page.evaluate(() => history.length);
  const back = (page: import('@playwright/test').Page) => page.evaluate(() => history.back());

  test('leave guard: a tab switch after Verwerfen replaces its entry like any tab switch (Back leaves the person)', async ({ page }) => {
    const n = await stagedViaLinks(page);
    await page.getByRole('tab', { name: 'Profile' }).click();
    await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\?tab=profiles$/);
    await expect(page.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => historyLength(page)).toBe(n);
    await back(page);
    await expect(page).toHaveURL(/\/admin\/users$/);
    await back(page);
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('leave guard: a confirmed Back goes back once, the next Back goes back again', async ({ page }) => {
    const n = await stagedViaLinks(page);
    await back(page);
    await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole('link', { name: 'Anna Beispiel' })).toBeVisible();
    await expect.poll(() => historyLength(page)).toBe(n);
    await back(page);
    await expect(page).toHaveURL(/\/admin$/);
    // forward again lands on the person, without the discarded edit and without a question
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(/\/admin\/users$/);
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(/\?tab=rights$/);
    await expect(rowOf(page, 'Auf Fernseher übertragen').getByRole('radio', { name: 'Verbieten' })).not.toBeChecked();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('leave guard: Abbrechen on Back stays on the person with the edit staged', async ({ page }) => {
    const n = await stagedViaLinks(page);
    await back(page);
    await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' }).getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page).toHaveURL(/\?tab=rights$/);
    await expect(rowOf(page, 'Auf Fernseher übertragen').getByRole('radio', { name: 'Verbieten' })).toBeChecked();
    await expect.poll(() => historyLength(page)).toBe(n);
  });

  test('an admin account: switches are locked, numbers stay editable', async ({ page }) => {
    await page.goto('/admin/users/u1?tab=rights');
    const panel = rightsPanel(page);
    await expect(panel.getByRole('radiogroup')).toHaveCount(0);
    await expect(panel.getByText('Admins dürfen immer alles').first()).toBeVisible();
    await expect(panel.getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toBeEnabled();
  });

  test('extend access +30 days', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Zugang verlängern' }).click();
    const form = page.getByRole('form', { name: 'Zugang verlängern' });
    await form.getByRole('combobox', { name: 'Zugang bis' }).selectOption('p30');
    const before = Date.now();
    await form.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(toasts(page).getByText(/^Zugang von Anna Beispiel bis /)).toBeVisible();
    const patch = api.log.find((l) => l.startsWith(`PATCH /api/admin/users/${ANNA} `))!;
    const until = Date.parse(JSON.parse(patch.split(' ')[2]!).accessUntil);
    expect(Math.abs(until - (before + 30 * 86_400_000))).toBeLessThan(60_000);
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText(/^Zugang bis /)).toBeVisible();
    await expect(form).toHaveCount(0);
  });

  test('an account whose access ended offers "Extend access" instead of "Unlock"', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'expired', access_until: new Date(Date.now() - 86400e3).toISOString() });
    await page.goto(`/admin/users/${ANNA}`);
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByText('Gesperrt: Zugang abgelaufen')).toBeVisible();
    const m = await menu(page);
    await expect(m.getByRole('button', { name: 'Entsperren' })).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Zugang verlängern' })).toHaveCount(1);
    await m.getByRole('button', { name: 'Zugang verlängern' }).click();
    const form = page.getByRole('form', { name: 'Zugang verlängern' });
    await form.getByRole('combobox', { name: 'Zugang bis' }).selectOption('p30');
    await form.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(head.getByText('Aktiv', { exact: true })).toBeVisible();
  });

  test('a locked account whose access ended answers an unlock with the reason', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'manual', access_until: new Date(Date.now() + 86400e3).toISOString() });
    await page.goto(`/admin/users/${ANNA}`);
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText('Gesperrt: von Hand')).toBeVisible();
    anna.access_until = new Date(Date.now() - 1000).toISOString(); // ended while the page was open
    await (await menu(page)).getByRole('button', { name: 'Entsperren' }).click();
    await expect(toasts(page).getByText('Der Zugang ist abgelaufen – verlängere stattdessen den Zugang.')).toBeVisible();
    expect(anna.disabled).toBe(true);
  });

  test('role change and locking an admin need the typed name', async ({ page, api }) => {
    api.admin.users.find((u) => u.id === ANNA)!.role = 'admin';
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Rolle ändern' }).click();
    const form = page.getByRole('form', { name: 'Rolle ändern' });
    await form.getByRole('combobox', { name: 'Neue Rolle' }).selectOption('guest');
    await form.getByRole('button', { name: 'Übernehmen' }).click();
    const demote = page.getByRole('alertdialog', { name: 'Anna Beispiel herabstufen?' });
    await expect(demote.getByRole('button', { name: 'Übernehmen' })).toBeDisabled();
    await demote.getByRole('textbox').fill('Anna Beispiel');
    await demote.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel ist jetzt Gast.')).toBeVisible();
    expect(logged(api, new RegExp(`PATCH /api/admin/users/${ANNA} .*"role":"guest"`))).toBe(true);

    api.admin.users.find((u) => u.id === ANNA)!.role = 'admin';
    await page.reload();
    await (await menu(page)).getByRole('button', { name: 'Sperren' }).click();
    const lock = page.getByRole('alertdialog', { name: 'Anna Beispiel sperren?' });
    await expect(lock.getByRole('button', { name: 'Sperren' })).toBeDisabled();
    await lock.getByRole('textbox').fill('Anna Beispiel');
    await lock.getByRole('button', { name: 'Sperren' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wurde gesperrt.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText('Gesperrt: von Hand')).toBeVisible();
  });

  test('password reset button hidden without Authentik', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}`);
    let m = await menu(page);
    await expect(m.getByRole('button', { name: '2FA-Einrichtung senden' })).toHaveCount(0); // Authentik has no API for it
    await m.getByRole('button', { name: 'Passwort-Link senden' }).click();
    await page.getByRole('alertdialog', { name: 'Passwort-Link an Anna Beispiel senden?' }).getByRole('button', { name: 'Senden' }).click();
    await expect(toasts(page).getByText('Passwort-Link an Anna Beispiel gesendet.')).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/recovery`))).toBe(true);

    await page.route(`**/api/admin/users/${ANNA}/recovery`, (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"recovery_not_configured"}' }));
    m = await menu(page);
    await m.getByRole('button', { name: 'Passwort-Link senden' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Senden' }).click();
    await expect(toasts(page).getByText(/kein Ablauf zum Zurücksetzen/)).toBeVisible();

    api.admin.detailMfa = null;
    await page.reload();
    m = await menu(page);
    await expect(m.getByRole('button', { name: 'Überall abmelden' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Passwort-Link senden' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Anna Beispiel' }).getByText('2FA unbekannt')).toBeVisible();
    await page.keyboard.press('Escape');

    api.admin.detailMfa = { totp: false, webauthn: false, static: false };
    api.admin.authentik = { recovery: false, mfaSetup: false };
    await page.reload();
    m = await menu(page);
    await expect(m.getByRole('button', { name: 'Überall abmelden' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Passwort-Link senden' })).toHaveCount(0);
  });

  test('profiles: rename inline and reset PIN with confirm', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const kids = panel.getByRole('row', { name: /„Kinder“/ });
    await expect(kids).toContainText('PIN gesetzt');
    await kids.getByRole('button', { name: 'Aktionen für Kinder' }).click();
    await page.getByRole('dialog', { name: 'Kinder' }).getByRole('button', { name: 'Umbenennen' }).click();
    const name = kids.getByRole('textbox', { name: 'Neuer Name' });
    await expect(name).toHaveAttribute('maxlength', '20');
    await name.fill('Anna');
    await kids.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Diesen Namen hat schon ein anderes Profil.')).toBeVisible();
    await name.fill('Kids');
    await kids.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Profil heißt jetzt „Kids“.')).toBeVisible();
    const row = panel.getByRole('row', { name: /Kids/ });
    await row.getByRole('button', { name: 'PIN von „Kids“ zurücksetzen' }).click();
    await page.getByRole('alertdialog', { name: 'PIN von „Kids“ zurücksetzen?' }).getByRole('button', { name: 'PIN zurücksetzen' }).click();
    await expect(toasts(page).getByText('PIN von „Kids“ zurückgesetzt.')).toBeVisible();
    await expect(row).toContainText('Keine PIN');
    expect(logged(api, /PATCH \/api\/admin\/users\/.*\/profiles\/.*"resetPin":true/)).toBe(true);
    // the owner profile can be renamed too
    await panel.getByRole('row', { name: /Hauptprofil/ }).getByRole('button', { name: 'Aktionen für Anna' }).click();
    await expect(page.getByRole('dialog', { name: 'Anna' }).getByRole('button', { name: 'Umbenennen' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  const plain = (id: string, n: number, name: string, kids = false) => ({ id: `${id.slice(0, -4)}p00${n}`, name, kids, maxRating: kids ? 12 : null, avatar: 'a1', lastUsed: null, isOwner: n === 1, hasPin: false });

  test('profiles: switch Clara\'s second profile to kids, cap 6', async ({ page, api }) => {
    api.admin.userProfiles[CLARA] = [plain(CLARA, 1, 'Clara'), plain(CLARA, 2, 'Zweitprofil')];
    await page.goto(`/admin/users/${CLARA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const row = panel.getByRole('row', { name: /Zweitprofil/ });
    const sw = row.getByRole('switch', { name: 'Kinderprofil: „Zweitprofil“' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    // the age limit has its room before it exists: switching never moves the list
    await expect(row.getByRole('combobox')).toHaveCount(0);
    const table = panel.getByRole('table');
    const before = await Promise.all([row.boundingBox(), table.boundingBox()]);
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    const cap = row.getByRole('combobox', { name: 'Altersgrenze von „Zweitprofil“' });
    await expect(cap).toHaveValue('12');
    const after = await Promise.all([row.boundingBox(), table.boundingBox()]);
    expect(after[0]!.height).toBe(before[0]!.height);
    expect(after[1]!.height).toBe(before[1]!.height);
    expect(logged(api, /PATCH \/api\/admin\/users\/.*\/profiles\/.*p002 \{"kids":true\} -> 200/)).toBe(true);
    await expect(toasts(page).getByText('„Zweitprofil“ ist jetzt ein Kinderprofil.')).toBeVisible();
    await cap.selectOption('6');
    await expect(toasts(page).getByText('Altersgrenze von „Zweitprofil“ gespeichert.')).toBeVisible();
    expect(logged(api, /PATCH .*p002 \{"maxRating":6\} -> 200/)).toBe(true);
    await expect(cap).toHaveValue('6');
    await expect(row).toContainText('Kinderprofil');
    // and back: the cap goes, the row keeps its height
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(row.getByRole('combobox')).toHaveCount(0);
    expect(logged(api, /PATCH .*p002 \{"kids":false\} -> 200/)).toBe(true);
    expect((await row.boundingBox())!.height).toBe(before[0]!.height);
  });

  test('profiles: the media server does not take a kids change (502): stored, the toast names the repair button', async ({ page, api }) => {
    api.admin.profileMediaFails = true;
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const cap = panel.getByRole('combobox', { name: 'Altersgrenze von „Kinder“' });
    await expect(cap).toHaveValue('6');
    await cap.selectOption('12');
    await expect(toasts(page).getByText('Die Änderung ist gespeichert, aber der Medienserver hat die Freigaben nicht übernommen. „Verknüpfungen reparieren“ auf der Übersicht wendet sie erneut an.')).toBeVisible();
    await expect.poll(() => logged(api, /PATCH .*p002 \{"maxRating":12\} -> 502/)).toBe(true);
    // stored anyway: the list is read again and keeps the new cap
    await expect(cap).toHaveValue('12');
    await page.reload();
    await expect(panel.getByRole('combobox', { name: 'Altersgrenze von „Kinder“' })).toHaveValue('12');
  });

  test('44 px targets with a fine pointer: PIN zurücksetzen, Wie Rolle, the Kinderprofil sheet\'s buttons', async ({ page }) => {
    const tall = async (l: import('@playwright/test').Locator) => {
      await expect(l).toBeVisible();
      expect((await l.boundingBox())!.height, await l.textContent() ?? '').toBeGreaterThanOrEqual(44);
    };
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    await tall(panel.getByRole('button', { name: 'PIN von „Kinder“ zurücksetzen' }));
    await tall(panel.getByRole('button', { name: 'Kinderprofil anlegen' }));
    await panel.getByRole('button', { name: 'Kinderprofil anlegen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Kinderprofil anlegen' });
    for (const name of ['Abbrechen', 'Anlegen', 'Schließen']) await tall(sheet.getByRole('button', { name, exact: true }));
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await page.getByRole('tab', { name: 'Rechte' }).click();
    await tall(rightsPanel(page).getByRole('listitem').filter({ has: page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' }) }).getByRole('button', { name: 'Wie Rolle' }));
  });

  test('profiles: a refused switch goes back and says why', async ({ page, api }) => {
    api.admin.claimed.add(ANNA);
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const sw = page.getByRole('tabpanel', { name: 'Profile' }).getByRole('switch', { name: 'Kinderprofil: „Kinder“' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(toasts(page).getByText('Dieses Konto wird gerade gelöscht. Seine Profile lassen sich nicht mehr ändern.')).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  test('profiles: create a kids profile', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    await panel.getByRole('button', { name: 'Kinderprofil anlegen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Kinderprofil anlegen' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await expect(sheet.getByRole('textbox', { name: 'Name' })).toHaveAttribute('maxlength', '20');
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Kinder');
    await sheet.getByRole('button', { name: 'Anlegen' }).click();
    // a refusal is said inside the sheet, next to the button (a toast would cover it); typing clears it
    await expect(sheet.getByRole('alert')).toHaveText('Diesen Namen hat schon ein anderes Profil.');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Lena');
    await expect(sheet.getByRole('alert')).toHaveCount(0);
    await sheet.getByRole('combobox', { name: 'Altersgrenze' }).selectOption('6');
    await sheet.getByRole('button', { name: 'Anlegen' }).click();
    await expect(toasts(page).getByText('„Lena“ angelegt.')).toBeVisible();
    expect(logged(api, /POST \/api\/admin\/users\/.*\/profiles \{"name":"Lena","kids":true,"maxRating":6\} -> 201/)).toBe(true);
    await expect(sheet).toHaveCount(0);
    const row = panel.getByRole('row', { name: /Lena/ });
    await expect(row.getByRole('switch', { name: 'Kinderprofil: „Lena“' })).toHaveAttribute('aria-checked', 'true');
    await expect(row.getByRole('combobox', { name: 'Altersgrenze von „Lena“' })).toHaveValue('6');
    await expect(panel.getByRole('button', { name: 'Kinderprofil anlegen' })).toBeFocused();
  });

  /** the toast's lower edge is above the top edge of `target` (a sheet's footer button), so the button takes the click */
  const toastAbove = async (page: import('@playwright/test').Page, toast: import('@playwright/test').Locator, target: import('@playwright/test').Locator) => {
    await expect.poll(async () => {
      const [a, b] = await Promise.all([toast.boundingBox(), target.boundingBox()]);
      return a && b ? Math.round(b.y - (a.y + a.height)) : -1;
    }).toBeGreaterThanOrEqual(0);
  };

  test('sheets keep their footer free: a toast glides above the Kinderprofil sheet, Anlegen takes the click', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    await panel.getByRole('combobox', { name: 'Altersgrenze von „Kinder“' }).selectOption('12');
    const toast = toasts(page).getByRole('listitem').filter({ hasText: 'Altersgrenze von „Kinder“ gespeichert.' });
    await expect(toast).toBeVisible();
    await panel.getByRole('button', { name: 'Kinderprofil anlegen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Kinderprofil anlegen' });
    await sheet.getByRole('textbox', { name: 'Name' }).fill('Lena');
    const create = sheet.getByRole('button', { name: 'Anlegen' });
    await expect(toast).toBeVisible();
    await toastAbove(page, toast, sheet.getByRole('button', { name: 'Abbrechen' }));
    await toastAbove(page, toast, create);
    await create.click();
    await expect(toasts(page).getByText('„Lena“ angelegt.')).toBeVisible();
    expect(logged(api, /POST \/api\/admin\/users\/.*\/profiles \{"name":"Lena"/)).toBe(true);
    // the sheet has gone: its room with it, the toasts are back at their place
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--sheet-h'))).toBe('');
  });

  test('sheets keep their footer free: a toast glides above Änderungen prüfen, Speichern takes the click', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=rights`);
    const streams = rightsPanel(page).getByRole('spinbutton', { name: 'Gleichzeitige Streams' });
    await streams.fill('4');
    await saveViaReview(page);
    const toast = toasts(page).getByRole('listitem').filter({ hasText: 'Rechte von Anna Beispiel gespeichert.' });
    await expect(toast).toBeVisible();
    await streams.fill('5');
    await saveBar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
    const sheet = page.getByRole('dialog', { name: 'Änderungen prüfen' });
    const save = sheet.getByRole('button', { name: 'Speichern' });
    await expect(toast).toBeVisible();
    await toastAbove(page, toast, save);
    await save.click();
    await expect(sheet).toHaveCount(0);
    await expect(streams).toHaveValue('5');
  });

  test('profiles: delete asks first, then removes', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const row = panel.getByRole('row', { name: /„Kinder“/ });
    await row.getByRole('button', { name: 'Aktionen für Kinder' }).click();
    await page.getByRole('dialog', { name: 'Kinder' }).getByRole('button', { name: 'Löschen' }).click();
    const ask = page.getByRole('alertdialog', { name: '„Kinder“ löschen?' });
    await expect(ask).toContainText('Merkliste, Verlauf und Favoriten des Profils werden gelöscht.');
    await ask.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(ask).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(logged(api, /DELETE /)).toBe(false);
    await row.getByRole('button', { name: 'Aktionen für Kinder' }).click();
    await page.getByRole('dialog', { name: 'Kinder' }).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog', { name: '„Kinder“ löschen?' }).getByRole('button', { name: 'Profil löschen' }).click();
    await expect(toasts(page).getByText('„Kinder“ gelöscht.')).toBeVisible();
    await expect(panel.getByRole('row', { name: /„Kinder“/ })).toHaveCount(0);
    expect(logged(api, /DELETE \/api\/admin\/users\/.*\/profiles\/.*p002\s+-> 200/)).toBe(true);
  });

  test('profiles: the owner row has no kids switch, age limit or delete', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const owner = panel.getByRole('row', { name: /Hauptprofil/ });
    await expect(owner).toBeVisible();
    await expect(owner.getByRole('switch')).toHaveCount(0);
    await expect(owner.getByRole('combobox')).toHaveCount(0);
    await owner.getByRole('button', { name: 'Aktionen für Anna' }).click();
    const m = page.getByRole('dialog', { name: 'Anna' });
    await expect(m.getByRole('button', { name: 'Umbenennen' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
  });

  test('profiles: at 5 profiles the create button is disabled and says why', async ({ page, api }) => {
    api.admin.userProfiles[ANNA] = [plain(ANNA, 1, 'Anna'), plain(ANNA, 2, 'Eins', true), plain(ANNA, 3, 'Zwei', true), plain(ANNA, 4, 'Drei', true), plain(ANNA, 5, 'Vier', true)];
    await page.goto(`/admin/users/${ANNA}?tab=profiles`);
    const panel = page.getByRole('tabpanel', { name: 'Profile' });
    const btn = panel.getByRole('button', { name: 'Kinderprofil anlegen' });
    await expect(btn).toBeDisabled();
    await expect(panel.getByText('Höchstens 5 Profile pro Konto.')).toBeVisible();
    await expect(btn).toHaveAccessibleDescription('Höchstens 5 Profile pro Konto.');
    // one fewer and it is open again
    await panel.getByRole('row', { name: /Vier/ }).getByRole('button', { name: 'Aktionen für Vier' }).click();
    await page.getByRole('dialog', { name: 'Vier' }).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Profil löschen' }).click();
    await expect(btn).toBeEnabled();
    await expect(panel.getByText('Höchstens 5 Profile pro Konto.')).toHaveCount(0);
  });

  test('devices: approve, withdraw approval, sign out one device, remove', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=devices`);
    const panel = page.getByRole('tabpanel', { name: 'Geräte' });
    const row = panel.getByRole('row', { name: /Chrome auf Windows/ });
    await expect(row).toContainText('Wartet auf Freigabe');
    await row.getByRole('button', { name: '„Chrome auf Windows“ freigeben' }).click();
    await expect(toasts(page).getByText('„Chrome auf Windows“ freigegeben.')).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/devices/approve .*"userId":"${ANNA}","deviceId":"dev-0-0123456789ab"`))).toBe(true);
    await expect(row).toContainText('Freigegeben');

    const actions = async () => {
      await row.getByRole('button', { name: 'Aktionen für Chrome auf Windows' }).click();
      return page.getByRole('dialog', { name: 'Chrome auf Windows' });
    };
    await (await actions()).getByRole('button', { name: 'Freigabe zurücknehmen' }).click();
    await expect(toasts(page).getByText('Freigabe von „Chrome auf Windows“ zurückgenommen.')).toBeVisible();
    expect(logged(api, /POST \/api\/admin\/devices\/unapprove /)).toBe(true);
    await expect(row).toContainText('Wartet auf Freigabe');

    await (await actions()).getByRole('button', { name: 'Abmelden' }).click();
    await page.getByRole('alertdialog', { name: '„Chrome auf Windows“ abmelden?' }).getByRole('button', { name: 'Abmelden' }).click();
    await expect(toasts(page).getByText(/Sitzung beendet/)).toBeVisible();
    expect(logged(api, new RegExp(`POST /api/admin/users/${ANNA}/sessions/dev-0-0123456789ab/revoke`))).toBe(true);

    await (await actions()).getByRole('button', { name: 'Entfernen' }).click();
    const dlg = page.getByRole('alertdialog', { name: '„Chrome auf Windows“ entfernen?' });
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(logged(api, /devices\/remove/)).toBe(false);
    await (await actions()).getByRole('button', { name: 'Entfernen' }).click();
    await dlg.getByRole('button', { name: 'Entfernen' }).click();
    await expect(toasts(page).getByText('„Chrome auf Windows“ entfernt.')).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.getByRole('tab', { name: 'Audit-Log' }).click();
    const audit = page.getByRole('tabpanel', { name: 'Audit-Log' });
    await expect(audit.getByText('Tester hat Anna Beispiel auf einem Gerät abgemeldet')).toBeVisible();
    await expect(audit.getByText('Tester hat Anna Beispiel überall abgemeldet')).toHaveCount(0);
  });

  test('downloads: revoke a licence with confirm', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=downloads`);
    const panel = page.getByRole('tabpanel', { name: 'Downloads' });
    const row = panel.getByRole('row', { name: /Hearth/ });
    await row.getByRole('button', { name: 'Aktionen für Hearth' }).click();
    await page.getByRole('dialog', { name: 'Hearth' }).getByRole('button', { name: 'Widerrufen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Download „Hearth“ widerrufen?' });
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    expect(logged(api, /DELETE \/api\/admin\/downloads/)).toBe(false);
    await row.getByRole('button', { name: 'Aktionen für Hearth' }).click();
    await page.getByRole('dialog', { name: 'Hearth' }).getByRole('button', { name: 'Widerrufen' }).click();
    await dlg.getByRole('button', { name: 'Widerrufen' }).click();
    await expect(toasts(page).getByText('Download „Hearth“ widerrufen.')).toBeVisible();
    expect(logged(api, new RegExp(`DELETE /api/admin/downloads/${auid(601)} `))).toBe(true);
    await expect(panel.getByText('Keine aktiven Downloads.')).toBeVisible();
  });

  test('audit tab lists the entries as sentences', async ({ page, api }) => {
    api.admin.audit.unshift({ id: 99, at: new Date().toISOString(), action: 'user.limits', target: ANNA, meta: { from: { maxStreams: null }, to: { maxStreams: 3 } }, actor: 'Tester', target_name: 'Anna Beispiel' });
    await page.goto(`/admin/users/${ANNA}?tab=audit`);
    await expect(page.getByRole('tabpanel', { name: 'Audit-Log' }).getByText('Tester hat die Limits von Anna Beispiel geändert')).toBeVisible();
  });

  test('own account: no lock, demotion or sign out everywhere', async ({ page }) => {
    await page.goto('/admin/users/u1');
    await page.getByRole('button', { name: 'Aktionen', exact: true }).click();
    const m = page.getByRole('dialog', { name: 'Tester' });
    await expect(m.getByRole('button', { name: 'Du kannst dich nicht selbst sperren oder herabstufen.' })).toBeDisabled();
    await expect(m.getByRole('button', { name: 'Zugang verlängern' })).toBeVisible();
    for (const n of ['Sperren', 'Rolle ändern', 'Überall abmelden']) await expect(m.getByRole('button', { name: n, exact: true })).toHaveCount(0);
  });

  test('unknown user shows not found; a load error offers retry', async ({ page }) => {
    await page.goto(`/admin/users/${auid(999)}`);
    const nf = page.getByRole('alert').filter({ hasText: 'Diesen Nutzer gibt es nicht (mehr).' });
    await expect(nf).toBeVisible();
    await expect(nf.getByRole('button')).toHaveCount(0);

    let fail = true;
    await page.route(`**/api/admin/users/${ANNA}`, (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
    await page.goto(`/admin/users/${ANNA}`);
    const err = page.getByRole('alert').filter({ hasText: 'Das ließ sich nicht laden' });
    await expect(err).toBeVisible();
    fail = false;
    await err.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Anna Beispiel' })).toBeVisible();
  });

  test('tablist has names', async ({ page }) => {
    await page.goto(`/admin/users/${ANNA}`);
    const list = page.getByRole('tablist', { name: 'Bereiche von Anna Beispiel' });
    await expect(list).toBeVisible();
    const names = ['Übersicht', 'Rechte', 'Profile', 'Geräte', 'Downloads', 'Verlauf', 'Audit-Log'];
    for (const n of names) await expect(list.getByRole('tab', { name: n, exact: true })).toBeVisible();
    await expect(list.getByRole('tab', { name: 'Übersicht' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Übersicht' })).toBeVisible();
    await list.getByRole('tab', { name: 'Übersicht' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(list.getByRole('tab', { name: 'Rechte' })).toBeFocused();
    await expect(list.getByRole('tab', { name: 'Rechte' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Rechte' })).toBeVisible();
  });
});

/** Block 23 self-service: a scheduled deletion on the detail page, cleanup rows in the list */
test.describe('admin user deletion', () => {
  test.use({ allowedConsole: /status of (404|409)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  const WEEKISH = () => new Date(Date.now() + 5 * 86400e3).toISOString();

  test('admin restore and delete-now call the APIs', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    await page.goto(`/admin/users/${ANNA}`);
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByText(/^Löschung am \d/)).toBeVisible();
    // a deletion lock: restore takes the place of unlock, plus delete now; nothing else applies to an account being deleted
    let m = await menu(page);
    await expect(m.getByRole('button')).toHaveText(['Konto wiederherstellen', 'Jetzt löschen']);
    await m.getByRole('button', { name: 'Jetzt löschen' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText('Anna Beispiel jetzt löschen?');
    await expect(dlg).toContainText('Das lässt sich nicht rückgängig machen.');
    await expect(dlg.getByRole('button', { name: 'Abbrechen' })).toBeFocused(); // danger: focus starts on cancel
    await dlg.getByRole('button', { name: 'Jetzt löschen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wird jetzt gelöscht.')).toBeVisible();
    expect(logged(api, new RegExp(`^POST /api/admin/users/${ANNA}/deletion/now `))).toBe(true);

    m = await menu(page);
    await m.getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wiederhergestellt.')).toBeVisible();
    expect(logged(api, new RegExp(`^POST /api/admin/users/${ANNA}/deletion/restore `))).toBe(true);
    await expect(head.getByText('Aktiv', { exact: true })).toBeVisible();
    await expect(head.getByText(/^Löschung am/)).toHaveCount(0);
  });

  test('restoring an account whose access ended keeps it locked as expired (F8)', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH(), access_until: new Date(Date.now() - 86400e3).toISOString() });
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wiederhergestellt – bleibt gesperrt, weil der Zugang abgelaufen ist.')).toBeVisible();
    const head = page.getByRole('region', { name: 'Anna Beispiel' });
    await expect(head.getByText('Gesperrt: Zugang abgelaufen')).toBeVisible();
    const m = await menu(page);
    await expect(m.getByRole('button', { name: 'Zugang verlängern' })).toHaveCount(1);
    await expect(m.getByRole('button', { name: 'Entsperren' })).toHaveCount(0);
  });

  test('a deletion already running answers restore with the reason', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    api.admin.claimed.add(ANNA);
    await page.goto(`/admin/users/${ANNA}`);
    await (await menu(page)).getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Die Löschung läuft bereits – sie lässt sich nicht mehr aufhalten.')).toBeVisible();
  });

  test('cleanup row shows the pseudonym and step', async ({ page, api }) => {
    Object.assign(api.admin.users.find((u) => u.id === ANNA)!, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    api.admin.cleanups.push({ id: auid(900), pseudonym: 'deleted-1a2b3c4d', started_at: new Date(Date.now() - 3600e3).toISOString(), step: 3, error: 'media_error' });
    api.admin.cleanups.push({ id: auid(901), pseudonym: 'deleted-99ff00aa', started_at: new Date(Date.now() - 600e3).toISOString(), step: 5, error: null });
    // claimed, users row still there (steps 1-4): still has a detail page
    Object.assign(api.admin.users.find((u) => u.id === auid(3))!, { disabled: true, locked_reason: 'deletion', deletion_at: new Date(Date.now() - 60e3).toISOString(), cleanup: { step: 2, error: 'request_error' } });
    await page.goto('/admin/users');
    const table = page.getByRole('table', { name: 'Nutzer' });
    await expect(table.getByRole('row', { name: /Ben Test/ })).toBeVisible();
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Löschung ausstehend' });
    await expect(table.getByRole('row', { name: /Clara Fischer/ })).toHaveCount(0);
    const failing = table.getByRole('row', { name: /deleted-1a2b3c4d/ });
    await expect(failing).toContainText('Bereinigung: Schritt 3 von 6 – Fehler: media_error');
    await expect(table.getByRole('row', { name: /deleted-99ff00aa/ })).toContainText('Bereinigung: Schritt 5 von 6');
    await expect(table.getByRole('row', { name: /deleted-99ff00aa/ })).not.toContainText('Fehler');
    // no detail page behind a gone cleanup row, not selectable, no actions
    await expect(failing.getByRole('link')).toHaveCount(0);
    await expect(failing.getByRole('checkbox')).toBeDisabled();
    await expect(failing.getByRole('button')).toHaveCount(0);
    // a claimed account whose users row exists links to its detail page, but is not selectable and has no actions either
    const claimed = table.getByRole('row', { name: /Ben Test/ });
    await expect(claimed).toContainText('Bereinigung: Schritt 2 von 6 – Fehler: request_error');
    await expect(claimed.getByRole('link', { name: 'Ben Test' })).toHaveAttribute('href', `/admin/users/${auid(3)}`);
    await expect(claimed.getByRole('checkbox')).toBeDisabled();
    await expect(claimed.getByRole('button')).toHaveCount(0);
    // the scheduled account keeps its link and shows the date
    const anna = table.getByRole('row', { name: /Anna Beispiel/ });
    await expect(anna.getByRole('link', { name: 'Anna Beispiel' })).toBeVisible();
    await expect(anna.getByText(/^Löschung am \d/)).toBeVisible();
    await expect(page.locator('main')).not.toContainText('undefined');
  });

  test('a scheduled account in the list offers "Restore account" instead of "Unlock" (no undo)', async ({ page, api }) => {
    const anna = api.admin.users.find((u) => u.id === ANNA)!;
    Object.assign(anna, { disabled: true, locked_reason: 'deletion', deletion_at: WEEKISH() });
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Aktionen für Anna Beispiel' }).click();
    const m = page.getByRole('dialog', { name: 'Anna Beispiel' });
    await expect(m.getByRole('button', { name: 'Entsperren' })).toHaveCount(0);
    await m.getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(toasts(page).getByText('Anna Beispiel wiederhergestellt.')).toBeVisible();
    await expect(toasts(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
    expect(logged(api, new RegExp(`^POST /api/admin/users/${ANNA}/deletion/restore `))).toBe(true);
    expect(logged(api, /^PATCH /)).toBe(false);
    expect(anna).toMatchObject({ disabled: false, deletion_at: null });
  });
});

test.describe('admin user detail: Sicht prüfen (desktop)', () => {
  test.use({ allowedConsole: /status of (400|404|429)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  const checkPanel = (page: import('@playwright/test').Page) => page.getByRole('tabpanel', { name: 'Sicht prüfen' });
  const checkPosts = (api: { log: string[] }) => api.log.filter((l) => l.startsWith('POST ') && l.includes('/check '));

  test('kids profile view: the chips switch the profile, the summary and the library counts follow', async ({ page, api }) => {
    await page.goto(`/admin/users/${ANNA}?tab=check`);
    await expect(page.getByRole('tab', { name: 'Sicht prüfen' })).toHaveAttribute('aria-selected', 'true');
    const panel = checkPanel(page);
    const chips = panel.getByRole('group', { name: 'Profil wählen' }).getByRole('button');
    // the owner first, the kids profile marked
    await expect(chips).toHaveText([/^Anna/, /^Kinder.*Kinderprofil/]);
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
    const summary = panel.getByRole('region', { name: 'Kurzfassung' });
    await expect(summary).toContainText('Anna sieht alle Bibliotheken.');
    await expect(summary).toContainText('Keine Altersgrenze.');
    await expect(summary).toContainText('Darf nicht herunterladen.');
    const libs = panel.getByRole('region', { name: 'Bibliotheken' });
    await expect(libs.getByRole('listitem').filter({ hasText: 'Filme' })).toHaveText(/Filme · 1\.204 von 1\.204/);
    await chips.nth(1).click();
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(summary).toContainText('Kinderprofil: ab 6, Titel ohne Freigabe sind ausgeblendet, keine Kommentare, keine Partys.');
    await expect(summary).not.toContainText('Keine Altersgrenze.');
    await expect(libs.getByRole('listitem').filter({ hasText: 'Filme' })).toHaveText(/Filme · 212 von 1\.204/);
    await expect(libs.getByRole('listitem').filter({ hasText: 'Serien' })).toHaveText(/Serien · 61 von 340/);
    await expect(page.locator('main')).not.toContainText('undefined');
    expect(checkPosts(api)).toEqual([]);
  });

  test('title check: a hidden title names its reason, a visible one says so', async ({ page, api }) => {
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const panel = checkPanel(page);
    // a guest: age limit 12
    await expect(panel.getByRole('region', { name: 'Kurzfassung' })).toContainText('Titel bis FSK 12.');
    await panel.getByRole('searchbox', { name: 'Film oder Serie suchen' }).fill('Dunmoor');
    const rows = panel.getByRole('region', { name: 'Titel prüfen' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Dunmoor Origins' })).toContainText('sichtbar');
    const hidden = rows.filter({ hasNotText: 'Origins' });
    await expect(hidden).toContainText('ausgeblendet · Freigabe FSK-16 über FSK 12');
    await expect(hidden).toContainText('2021');
    expect(checkPosts(api)).toHaveLength(1);
    expect(JSON.parse(checkPosts(api)[0]!.slice(checkPosts(api)[0]!.indexOf('{'), checkPosts(api)[0]!.lastIndexOf(' -> ')))).toEqual({ profileId: `${CLARA.slice(0, -4)}p001`, query: 'Dunmoor' });
    // the kids profile: an unrated title is hidden with its own reason
    await panel.getByRole('group', { name: 'Profil wählen' }).getByRole('button', { name: /^Kinder/ }).click();
    await expect(rows.filter({ hasText: 'Dunmoor Origins' })).toContainText('ausgeblendet · ohne Freigabe (Kinderprofil)');
    expect(api.admin.audit.some((e) => e.action === 'user.check_viewed' && e.target === CLARA)).toBe(true);
  });

  test('title check: the 30-a-minute limit has its own message, not the generic failure', async ({ page, api }) => {
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const panel = checkPanel(page);
    await expect(panel.getByRole('region', { name: 'Kurzfassung' })).toContainText('Clara sieht');
    // the limiter has seen 30 checks this minute
    api.admin.checkTimes = Array.from({ length: 30 }, () => Date.now());
    await panel.getByRole('searchbox', { name: 'Film oder Serie suchen' }).fill('Dunmoor');
    const status = panel.getByRole('region', { name: 'Titel prüfen' }).getByRole('status');
    await expect(status).toHaveText('Zu viele Prüfungen in kurzer Zeit. Bitte eine Minute warten.');
    await expect(status).not.toContainText('fehlgeschlagen');
    await expect.poll(() => logged(api, /POST .*\/check .* -> 429/)).toBe(true);
  });

  test('title check: an unrated title a grown-up\'s cap hides (adapters that say so) names that reason', async ({ page, api }) => {
    api.admin.checkHidesUnrated = true;
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const panel = checkPanel(page);
    await panel.getByRole('searchbox', { name: 'Film oder Serie suchen' }).fill('Dunmoor');
    const rows = panel.getByRole('region', { name: 'Titel prüfen' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Dunmoor Origins' })).toContainText('ausgeblendet · ohne Altersfreigabe');
    await expect(rows.filter({ hasText: 'Dunmoor Origins' })).not.toContainText('Kinderprofil');
  });

  test('title check: at most 8 hits, and the list says it may be cut', async ({ page }) => {
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const panel = checkPanel(page);
    await panel.getByRole('searchbox', { name: 'Film oder Serie suchen' }).fill('Harbour');
    const sec = panel.getByRole('region', { name: 'Titel prüfen' });
    await expect(sec.getByRole('listitem')).toHaveCount(8);
    await expect(sec.getByText('Höchstens 8 Treffer. Für weitere den Titel genauer eingeben.')).toBeVisible();
    await panel.getByRole('searchbox', { name: 'Film oder Serie suchen' }).fill('Dunmoor');
    await expect(sec.getByRole('listitem')).toHaveCount(2);
    await expect(sec.getByText(/Höchstens 8 Treffer/)).toHaveCount(0);
  });

  test('kids summary: the effective limit from the rows (a lower account cap wins), none said honestly, never a guessed one', async ({ page, api }) => {
    const clara = api.admin.users.find((u) => u.id === CLARA)!;
    clara.ov = { ...clara.ov, maxParentalRating: 0 };
    api.admin.userProfiles[CLARA] = [
      { id: `${CLARA.slice(0, -4)}p001`, name: 'Clara', kids: false, maxRating: null, avatar: 'a1', lastUsed: null, isOwner: true, hasPin: false },
      { id: `${CLARA.slice(0, -4)}p002`, name: 'Kinder', kids: true, maxRating: 12, avatar: 'a4', lastUsed: null, isOwner: false, hasPin: false },
    ];
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const panel = checkPanel(page);
    const summary = panel.getByRole('region', { name: 'Kurzfassung' });
    await panel.getByRole('group', { name: 'Profil wählen' }).getByRole('button', { name: /^Kinder/ }).click();
    await expect(summary).toContainText('Kinderprofil: ab 0, Titel ohne Freigabe sind ausgeblendet');
    await expect(summary).not.toContainText('ab 12');
    // a kids profile whose rows carry no limit at all: said as such (the answer is changed in the page, after the mock's route)
    await page.addInitScript((part) => {
      const orig = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await orig(input, init);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes(part)) return res;
        const v = await res.clone().json() as { rows: Array<{ key: string; value: unknown }>; profile: { maxRating: unknown } };
        v.rows = v.rows.map((row) => (row.key === 'maxParentalRating' ? { ...row, value: null } : row));
        v.profile.maxRating = null;
        return new Response(JSON.stringify(v), { status: res.status, headers: res.headers });
      };
    }, `/api/admin/users/${CLARA}/rights?profile=`);
    await page.reload();
    await panel.getByRole('group', { name: 'Profil wählen' }).getByRole('button', { name: /^Kinder/ }).click();
    await expect(summary).toContainText('Kinderprofil ohne Altersgrenze: Titel ohne Freigabe sind ausgeblendet, keine Kommentare, keine Partys.');
    await expect(summary).not.toContainText(/ab \d/);
  });

  test('a malformed profile id is 400 (the route\'s schema), an unknown one 404', async ({ page }) => {
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    await expect(checkPanel(page).getByRole('region', { name: 'Kurzfassung' })).toContainText('Clara sieht');
    /** the status of a request the page sends (the mock answers the page's requests); `post` is a JSON body */
    const status = (url: string, post?: unknown) => page.evaluate(async ([u, b]) => (await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, [url, post] as const);
    const base = `/api/admin/users/${CLARA}`;
    expect(await status(`${base}/check?profile=not-a-profile`)).toBe(400);
    expect(await status(`${base}/rights?profile=not-a-profile`)).toBe(400);
    expect(await status(`${base}/check`, { profileId: 'x', query: 'Dunmoor' })).toBe(400);
    expect(await status(`${base}/check?profile=${CLARA.slice(0, -4)}p099`)).toBe(404);
  });

  test('title check: nothing is sent under 2 characters', async ({ page, api }) => {
    await page.goto(`/admin/users/${CLARA}?tab=check`);
    const panel = checkPanel(page);
    const box = panel.getByRole('searchbox', { name: 'Film oder Serie suchen' });
    await expect(panel.getByRole('region', { name: 'Kurzfassung' })).toContainText('Clara sieht');
    await box.fill('D');
    await expect(panel.getByText('Mindestens 2 Zeichen eingeben.')).toBeVisible();
    // a negative: give the 300 ms debounce more than its time before looking
    await page.waitForTimeout(700);
    expect(checkPosts(api)).toEqual([]);
    await box.fill('Salt');
    await expect(panel.getByRole('region', { name: 'Titel prüfen' }).getByRole('listitem')).toHaveCount(1);
    await box.fill('S');
    await expect(panel.getByText('Mindestens 2 Zeichen eingeben.')).toBeVisible();
    await expect(panel.getByRole('region', { name: 'Titel prüfen' }).getByRole('listitem')).toHaveCount(0);
    expect(checkPosts(api)).toHaveLength(1);
  });
});
