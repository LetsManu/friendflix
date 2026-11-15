// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Rollen & Rechte on the desktop (roles redesign §5): the role list with its menu, and *Vergleichen*, the read-only matrix (mocked API). */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { roleDeleteSample, type MatrixMockRole } from '../mocks/admin.js';

const grid = (page: Page) => page.getByRole('grid', { name: 'Rechte der Rollen' });
const cell = (page: Page, name: string | RegExp) => grid(page).getByRole('gridcell', { name, exact: typeof name === 'string' ? true : undefined });
const bar = (page: Page) => page.getByRole('region', { name: 'Ungespeicherte Änderungen' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
/** the points (fractions of the duration) a seeked transition is read at */
const AT = [0, 0.125, 0.25, 0.5, 0.75, 1];

/** the Rollen list (roles redesign §5.1): one row per role with its areas and people, the ⋯ menu; *Vergleichen* opens the matrix */
const roleList = (page: Page) => page.getByRole('list', { name: 'Rollen' });
const roleRow = (page: Page, name: string) => roleList(page).getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });
const rowNames = (page: Page) => roleList(page).locator('li > .main > .head > a.name').allTextContents();
const rowMenu = async (page: Page, role: string) => {
  await page.getByRole('button', { name: `Aktionen für ${role}` }).click();
  return page.getByRole('dialog', { name: role });
};

