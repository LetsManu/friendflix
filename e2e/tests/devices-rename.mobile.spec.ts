// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import type { MockState } from '../fixtures.js';

/** Geräte (/devices) at 390 px: the form overlays its row, nothing moves, the error is in view (spec 2.8) */
const TV = 'dev-lgtv-000000000003';
const patches = (api: MockState) => api.log.filter((l) => l.startsWith('PATCH /api/devices/'));

async function open(page: Page, api: MockState, name: string | null = null) {
  api.devices = [
    api.devices[0]!,
    { id: TV, label: 'Fernseher (TV-Modus)', name, kind: 'webos', approved: true, current: false, created_at: '2026-09-03T10:00:00Z', last_seen: '2026-10-13T18:00:00Z' },
    api.devices[1]!,
    { id: 'dev-fire-0000000000004', label: 'Fire TV Stick', name: null, kind: 'firetv', approved: true, current: false, created_at: '2026-09-04T10:00:00Z', last_seen: '2026-10-11T18:00:00Z' },
    { id: 'dev-pc-000000000000005', label: 'Firefox auf Windows', name: null, kind: 'web', approved: true, current: false, created_at: '2026-09-05T10:00:00Z', last_seen: '2026-10-10T18:00:00Z' },
  ];
  await page.goto('/devices');
  await page.waitForLoadState('networkidle'); // hydrated
  await expect(page.getByRole('row', { name: name ?? /LG-Fernseher/ })).toBeVisible();
}
/** page y of the table and every row (the page may scroll when the field takes focus) */
const ys = async (page: Page) => {
  const sy = await page.evaluate(() => window.scrollY);
  const rows = page.locator('.drow');
  const n = await rows.count();
  const out: number[] = [(await page.getByRole('table').boundingBox())!.y + sy];
  for (let i = 0; i < n; i++) out.push((await rows.nth(i).boundingBox())!.y + sy);
  return out;
};

/** the bubble ignores pointer events (taps reach the buttons under it), so the probe lets it take them */
const topmostIsBubble = async (page: Page, bubble: Locator) => {
  await page.addStyleTag({ content: '.bubble { pointer-events: auto !important; }' });
  return bubble.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.bubble');
  });
};

test.describe('devices page: renaming (phone)', () => {
  test('rename a device to Wohnzimmer', async ({ page, api }) => {
    await open(page, api);
    const before = await ys(page);
    await page.getByRole('button', { name: 'LG-Fernseher umbenennen' }).click();
    const field = page.getByLabel('Gerätename');
    await expect(field).toBeFocused();
    await expect(field).not.toHaveAttribute('maxlength');
    await expect(field).toHaveAttribute('placeholder', 'LG-Fernseher');
    expect(await ys(page)).toEqual(before); // opening the form moves nothing
    const save = (await page.getByRole('button', { name: 'Speichern' }).boundingBox())!;
    expect(save.height).toBeGreaterThanOrEqual(44);
    await field.fill('Wohnzimmer');
    await field.press('Enter');
    await expect.poll(() => patches(api)).toEqual([`PATCH /api/devices/${TV} {"name":"Wohnzimmer"} -> 200`]);
    await expect(page.getByRole('status').filter({ hasText: 'Das Gerät heißt jetzt „Wohnzimmer“.' })).toBeVisible();
    const row = page.getByRole('row', { name: /Wohnzimmer/ });
    await expect(row).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wohnzimmer umbenennen' })).toBeFocused();
    expect(await ys(page)).toEqual(before); // the saved name and the status line move nothing
  });

  test('Escape cancels', async ({ page, api }) => {
    await open(page, api);
    await page.getByRole('button', { name: 'LG-Fernseher umbenennen' }).click();
    await page.getByLabel('Gerätename').fill('Schlafzimmer');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Gerätename')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'LG-Fernseher umbenennen' })).toBeFocused();
    expect(patches(api)).toEqual([]);
  });

  test('an invalid name shows the error', async ({ page, api }) => {
    await open(page, api);
    const before = await ys(page);
    await page.getByRole('button', { name: 'LG-Fernseher umbenennen' }).click();
    const field = page.getByLabel('Gerätename');
    await field.fill('\u202eevil');
    await field.press('Enter');
    const bubble = page.getByRole('alert').filter({ hasText: 'Bitte 1 bis 40 Zeichen ohne Steuerzeichen.' });
    await expect(bubble).toBeInViewport({ ratio: 1 }); // next to the field, not off-screen
    await expect(field).toHaveAttribute('aria-describedby', (await bubble.getAttribute('id'))!);
    const f = (await field.boundingBox())!, b = (await bubble.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(f.y + f.height - 1); // directly under the field
    expect(b.y - (f.y + f.height)).toBeLessThan(120); // one line of buttons may sit between the field and the message
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toBeFocused();
    expect(patches(api)).toEqual([]);
    expect(await ys(page)).toEqual(before);
  });

  test('use the detected name', async ({ page, api }) => {
    await open(page, api, 'Wohnzimmer');
    await page.getByRole('button', { name: 'Wohnzimmer umbenennen' }).click();
    await expect(page.getByLabel('Gerätename')).toHaveValue('Wohnzimmer');
    await page.getByRole('button', { name: 'Automatischen Namen verwenden' }).click();
    await expect.poll(() => patches(api)).toEqual([`PATCH /api/devices/${TV} {"name":null} -> 200`]);
    await expect(page.getByRole('row', { name: /LG-Fernseher/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'LG-Fernseher umbenennen' })).toBeFocused();
  });

  test('the error of the last row is not covered by the tab bar', async ({ page, api }) => {
    await open(page, api);
    await page.getByRole('button', { name: 'Firefox auf Windows umbenennen' }).click();
    const field = page.getByLabel('Gerätename');
    await field.fill('\u202eevil');
    await field.press('Enter');
    const bubble = page.getByRole('alert').filter({ hasText: 'Bitte 1 bis 40 Zeichen ohne Steuerzeichen.' });
    await expect(bubble).toBeInViewport({ ratio: 1 });
    // the topmost element at the bubble's centre is the bubble itself (not the fixed tab bar)
    await expect.poll(() => topmostIsBubble(page, bubble)).toBe(true);
  });

  test('scrolled so the form sits just above the tab bar, the error scrolls into view', async ({ page, api }) => {
    await open(page, api);
    await page.getByRole('button', { name: 'Firefox auf Windows umbenennen' }).click();
    const field = page.getByLabel('Gerätename');
    await field.fill('\u202eevil');
    // put the form's bottom edge right at the top of the tab bar
    await page.evaluate(() => {
      const f = document.querySelector('.edit')!.getBoundingClientRect();
      const bar = document.querySelector('nav.tabbar')!.getBoundingClientRect();
      window.scrollBy(0, f.bottom - bar.top);
    });
    await field.press('Enter');
    const bubble = page.getByRole('alert').filter({ hasText: 'Bitte 1 bis 40 Zeichen ohne Steuerzeichen.' });
    await expect(bubble).toBeInViewport({ ratio: 1 });
    await expect.poll(() => topmostIsBubble(page, bubble)).toBe(true);
  });
});
