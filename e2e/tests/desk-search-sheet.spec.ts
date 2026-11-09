// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { byName, hex, ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';

/**
 * The desktop search sheet (glass spec §2): typing in the top-bar pill opens one frosted sheet below it (no navigation), the
 * page dims, results cascade in (§8.6); the field is a combobox (arrows, Enter, Esc); on /search the pill drives the page.
 */

/** no brand intro over the page; the frame guard with a budget no test host misses */
async function quiet(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
}
async function calm(page: Page) {
  await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
  await page.addInitScript(() => localStorage.setItem('ff_calm:p1', '1'));
}
/** calm mode is on (the prefs arrived) */
const calmOn = (page: Page) => expect(page.locator('html')).toHaveClass(/m-still/);
/** /watchlist with the bar ready ("/" before /api/me answered has no bar to open) */
async function ready(page: Page) {
  await page.goto('/watchlist');
  await expect(page.locator('[data-desk-bar] .pill')).toHaveClass(/\bon\b/);
}
const sheet = (page: Page) => page.locator('#ds-sheet');
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

test.describe('desktop search sheet', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: false } }));
    await quiet(page);
  });

  test('typing in the pill opens one frosted sheet below it; the page dims; the URL stays', async ({ page }) => {
    await page.route('**/api/search?*', (r) => r.fulfill({ json: {
      q: 'har', titles: [byName('Pulse Harbor'), byName('Strange Harbor'), byName('The Wharf')], episodes: [],
      people: [{ id: hex(310), name: 'Ida Harlow', image: false }], genres: ['Drama', 'Krimi'], partial: false,
    } }));
    await ready(page);
    await page.keyboard.press('/');
    await page.keyboard.type('har', { delay: 30 });
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Beste Treffer' })).toBeVisible();
    const pb = await box(page, '[data-desk-bar] .pill'), sb = await box(page, '#ds-sheet');
    expect(sb.y).toBeGreaterThan(pb.y + pb.height);
    expect(Math.abs(sb.x + sb.width / 2 - (pb.x + pb.width / 2))).toBeLessThanOrEqual(2);
    await expect(page.locator('.frost-dim')).toBeVisible();
    expect(page.url()).not.toContain('/search');
    for (const h of ['Beste Treffer', 'Personen', 'Filme & Serien', 'Nach Genre stöbern']) await expect(sheet(page).getByRole('heading', { name: h })).toBeVisible();
    const mark = sheet(page).locator('#ds-hit-0 mark');
    await expect(mark).toHaveText('Har');
    // white (AA on the sheet and its selected row, searchSheet.test.ts) with a 2 px brand-coral underline
    const mk = await mark.evaluate((e) => { const c = getComputedStyle(e); return [c.color, c.textDecorationLine, c.textDecorationThickness, c.textDecorationColor]; });
    expect(mk).toEqual(['rgb(255, 255, 255)', 'underline', '2px', 'rgb(255, 79, 109)']);
    // above the bar's scroll shade (on, on /watchlist): just inside the sheet's top edge is the sheet itself
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('#ds-sheet'), [sb.x + sb.width / 2, sb.y + 4]);
    expect(hit).toBe(true);
    expect(await sheet(page).evaluate((e) => +getComputedStyle(e).zIndex)).toBeGreaterThan(await page.locator('[data-desk-bar]').evaluate((e) => +getComputedStyle(e).zIndex));
    await expect(sheet(page)).toHaveAttribute('role', 'region');
    await expect(sheet(page)).toHaveAttribute('aria-label', 'Suchergebnisse');
    await expect(sheet(page).locator('#ds-all')).toHaveText('Alle Ergebnisse');
    await expect(page.locator('#hq')).toHaveAttribute('aria-expanded', 'true');
  });

  test('before typing: recent, popular and genres in the same sheet', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ff-recent-search:p1', JSON.stringify(['nolan', 'dahl'])));
    await ready(page);
    await page.keyboard.press('/');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Zuletzt gesucht' })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'nolan' })).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Beliebt hier' })).toBeVisible();
    await expect(sheet(page).locator('.posters a')).toHaveCount(5);
    await expect(sheet(page).getByRole('link', { name: 'Krimi' })).toBeVisible();
    const before = await box(page, '#ds-sheet');
    await page.keyboard.type('ha', { delay: 30 });
    await expect(sheet(page).getByRole('heading', { name: 'Beste Treffer' })).toBeVisible();
    const after = await box(page, '#ds-sheet');
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(Math.round(after.width)).toBe(Math.round(before.width));
    // a recent chip goes into the field; Clear empties the list
    await page.keyboard.press('Escape');
    await sheet(page).getByRole('button', { name: 'dahl' }).click();
    await expect(page.locator('#hq')).toHaveValue('dahl');
    await expect(page.locator('#hq')).toBeFocused();
    await page.keyboard.press('Escape');
    await sheet(page).getByRole('button', { name: 'Verlauf löschen' }).click();
    await expect(sheet(page).getByRole('button', { name: 'nolan' })).toHaveCount(0);
    await expect(page.locator('#hq')).toBeFocused();
  });

  test('keyboard: arrows move the active hit, Enter opens it, Enter without one goes to /search', async ({ page }) => {
    await ready(page);
    const input = page.locator('#hq');
    await page.keyboard.press('/');
    await page.keyboard.type('har', { delay: 30 });
    await expect(sheet(page).locator('#ds-hit-0')).toBeVisible();
    await expect(input).toHaveAttribute('role', 'combobox');
    // the combobox controls the listbox; All results is its option too (owned from the other column)
    await expect(input).toHaveAttribute('aria-controls', 'ds-list');
    await expect(sheet(page).locator('#ds-list')).toHaveAttribute('role', 'listbox');
    await expect(sheet(page).locator('#ds-list')).toHaveAttribute('aria-owns', 'ds-all');
    await expect(sheet(page).locator('#ds-all')).toHaveAttribute('role', 'option');
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'ds-hit-0');
    await expect(sheet(page).locator('#ds-hit-0')).toHaveAttribute('aria-selected', 'true');
    // ↑ from the first wraps to All results, ↓ comes back
    await input.press('ArrowUp');
    await expect(input).toHaveAttribute('aria-activedescendant', 'ds-all');
    await expect(sheet(page).locator('#ds-all')).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'ds-hit-0');
    const href = await sheet(page).locator('#ds-hit-0').getAttribute('href');
    expect(href).toMatch(/^\/item\/[0-9a-f]{32}$/);
    await input.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(sheet(page)).toHaveCount(0);
    // the pick is remembered as a recent search
    expect(await page.evaluate(() => localStorage.getItem('ff-recent-search:p1'))).toContain('har');

    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await page.keyboard.type('har', { delay: 30 });
    await expect(sheet(page).locator('#ds-hit-0')).toBeVisible();
    await input.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=har$/);
  });

  test('Esc clears, then closes; outside click closes; a late answer does not reopen', async ({ page }) => {
    await page.route('**/api/search?*', async (r) => { await new Promise((res) => setTimeout(res, 600)); await r.fallback(); });
    await ready(page);
    const input = page.locator('#hq');
    await page.keyboard.press('/');
    const asked = page.waitForRequest('**/api/search?*');
    await page.keyboard.type('har', { delay: 30 });
    await asked;
    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(sheet(page)).toBeVisible(); // cleared: the idle sheet
    await input.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('[data-desk-bar] button.mag')).toBeFocused(); // the focus comes back to the magnifier
    await page.waitForTimeout(800);
    await expect(sheet(page)).toHaveCount(0);

    await page.keyboard.press('/');
    await expect(sheet(page)).toBeVisible();
    await page.mouse.click(5, 700);
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('[data-desk-bar] .pill')).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('.frost-dim')).toHaveCount(0);
  });

  test('a late answer for an older query never shows', async ({ page }) => {
    await page.route('**/api/search?*', async (r) => {
      if (new URL(r.request().url()).searchParams.get('q') === 'har') await new Promise((res) => setTimeout(res, 600));
      await r.fallback();
    });
    await ready(page);
    const input = page.locator('#hq');
    await page.keyboard.press('/');
    // record whether a "har" hit ever appears
    await page.evaluate(() => {
      const w = window as unknown as { __harSeen: boolean };
      w.__harSeen = false;
      new MutationObserver(() => { if (document.querySelector('#ds-sheet mark')?.textContent?.toLowerCase() === 'har') w.__harSeen = true; }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const asked = page.waitForRequest((r) => r.url().includes('/api/search?q=har'));
    await page.keyboard.type('har', { delay: 30 });
    await asked;
    await input.fill('xyz');
    await expect(sheet(page).getByText('Keine Treffer für „xyz“')).toBeVisible();
    await page.waitForTimeout(800); // the "har" answer has landed by now
    await expect(sheet(page).getByText('Keine Treffer für „xyz“')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __harSeen: boolean }).__harSeen)).toBe(false);
  });

  test.describe('a failed search', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('says so in the sheet', async ({ page }) => {
      await page.route('**/api/search?*', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }));
      await ready(page);
      await page.keyboard.press('/');
      await page.keyboard.type('har', { delay: 30 });
      await expect(sheet(page).getByRole('status')).toHaveText('Suche gerade nicht möglich');
    });
  });

  test('Tab moves through the sheet and closes it on the way out; clicking its empty space keeps typing in the field', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ff-recent-search:p1', JSON.stringify(['nolan', 'dahl'])));
    await ready(page);
    const input = page.locator('#hq');
    await page.keyboard.press('/');
    await expect(sheet(page).getByRole('button', { name: 'nolan' })).toBeVisible();
    await expect(sheet(page).locator('.posters a')).toHaveCount(5);
    // a press on empty space (a heading) keeps the focus in the field
    await sheet(page).getByRole('heading', { name: 'Beliebt hier' }).click();
    await expect(input).toBeFocused();
    await page.keyboard.type('n');
    await expect(input).toHaveValue('n');
    await input.fill('');
    // field → ✕ → the sheet's first control (Clear), then on through its chips, posters and genres
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-desk-bar] button.x')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sheet(page).getByRole('button', { name: 'Verlauf löschen' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sheet(page).getByRole('button', { name: 'nolan' })).toBeFocused();
    // Shift+Tab off the first control: back to the field, the sheet stays
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(input).toBeFocused();
    await expect(sheet(page)).toBeVisible();
    // all the way through: the sheet closes and the focus moves on to the bell
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const n = await sheet(page).evaluate((s) => s.querySelectorAll('a[href]:not([tabindex="-1"]), button:not(:disabled)').length);
    for (let i = 1; i < n; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('#ds-sheet'))).toBe(true);
    }
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('[data-desk-bar] .right button').first()).toBeFocused();
  });

  test('on /search the sheet never opens', async ({ page }) => {
    await page.goto('/search?q=har');
    const input = page.locator('#hq');
    await expect(input).toHaveValue('har');
    await input.fill('harb');
    await expect(page).toHaveURL(/\/search\?q=harb$/);
    await expect(page.locator('section[aria-labelledby="st"] article.card')).toHaveCount(2); // Pulse Harbor, Strange Harbor
    await expect(sheet(page)).toHaveCount(0);
    await expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  test('calm: no cascade, and closing is instant', async ({ page }) => {
    await calm(page);
    await ready(page);
    await calmOn(page);
    await page.keyboard.press('/');
    await page.keyboard.type('har', { delay: 30 });
    await expect(sheet(page).locator('#ds-hit-0')).toBeVisible();
    await page.waitForTimeout(100);
    expect(await sheet(page).evaluate((s) => [...s.querySelectorAll('[data-cascade]')].reduce((n, e) => n + e.getAnimations().length, 0))).toBe(0);
    await page.locator('#hq').press('Escape');
    await page.locator('#hq').press('Escape');
    await expect(sheet(page)).toHaveCount(0, { timeout: 100 });
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('results cascade 45 ms apart (full motion)', async ({ page }) => {
      await ready(page);
      await page.keyboard.press('/');
      await page.keyboard.type('har', { delay: 30 });
      const delays = await page.waitForFunction(() => {
        const els = [...document.querySelectorAll('#ds-sheet [data-cascade]')].slice(0, 3);
        if (els.length < 3 || els[0]!.id !== 'ds-hit-0') return null;
        const d = els.map((e) => e.getAnimations()[0]?.effect?.getTiming().delay);
        return d.every((x) => x !== undefined) ? d : null;
      }, null, { polling: 'raf' });
      expect(await delays.jsonValue()).toEqual([0, 45, 90]);
    });

    test('closing animates (full) and is instant in calm', async ({ page }) => {
      await ready(page);
      await page.keyboard.press('/');
      await expect(sheet(page)).toBeVisible();
      await expect.poll(() => sheet(page).evaluate((s) => s.getAnimations().length)).toBe(0); // grown in
      // a per-frame watcher, started before the Esc: did a frame show the sheet still attached and folding back?
      // (installed in the page before the key is sent, awaited after it)
      await page.evaluate(() => {
        (window as unknown as { __folded: Promise<boolean> }).__folded = new Promise<boolean>((res) => {
          const t0 = performance.now();
          const f = () => {
            const s = document.getElementById('ds-sheet');
            if (s?.getAnimations().length) return res(true);
            if (!s || performance.now() - t0 > 4000) return res(false);
            requestAnimationFrame(f);
          };
          requestAnimationFrame(f);
        });
      });
      await page.locator('#hq').press('Escape');
      expect(await page.evaluate(() => (window as unknown as { __folded: Promise<boolean> }).__folded)).toBe(true); // folding back up, not cut
      await expect(sheet(page)).toHaveCount(0);
    });

    test('toggle fast: open, close mid-open, reopen mid-close (within ~100 ms) turns around without a jump', async ({ page }) => {
      await ready(page);
      type S = { n: number; s: number; o: number; d: number };
      const run = () => page.evaluate(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const at = (): S | null => {
          const all = document.querySelectorAll<HTMLElement>('#ds-sheet');
          if (!all.length) return null;
          const cs = getComputedStyle(all[0]!);
          const dim = document.querySelector<HTMLElement>('.ds-dim');
          return { n: all.length, s: cs.transform === 'none' ? 1 : new DOMMatrixReadOnly(cs.transform).a, o: Number(cs.opacity), d: dim ? Number(getComputedStyle(dim).opacity) : -1 };
        };
        const key = (el: Element | null, k: string) => (el ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        const out: Array<S | null> = [];
        const until = async (ok: (v: S | null) => boolean, ms = 2000) => {
          const t0 = performance.now();
          for (;;) { await frame(); const v = at(); out.push(v); if (ok(v) || performance.now() - t0 > ms) return v; }
        };
        const gone = () => until((v) => !v);
        // condition-driven (a loaded host has long frames): close once the sheet is visibly growing, reopen as soon as it is
        // visibly folding back. Svelte hands a turn over a frame or two later (the running half goes on until then), so a stall
        // can let the fold reach its end before the reopen takes over (then it rightly grows from there): such a try is
        // retried. A real restart (back to scale .4 / opacity 0, or a new sheet) looks like that every time, so it still fails.
        const settledOpen = (v: S | null) => !v || (v.o === 1 && v.s === 1 && !document.getElementById('ds-sheet')!.getAnimations().length);
        for (let tries = 0; tries < 5; tries++) {
          out.length = 0;
          key(document.activeElement, '/'); // open
          const a = await until((v) => !!v && v.o >= 0.3);
          if (!a || a.o > 0.9) { key(document.getElementById('hq'), 'Escape'); await gone(); continue; } // overshot
          const closeAt = out.length;
          key(document.getElementById('hq'), 'Escape'); // close mid-open (the field is empty: it closes)
          let peak = 0;
          const b = await until((v) => { if (v) peak = Math.max(peak, v.o); return !v || v.o <= peak - 0.05; });
          if (!b || b.o < 0.2) { await gone(); continue; } // stalled: (nearly) gone before the reopen
          const reopenAt = out.length;
          key(document.activeElement, '/'); // reopen mid-close
          await until(settledOpen);
          if (out.slice(reopenAt).some((v) => !v || v.o === 0)) { await until(settledOpen); key(document.getElementById('hq'), 'Escape'); await gone(); continue; } // stalled
          return { out: out as S[], closeAt, reopenAt };
        }
        return { out: out as S[], closeAt: -1, reopenAt: -1 }; // (the last try's samples, gaps included)
      });
      const r = await run();
      const dump = JSON.stringify(r.out.map((x) => (x ? [+x.s.toFixed(3), +x.o.toFixed(2), +x.d.toFixed(2)] : null)));
      expect(r.reopenAt, dump).toBeGreaterThan(0);
      const fall = r.out.slice(r.closeAt, r.reopenAt), rise = r.out.slice(r.reopenAt);
      // one sheet at all times, and never a frame at opacity 0 once it showed (a restart would drop to scale .4, opacity 0)
      expect(r.out.every((x) => x.n === 1), dump).toBe(true);
      expect(r.out.slice(r.closeAt).some((x) => x.o === 0), dump).toBe(false);
      expect(Math.min(...rise.map((x) => x.s)), dump).toBeGreaterThan(0.45);
      // the close turns around within a frame or two and only fades from there; the reopen likewise only rises
      const top = fall.findIndex((x) => x.o === Math.max(...fall.map((y) => y.o)));
      expect(top, dump).toBeLessThanOrEqual(3);
      for (let k = top + 1; k < fall.length; k++) expect(fall[k]!.o, dump).toBeLessThanOrEqual(fall[k - 1]!.o + 0.001);
      const low = rise.findIndex((x) => x.o === Math.min(...rise.map((y) => y.o)));
      expect(low, dump).toBeLessThanOrEqual(3);
      for (let k = low + 1; k < rise.length; k++) expect(rise[k]!.o, dump).toBeGreaterThanOrEqual(rise[k - 1]!.o - 0.001);
      // the dim turns with it (its fade is shorter, so it may reach its end first): after its lowest point it only rises
      const dlow = rise.findIndex((x) => x.d === Math.min(...rise.map((y) => y.d)));
      expect(dlow, dump).toBeLessThanOrEqual(3);
      for (let k = dlow + 1; k < rise.length; k++) expect(rise[k]!.d, dump).toBeGreaterThanOrEqual(rise[k - 1]!.d - 0.001);
      await expect.poll(() => page.locator('.ds-dim').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      await expect(sheet(page)).toHaveCount(1);
      await expect(page.locator('#hq')).toHaveAttribute('aria-expanded', 'true');
    });

    test('calm mode: closing is instant', async ({ page }) => {
      await calm(page);
      await ready(page);
      await calmOn(page);
      await page.keyboard.press('/');
      await expect(sheet(page)).toBeVisible();
      await page.locator('#hq').press('Escape');
      await expect(sheet(page)).toHaveCount(0, { timeout: 100 });
    });

    test('bar pill and round buttons are glass with the sheen', async ({ page }) => {
      await ready(page);
      await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
      const half = page.locator('[data-desk-bar] .pbg .half i.blur').first();
      expect(await half.evaluate((e) => getComputedStyle(e).backdropFilter)).toContain('blur(38px)');
      expect(await page.locator('[data-desk-bar] .round').evaluate((e) => getComputedStyle(e).backdropFilter)).toContain('blur(38px)');
      const pill = page.locator('[data-desk-bar] .pill');
      const pb = (await pill.boundingBox())!;
      await page.mouse.move(pb.x + 20, pb.y + pb.height / 2);
      await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 4 });
      await expect(pill.locator('.frost-sheen.on')).toHaveCount(1);
      await expect(page.locator('[data-desk-bar] .round .frost-sheen')).toHaveCount(1);
      // the bell's hover lights its edge; the milk stays as it is (glass spec §1.3)
      const round = page.locator('[data-desk-bar] .round');
      const bg = await round.evaluate((e) => getComputedStyle(e).backgroundImage);
      await round.hover();
      await expect.poll(() => round.evaluate((e) => getComputedStyle(e).borderTopColor)).toBe('rgba(255, 255, 255, 0.42)');
      expect(await round.evaluate((e) => getComputedStyle(e).backgroundImage)).toBe(bg);
    });

    test('over the billboard the bar keeps the safe scrim until the shade is in', async ({ page }) => {
      await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
      await page.goto('/');
      const bar = page.locator('[data-desk-bar]');
      const half = bar.locator('.pbg .half i.frost').first();
      await expect(half).toHaveClass(/frost-safe/);
      await expect(bar.locator('.round')).toHaveClass(/frost-safe/);
      // scrolled: the safe scrim stays while the shade fades in (240 ms), then the light one over the shade
      const kept = await page.evaluate(async () => {
        window.scrollTo(0, 60);
        await new Promise((r) => setTimeout(r, 120));
        return document.querySelector('[data-desk-bar] .pbg .half i.frost')!.classList.contains('frost-safe');
      });
      expect(kept).toBe(true);
      await expect(half).not.toHaveClass(/frost-safe/);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(half).toHaveClass(/frost-safe/);
    });
  });
});
