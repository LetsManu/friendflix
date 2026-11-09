// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { byName, ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/**
 * Accessibility audit fixes (2026-11-09), desktop: the two-tone focus ring, undo toasts that wait for keyboard users (with a
 * shortcut), the search sheet's result count, and settings at 320 px. The player and the bar's menus have their own specs
 * (desk-player, desk-bar).
 */
const toasts = (page: Page) => page.getByRole('region', { name: 'Hinweise' });
const ring = (page: Page) => page.evaluate(() => {
  const c = getComputedStyle(document.activeElement!);
  return { outline: `${c.outlineStyle} ${c.outlineColor}`, shadow: c.boxShadow };
});

test.describe('accessibility (desktop)', () => {
  test('the focus ring is two-tone: a white outline with a dark companion (shows on bright art and light glass)', async ({ page }) => {
    await page.goto('/');
    const thumb = page.locator('section.row a.thumb').first();
    await expect(thumb).toBeVisible();
    await page.keyboard.press('Shift'); // keyboard modality: the scripted focus is focus-visible
    await thumb.focus();
    const r = await ring(page);
    expect(r.outline).toBe('solid rgb(255, 255, 255)');
    expect(r.shadow).toContain('rgba(8, 8, 12, 0.85)');
    // a glass button keeps the companion too (its own highlight shadow does not override it)
    const bell = page.locator('[data-desk-bar]').getByRole('button', { name: /Benachrichtigungen/ });
    await bell.focus();
    expect((await ring(page)).shadow).toContain('rgba(8, 8, 12, 0.85)');
  });

  test('an undo toast stays while the keyboard is in use; Alt+Z runs its action from anywhere (WCAG 2.2.1)', async ({ page, api }) => {
    api.asAdmin = true;
    await page.clock.install();
    await page.goto('/admin/hygiene');
    const table = page.getByRole('table', { name: 'Bibliothekspflege' });
    const row = table.getByRole('row', { name: /Old Reel/ });
    await row.getByRole('button', { name: /Aktionen/ }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).focus();
    await page.keyboard.press('Enter');
    const undo = toasts(page).getByRole('button', { name: 'Rückgängig' });
    await expect(undo).toBeVisible();
    // the shortcut is announced with the toast and is the action's description
    await expect(undo).toHaveAttribute('aria-keyshortcuts', 'Alt+Z');
    await expect(undo).toHaveAccessibleDescription('Tastenkürzel: Alt+Z');
    await page.clock.runFor(30_000); // far past the 5 s countdown
    await expect(undo).toBeVisible();
    await expect(toasts(page).locator('.ring')).toHaveClass(/\bheld\b/);
    await page.keyboard.press('Alt+KeyZ');
    await expect(undo).toHaveCount(0);
    await expect.poll(() => api.log.some((l) => l.startsWith('DELETE /api/admin/hygiene/ignore'))).toBe(true);
  });

  test('pointer users keep the countdown: the undo toast still leaves after 5 s', async ({ page, api }) => {
    api.asAdmin = true;
    await page.clock.install();
    await page.goto('/admin/hygiene');
    const row = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
    await row.getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    const undo = toasts(page).getByRole('button', { name: 'Rückgängig' });
    await expect(undo).toBeVisible();
    await page.mouse.move(5, 5); // away from the toast (hovering it pauses the timer)
    await expect(toasts(page).locator('.ring')).not.toHaveClass(/\bheld\b/);
    await page.clock.runFor(6000);
    await expect(undo).toHaveCount(0);
  });

  test('the search sheet says how many results it found (WCAG 4.1.3)', async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: false } }));
    await page.route('**/api/search?*', (r) => r.fulfill({ json: {
      q: 'har', titles: [byName('Pulse Harbor'), byName('Strange Harbor')], episodes: [], people: [], genres: ['Drama'], partial: false,
    } }));
    await page.goto('/watchlist');
    await expect(page.locator('[data-desk-bar] .pill')).toHaveClass(/\bon\b/);
    const status = page.locator('[data-ds-status]');
    await expect(status).toHaveAttribute('role', 'status');
    await page.keyboard.press('/');
    await page.keyboard.type('har', { delay: 30 });
    await expect(status).toHaveText('3 Treffer');
  });

  test('settings reflow at 320 px: no horizontal scroll, the switch rows wrap (WCAG 1.4.10)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/settings');
    const sw = page.locator('label.sw-row').first();
    await expect(sw).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    const over = await page.locator('main label.sw-row, main .field select').evaluateAll((els) => els
      .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > innerWidth + 1).length);
    expect(over).toBe(0);
  });
});
