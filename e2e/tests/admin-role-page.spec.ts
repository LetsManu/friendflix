// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** One page per role (roles redesign §5.3): area switches with the coupling, the details per area, the channel groups inline, save, guard (mocked API). */
import type { Locator, Page } from '@playwright/test';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';
import { armTransition, expectAlongCurve, seekTransition } from '../helpers.js';
import { envOnlyRole, ENV_ONLY_KEY } from '../mocks/admin.js';

const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const areas = (page: Page) => page.getByRole('region', { name: 'Bereiche' });
const area = (page: Page, name: string) => areas(page).getByRole('switch', { name, exact: true });
const chips = (page: Page, role: string) => page.getByRole('group', { name: `Kanalgruppen von ${role}` });
const review = async (page: Page) => {
  await bar(page).getByRole('button', { name: 'Änderungen prüfen' }).click();
  return page.getByRole('dialog', { name: 'Änderungen prüfen' });
};
/** a box in page coordinates (an interaction may scroll the window: what matters is whether the element moved on the page) */
const pageBox = (l: Locator) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; });
const values = (api: MockState, key: string) => api.admin.matrix.roles.find((r) => r.key === key)!.values;
/** Live TV installed with two released groups (Nordlicht TV seen by Freund) and one waiting for release */
function liveTv(api: MockState) {
  Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
  api.admin.matrix.features.livetv = true;
  const g = (id: string, name: string, position: number, o: Record<string, unknown> = {}) => ({ id, name, kidFriendly: false, roles: [] as string[], released: true, position, channels: 12, providerGroups: [], ...o });
  api.admin.livetv.area.groups = [
    g('g-nord', 'Nordlicht TV', 0, { roles: ['family', 'friend'] }),
    g('g-hafen', 'Hafenkanal', 1, { kidFriendly: true, channels: 4, roles: ['family'] }),
    g('g-neu', 'Neue Gruppe', 2, { released: false }),
  ];
  Object.assign(values(api, 'friend'), { liveTv: true });
}

