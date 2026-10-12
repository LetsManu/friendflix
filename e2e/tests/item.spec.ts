import { LOCKED_ID, UNLOCKED_ID, XSS_COMMENT } from '../mocks/api.js';
import { SERIES } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test.describe('item page', () => {
  test('shows cast, status picker, friends strip and language line', async ({ page, api }) => {
    await page.goto('/item/' + LOCKED_ID);
    await expect(page.getByRole('heading', { level: 1, name: 'Inception' })).toBeVisible();

    const cast = page.locator('section.cast');
    await expect(cast.getByRole('heading', { level: 2, name: 'Besetzung & Crew' })).toBeVisible();
    await expect(cast.getByText('Leonardo DiCaprio')).toBeVisible();
    await expect(cast.getByText('Tom Hardy')).toBeVisible();

    const friends = page.locator('section.fr');
    await expect(friends.getByText('Anna Beispiel')).toBeVisible();
    await expect(friends.getByText('Ben Test')).toBeVisible();

    await expect(page.getByText('Ton: Deutsch, Englisch · Untertitel: Deutsch')).toBeVisible();

    // status picker: "Inception" is planned (on the watchlist); switching to "Abgebrochen" persists
    const status = page.getByRole('group', { name: 'Status' });
    const planned = status.getByRole('button', { name: 'Geplant' });
    const dropped = status.getByRole('button', { name: 'Abgebrochen' });
    await expect(planned).toHaveAttribute('aria-pressed', 'true');
    await dropped.click();
    await expect(dropped).toHaveAttribute('aria-pressed', 'true');
    await expect(planned).toHaveAttribute('aria-pressed', 'false');
    expect(api.log.some((l) => l.startsWith(`PUT /api/items/${LOCKED_ID}/status`) || l.startsWith(`POST /api/items/${LOCKED_ID}/status`))).toBe(true);
    await expect.poll(() => noHorizontalOverflow(page)).toBe(true);
  });

  test('reactions are locked until the title was watched', async ({ page }) => {
    await page.goto('/item/' + LOCKED_ID);
    const rx = page.locator('section.reactions');
    await expect(rx.getByText(/sobald du das gesehen hast\s*\(3\)\./)).toBeVisible();
    await expect(rx.locator('textarea')).toHaveCount(0);
    await expect(rx.locator('.chip')).toHaveCount(0);
    await expect(rx.getByText('Anna')).toHaveCount(0);
  });

  test('unlocked reactions render comments as text (XSS probe) and save/delete', async ({ page, api }) => {
    let dialog = '';
    page.on('dialog', (d) => { dialog = d.message(); void d.dismiss(); });
    await page.goto('/item/' + UNLOCKED_ID);
    const rx = page.locator('section.reactions');
    await rx.scrollIntoViewIfNeeded();
    await expect(rx.locator('.chip')).toHaveCount(5);

    // the markup in the comment is shown literally, never interpreted
    await expect(rx.locator('.txt p').first()).toHaveText(XSS_COMMENT);
    await expect(rx.locator('li img, li b:has-text("x")')).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(dialog).toBe('');

    // own reaction is preselected; pick another, comment, save
    const chips = rx.getByRole('group', { name: 'Deine Reaktion' }).getByRole('button');
    await expect(chips.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await chips.nth(1).click();
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await rx.getByLabel('Kommentar (optional)').fill('Sehr lustig & "gut"');
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes(`/api/items/${UNLOCKED_ID}/reactions`));
    await rx.getByRole('button', { name: 'Speichern' }).click();
    expect((await put).postDataJSON()).toEqual({ emoji: 'funny', comment: 'Sehr lustig & "gut"' });
    await expect(rx.getByText('Gespeichert')).toBeVisible();

    const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/reactions'));
    await rx.getByRole('button', { name: 'Löschen' }).click();
    await del;
    await expect(rx.getByText('Reaktion gelöscht')).toBeVisible();
    expect(api.log.filter((l) => l.includes('/reactions'))).toHaveLength(2);
  });

  test('a series lists its episodes', async ({ page }) => {
    await page.goto('/item/' + SERIES.id);
    await expect(page.getByRole('heading', { level: 1, name: 'Breaking Bad' })).toBeVisible();
    await expect(page.getByText('Folge 1', { exact: false }).first()).toBeVisible();
  });
});
