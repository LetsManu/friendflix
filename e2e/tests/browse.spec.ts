import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('browse (desktop)', () => {
  test('active filters render as chips and can be removed one by one', async ({ page }) => {
    await page.goto('/browse/movies?genre=Drama&decade=1990&minRating=7&audio=deu');
    await expect(page.getByRole('heading', { level: 1, name: 'Filme' })).toBeVisible();
    const chips = page.getByRole('list', { name: 'Aktive Filter' });
    for (const label of ['Drama', '1990er', 'ab 7 Sterne', 'Deutsch']) await expect(chips.getByRole('button', { name: new RegExp(label) })).toBeVisible();
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);

    await chips.getByRole('button', { name: /1990er/ }).click();
    await expect(page).not.toHaveURL(/decade=/);
    await expect(page).toHaveURL(/genre=Drama/);
    await expect(page).toHaveURL(/audio=deu/);
    await expect(chips.getByRole('button', { name: /1990er/ })).toHaveCount(0);
    await expect(chips.getByRole('button', { name: /^Filter Drama entfernen/ })).toBeVisible();
    await expect(chips.getByRole('button', { name: /^Filter ab 7 Sterne entfernen/ })).toBeVisible();
  });

  test('changing a select adds a chip', async ({ page }) => {
    await page.goto('/browse/movies');
    await expect(page.getByRole('list', { name: 'Aktive Filter' })).toHaveCount(0);
    await expect(page.locator('.fbtn')).toBeHidden();
    await page.locator('#g').selectOption('Krimi');
    await expect(page).toHaveURL(/genre=Krimi/);
    await expect(page.getByRole('button', { name: /^Filter Krimi entfernen/ })).toBeVisible();
  });
});