test.describe('Rollen & Rechte: the role page', () => {
  test.use({ allowedConsole: /status of (400|502)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('Freund: switching Mediathek off disables Wünsche, Gemeinsam, Downloads with "Braucht die Mediathek"; review lists the six changes; save sends one PUT', async ({ page, api }) => {
    Object.assign(values(api, 'friend'), { download: true, partySchedule: true });
    await page.goto('/admin/roles/friend');
    await expect(page.getByRole('link', { name: 'Rollen', exact: true })).toHaveAttribute('href', '/admin/roles');
    for (const n of ['Mediathek', 'Wünsche', 'Gemeinsam', 'Downloads']) await expect(area(page, n)).toBeChecked();
    await expect(page.getByRole('region', { name: 'Gemeinsam' })).toBeVisible();
    await area(page, 'Mediathek').click();
    await expect(area(page, 'Mediathek')).not.toBeChecked();
    for (const n of ['Wünsche', 'Gemeinsam', 'Downloads']) {
      await expect(area(page, n)).not.toBeChecked();
      await expect(area(page, n)).toBeDisabled();
      await expect(area(page, n)).toHaveAccessibleDescription(/Braucht die Mediathek/);
    }
    // a disabled area does not switch on
    await area(page, 'Wünsche').click({ force: true });
    await expect(area(page, 'Wünsche')).not.toBeChecked();
    // the sections of the areas that are off are gone
    for (const n of ['Mediathek', 'Wünsche', 'Gemeinsam', 'Downloads']) await expect(page.getByRole('region', { name: n, exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Allgemein' })).toBeVisible();
    await expect(bar(page)).toContainText('6 Änderungen in 1 Rolle · betrifft 7 Personen');
    const sheet = await review(page);
    await expect(sheet.getByRole('listitem')).toHaveText([
      'Freund · Bibliotheken: alle → Keine Bibliothek',
      'Freund · Downloads erlaubt: ✓ → –',
      'Freund · Darf sich Titel wünschen: ✓ → –',
      'Freund · Watch-Partys: ✓ → –',
      'Freund · Mehr als 3 geplante Partys: ✓ → –',
      'Freund · Kommentare: ✓ → –',
    ]);
    await sheet.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'friend', body: { libraries: [], download: false, perms: { requests: false, party: false, partySchedule: false, comments: false } } }]);
    await expect(bar(page)).toHaveCount(0);
    await expect(area(page, 'Mediathek')).not.toBeChecked();
  });

  test('Mediathek off then on before saving leaves nothing staged (save bar gone)', async ({ page }) => {
    await page.goto('/admin/roles/friend');
    await area(page, 'Mediathek').click();
    await expect(bar(page)).toBeVisible();
    await area(page, 'Mediathek').click();
    await expect(bar(page)).toHaveCount(0);
    for (const n of ['Mediathek', 'Wünsche', 'Gemeinsam']) await expect(area(page, n)).toBeChecked();
    await expect(area(page, 'Downloads')).not.toBeChecked();
    await expect(area(page, 'Downloads')).toBeEnabled();
  });

  test('unticking the last library is the Mediathek switched off, with what needs it', async ({ page, api }) => {
    Object.assign(values(api, 'friend'), { libraries: ['Musik'] });
    await page.goto('/admin/roles/friend');
    // the section goes with the Mediathek: a press, not a check that waits for the box
    await page.getByRole('region', { name: 'Mediathek' }).getByRole('checkbox', { name: 'Musik' }).click();
    await expect(area(page, 'Mediathek')).not.toBeChecked();
    await expect(area(page, 'Wünsche')).toBeDisabled();
    await expect(bar(page)).toContainText('4 Änderungen');
    await area(page, 'Mediathek').click();
    await expect(bar(page)).toHaveCount(0);
    // the admin role keeps its last library
    Object.assign(values(api, 'admin'), { libraries: ['Musik'] });
    await page.goto('/admin/roles/admin');
    await expect(page.getByRole('region', { name: 'Mediathek' }).getByRole('checkbox', { name: 'Musik' })).toBeDisabled();
  });

  test('a key press that removes its own section moves the focus to that area\'s card', async ({ page, api }) => {
    Object.assign(values(api, 'friend'), { libraries: ['Musik'] });
    await page.goto('/admin/roles/friend');
    // the role page never shows the "no library" hint: its line is not reserved under the checkboxes
    await expect(page.locator('[data-field="libraries"] p.min')).toHaveCount(0);
    await page.getByRole('region', { name: 'Mediathek' }).getByRole('checkbox', { name: 'Musik' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('region', { name: 'Mediathek', exact: true })).toHaveCount(0);
    await expect(area(page, 'Mediathek')).toBeFocused();
    await page.keyboard.press('Space'); // the card switches it back on
    await expect(bar(page)).toHaveCount(0);
    // Gemeinsam: the last of Watch-Partys and Kommentare switched off
    const together = page.getByRole('region', { name: 'Gemeinsam', exact: true });
    await together.getByRole('switch', { name: 'Watch-Partys' }).focus();
    await page.keyboard.press('Space');
    await expect(together).toBeVisible();
    await expect(together.getByRole('switch', { name: 'Watch-Partys' })).toBeFocused();
    await together.getByRole('switch', { name: 'Kommentare' }).focus();
    await page.keyboard.press('Space');
    await expect(together).toHaveCount(0);
    await expect(area(page, 'Gemeinsam')).toBeFocused();
  });

  test('Live-TV groups: tick Hafenkanal → review "Live-TV-Gruppen: Nordlicht TV → Nordlicht TV, Hafenkanal" → PUT body livetvGroups [ids]', async ({ page, api }) => {
    liveTv(api);
    await page.goto('/admin/roles/friend');
    const g = chips(page, 'Freund');
    await expect(g.getByRole('button', { name: /^Nordlicht TV/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toContainText('Kinderfreundlich');
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toContainText('4 Kanäle');
    // the group waiting for release is not offered, a link says so
    await expect(g.getByRole('button', { name: /Neue Gruppe/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '1 Gruppe wartet auf Freigabe' })).toHaveAttribute('href', '/admin/livetv?tab=groups&pending=1');
    await expect(page.getByRole('link', { name: 'Gruppen verwalten' })).toHaveAttribute('href', '/admin/livetv?tab=groups');
    await g.getByRole('button', { name: /^Hafenkanal/ }).click();
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toHaveAttribute('aria-pressed', 'true');
    const sheet = await review(page);
    await expect(sheet.getByRole('listitem')).toHaveText(['Freund · Live-TV-Gruppen: Nordlicht TV → Nordlicht TV, Hafenkanal']);
    await expect(sheet).not.toContainText('Medienserver'); // no media server policy for groups
    await sheet.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'friend', body: { livetvGroups: ['g-nord', 'g-hafen'] } }]);
    expect(api.admin.livetv.area.groups.find((x) => x.id === 'g-hafen')!.roles).toContain('friend');
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar(page)).toHaveCount(0);
  });

  test('no group chosen: the reserved warning line appears without moving the chips (bounding boxes equal)', async ({ page, api }) => {
    liveTv(api);
    await page.goto('/admin/roles/friend');
    const g = chips(page, 'Freund');
    const warn = page.getByText('Ohne Kanalgruppe sieht diese Rolle kein Live-TV.');
    await expect(warn).toHaveCount(0);
    const before = await Promise.all([pageBox(g), pageBox(page.getByRole('link', { name: 'Gruppen verwalten' }))]);
    await page.getByRole('button', { name: 'Keine', exact: true }).click();
    await expect(warn).toBeVisible();
    await expect(g.getByRole('button', { name: /^Nordlicht TV/ })).toHaveAttribute('aria-pressed', 'false');
    expect(await Promise.all([pageBox(g), pageBox(page.getByRole('link', { name: 'Gruppen verwalten' }))])).toEqual(before);
    await page.getByRole('button', { name: 'Alle', exact: true }).click();
    await expect(warn).toHaveCount(0);
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toHaveAttribute('aria-pressed', 'true');
    const sheet = await review(page);
    await expect(sheet.getByRole('listitem')).toHaveText(['Freund · Live-TV-Gruppen: Nordlicht TV → Nordlicht TV, Hafenkanal']);
  });

  test('Live-TV off: chips dimmed and disabled, still listed', async ({ page, api }) => {
    liveTv(api);
    await page.goto('/admin/roles/friend');
    await area(page, 'Live-TV').click();
    const g = chips(page, 'Freund');
    await expect(g.getByRole('button')).toHaveCount(2);
    for (const b of await g.getByRole('button').all()) await expect(b).toBeDisabled();
    await expect(g.getByRole('button', { name: /^Nordlicht TV/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Gespeichert, wirkt wenn Live-TV an ist')).toBeVisible();
    expect(Number(await g.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
    await expect(page.getByRole('button', { name: 'Keine', exact: true })).toBeDisabled();
  });

  test('Live-TV: Darf aufnehmen is a sub-switch; Live-TV off switches it off and locks it ("Braucht Live-TV"), on again restores it', async ({ page, api }) => {
    liveTv(api);
    Object.assign(values(api, 'friend'), { liveRecord: true });
    await page.goto('/admin/roles/friend');
    const sec = page.getByRole('region', { name: 'Live-TV', exact: true });
    const rec = sec.getByRole('switch', { name: 'Darf aufnehmen' });
    await expect(rec).toBeChecked();
    await expect(rec).toBeEnabled();
    const line = sec.locator('[data-field="liveRecord"] .mark');
    const box = await pageBox(line);
    await area(page, 'Live-TV').click();
    await expect(rec).not.toBeChecked();
    await expect(rec).toBeDisabled();
    await expect(line).toHaveText('Braucht Live-TV');
    expect(await pageBox(line)).toEqual(box); // the line was there all along
    await expect(bar(page)).toContainText('2 Änderungen');
    const sheet = await review(page);
    await expect(sheet.getByRole('listitem')).toHaveText(['Freund · Live-TV: ✓ → –', 'Freund · Darf aufnehmen: ✓ → –']);
    await page.keyboard.press('Escape');
    await area(page, 'Live-TV').click();
    await expect(bar(page)).toHaveCount(0);
    await expect(rec).toBeChecked();
    // on its own it switches like any right
    await rec.click();
    await (await review(page)).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'friend', body: { perms: { liveRecord: false } } }]);
    // a role saved without Live-TV: the switch reads off and stays locked
    Object.assign(values(api, 'guest'), { liveTv: false, liveRecord: true });
    await page.goto('/admin/roles/guest');
    const g = page.getByRole('region', { name: 'Live-TV', exact: true }).getByRole('switch', { name: 'Darf aufnehmen' });
    await expect(g).not.toBeChecked();
    await expect(g).toBeDisabled();
  });

  test('admin page: area switches locked with "Admins dürfen immer alles"; groups read "Alle freigegebenen Gruppen"', async ({ page, api }) => {
    liveTv(api);
    await page.goto('/admin/roles/admin');
    for (const n of ['Mediathek', 'Live-TV', 'Wünsche', 'Gemeinsam', 'Downloads']) {
      await expect(area(page, n)).toBeChecked();
      await expect(area(page, n)).toBeDisabled();
      await expect(area(page, n)).toHaveAccessibleDescription(/Admins dürfen immer alles/);
    }
    await area(page, 'Mediathek').click({ force: true });
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByText('Alle freigegebenen Gruppen')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Kanalgruppen von Admin' })).toHaveCount(0);
    // the numbers stay editable; the switches of the admin role are not offered
    await expect(page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toBeEnabled();
    await expect(page.getByRole('switch', { name: 'Watch-Partys' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Für Einladungen wählbar' })).toHaveCount(0);
    // Gemeinsam has only switches, all locked for admin: no empty panel
    await expect(page.getByRole('region', { name: 'Gemeinsam', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Wünsche', exact: true })).toBeVisible();
  });

  test('env-only role: name and groups locked with "Steht in der .env"', async ({ page, api }) => {
    liveTv(api);
    api.admin.matrix.roles.push(envOnlyRole());
    Object.assign(values(api, ENV_ONLY_KEY), { liveTv: true });
    await page.goto(`/admin/roles/${encodeURIComponent(ENV_ONLY_KEY)}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Kombüse' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
    await expect(page.getByText('Steht in der .env')).toHaveCount(2);
    for (const b of await chips(page, 'Kombüse').getByRole('button').all()) await expect(b).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Für Einladungen wählbar' })).toHaveCount(0);
    // the values stay editable (the role row overrides .env)
    await page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' }).fill('3');
    await expect(bar(page)).toContainText('1 Änderung');
  });

  test('a value from .env says "aus .env"; a role-set value says "geändert (Standard: …)"', async ({ page, api }) => {
    await page.goto('/admin/roles/crew');
    const streams = page.locator('[data-field="maxStreams"]');
    await expect(streams).toContainText('aus .env');
    const guest = api.admin.matrix.roles.find((r) => r.key === 'guest')!;
    guest.values.maxStreams = 3;
    guest.sources.maxStreams = 'role';
    await page.goto('/admin/roles/guest');
    await expect(page.locator('[data-field="maxStreams"]')).toContainText('geändert (Standard: 1)');
    // a staged value says so on the same line (reserved: nothing moves, also where the line was empty)
    const empty = page.locator('[data-field="maxBitrate"] .mark');
    await expect(empty).toHaveText('');
    const below = await pageBox(page.locator('[data-field="remoteMaxBitrate"]'));
    await page.locator('[data-field="maxBitrate"]').getByRole('combobox').selectOption({ index: 0 });
    await expect(empty).toHaveText('Nicht gespeichert');
    expect(await pageBox(page.locator('[data-field="remoteMaxBitrate"]'))).toEqual(below);
    const line = page.locator('[data-field="maxStreams"] .mark');
    const box = await pageBox(line);
    await page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' }).fill('4');
    await expect(line).toHaveText('Nicht gespeichert');
    expect(await pageBox(line)).toEqual(box);
  });

  test('pressing an area switch never moves it', async ({ page }) => {
    await page.goto('/admin/roles/friend');
    const grid = areas(page);
    const boxes = async () => Promise.all([pageBox(grid), ...['Mediathek', 'Wünsche', 'Gemeinsam', 'Downloads'].map((n) => pageBox(area(page, n)))]);
    const before = await boxes();
    await area(page, 'Mediathek').click();
    await expect(area(page, 'Wünsche')).toBeDisabled();
    expect(await boxes()).toEqual(before);
    await area(page, 'Downloads').click({ force: true });
    await area(page, 'Mediathek').click();
    await area(page, 'Downloads').click();
    await expect(area(page, 'Downloads')).toBeChecked();
    expect(await boxes()).toEqual(before);
  });

  test('leaving with staged changes asks first', async ({ page }) => {
    await page.goto('/admin/roles/friend');
    await area(page, 'Gemeinsam').click();
    await page.getByRole('link', { name: 'Rollen', exact: true }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    await expect(dlg).toContainText('1 Rolle hat ungespeicherte Änderungen');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles\/friend$/);
    await page.getByRole('link', { name: 'Rollen', exact: true }).click();
    await dlg.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
  });

  test('a 502 policy_partial offers Erneut anwenden', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto('/admin/roles/guest');
    await page.getByRole('combobox', { name: 'Altersfreigabe' }).selectOption('16');
    await (await review(page)).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    // stored either way: nothing is staged any more
    await expect(bar(page).getByRole('button', { name: 'Änderungen prüfen' })).toHaveCount(0);
    api.admin.matrix.policyPartial = false;
    await bar(page).getByRole('button', { name: 'Erneut anwenden' }).click();
    await expect(bar(page)).toHaveCount(0);
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { maxParentalRating: 16 } }, { role: 'guest', body: { maxParentalRating: 16 } }]);
  });

  test('/admin/roles/unknown shows the missing state with a link back', async ({ page }) => {
    await page.goto('/admin/roles/unknown');
    await expect(page.getByText('Diese Rolle gibt es nicht (mehr).')).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: 'Rollen', exact: true }).last().click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
  });

  test('?field=maxStreams focuses that field', async ({ page }) => {
    await page.goto('/admin/roles/guest?field=maxStreams');
    await expect(page.getByRole('spinbutton', { name: 'Gleichzeitige Streams' })).toBeFocused();
    await page.goto('/admin/roles/guest?field=liveTv');
    await expect(page.getByRole('heading', { level: 2, name: 'Gast' })).toBeVisible(); // Live TV not installed: nothing to focus, no error
  });

  test('a reload or a closed tab with staged changes asks the browser first; without changes it does not', async ({ page }) => {
    await page.goto('/admin/roles/friend');
    let asked = '';
    page.on('dialog', (d) => { asked = d.type(); void d.dismiss(); });
    await page.reload();
    expect(asked).toBe('');
    await area(page, 'Gemeinsam').click();
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => { location.reload(); });
    await expect.poll(() => asked).toBe('beforeunload');
    // dismissed: the page and its staged change stay
    await expect(bar(page)).toContainText('2 Änderungen');
  });

  test('Duplizieren with staged changes asks before it creates anything', async ({ page, api }) => {
    await page.goto('/admin/roles/crew');
    await area(page, 'Gemeinsam').click();
    const before = api.admin.matrix.roles.length;
    const ask = async () => {
      await page.getByRole('button', { name: 'Aktionen für Crew' }).click();
      await page.getByRole('dialog', { name: 'Crew' }).getByRole('button', { name: 'Duplizieren' }).click();
      return page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' });
    };
    await (await ask()).getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByRole('dialog', { name: 'Rolle „Crew“ duplizieren' })).toHaveCount(0);
    await expect(bar(page)).toBeVisible();
    await (await ask()).getByRole('button', { name: 'Verwerfen' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Crew“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Hafencrew');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles\/hafencrew$/);
    await expect(page.getByRole('alertdialog')).toHaveCount(0); // asked once, before the copy
    expect(api.admin.matrix.roles.length).toBe(before + 1);
    expect(api.admin.matrix.puts).toEqual([]);
  });

  test('a channel group that changed meanwhile: the groups are read again, a specific message, nothing is resent', async ({ page, api }) => {
    liveTv(api);
    await page.goto('/admin/roles/friend');
    const g = chips(page, 'Freund');
    await g.getByRole('button', { name: /^Nordlicht TV/ }).click();
    await g.getByRole('button', { name: /^Hafenkanal/ }).click();
    // another admin takes Hafenkanal back meanwhile: the write answers 400 invalid livetvGroups
    api.admin.livetv.area.groups.find((x) => x.id === 'g-hafen')!.released = false;
    await (await review(page)).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Die Kanalgruppen haben sich geändert. Bitte prüfe die Auswahl und speichere noch einmal.')).toBeVisible();
    // the list is read again: Hafenkanal is gone, the choice without it stays staged (Nordlicht TV off)
    await expect(g.getByRole('button', { name: /^Hafenkanal/ })).toHaveCount(0);
    await expect(g.getByRole('button', { name: /^Nordlicht TV/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(bar(page)).toContainText('1 Änderung');
    await expect(bar(page).getByRole('button', { name: 'Erneut anwenden' })).toHaveCount(0);
    expect(api.admin.matrix.puts).toEqual([]); // the mock logs only accepted bodies: one refused write, never resent
    const sheet = await review(page);
    await expect(sheet.getByRole('listitem')).toHaveText(['Freund · Live-TV-Gruppen: Nordlicht TV → Keine']);
  });

  test('a lock reason wraps instead of being cut off at mid widths, and the cards keep their size', async ({ page }) => {
    await page.setViewportSize({ width: 610, height: 900 });
    await page.goto('/admin/roles/friend');
    const card = page.locator('[data-area="requests"]');
    const before = await pageBox(card);
    await area(page, 'Mediathek').click();
    const why = card.locator('.why');
    await expect(why).toHaveText('Braucht die Mediathek');
    expect(await why.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(await pageBox(card)).toEqual(before);
  });

  test('the name stages; Duplizieren opens the copy\'s page; Löschen goes back to the list', async ({ page, api }) => {
    await page.goto('/admin/roles/crew');
    await page.getByRole('textbox', { name: 'Name' }).fill('Bordcrew');
    await expect(page.getByRole('heading', { level: 2, name: 'Bordcrew' })).toBeVisible();
    await (await review(page)).getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    expect(api.admin.matrix.puts).toEqual([{ role: 'crew', body: { label: 'Bordcrew' } }]);
    await page.getByRole('button', { name: 'Aktionen für Bordcrew' }).click();
    await page.getByRole('dialog', { name: 'Bordcrew' }).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Bordcrew“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Hafencrew');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles\/hafencrew$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Hafencrew' })).toBeVisible();
    await page.getByRole('button', { name: 'Aktionen für Hafencrew' }).click();
    await page.getByRole('dialog', { name: 'Hafencrew' }).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog', { name: 'Rolle „Hafencrew“ löschen?' }).getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Hafencrew“ gelöscht.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/roles$/);
  });
});

/** the save bar, the leave guard, the menu and the toasts, as the compare view's tests had them (that view is read-only now, roles redesign §1.1) */
test.describe('Rollen & Rechte: the role page saves, guards and tells', () => {
  test.use({ allowedConsole: /status of 502/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  /** the points (fractions of the duration) a seeked transition is read at */
  const AT = [0, 0.125, 0.25, 0.5, 0.75, 1];
  const rating = (page: Page) => page.getByRole('combobox', { name: 'Altersfreigabe' });

  test('retry sends only the failed role\'s last body, not newer edits', async ({ page, api }) => {
    api.admin.matrix.policyPartial = true;
    await page.goto('/admin/roles/guest');
    await rating(page).selectOption('16');
    await (await review(page)).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('2 Konten konnten nicht aktualisiert werden.');
    // a new edit while the failure stands
    await area(page, 'Gemeinsam').click();
    api.admin.matrix.policyPartial = false;
    await bar(page).getByRole('button', { name: 'Erneut anwenden' }).click();
    await expect(bar(page)).not.toContainText('Konten konnten nicht');
    await expect(bar(page)).toContainText('2 Änderungen in 1 Rolle · betrifft 3 Personen');
    // the newer edit is still staged: not "Änderungen gespeichert."
    await expect(toasts(page).getByText('1 fehlgeschlagene Rolle gespeichert.')).toBeVisible();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toHaveCount(0);
    expect(api.admin.matrix.puts).toEqual([{ role: 'guest', body: { maxParentalRating: 16 } }, { role: 'guest', body: { maxParentalRating: 16 } }]);
    await expect(area(page, 'Gemeinsam')).toBeChecked();
  });

  test('leaving by Back with staged changes: Verwerfen goes back once, the next Back goes back again', async ({ page }) => {
    await page.goto('/admin');
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await nav.getByRole('link', { name: 'Nutzer' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await nav.getByRole('link', { name: 'Rollen & Rechte' }).click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await page.getByRole('list', { name: 'Rollen' }).getByRole('link', { name: 'Gast', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/roles\/guest$/);
    await rating(page).selectOption('16');
    const n = await page.evaluate(() => history.length);
    await page.evaluate(() => history.back());
    await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await expect.poll(() => page.evaluate(() => history.length)).toBe(n);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/admin\/users$/);
  });

  test('leaving by a link with staged changes: Verwerfen pushes one entry, as the link would', async ({ page }) => {
    await page.goto('/admin/roles/guest');
    await rating(page).selectOption('16');
    const n = await page.evaluate(() => history.length);
    await page.getByRole('navigation', { name: 'Admin-Bereiche' }).getByRole('link', { name: 'Nutzer' }).click();
    await page.getByRole('alertdialog', { name: 'Änderungen verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect.poll(() => page.evaluate(() => history.length)).toBe(n + 1);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/admin\/roles\/guest$/);
    await expect(bar(page)).toHaveCount(0);
  });

  test('history shows a rename and the invitable switch as from → to', async ({ page }) => {
    await page.goto('/admin/roles/guest');
    await page.getByRole('textbox', { name: 'Name' }).fill('Besucher');
    await page.getByRole('switch', { name: 'Für Einladungen wählbar' }).click();
    const sheet = await review(page);
    await expect(sheet.getByText('Gast · Name: Gast → Besucher')).toBeVisible();
    await expect(sheet.getByText('Gast · Für Einladungen wählbar: erlaubt → nicht erlaubt')).toBeVisible();
    await sheet.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await page.getByRole('button', { name: 'Aktionen für Besucher' }).click();
    await page.getByRole('dialog', { name: 'Besucher' }).getByRole('button', { name: 'Verlauf' }).click();
    const h = page.getByRole('dialog', { name: 'Verlauf · Besucher' });
    await expect(h.getByText('Name: Gast → Besucher')).toBeVisible();
    await expect(h.getByText('Für Einladungen wählbar: erlaubt → nicht erlaubt')).toBeVisible();
  });

  test('clearing the name leaves no prefix staged', async ({ page }) => {
    await page.goto('/admin/roles/friend');
    const name = page.getByRole('textbox', { name: 'Name' });
    await name.fill('F');
    await expect(bar(page)).toContainText('1 Änderung in 1 Rolle');
    await name.fill('');
    await expect(page.getByText('Bitte einen Namen mit 1 bis 30 Zeichen eingeben.')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await name.fill('Freund'); // typed back: nothing left to save
    await expect(bar(page)).toHaveCount(0);
  });

  test('while a save runs the menu cannot duplicate or delete', async ({ page, api }) => {
    const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    api.admin.matrix.roles.splice(4, 0, { ...family, key: 'oma', label: 'Oma', builtinLabel: false, origin: 'admin', accounts: 0, profiles: 0, kidsProfiles: 0, invites: 0, values: { ...family.values } });
    await page.goto('/admin/roles/oma');
    await rating(page).selectOption('16');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/admin/roles/oma', async (r) => { if (r.request().method() === 'PUT') await held; await r.fallback(); });
    await (await review(page)).getByRole('button', { name: 'Speichern' }).click();
    await expect(bar(page)).toContainText('Aktualisiere 1 von 1 …');
    await expect(rating(page)).toBeDisabled();
    await page.getByRole('button', { name: 'Aktionen für Oma' }).click();
    const m = page.getByRole('dialog', { name: 'Oma' });
    for (const n of ['Duplizieren', 'Löschen']) await expect(m.getByRole('button', { name: n })).toBeDisabled();
    await expect(m.getByRole('button', { name: 'Verlauf' })).toBeEnabled();
    await page.keyboard.press('Escape');
    release();
    await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
    await expect(rating(page)).toBeEnabled();
  });

  test('a long toast beside a sheet stays on screen and left of the sheet (1000 px)', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto('/admin/roles/family');
    await page.getByRole('button', { name: 'Aktionen für Familie' }).click();
    await page.getByRole('dialog', { name: 'Familie' }).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Oma & Opa aus dem Nachbardorf');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    const toast = toasts(page).getByRole('listitem').filter({ hasText: 'Rolle „Oma & Opa aus dem Nachbardorf“ angelegt.' });
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Aktionen für Oma & Opa aus dem Nachbardorf' }).click();
    await page.getByRole('dialog', { name: 'Oma & Opa aus dem Nachbardorf' }).getByRole('button', { name: 'Verlauf' }).click();
    const sheet = page.getByRole('dialog', { name: 'Verlauf · Oma & Opa aus dem Nachbardorf' });
    await expect(sheet).toBeVisible();
    await expect(toast).toBeVisible();
    // the sheet is narrower than the window: the toast is centred in the rest and never wider than it
    await expect.poll(async () => {
      const [a, b] = await Promise.all([toast.boundingBox(), sheet.boundingBox()]);
      return a && b ? { left: a.x >= 0, beside: Math.round(a.x + a.width) <= Math.round(b.x) } : null;
    }).toEqual({ left: true, beside: true });
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('the success toast glides down as the bar leaves (no snap)', async ({ page }) => {
      await page.goto('/admin/roles/guest');
      await rating(page).selectOption('16');
      const sheet = await review(page);
      const vh = await page.evaluate(() => window.innerHeight);
      // the review sheet's room goes when it closes, the bar's room (96 px) once the bar has gone: catch that one
      await armTransition(page, '.toasts', 'bottom', '--savebar-h');
      await sheet.getByRole('button', { name: 'Speichern' }).click();
      await expect(toasts(page).getByText('Änderungen gespeichert.')).toBeVisible();
      // from above the bar down to its own place: a 240 ms transform transition on the glass curve, seeked (not sampled per frame)
      const { duration, ys } = await seekTransition(page, '.toasts', AT);
      expect(duration).toBe(240);
      expectAlongCurve(ys, AT, vh - 36 - 96, vh - 36);
      await expect.poll(() => toasts(page).evaluate((el) => el.getBoundingClientRect().bottom)).toBeCloseTo(vh - 36, 0);
    });

    test('the save bar glides up when the cast bar comes (no snap)', async ({ page }) => {
      await page.goto('/admin/roles/guest');
      await rating(page).selectOption('16');
      await expect(bar(page)).toBeVisible();
      const from = await armTransition(page, '.sb-wrap'); // after the bar's own rise
      await page.evaluate(() => document.documentElement.style.setProperty('--castbar-h', '92px'));
      // the same moment: no jump; then 240 ms on the glass curve up to 92 px higher, seeked (not sampled per frame)
      const { duration, ys } = await seekTransition(page, '.sb-wrap', AT);
      expect(duration).toBe(240);
      expectAlongCurve(ys, AT, from, from - 92);
    });
  });
});
