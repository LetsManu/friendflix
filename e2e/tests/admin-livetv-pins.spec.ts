// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { ltvGuideMock } from '../mocks/admin.js';
import type { MockState } from '../mocks/api.js';
import { expect, test } from '../fixtures.js';

// Admin → Live-TV → Kanäle → *Programm zuordnen…* (extra-guides plan Task 8): the sheet with the guide picker, the search and its hits,
// *Automatisch* and *Kein Programm*; the EPG column names a pinned guide and says when that guide is switched off.
const area = (api: MockState) => api.admin.livetv.area;
const writes = (api: MockState) => area(api).calls.filter((c) => c.m === 'PUT' && /\/epg$/.test(c.p));
const table = (page: Page) => page.getByRole('table', { name: 'Kanäle' });
const rowOf = (page: Page, name: string): Locator => table(page).getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
async function openPin(page: Page, channel: string) {
  await page.goto('/admin/livetv?tab=channels');
  await expect(rowOf(page, channel)).toBeVisible();
  await page.getByRole('button', { name: `Aktionen für ${channel}` }).click();
  await page.getByRole('dialog', { name: channel }).getByRole('button', { name: 'Programm zuordnen…' }).click();
  return page.getByRole('dialog', { name: `Programm zuordnen: ${channel}` });
}

