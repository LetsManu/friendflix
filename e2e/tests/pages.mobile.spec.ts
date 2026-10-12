import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('account and news pages (phone)', () => {
  test('/me renders with the tab bar and no horizontal overflow', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByRole('list', { name: 'Schnellzugriff' })).toBeVisible();
    await expect(page.getByText('Anna hat dich zur Liste „Annas Klassiker“ eingeladen')).toBeVisible();
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('/new renders the tabs and cards without horizontal overflow', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Neu & beliebt' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Bereich' }).getByRole('tab').first()).toBeVisible();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });
});
