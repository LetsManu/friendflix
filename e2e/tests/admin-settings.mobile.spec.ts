// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { mailConfigured } from '../mocks/settings.js';

// Admin → Einstellungen on the phone (390px).
test.describe('admin: settings (phone)', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('no horizontal overflow on any tab; every control is reachable and at least 44px tall', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Öffentliche Adresse' })).toBeVisible();
    const vw = await page.evaluate(() => window.innerWidth);
    let total = 0;
    for (const name of ['Allgemein', 'Anmeldung', 'Medien', 'Wiedergabe', 'Updates', 'Benachrichtigungen']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel').getByRole('button', { name: 'Speichern' }).first()).toBeVisible();
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
      const controls = page.getByRole('tabpanel').getByRole('button');
      const n = await controls.count();
      total += n;
      for (let i = 0; i < n; i++) {
        const c = controls.nth(i);
        await c.scrollIntoViewIfNeeded();
        const box = (await c.boundingBox())!;
        expect(box.height, await c.innerText()).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
      }
      const inputs = page.locator('main input:not([type=checkbox])');
      for (let i = 0; i < await inputs.count(); i++) {
        const box = (await inputs.nth(i).boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
      }
    }
    expect(total).toBeGreaterThanOrEqual(20);
  });

  test('tab chips scroll, no horizontal page scroll at 375 px, chips ≥ 44 px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/admin/settings');
    const list = page.getByRole('tablist', { name: 'Bereiche der Einstellungen' });
    await expect(list.getByRole('tab')).toHaveCount(6);
    // the row is wider than the phone: it scrolls on its own, the page does not
    expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    for (const t of await list.getByRole('tab').all()) expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // the last chip is reached by scrolling the row (keyboard: End), and it opens its tab
    await list.getByRole('tab', { name: 'Allgemein' }).focus();
    await page.keyboard.press('End');
    const last = list.getByRole('tab', { name: 'Benachrichtigungen' });
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    await expect(page.getByRole('heading', { level: 2, name: 'Push-Mitteilungen' })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Replace, Clear and Move buttons carry the setting in their accessible name', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.getByRole('button', { name: 'Öffentliche Adresse: in die Einstellungen übernehmen' })).toBeVisible();
    await page.getByRole('tab', { name: 'Medien' }).tap();
    await expect(page.getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'TMDB-API-Schlüssel entfernen' })).toBeVisible();
    // the visible text stays short
    await expect(page.getByRole('group', { name: 'TMDB-API-Schlüssel' }).getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' })).toHaveText('Ersetzen');
    await page.getByRole('button', { name: 'TMDB-API-Schlüssel ersetzen' }).click();
    await expect(page.getByRole('group', { name: 'TMDB-API-Schlüssel' }).getByLabel('Neuer Wert')).toBeFocused();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('a deep link on the phone: the row is centred and highlighted', async ({ page }) => {
    await page.goto('/admin/settings?setting=PORTAINER_STACK_ID');
    await expect(page.getByRole('tab', { name: 'Updates' })).toHaveAttribute('aria-selected', 'true');
    const row = page.locator('#setting-PORTAINER_STACK_ID');
    await expect(row).toHaveAttribute('data-flash', 'static');
    await expect(row).toBeInViewport();
    await expect(row.getByRole('textbox')).toBeFocused();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    // an unsaved edit: the tab's dot and its screen-reader text stay inside the scrolling chip row
    await row.getByRole('textbox').fill('7');
    await expect(page.getByRole('tab', { name: 'Updates' })).toHaveAccessibleName('Updates (ungespeicherte Änderungen)');
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('search results fit 375 px and are 44 px targets', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/admin/settings');
    await page.getByRole('searchbox', { name: 'Einstellungen durchsuchen' }).fill('schlüssel');
    const links = page.locator('#set-results').getByRole('link');
    await expect(links.first()).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    for (const l of await links.all()) {
      const box = (await l.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(375.5);
    }
    await links.first().tap();
    await expect(page.locator('[data-flash]')).toHaveCount(1);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('Authentik card: button and checkbox ≥ 44 px, no overflow, a result does not move the button', async ({ page, api }) => {
    mailConfigured(api.settings);
    api.settings.ak.logoUrl = 'https://friend.example.com/api/public/brand/img/' + 'f'.repeat(64) + '.png';
    api.settings.ak.answers = [{ status: 200, body: { brand: { state: 'failed', code: 'permission', permission: 'authentik_brands.change_brand' }, stage: { state: 'failed', code: 'permission', permission: 'authentik_stages_email.change_emailstage' } } }];
    await page.goto('/admin/settings?tab=notifications');
    const ak = page.locator('section', { has: page.getByRole('heading', { level: 3, name: 'Authentik', exact: true }) });
    const button = ak.getByRole('button', { name: 'Branding an Authentik übertragen' });
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const label = ak.locator('label', { has: page.getByRole('checkbox') });
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    const pageBox = () => button.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; });
    const results = () => ak.getByTestId('ak-results').evaluate((el) => el.getBoundingClientRect().height);
    const before = await pageBox();
    const roomBefore = await results();
    await ak.getByRole('checkbox').tap();
    await button.tap();
    await expect(ak.getByTestId('ak-stage-result')).toContainText('authentik_stages_email.change_emailstage');
    expect(await pageBox()).toEqual(before);
    // the reserved room holds the longest lines: nothing below moves either
    expect(await results()).toBe(roomBefore);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  // the reserved room holds the longest result lines (both parts refused, the longest codename, the guide link) in every locale
  for (const loc of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
    test(`Authentik card, ${loc}: the longest results fit their reserved room`, async ({ page, api }) => {
      await page.addInitScript((l) => { try { localStorage.setItem('ff-locale', l); } catch { /* blocked storage */ } }, loc);
      mailConfigured(api.settings);
      api.settings.ak.answers = [{ status: 200, body: { brand: { state: 'failed', code: 'permission', permission: 'authentik_brands.change_brand' }, stage: { state: 'failed', code: 'permission', permission: 'authentik_stages_email.change_emailstage' } } }];
      await page.goto('/admin/settings?tab=notifications');
      const ak = page.locator('section[aria-labelledby="ak-sync-h"]');
      const results = ak.getByTestId('ak-results');
      await results.scrollIntoViewIfNeeded();
      const h0 = await results.evaluate((el) => el.getBoundingClientRect().height);
      await ak.locator('.act button').tap();
      await expect(ak.getByTestId('ak-stage-result').getByRole('link')).toBeVisible();
      expect(await results.evaluate((el) => el.getBoundingClientRect().height)).toBe(h0);
      for (const line of await results.locator('p').all()) expect(await line.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
      await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
    });
  }
});
