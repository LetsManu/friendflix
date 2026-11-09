// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';

/** Accessibility audit fixes (2026-11-09), phone: focus is never hidden under the glass tab bar; the carousel's two-tone ring. */
test.describe('accessibility (phone)', () => {
  test('a control focused below the fold scrolls clear of the floating tab bar (WCAG 2.4.11)', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('nav.tabbar, .tabbar').first();
    await expect(bar).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom)).toBe('86px'); // 70 + 0 + 16
    const top = (await bar.boundingBox())!.y;
    // every link in the rows, one after the other, as a Tab walk would (scripted: the phone has no Tab key)
    await page.keyboard.press('Shift');
    const n = await page.locator('main section.row a[href]').count();
    expect(n).toBeGreaterThan(3);
    let checked = 0;
    for (let i = 0; i < Math.min(n, 12); i++) {
      const a = page.locator('main section.row a[href]').nth(i);
      await a.evaluate((el) => (el as HTMLElement).focus());
      const r = await a.evaluate((el) => { const b = el.getBoundingClientRect(); return { bottom: b.bottom, h: b.height }; });
      if (!r.h) continue;
      expect(r.bottom, `link ${i}`).toBeLessThanOrEqual(top + 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  test('the carousel card ring: white outline over a dark band drawn over the poster', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.mc a.card[tabindex="0"]').first();
    await expect(card).toBeVisible();
    await page.keyboard.press('Shift');
    await card.focus();
    const r = await card.evaluate((el) => {
      const c = getComputedStyle(el), a = getComputedStyle(el, '::after');
      return { outline: `${c.outlineStyle} ${c.outlineColor}`, after: a.boxShadow };
    });
    expect(r.outline).toBe('solid rgb(255, 255, 255)');
    expect(r.after).toContain('rgba(8, 8, 12, 0.85)');
  });
});
