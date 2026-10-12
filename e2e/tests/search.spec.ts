import { expect, test } from '../fixtures.js';

test.describe('search', () => {
  test('typing keeps the input value and shows grouped results; Escape clears', async ({ page }) => {
    await page.goto('/search');
    const input = page.locator('#q');
    await expect(page.getByText('Gib mindestens zwei Zeichen ein.')).toBeVisible();

    // regression: results used to re-render the page and wipe what was typed
    await input.click();
    await input.pressSequentially('nolan', { delay: 40 });
    await expect(page.getByRole('heading', { level: 2, name: 'Personen' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Filme & Serien' })).toBeVisible();
    await expect(input).toHaveValue('nolan');
    await expect(input).toBeFocused();
    await expect(page).toHaveURL(/\/search\?q=nolan$/);
    await expect(page.getByRole('link', { name: 'Christopher Nolan' })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="st"] article.card')).toHaveCount(6);

    // keep typing: a longer query replaces the results, input is still intact
    await input.fill('');
    await input.pressSequentially('dark', { delay: 40 });
    await expect(page).toHaveURL(/q=dark$/);
    await expect(page.locator('section[aria-labelledby="st"] article.card')).toHaveCount(2); // "The Dark Knight", "Dark"
    await expect(input).toHaveValue('dark');

    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/search$/);
    // results are gone; the idle state offers the recent searches
    await expect(page.locator('section[aria-labelledby="st"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Zuletzt gesucht' })).toBeVisible();
  });

  test('episodes get their own group and unknown terms show the empty state', async ({ page }) => {
    await page.goto('/search?q=breaking');
    await expect(page.getByRole('heading', { level: 2, name: 'Folgen' })).toBeVisible();
    await expect(page.locator('#q')).toHaveValue('breaking');

    await page.locator('#q').fill('zzzzz');
    await expect(page.getByRole('heading', { level: 2, name: 'Keine Treffer für „zzzzz“' })).toBeVisible();
  });
});