test.describe('Rollen & Rechte: the role list', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('the list shows each role with its area summary and people link; a role with Live-TV and no group shows the warning', async ({ page, api }) => {
    api.admin.matrix.features.livetv = true;
    const set = (key: string, values: Record<string, unknown>) => Object.assign(api.admin.matrix.roles.find((r) => r.key === key)!.values, values);
    set('family', { liveTv: true }); // Sport, Nachrichten, Kinderinsel, Natur & Tiere
    set('crew', { liveTv: true }); // no group
    set('guest', { libraries: [], liveTv: true, requests: false, party: false, comments: false }); // Nachrichten
    await page.goto('/admin/roles');
    await expect(page.getByRole('heading', { level: 1, name: 'Rollen & Rechte' })).toBeVisible();
    await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    await expect(roleRow(page, 'Familie')).toContainText('Mediathek · Live-TV · Wünsche · Gemeinsam · Downloads');
    await expect(roleRow(page, 'Freund')).toContainText('Mediathek · Wünsche · Gemeinsam');
    await expect(roleRow(page, 'Gast')).toContainText('Nur Live-TV');
    await expect(roleRow(page, 'Crew')).toContainText('Mediathek · Live-TV · Wünsche · Gemeinsam');
    // Live-TV without a group: the warning (an icon and its words); a role with groups or without Live-TV has none
    await expect(roleRow(page, 'Crew')).toContainText('Live-TV ohne Kanalgruppe');
    for (const n of ['Admin', 'Familie', 'Freund', 'Gast']) await expect(roleRow(page, n)).not.toContainText('ohne Kanalgruppe');
    // the row is a link to the role page; the people line its own link to Personen
    await expect(roleList(page).getByRole('link', { name: 'Gast', exact: true })).toHaveAttribute('href', '/admin/roles/guest');
    await expect(roleRow(page, 'Gast').getByRole('link', { name: '3 Personen · 2 Kinderprofile' })).toHaveAttribute('href', '/admin/users?role=guest');
    await expect(roleRow(page, 'Crew')).toContainText('aus .env');
    // nothing staged, no save bar, no matrix
    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Ungespeicherte Änderungen' })).toHaveCount(0);
  });

  test('without Live TV installed the summary names no Live-TV and nothing warns', async ({ page, api }) => {
    api.admin.matrix.roles.find((r) => r.key === 'crew')!.values.liveTv = true;
    await page.goto('/admin/roles');
    await expect(roleRow(page, 'Crew')).toContainText('Mediathek · Wünsche · Gemeinsam');
    await expect(roleRow(page, 'Crew')).not.toContainText('Live-TV');
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('Nach unten moves the row by transform (no snap) and sends PUT /order', async ({ page, api }) => {
      // a loaded runner draws slowly: the frame guard (which would drop the glide, by design) gets a budget it cannot trip
      await page.addInitScript(() => { (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 }; });
      await page.goto('/admin/roles');
      const fam = roleRow(page, 'Familie'), friend = roleRow(page, 'Freund');
      const top = async () => (await roleList(page).boundingBox())!.y;
      const [y0, y1] = [(await fam.boundingBox())!.y - await top(), (await friend.boundingBox())!.y - await top()];
      const menu = await rowMenu(page, 'Familie');
      // the row's glide is caught as it starts (paused), then seeked: deterministic, no frame sampling
      await page.evaluate(() => {
        const w = window as unknown as { __glide?: Animation };
        const own = Element.prototype.animate;
        Element.prototype.animate = function (this: Element, ...a: Parameters<Element['animate']>) {
          const an = own.apply(this, a);
          // Svelte first runs an empty placeholder for the delay; the glide is the one with keyframes and a duration
          const [frames, opts] = a;
          if (!w.__glide && this.matches('li[data-role="family"]') && Array.isArray(frames) && frames.length && typeof opts === 'object' && Number(opts.duration) > 0) { an.pause(); w.__glide = an; }
          return an;
        };
      });
      // the order write is held: its read-back must not restart the glide while it is read
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      await page.route('**/api/admin/roles/order', async (r) => { await held; await r.fallback(); });
      await menu.getByRole('button', { name: 'Nach unten' }).click();
      // shown at once (optimistic), before the write answers
      await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Freund', 'Familie', 'Gast', 'Crew']);
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __glide?: Animation }).__glide))).toBe(true);
      const { duration, ys, moved } = await page.evaluate((at) => {
        const a = (window as unknown as { __glide: Animation }).__glide;
        const el = document.querySelector('li[data-role="family"]')!, list = el.parentElement!;
        const duration = Number(a.effect!.getComputedTiming().duration);
        const ys: number[] = [], moved: boolean[] = [];
        for (const f of at) { a.currentTime = f * duration; ys.push(el.getBoundingClientRect().y - list.getBoundingClientRect().y); moved.push(getComputedStyle(el).transform !== 'none'); }
        a.finish();
        return { duration, ys, moved };
      }, AT);
      // from the old place (the open menu may have scrolled the page a little meanwhile) to the new one by transform, monotonic,
      // with places in between: no snap
      expect(duration).toBeGreaterThan(150);
      expect(ys[0]!).toBeLessThan(y0 + 4);
      expect(Math.abs(ys.at(-1)! - y1)).toBeLessThan(1);
      for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]! - 0.5);
      expect(ys.filter((y) => y > y0 + 1 && y < y1 - 1).length).toBeGreaterThanOrEqual(2);
      expect(moved.slice(0, -1).every(Boolean)).toBe(true);
      release();
      await expect.poll(() => api.admin.matrix.orders.length).toBe(1);
      expect(api.admin.matrix.orders[0]).toEqual(['admin', 'friend', 'family', 'guest', 'crew']);
      await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Freund', 'Familie', 'Gast', 'Crew']); // read back: unchanged
      await expect(page.getByRole('button', { name: 'Aktionen für Familie' })).toBeFocused();
      await expect(page.getByText('Rolle „Familie“ steht jetzt an Position 3 von 5.')).toBeAttached();
    });
  });

  test('the people link opens Personen filtered by the role', async ({ page }) => {
    await page.goto('/admin/roles');
    await roleRow(page, 'Gast').getByRole('link', { name: '3 Personen · 2 Kinderprofile' }).click();
    await expect(page).toHaveURL(/\/admin\/users\?role=guest$/);
    await expect(page.getByRole('combobox', { name: 'Rolle', exact: true })).toHaveValue('guest');
  });

  test('?view=compare opens the matrix; the segmented control switches without reload', async ({ page }) => {
    await page.goto('/admin/roles?view=compare');
    const tabs = page.getByRole('tablist', { name: 'Ansicht' });
    await expect(tabs.getByRole('tab', { name: 'Vergleichen' })).toHaveAttribute('aria-selected', 'true');
    await expect(grid(page)).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __same: boolean }).__same = true; });
    await tabs.getByRole('tab', { name: 'Rollen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await expect(roleList(page)).toBeVisible();
    await expect(grid(page)).toHaveCount(0);
    await tabs.getByRole('tab', { name: 'Vergleichen' }).click();
    await expect(page).toHaveURL(/\/admin\/roles\?view=compare$/);
    await expect(grid(page)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true);
  });

  test('the ⋯ menu: Bearbeiten opens the role page; built-ins have no Löschen; Duplizieren creates a copy and focuses it', async ({ page, api }) => {
    await page.goto('/admin/roles');
    const m = await rowMenu(page, 'Gast');
    await expect(m.getByRole('link', { name: 'Bearbeiten' })).toHaveAttribute('href', '/admin/roles/guest');
    await expect(m.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Umbenennen' })).toHaveCount(0);
    await m.getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Gast“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Nachbarn');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Rolle „Nachbarn“ angelegt.')).toBeVisible();
    await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew', 'Nachbarn']);
    await expect(roleList(page).getByRole('link', { name: 'Nachbarn', exact: true })).toBeFocused();
    expect(api.admin.matrix.roles.at(-1)!.key).toBe('nachbarn');
  });

  test('+ Neue Rolle: a name and the role to start from; the new role\'s page opens', async ({ page, api }) => {
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'Neue Rolle' }).click();
    const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
    await dlg.getByRole('combobox', { name: 'Starten mit' }).selectOption({ label: 'Familie' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Oma & Opa');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Rolle „Oma & Opa“ angelegt.')).toBeVisible();
    // the new role's page opens
    await expect(page).toHaveURL(/\/admin\/roles\/oma-opa$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Oma & Opa' })).toBeVisible();
    expect(api.admin.audit.some((e) => e.action === 'role.create' && (e.meta as { from?: string } | null)?.from === 'family')).toBe(true);
  });
});