test.describe('admin: Live-TV, Programm zuordnen (desktop)', () => {
  test.beforeEach(({ api }) => {
    api.asAdmin = true;
    Object.assign(api.admin.livetv, { installed: true, wanted: true, ltState: 'enabled' });
    area(api).sources.push(
      ltvGuideMock({ id: 'g-int', name: 'Sternwarte Guide', position: 2 }),
      ltvGuideMock({ id: 'g-off', name: 'Aus Guide', position: 3, enabled: false }),
    );
    area(api).epgIndex['g-int'] = [
      { xmlId: 'hk.int', names: ['Hafenkanal International'] }, { xmlId: 'sw.int', names: ['Sternwarte International', 'SW Int'] },
      ...Array.from({ length: 55 }, (_, i) => ({ xmlId: `k${i + 1}.int`, names: [`Kanal ${String(i + 1).padStart(2, '0')}`] })),
    ];
    area(api).epgIndex['g-off'] = [{ xmlId: 'aus.1', names: ['Aus Eins'] }];
  });

  test('pin a channel to a guide entry, then back to automatic', async ({ page, api }) => {
    const dlg = await openPin(page, 'Sternwarte 24');
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Automatisch');
    await expect(dlg.getByRole('button', { name: 'Automatisch' })).toBeDisabled();
    // the picker: the list with a guide and the enabled guides; a disabled guide is no choice; it opens on the channel's own list
    const picker = dlg.getByLabel('Programmführer', { exact: true });
    await expect(picker).toHaveValue('src-nordlicht');
    expect(await picker.locator('option').allTextContents()).toEqual(['Nordlicht Paket', 'Sternwarte Guide']);
    await expect(dlg.locator('[data-pin-hits] li')).toHaveCount(4);
    await picker.selectOption('g-int');
    // at most 50 hits, then the hint to search more precisely
    await expect(dlg.locator('[data-pin-hits] li')).toHaveCount(50);
    await expect(dlg.locator('[data-pin-more]')).toBeVisible();
    await dlg.getByRole('searchbox', { name: 'Sender im Programmführer suchen' }).fill('stern');
    await expect(dlg.locator('[data-pin-hits] li')).toHaveCount(1);
    await expect(dlg.locator('[data-pin-more]')).toHaveCount(0);
    const hit = dlg.getByRole('button', { name: '„Sternwarte International“ zuordnen' });
    await expect(hit).toContainText('sw.int · SW Int');
    await hit.click();
    await expect(toasts(page)).toContainText('Programm zugeordnet.');
    expect(writes(api).at(-1)).toMatchObject({ p: '/api/admin/livetv/channels/ch-5/epg', body: { sourceId: 'g-int', xmlId: 'sw.int' } });
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Sternwarte International aus „Sternwarte Guide“');
    await expect(hit).toHaveAttribute('aria-pressed', 'true');
    await expect(hit).toContainText('zugeordnet');
    await expect(dlg.getByRole('button', { name: 'Automatisch' })).toBeEnabled();
    // the row: a programme, by hand from the guide
    const row = rowOf(page, 'Sternwarte 24');
    await expect(row.locator('[data-pin]')).toHaveText('Von Hand: Sternwarte Guide');
    await expect(row).toContainText('Programm');

    // back to automatic: null, matched at once
    await dlg.getByRole('button', { name: 'Automatisch' }).click();
    await expect(toasts(page)).toContainText('Das Programm wird wieder automatisch zugeordnet.');
    expect(writes(api).at(-1)).toMatchObject({ body: null });
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Automatisch');
    await expect(row.locator('[data-pin]')).toHaveCount(0);
    await expect(row).toContainText('Kein Programm'); // the mock's channel 5 has no automatic match
    // closing returns the focus to the row menu
    await dlg.getByRole('button', { name: 'Schließen' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Aktionen für Sternwarte 24' })).toBeFocused();
  });

  test('Kein Programm', async ({ page, api }) => {
    const dlg = await openPin(page, 'Nordlicht TV');
    await dlg.getByRole('button', { name: 'Kein Programm' }).click();
    await expect(toasts(page)).toContainText('Dieser Sender zeigt kein Programm mehr.');
    expect(writes(api).at(-1)).toMatchObject({ p: '/api/admin/livetv/channels/ch-1/epg', body: { none: true } });
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Kein Programm');
    await expect(dlg.getByRole('button', { name: 'Kein Programm' })).toBeDisabled();
    await expect(rowOf(page, 'Nordlicht TV')).toContainText('Kein Programm');
    // the search finds by any name, the list's own guide
    await dlg.getByRole('searchbox').fill('xyz');
    await expect(dlg.locator('[data-pin-empty]')).toHaveText('Kein Sender gefunden.');
    await dlg.getByRole('searchbox').fill('wetter');
    await dlg.getByRole('button', { name: '„Wetterkanal Küste“ zuordnen' }).click();
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Wetterkanal Küste aus „Nordlicht Paket“');
    await expect(rowOf(page, 'Nordlicht TV').locator('[data-pin]')).toHaveText('Von Hand: Nordlicht Paket');
  });

  test('a pin to a switched-off guide says so in the row and in the sheet', async ({ page, api }) => {
    area(api).channels.find((c) => c.id === 'ch-2')!.pin = { sourceId: 'g-off', xmlId: 'aus.1' };
    await page.goto('/admin/livetv?tab=channels');
    const row = rowOf(page, 'Wetterkanal Küste');
    await expect(row).toContainText('Programmführer ausgeschaltet');
    await expect(row.locator('[data-pin]')).toHaveText('Von Hand: Aus Guide');
    await page.getByRole('button', { name: 'Aktionen für Wetterkanal Küste' }).click();
    await page.getByRole('dialog', { name: 'Wetterkanal Küste' }).getByRole('button', { name: 'Programm zuordnen…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Programm zuordnen: Wetterkanal Küste' });
    await expect(dlg.locator('[data-pin-state]')).toHaveText('Aus Eins aus „Aus Guide“');
    await expect(dlg.locator('[data-guide-off]')).toHaveText('Programmführer ausgeschaltet');
    // the picker does not offer the disabled guide: it opens on the channel's own list
    await expect(dlg.getByLabel('Programmführer', { exact: true })).toHaveValue('src-nordlicht');
  });

  test('without any guide the sheet says where to add one', async ({ page, api }) => {
    area(api).sources = area(api).sources.filter((s) => s.kind === 'feeds');
    const dlg = await openPin(page, 'Nordlicht TV');
    await expect(dlg.locator('[data-no-guides]')).toBeVisible();
    await expect(dlg.getByRole('searchbox')).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Kein Programm' })).toBeEnabled();
  });
});
