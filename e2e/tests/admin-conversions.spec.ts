// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

const card = (page: Page) => page.getByRole('region', { name: 'Umwandlungen' });
const putsOf = (api: { settings: { puts: Array<{ values: Record<string, unknown> }> } }) => api.settings.puts.map((p) => p.values);

test.describe('admin: Umwandlungen card on the Wiedergabe-Check page', () => {
  // the refusals are mocked failures: the browser logs the 4xx answers
  test.use({ allowedConsole: /Failed to load resource: the server responded with a status of (400|409|429)/ });
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('card shows usage and the running list', async ({ page }) => {
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByText('2 von 3 belegt')).toBeVisible();
    const list = c.getByRole('list', { name: 'Läuft gerade' });
    const rows = list.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    // the list is named by its heading (one name, not the same words twice)
    await expect(list).not.toHaveAttribute('aria-label', /./);
    await expect(list).toHaveAttribute('aria-labelledby', (await c.getByRole('heading', { name: 'Läuft gerade' }).getAttribute('id'))!);
    await expect(rows.nth(0)).toContainText('Dunmoor');
    await expect(rows.nth(0)).toContainText('Film/Serie');
    await expect(rows.nth(0)).toContainText('Wohnzimmer-TV');
    await expect(rows.nth(1)).toContainText('Dunmoor');
    await expect(rows.nth(1)).toContainText('Andere');
    // no start time yet: a dash, never NaN
    await expect(c).not.toContainText('NaN');
    // the bar: one segment per slot, each with a text label (never colour alone)
    const bar = c.getByRole('img', { name: /Belegung/ });
    await expect(bar).toBeVisible();
    await expect(bar.locator('.seg-cell')).toHaveCount(3);
    await expect(bar.locator('.seg-cell').nth(2)).toContainText('frei');
    await expect(c.getByText('Gemessen 4,6× Echtzeit (Jellyfin, Intel QSV) · Live-TV 4,4× · empfohlen 3 · geprüft ')).toBeVisible();
    // the card is the first one on the page
    await expect(page.locator('main section.card').first()).toHaveAccessibleName('Umwandlungen');
  });

  test('an own value saves CONVERSION_SLOTS', async ({ page, api }) => {
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByRole('radio', { name: 'Automatisch (3)' })).toBeChecked();
    await expect(c.getByRole('spinbutton')).toHaveCount(0);
    await c.getByRole('radio', { name: 'Eigener Wert' }).click();
    await expect(c.getByRole('radio', { name: 'Eigener Wert' })).toBeChecked();
    await c.getByRole('button', { name: 'Mehr' }).click();
    await expect.poll(() => putsOf(api).at(-1)).toEqual({ CONVERSION_SLOTS: 4 });
    await expect(c.getByRole('spinbutton')).toHaveText('4');
    await expect(c.getByText('2 von 4 belegt')).toBeVisible();
    // the limits are 1 and 16
    await c.getByRole('spinbutton').focus();
    await page.keyboard.press('Home');
    await expect.poll(() => putsOf(api).at(-1)).toEqual({ CONVERSION_SLOTS: 1 });
    await expect(c.getByRole('button', { name: 'Weniger' })).toBeDisabled();
    await page.keyboard.press('End');
    await expect.poll(() => putsOf(api).at(-1)).toEqual({ CONVERSION_SLOTS: 16 });
    await expect(c.getByRole('button', { name: 'Mehr' })).toBeDisabled();
  });

  test('Automatisch sends null', async ({ page, api }) => {
    api.settings.groups.flatMap((g) => g.items).find((i) => i.key === 'CONVERSION_SLOTS')!.value = 5;
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByRole('radio', { name: 'Eigener Wert' })).toBeChecked();
    await expect(c.getByRole('spinbutton')).toHaveText('5');
    await c.getByRole('radio', { name: 'Automatisch (3)' }).click();
    await expect.poll(() => putsOf(api).at(-1)).toEqual({ CONVERSION_SLOTS: null });
    await expect(c.getByRole('radio', { name: 'Automatisch (3)' })).toBeChecked();
    await expect(c.getByRole('spinbutton')).toHaveCount(0);
    await expect(c.getByText('2 von 3 belegt')).toBeVisible();
  });

  test('priority saves and the hint follows the option', async ({ page, api }) => {
    await page.goto('/admin/playback');
    const c = card(page);
    const films = 'Live-TV lässt einen Platz für Filme & Serien frei (ab 2 Plätzen).';
    const live = 'Filme & Serien lassen einen Platz für Live-TV frei (ab 2 Plätzen).';
    const equal = 'Kein Platz wird freigehalten – wer zuerst kommt, bekommt ihn.';
    await expect(c.getByRole('radio', { name: 'Filme & Serien zuerst' })).toBeChecked();
    await expect(c.getByText(films)).toBeVisible();
    await expect(c.getByText(live)).toBeHidden();
    const h0 = (await c.locator('.hints').boundingBox())!.height;
    await c.getByRole('radio', { name: 'Live-TV zuerst' }).click();
    await expect.poll(() => putsOf(api).at(-1)).toEqual({ CONVERSION_PRIORITY: 'live' });
    await expect(c.getByText(live)).toBeVisible();
    await expect(c.getByText(films)).toBeHidden();
    await c.getByRole('radio', { name: 'Gleichrangig' }).click();
    await expect.poll(() => putsOf(api).at(-1)).toEqual({ CONVERSION_PRIORITY: 'equal' });
    await expect(c.getByText(equal)).toBeVisible();
    // the line's height is reserved: switching moves nothing
    expect((await c.locator('.hints').boundingBox())!.height).toBe(h0);
  });

  test('a save the server refuses is rolled back with a message', async ({ page, api }) => {
    api.settings.saveErrors = { CONVERSION_PRIORITY: 'locked' };
    await page.goto('/admin/playback');
    const c = card(page);
    await c.getByRole('radio', { name: 'Gleichrangig' }).click();
    await expect(page.getByText('In der Umgebung festgelegt – hier nicht änderbar.')).toBeVisible();
    await expect(c.getByRole('radio', { name: 'Filme & Serien zuerst' })).toBeChecked();
  });

  test('Neu messen is disabled with the reason while someone watches', async ({ page, api }) => {
    api.admin.conv.measure = { running: false, busy: 'watching', last: null };
    await page.goto('/admin/playback');
    const c = card(page);
    const btn = c.getByRole('button', { name: 'Neu messen' });
    await expect(btn).toBeDisabled();
    await expect(c.getByText('Messen geht nur, wenn gerade niemand schaut.')).toBeVisible();
    await expect(btn).toHaveAccessibleDescription('Messen geht nur, wenn gerade niemand schaut.');
    expect(api.admin.conv.posts).toBe(0);
  });

  test('Neu messen starts a measurement and shows that it runs', async ({ page, api }) => {
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByRole('button', { name: 'Neu messen' })).toBeEnabled();
    await c.getByRole('button', { name: 'Neu messen' }).click();
    await expect.poll(() => api.admin.conv.posts).toBe(1);
    await expect(c.getByText('Misst … (ca. 20 s)')).toBeVisible();
    await expect(c.getByRole('button', { name: /Neu messen|Misst/ })).toHaveAttribute('aria-busy', 'true');
    // it ends: the last outcome is told
    api.admin.conv.measure = { running: false, busy: null, last: { outcome: 'ok', at: new Date().toISOString() } };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(c.getByText(/Letzte Messung erfolgreich/)).toBeVisible();
    await expect(c.getByText('Misst … (ca. 20 s)')).toBeHidden();
  });

  test('each refusal of the benchmark gets its own message', async ({ page, api }) => {
    await page.goto('/admin/playback');
    const c = card(page);
    const btn = c.getByRole('button', { name: 'Neu messen' });
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [409, { error: 'running' }, 'Es läuft schon eine Messung.'],
      [409, { error: 'busy', reason: 'unknown' }, 'Der Medienserver antwortet gerade nicht, deshalb lässt sich noch nicht sagen, ob jemand schaut.'],
      [409, { error: 'no_user' }, 'Für die Messung fehlt ein Admin-Konto, mit dem der Medienserver umwandeln kann.'],
      [409, { error: 'unsupported' }, 'Messung nur mit Jellyfin'],
      [429, { error: 'rate_limited' }, 'Zu viele Messungen in kurzer Zeit. Bitte in ein paar Minuten noch einmal versuchen.'],
    ];
    for (const [status, body, text] of cases) {
      api.admin.conv.benchAnswer = { status, body };
      await btn.click();
      await expect(page.getByText(text).first()).toBeVisible();
      await expect(btn).toBeEnabled();
    }
    expect(api.admin.conv.posts).toBe(cases.length);
  });

  test('on Plex there is nothing to measure: a plain note, no button', async ({ page, api }) => {
    api.admin.conv.measure = { running: false, busy: null, last: { outcome: 'unsupported', at: null } };
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByText('Messung nur mit Jellyfin')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Neu messen' })).toHaveCount(0);
    await expect(c.getByText(/Noch nicht gemessen/)).toHaveCount(0);
  });

  test('Neu messen keeps its place from the first paint: no button flashes up on Plex, the header does not move', async ({ page, api }) => {
    for (const plex of [true, false]) {
      api.admin.conv.measure = plex ? { running: false, busy: null, last: { outcome: 'unsupported', at: null } } : { running: false, busy: null, last: null };
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      await page.route('**/api/admin/conversions', async (r) => { await gate; await r.fallback(); });
      await page.goto('/admin/playback');
      const c = card(page);
      const slot = c.getByTestId('conv-measure');
      await expect(slot).toBeAttached();
      await expect(c.getByRole('button', { name: 'Neu messen' })).toHaveCount(0); // reserved, not shown and not focusable
      await expect(slot.locator('button')).not.toHaveAttribute('aria-describedby', /./); // its note does not exist yet
      const head = c.locator('.head');
      const before = (await head.boundingBox())!;
      release();
      await expect(c.getByTestId('conv-used')).toBeVisible();
      if (plex) {
        await expect(c.getByText('Messung nur mit Jellyfin')).toBeVisible();
        await expect(c.getByRole('button', { name: 'Neu messen' })).toHaveCount(0);
      } else {
        await expect(c.getByRole('button', { name: 'Neu messen' })).toBeEnabled();
        await expect(slot.locator('button')).toHaveAttribute('aria-describedby', (await c.locator('.note').getAttribute('id'))!);
      }
      const after = (await head.boundingBox())!;
      expect([after.y, after.height]).toEqual([before.y, before.height]);
      await page.unroute('**/api/admin/conversions');
    }
  });

  test('a measurement that failed is told in the reserved line', async ({ page, api }) => {
    api.admin.conv.measure = { running: false, busy: null, last: { outcome: 'no_title', at: new Date().toISOString() } };
    await page.goto('/admin/playback');
    await expect(card(page).getByText(/Letzte Messung nicht möglich: kein geeigneter Titel/)).toBeVisible();
  });

  test('never measured is said in words', async ({ page, api }) => {
    api.admin.conv.bench = { jellyfin: null, livetv: null, recommended: null, stale: false, noRealtime: false };
    await page.goto('/admin/playback');
    await expect(card(page).getByText('Noch nicht gemessen · bis dahin 3')).toBeVisible();
  });

  test('too slow and out of date', async ({ page, api }) => {
    api.admin.conv.bench = { ...api.admin.conv.bench, stale: true, noRealtime: true };
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByText('Der Server schafft keine Umwandlung in Echtzeit.')).toBeVisible();
    await expect(c.getByText('Messung veraltet – bitte neu messen')).toBeVisible();
  });

  test('over the limit is marked in words', async ({ page, api }) => {
    api.admin.conv.auto = 1;
    await page.goto('/admin/playback');
    const bar = card(page).getByRole('img', { name: /Belegung/ });
    await expect(bar.locator('.seg-cell')).toHaveCount(2);
    await expect(bar.locator('.seg-cell').nth(1)).toContainText('über dem Limit');
  });

  test('polls while visible: a new session shows up without a reload', async ({ page, api }) => {
    await page.clock.install();
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByText('2 von 3 belegt')).toBeVisible();
    api.admin.conv.running = [...api.admin.conv.running, { kind: 'live', hevc: false, label: 'Saltwater Almanac', since: null, device: null }];
    await page.clock.fastForward(5500);
    await expect(c.getByText('3 von 3 belegt')).toBeVisible();
    await expect(c.getByRole('list', { name: 'Läuft gerade' })).toContainText('Saltwater Almanac');
  });

  test('a session that appears does not move any control (the list is last)', async ({ page, api }) => {
    await page.clock.install();
    await page.goto('/admin/playback');
    const c = card(page);
    await expect(c.getByText('2 von 3 belegt')).toBeVisible();
    const targets = [c.getByRole('button', { name: 'Neu messen' }), c.getByRole('radio', { name: 'Eigener Wert' }), c.getByRole('radio', { name: 'Live-TV zuerst' }), c.getByRole('radio', { name: 'Gleichrangig' })];
    const ys = async () => Promise.all(targets.map(async (t) => (await t.boundingBox())!.y));
    const before = await ys();
    api.admin.conv.running = [...api.admin.conv.running, { kind: 'live', hevc: false, label: 'Saltwater Almanac', since: null, device: null }];
    await page.clock.fastForward(5500);
    await expect(c.getByText('3 von 3 belegt')).toBeVisible();
    await expect(c.getByRole('list', { name: 'Läuft gerade' }).getByRole('listitem')).toHaveCount(3);
    await expect.poll(ys).toEqual(before);
  });

  test('Admin → Einstellungen shows proper labels for the two keys', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByText('CONVERSION_SLOTS', { exact: true })).toHaveCount(1); // only as the env name under the label
    await expect(page.locator('span.lbl').filter({ hasText: /^Umwandlungen gleichzeitig$/ })).toBeVisible();
    await expect(page.locator('span.lbl').filter({ hasText: /^Vorrang bei Umwandlungen$/ })).toBeVisible();
  });
});