/** *Vergleichen* (/admin/roles?view=compare, roles redesign §1.1, §5.5): the matrix, read-only; every cell and head links to the role page */
test.describe('compare (read-only)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  const link = (page: Page, name: string) => grid(page).getByRole('link', { name, exact: true });
  const rowHeads = (page: Page, group: string) => grid(page).locator('tbody').filter({ has: page.getByRole('columnheader', { name: group, exact: true }) }).getByRole('rowheader').allTextContents();

  test('compare: Enter on a cell opens the role page with that field focused', async ({ page }) => {
    await page.goto('/admin/roles?view=compare');
    const rating = link(page, 'Gast, Altersfreigabe: ab 12, bearbeiten');
    await expect(rating).toHaveAttribute('href', '/admin/roles/guest?field=maxParentalRating');
    await rating.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/roles\/guest\?field=maxParentalRating$/);
    await expect(page.getByRole('combobox', { name: 'Altersfreigabe' })).toBeFocused();
    // a Bereiche cell focuses the area's card
    await page.goto('/admin/roles?view=compare');
    await link(page, 'Freund, Downloads: nicht erlaubt, bearbeiten').click();
    await expect(page).toHaveURL(/\/admin\/roles\/friend\?field=area%3Adownloads$/);
    await expect(page.getByRole('region', { name: 'Bereiche' }).getByRole('switch', { name: 'Downloads', exact: true })).toBeFocused();
  });

  test('compare: the Bereiche rows show ✓/– per role; Darf aufnehmen is not listed', async ({ page, api }) => {
    api.admin.matrix.features.livetv = true;
    Object.assign(api.admin.matrix.roles.find((r) => r.key === 'guest')!.values, { libraries: [], liveTv: true });
    await page.goto('/admin/roles?view=compare');
    // the areas come first, then the details grouped by area (their own switches are the Bereiche rows)
    await expect(grid(page).locator('tbody th[scope="colgroup"]')).toHaveText(['Bereiche', 'Mediathek', 'Live-TV', 'Wünsche', 'Gemeinsam', 'Downloads', 'Allgemein']);
    expect(await rowHeads(page, 'Bereiche')).toEqual(['Mediathek', 'Live-TV', 'Wünsche', 'Gemeinsam', 'Downloads']);
    await expect(link(page, 'Familie, Downloads: erlaubt, bearbeiten').locator('.chip')).not.toHaveClass(/\boff\b/); // ✓
    await expect(link(page, 'Freund, Downloads: nicht erlaubt, bearbeiten').locator('.chip')).toHaveClass(/\boff\b/); // –
    // Gast without a library: Nur Live-TV (the coupled areas read off, as the role page shows them)
    await expect(link(page, 'Gast, Mediathek: nicht erlaubt, bearbeiten').locator('.chip')).toHaveClass(/\boff\b/); // –
    await expect(link(page, 'Gast, Live-TV: erlaubt, bearbeiten').locator('.chip')).not.toHaveClass(/\boff\b/); // ✓
    await expect(link(page, 'Gast, Wünsche: nicht erlaubt, bearbeiten')).toBeVisible();
    // the Live-TV details: the channel groups, a link to the role page's groups
    await expect(link(page, 'Crew, Kanalgruppen: Keine, bearbeiten')).toHaveAttribute('href', '/admin/roles/crew?field=livetvGroups');
    await expect(link(page, 'Familie, Kanalgruppen: Sport, Nachrichten +2, bearbeiten')).toBeVisible();
    // the details of the Mediathek: no area switch repeated there
    expect(await rowHeads(page, 'Mediathek')).toEqual(['Bibliotheken', 'Altersfreigabe', 'Höchste Qualität', 'Höchste Qualität unterwegs', 'Umwandeln erlaubt', 'Max. Auflösung']);
    expect(await rowHeads(page, 'Allgemein')).toEqual(['Gleichzeitige Streams', 'Auf Fernseher übertragen']);
  });

  test('compare: Darf aufnehmen is a Live-TV detail row, read-only, off while Live-TV is off', async ({ page, api }) => {
    api.admin.matrix.features.livetv = true;
    Object.assign(api.admin.matrix.roles.find((r) => r.key === 'friend')!.values, { liveTv: true, liveRecord: true });
    Object.assign(api.admin.matrix.roles.find((r) => r.key === 'guest')!.values, { liveTv: false, liveRecord: true });
    await page.goto('/admin/roles?view=compare');
    await expect.poll(() => rowHeads(page, 'Live-TV')).toEqual(['Darf aufnehmen', 'Kanalgruppen']);
    await expect(link(page, 'Freund, Darf aufnehmen: erlaubt, bearbeiten')).toHaveAttribute('href', '/admin/roles/friend?field=liveRecord');
    await expect(link(page, 'Gast, Darf aufnehmen: nicht erlaubt, bearbeiten')).toBeVisible();
    await expect(cell(page, 'Admin, Darf aufnehmen: erlaubt')).toHaveAttribute('aria-disabled', 'true');
  });

  test('compare: no save bar, no drag grip, no popover', async ({ page }) => {
    await page.goto('/admin/roles?view=compare');
    await expect(grid(page)).toBeVisible();
    await expect(grid(page).locator('.grip')).toHaveCount(0);
    await expect(grid(page).getByRole('button')).toHaveCount(0);
    await expect(grid(page).getByRole('switch')).toHaveCount(0);
    await expect(grid(page).getByRole('combobox')).toHaveCount(0);
    await expect(grid(page).getByRole('spinbutton')).toHaveCount(0);
    // Space on a cell opens nothing; the head is a link to the role page (a 44 px target)
    await link(page, 'Gast, Altersfreigabe: ab 12, bearbeiten').focus();
    await page.keyboard.press(' ');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    const head = grid(page).getByRole('columnheader', { name: /Gast/ }).getByRole('link', { name: 'Rolle „Gast“ bearbeiten' });
    await expect(head).toHaveAttribute('href', '/admin/roles/guest');
    const box = (await head.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await expect(grid(page).getByRole('columnheader', { name: /Gast/ })).toContainText('3 Personen · 2 Kinderprofile');
    await expect(grid(page).getByRole('columnheader', { name: /Crew/ })).toContainText('aus .env');
    // the admin's switches: locked, read-only, no link
    const locked = cell(page, 'Admin, Watch-Partys: erlaubt');
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toHaveAttribute('title', 'Admins dürfen immer alles');
    await expect(locked.getByRole('link')).toHaveCount(0);
    await expect(locked.locator('.lk')).toBeVisible();
    await expect(link(page, 'Admin, Gleichzeitige Streams: 4, bearbeiten')).toBeVisible();
  });

  test('grid keyboard still moves between cells', async ({ page }) => {
    await page.goto('/admin/roles?view=compare');
    // one tab stop: the first cell
    await expect(grid(page).locator('[data-cell][tabindex="0"]')).toHaveCount(1);
    await expect(cell(page, 'Admin, Mediathek: erlaubt')).toHaveAttribute('tabindex', '0');
    await link(page, 'Gast, Altersfreigabe: ab 12, bearbeiten').focus();
    await page.keyboard.press('ArrowDown');
    await expect(link(page, 'Gast, Höchste Qualität: 8 Mbit/s, bearbeiten')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(link(page, 'Freund, Höchste Qualität: 20 Mbit/s, bearbeiten')).toBeFocused();
    await page.keyboard.press('End');
    await expect(link(page, 'Crew, Höchste Qualität: 20 Mbit/s, bearbeiten')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(link(page, 'Crew, Höchste Qualität: 20 Mbit/s, bearbeiten')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(link(page, 'Admin, Höchste Qualität: 40 Mbit/s, bearbeiten')).toBeFocused();
    // a locked cell is on the way and says why
    await link(page, 'Familie, Watch-Partys: erlaubt, bearbeiten').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(cell(page, 'Admin, Watch-Partys: erlaubt')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/roles\?view=compare$/);
    await page.keyboard.press('Control+Home');
    await expect(cell(page, 'Admin, Mediathek: erlaubt')).toBeFocused(); // the admin's areas are locked too
    await expect(cell(page, 'Admin, Mediathek: erlaubt')).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('Control+End');
    await expect(link(page, 'Crew, Auf Fernseher übertragen: erlaubt, bearbeiten')).toBeFocused();
  });

  test('more than five roles scroll inside the panel, not the page', async ({ page, api }) => {
    const base = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    const extra = ['Oma', 'Opa', 'Nachbarn'].map((label, i): MatrixMockRole => ({ ...base, key: `extra-${i}`, label, builtinLabel: false, origin: 'admin', values: { ...base.values } }));
    api.admin.matrix.roles.splice(4, 0, ...extra);
    await page.goto('/admin/roles?view=compare');
    await expect(grid(page).getByRole('columnheader', { name: /Nachbarn/ })).toBeAttached();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const scroller = page.locator('.matrix-scroll');
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // the first column stays in place while the panel scrolls
    const rowHead = grid(page).getByRole('rowheader', { name: 'Altersfreigabe' });
    const x0 = (await rowHead.boundingBox())!.x;
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(async () => (await rowHead.boundingBox())!.x).toBe(x0);
  });
});

/** the role menu of the list (ported from the matrix's column menus, which the read-only compare view no longer has) */
test.describe('Rollen & Rechte: the list menu', () => {
  test.use({ allowedConsole: /status of (409|500)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });
  const extraRole = (api: { admin: { matrix: { roles: MatrixMockRole[] } } }, key: string, label: string, accounts = 0, invites = 0): void => {
    const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
    api.admin.matrix.roles.splice(4, 0, { ...family, key, label, builtinLabel: false, origin: 'admin', accounts, profiles: accounts ? 3 : 0, kidsProfiles: 0, invites, values: { ...family.values } });
  };

  test('a name that is too long or empty is not sent', async ({ page }) => {
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(dlg.getByText('Bitte einen Namen mit 1 bis 30 Zeichen eingeben.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Aktionen für Familie' })).toBeFocused();
  });

  test('delete with move', async ({ page, api }) => {
    extraRole(api, 'oma', 'Oma', 2, 1);
    await page.goto('/admin/roles');
    await expect(roleRow(page, 'Oma')).toContainText('2 Personen');
    await (await rowMenu(page, 'Oma')).getByRole('button', { name: 'Löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Rolle „Oma“ löschen?' });
    await expect(dlg).toContainText('2 Personen und 1 offene Einladung bekommen die Rolle:');
    // admin and the role itself are no targets; nothing is picked yet
    const to = dlg.getByRole('combobox', { name: 'Neue Rolle' });
    await expect.poll(() => to.locator('option').allTextContents()).toEqual(['Rolle wählen …', 'Familie', 'Freund', 'Gast', 'Crew']);
    await expect(dlg.getByRole('button', { name: 'Löschen' })).toBeDisabled();
    await to.selectOption({ label: 'Freund' });
    await dlg.getByRole('button', { name: 'Löschen' }).click();
    await expect(dlg).toHaveCount(0);
    await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    await expect(roleRow(page, 'Freund')).toContainText('9 Personen');
    // a plain toast: no undo
    await expect(toasts(page).getByText('Rolle „Oma“ gelöscht.')).toBeVisible();
    await expect(toasts(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
    expect(api.admin.matrix.deletes).toEqual([{ role: 'oma', moveTo: 'friend' }]);
  });

  test('delete of a role nobody holds asks once; built-in and env roles have no Löschen, an env role that left .env has', async ({ page, api }) => {
    extraRole(api, 'leer', 'Leer');
    await page.goto('/admin/roles');
    for (const r of ['Familie', 'Crew']) {
      await (await rowMenu(page, r)).getByRole('link', { name: 'Bearbeiten' }).waitFor();
      await expect(page.getByRole('dialog', { name: r }).getByRole('button', { name: 'Löschen' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    await (await rowMenu(page, 'Leer')).getByRole('button', { name: 'Löschen' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Rolle „Leer“ löschen?' });
    await expect(ask).toContainText('Die Rolle wird entfernt.');
    await ask.getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Leer“ gelöscht.')).toBeVisible();
    await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
    expect(api.admin.matrix.deletes).toEqual([{ role: 'leer', moveTo: null }]);
    // an env role whose key left .env says so and can go
    api.admin.matrix.roles.find((r) => r.key === 'crew')!.envGone = true;
    await page.reload();
    await expect(roleRow(page, 'Crew')).toContainText('nicht mehr in .env');
    await (await rowMenu(page, 'Crew')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog', { name: 'Rolle „Crew“ löschen?' }).getByRole('combobox', { name: 'Neue Rolle' }).selectOption({ label: 'Gast' });
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Crew“ gelöscht.')).toBeVisible();
    expect(api.admin.matrix.deletes).toEqual([{ role: 'leer', moveTo: null }, { role: 'crew', moveTo: 'guest' }]);
  });

  test('copy: only the parts that are not zero; a role with open invites and nobody else', async ({ page, api }) => {
    extraRole(api, 'einl', 'Einl', 0, 2);
    extraRole(api, 'leute', 'Leute', 3, 0);
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Leute')).getByRole('button', { name: 'Löschen' }).click();
    const a = page.getByRole('alertdialog', { name: 'Rolle „Leute“ löschen?' });
    await expect(a).toContainText('3 Personen bekommen die Rolle:');
    await expect(a).not.toContainText('Einladung');
    await a.getByRole('button', { name: 'Abbrechen' }).click();
    await (await rowMenu(page, 'Einl')).getByRole('button', { name: 'Löschen' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Rolle „Einl“ löschen?' });
    await expect(ask).not.toContainText('Niemand');
    await expect(ask).toContainText('offene Einladungen');
    await ask.getByRole('button', { name: 'Löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Rolle „Einl“ löschen?' });
    await expect(dlg).toContainText('2 offene Einladungen bekommen die Rolle:');
    await expect(dlg).not.toContainText('Personen');
  });

  test('a failed order write is reported and the order is read back', async ({ page }) => {
    await page.route('**/api/admin/roles/order', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Gast')).getByRole('button', { name: 'Nach oben' }).click();
    await expect(toasts(page).getByText('Die Reihenfolge konnte nicht gespeichert werden.')).toBeVisible();
    await expect.poll(() => rowNames(page)).toEqual(['Admin', 'Familie', 'Freund', 'Gast', 'Crew']);
  });

  test('two quick moves never flicker back: one order write after the other, the read-back after the last', async ({ page, api }) => {
    await page.route('**/api/admin/roles/order', async (r) => { await new Promise((res) => setTimeout(res, 500)); await r.fallback(); });
    await page.goto('/admin/roles');
    await expect(roleRow(page, 'Familie')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __orders: string[] };
      w.__orders = [];
      const loop = () => {
        const o = [...document.querySelectorAll('li > .main > .head > a.name')].map((n) => n.textContent).join(',');
        if (o && w.__orders.at(-1) !== o) w.__orders.push(o);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Nach unten' }).click();
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Nach unten' }).click();
    await expect.poll(() => api.admin.matrix.orders.length, { timeout: 5000 }).toBe(2);
    await page.waitForTimeout(700);
    expect(api.admin.matrix.orders).toEqual([['admin', 'friend', 'family', 'guest', 'crew'], ['admin', 'friend', 'guest', 'family', 'crew']]);
    expect(await page.evaluate(() => (window as unknown as { __orders: string[] }).__orders)).toEqual([
      'Admin,Familie,Freund,Gast,Crew', 'Admin,Freund,Familie,Gast,Crew', 'Admin,Freund,Gast,Familie,Crew',
    ]);
  });

  test('history sheet lists the role\'s entries', async ({ page }) => {
    await page.goto('/admin/roles');
    // Familie: the old role.playback entry reads as a sentence, no raw key
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Verlauf' }).click();
    const fam = page.getByRole('dialog', { name: 'Verlauf · Familie' });
    await expect(fam.getByText('Tester hat „Wiedergabe“ der Rolle Familie geändert')).toBeVisible();
    await expect(fam).not.toContainText('role.playback');
    await expect(fam.getByText(/Gast/)).toHaveCount(0); // only this role's entries
    await page.keyboard.press('Escape');
    await expect(fam).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Aktionen für Familie' })).toBeFocused();
    // a role without entries
    await (await rowMenu(page, 'Freund')).getByRole('button', { name: 'Verlauf' }).click();
    await expect(page.getByRole('dialog', { name: 'Verlauf · Freund' })).toContainText('Noch keine Einträge zu dieser Rolle.');
  });

  test('the history names roles, never a key: a copy of a copy, then the source deleted', async ({ page }) => {
    await page.goto('/admin/roles');
    const dupAs = async (from: string, name: string) => {
      await (await rowMenu(page, from)).getByRole('button', { name: 'Duplizieren' }).click();
      const dlg = page.getByRole('dialog', { name: `Rolle „${from}“ duplizieren` });
      await dlg.getByRole('textbox', { name: 'Name' }).fill(name);
      await dlg.getByRole('button', { name: 'Anlegen' }).click();
      await expect(toasts(page).getByText(`Rolle „${name}“ angelegt.`)).toBeVisible();
    };
    await dupAs('Familie', 'Oma & Opa');
    await dupAs('Oma & Opa', 'Nachbarn');
    await (await rowMenu(page, 'Nachbarn')).getByRole('button', { name: 'Verlauf' }).click();
    const sheet = page.getByRole('dialog', { name: 'Verlauf · Nachbarn' });
    await expect(sheet).toContainText('Tester hat die Rolle Nachbarn als Kopie von Oma & Opa angelegt');
    await expect(sheet).not.toContainText(/oma-opa/);
    await page.keyboard.press('Escape');
    // the source is deleted (nobody holds it): the history says so without the key
    await (await rowMenu(page, 'Oma & Opa')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ gelöscht.')).toBeVisible();
    await (await rowMenu(page, 'Nachbarn')).getByRole('button', { name: 'Verlauf' }).click();
    const again = page.getByRole('dialog', { name: 'Verlauf · Nachbarn' });
    await expect(again).toContainText('Kopie von „gelöschte Rolle“');
    await expect(again).not.toContainText(/oma-opa/);
  });

  test('a failed reload after a write keeps the success and says so (duplicate, delete)', async ({ page, api }) => {
    extraRole(api, 'leer', 'Leer');
    await page.goto('/admin/roles');
    await expect(roleRow(page, 'Leer')).toBeVisible();
    let failedReads = 0;
    await page.route('**/api/admin/roles', async (r) => { if (r.request().method() === 'GET') { failedReads++; await r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }); } else await r.fallback(); });
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Zwei');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(toasts(page).getByText('Rolle „Zwei“ angelegt.')).toBeVisible();
    await expect(toasts(page).getByText('Das ließ sich nicht laden. Prüfe die Verbindung und versuche es erneut.')).toBeVisible();
    await expect(dlg).toHaveCount(0);
    expect(api.admin.matrix.roles.some((r) => r.label === 'Zwei')).toBe(true);
    // delete: the success is a success, the failed read an extra note
    await (await rowMenu(page, 'Leer')).getByRole('button', { name: 'Löschen' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(toasts(page).getByText('Rolle „Leer“ gelöscht.')).toBeVisible();
    await expect.poll(() => failedReads).toBe(2);
    await expect(toasts(page).getByText('Das ließ sich nicht laden. Prüfe die Verbindung und versuche es erneut.').last()).toBeVisible();
    expect(api.admin.matrix.deletes).toEqual([{ role: 'leer', moveTo: null }]);
  });

  test('a role\'s history links to the audit page filtered by target; a deleted role is still named', async ({ page, api }) => {
    api.admin.audit.unshift(roleDeleteSample('kino', 'Kino'));
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Verlauf' }).click();
    await page.getByRole('dialog', { name: 'Verlauf · Familie' }).getByRole('link', { name: 'Im Audit-Log öffnen' }).click();
    await expect(page).toHaveURL(/\/admin\/audit\?target=family/);
    await expect(page.getByRole('group', { name: 'Betrifft: Familie' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Audit-Log' });
    await expect(table.getByText('Tester hat „Wiedergabe“ der Rolle Familie geändert')).toBeVisible();
    await expect(table.getByText('Kino')).toHaveCount(0);
    // the deleted role's own entry: the history sheet cannot be opened any more, the log names it through its label
    await page.goto('/admin/audit?target=kino');
    await expect(page.getByRole('group', { name: 'Betrifft: Kino' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Audit-Log' }).getByText('Ben Muster hat die Rolle Kino gelöscht')).toBeVisible();
  });

  test('a re-created role shows only the history since its latest creation', async ({ page, api }) => {
    extraRole(api, 'oma', 'Oma');
    const row = (id: number, action: string, meta: Record<string, unknown>) => ({ id, at: new Date(Date.now() - (1000 - id) * 60000).toISOString(), action, target: 'oma', meta, actor: 'Tester', target_name: null });
    api.admin.audit.unshift(
      row(904, 'role.update', { from: { maxStreams: 4 }, to: { maxStreams: 2 } }), row(903, 'role.create', { from: 'family', label: 'Oma' }),
      row(902, 'role.delete', { moveTo: null, accounts: 0, invites: 0, label: 'Oma' }), row(901, 'role.update', { from: { maxStreams: 6 }, to: { maxStreams: 7 } }),
    );
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Oma')).getByRole('button', { name: 'Verlauf' }).click();
    const sheet = page.getByRole('dialog', { name: 'Verlauf · Oma' });
    await expect(sheet).toContainText('Tester hat die Rolle Oma als Kopie von Familie angelegt');
    await expect(sheet).toContainText('Gleichzeitige Streams: 4 → 2');
    await expect(sheet).not.toContainText('gelöscht');
    await expect(sheet).not.toContainText('6 → 7');
  });

  test('without a bar the toast stands still (role list below 900 px)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Familie')).getByRole('button', { name: 'Duplizieren' }).click();
    const dlg = page.getByRole('dialog', { name: 'Rolle „Familie“ duplizieren' });
    await dlg.getByRole('textbox', { name: 'Name' }).fill('Oma & Opa');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    await expect(toasts(page).getByText('Rolle „Oma & Opa“ angelegt.')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    const a = await toasts(page).boundingBox();
    await page.waitForTimeout(350);
    expect(await toasts(page).boundingBox()).toEqual(a);
  });
});
