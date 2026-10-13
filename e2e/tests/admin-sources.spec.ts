import { expect, test } from '../fixtures.js';

// Admin → Datenquellen (/admin/sources): optional TMDB/OMDb keys; only last4 is ever shown.
const toasts = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Hinweise' });
const card = (page: import('@playwright/test').Page, name: string) => page.locator('section', { has: page.getByRole('heading', { name, exact: true }) });

test.describe('admin: data sources', () => {
  test.beforeEach(({ api }) => { api.asAdmin = true; });

  test('set key: pill shows …abcd, the typed key is gone from the field and the HTML', async ({ page }) => {
    await page.goto('/admin/sources');
    const tmdb = card(page, 'TMDB');
    await expect(tmdb.getByText('Nicht gesetzt')).toBeVisible();
    const field = tmdb.getByLabel('Neuer Schlüssel');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await field.fill('sekret-key-wxyzabcd');
    await tmdb.getByRole('button', { name: 'Speichern' }).click();
    await expect(toasts(page).getByText('Schlüssel gespeichert.')).toBeVisible();
    await expect(tmdb.getByText('Gesetzt · …abcd')).toBeVisible();
    await expect(field).toHaveValue('');
    expect(await page.content()).not.toContain('sekret-key-wxyzabcd');
  });

  test('test: success toast; invalid key shows "Schlüssel ungültig"', async ({ page }) => {
    await page.goto('/admin/sources');
    const omdb = card(page, 'OMDb');
    await omdb.getByRole('button', { name: 'Testen' }).click();
    await expect(toasts(page).getByText('Verbindung funktioniert.')).toBeVisible();
    await omdb.getByLabel('Neuer Schlüssel').fill('bad-key-12345');
    await omdb.getByRole('button', { name: 'Testen' }).click();
    await expect(toasts(page).getByText('Schlüssel ungültig')).toBeVisible();
  });

  test('remove asks for confirmation, then the pill says "Nicht gesetzt"', async ({ page }) => {
    await page.goto('/admin/sources');
    const omdb = card(page, 'OMDb');
    await expect(omdb.getByText('Gesetzt · …k3y9')).toBeVisible();
    await omdb.getByRole('button', { name: 'Entfernen' }).click();
    const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dlg).toContainText('Schlüssel für OMDb entfernen?');
    await dlg.getByRole('button', { name: 'Entfernen' }).click();
    await expect(omdb.getByText('Nicht gesetzt')).toBeVisible();
    await expect(toasts(page).getByText('Schlüssel entfernt.')).toBeVisible();
  });

  test('from file: field and Save are disabled, hint is visible', async ({ page, api }) => {
    api.admin.sources[0] = { name: 'tmdb', set: true, last4: 'file', from: 'file', invalid: false };
    await page.goto('/admin/sources');
    const tmdb = card(page, 'TMDB');
    await expect(tmdb.getByText('Aus Datei')).toBeVisible();
    await expect(tmdb.getByLabel('Neuer Schlüssel')).toBeDisabled();
    await expect(tmdb.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await expect(tmdb.getByRole('button', { name: 'Entfernen' })).toBeDisabled();
    await expect(tmdb.getByText(/kommt aus einer Datei/)).toBeVisible();
  });

  test('OMDb shows today\'s usage', async ({ page }) => {
    await page.goto('/admin/sources');
    await expect(card(page, 'OMDb').getByText('12 von 900 Abfragen heute')).toBeVisible();
  });

  test('nav: Datenquellen under Betrieb, active on /admin/sources', async ({ page }) => {
    await page.goto('/admin/sources');
    await expect(page.getByRole('heading', { level: 1, name: 'Datenquellen' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Admin-Bereiche' });
    await expect(nav.getByRole('link', { name: 'Datenquellen' })).toHaveAttribute('aria-current', 'page');
  });
});
