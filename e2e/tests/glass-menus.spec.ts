// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';
import { ME } from '../mocks/fixtures.js';
import { auid } from '../mocks/admin.js';
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';

/**
 * Glass menus and toasts (glass spec §5, §8.3, §8.5): every menu is a glass card that grows out of its button (380 ms spring) and
 * folds back into it (200 ms), reversing mid-flight; the selected row is a light pill. Toasts are glass pills at the bottom centre
 * with a status dot, the action and a 5 s countdown ring that pauses on hover. Calm mode: at once; TV and kids: solid.
 */

const BECAUSE = 'Weil du „Inkwell“ gesehen hast';

/** full motion without the brand intro over the page, no trailers; a frame guard no test host trips */
async function fullMotion(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    sessionStorage.setItem('ff-intro-seen', '1');
    localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
    (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 };
  });
  await page.route('**/api/items/*/trailer', (r) => r.fulfill({ json: {} }));
}
async function calmMode(page: Page) {
  await page.route('**/api/prefs', (r) => r.fulfill({ json: { prefs: { calm: true } } }));
  await page.addInitScript(() => localStorage.setItem('ff_calm:p1', '1'));
}

type Anim = { duration: number; origin: string; play: string };
/** waits frame by frame (in the page) for the element's first animation that has a duration, and reports it */
const anim = (loc: Locator): Promise<Anim> => loc.evaluate((e) => new Promise<Anim>((res, rej) => {
  const t0 = performance.now();
  const step = () => {
    const a = e.getAnimations().find((x) => Number(x.effect?.getTiming().duration) > 0);
    if (a) { res({ duration: Number(a.effect!.getTiming().duration), origin: getComputedStyle(e).transformOrigin, play: a.playState }); return; }
    if (performance.now() - t0 > 2000) { rej(new Error('no animation')); return; }
    requestAnimationFrame(step);
  };
  step();
}));
/** no animation left on the element */
const settled = (loc: Locator) => expect.poll(() => loc.evaluate((e) => e.getAnimations().length)).toBe(0);
const css = (loc: Locator, prop: string) => loc.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

/** a pure white layer over the page, under the menus (z 49: below the bar's dropdowns, the popovers and the toasts) */
const whiteBehind = (page: Page) => page.evaluate(() => {
  const d = document.createElement('div');
  d.id = 'white-bd';
  d.style.cssText = 'position:fixed;inset:0;z-index:49;background:#fff;pointer-events:none';
  document.body.appendChild(d);
});
const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/**
 * Every text inside `root` (an element with its own text) passes AA where it is drawn: its ink (alpha-blended) against the
 * brightest pixel under its text with the text hidden (the white layer, blur, scrim, milk, grain and any light pill drawn).
 */
async function textPasses(page: Page, root: Locator) {
  const n = await root.evaluate((r) => {
    document.querySelectorAll<HTMLElement>('[data-ink]').forEach((e) => delete e.dataset.ink);
    let i = 0;
    for (const e of [r, ...r.querySelectorAll<HTMLElement>('*')]) {
      if (![...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()) || !e.getClientRects().length || e.closest('.sr-only')) continue;
      e.dataset.ink = String(i++);
    }
    return i;
  });
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = root.page().locator(`[data-ink="${i}"]`);
    const info = await el.evaluate((e) => {
      const c = getComputedStyle(e).color.match(/[\d.]+/g)!.map(Number);
      const range = document.createRange();
      range.selectNodeContents(e);
      const b = range.getBoundingClientRect();
      e.style.setProperty('color', 'transparent', 'important');
      e.style.setProperty('text-decoration', 'none', 'important');
      e.style.transition = 'none';
      return { ink: c, box: { x: Math.max(0, b.left + 1), y: Math.max(0, b.top + 1), width: Math.max(1, b.width - 2), height: Math.max(1, b.height - 2) }, text: e.textContent!.trim().slice(0, 30) };
    });
    const shot = await page.screenshot({ clip: info.box });
    const back = await page.evaluate(async (b64) => {
      const im = new Image();
      im.src = `data:image/png;base64,${b64}`;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let best = [0, 0, 0], bl = -1;
      for (let k = 0; k < d.length; k += 4) { const l = d[k]! * 0.2126 + d[k + 1]! * 0.7152 + d[k + 2]! * 0.0722; if (l > bl) { bl = l; best = [d[k]!, d[k + 1]!, d[k + 2]!]; } }
      return best;
    }, shot.toString('base64'));
    await el.evaluate((e) => { e.style.removeProperty('color'); e.style.removeProperty('text-decoration'); });
    const a = info.ink[3] ?? 1;
    const ink = [0, 1, 2].map((k) => info.ink[k]! * a + back[k]! * (1 - a));
    expect(ratio(ink, back), `"${info.text}" (${info.ink.join(',')}) on ${back.join(',')}`).toBeGreaterThanOrEqual(4.5);
  }
}
/** a popover's scale (matrix a) and opacity in one frame */
type Sample = { s: number; o: number };

async function hoverCard(page: Page): Promise<Locator> {
  await page.goto('/');
  const card = row(page, BECAUSE).locator('article.card').nth(1);
  await card.scrollIntoViewIfNeeded();
  await card.locator('a.thumb').hover();
  const dpv = page.locator('.dpv.ready');
  await expect(dpv).toBeVisible();
  await settled(dpv);
  return dpv;
}

/** the menu is a glass card that grows out of its trigger: the spring's 380 ms and a transform-origin inside the trigger's extent */
async function expectGrows(menu: Locator, trigger: Locator) {
  const a = await anim(menu);
  expect(a.duration).toBe(380);
  await expect(menu).toHaveClass(/\bfrost-menu\b/);
  expect(await css(menu, 'border-top-left-radius')).toBe('20px');
  expect(await css(menu, 'backdrop-filter')).toContain('blur(38px)');
  await settled(menu);
  const box = (await menu.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left }; }));
  const t = (await trigger.boundingBox())!;
  const ox = box.left + parseFloat(a.origin.split(' ')[0]!);
  expect(ox).toBeGreaterThanOrEqual(t.x - 0.5);
  expect(ox).toBeLessThanOrEqual(t.x + t.width + 0.5);
}

test.describe('glass menus', () => {
  test.beforeEach(({ page }) => fullMotion(page));

  test('profile, bell, categories and ⋯ menus are glass cards that grow from their button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    const bar = page.locator('[data-desk-bar]');

    const acct = bar.getByRole('button', { name: /Profilmenü/ });
    await acct.click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    await expectGrows(menu, acct);
    await expect(menu.getByRole('menuitem').first()).toBeFocused(); // the focus moves into the menu
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(acct).toBeFocused(); // and back to its button

    const bell = bar.getByRole('button', { name: /Benachrichtigungen/ });
    await bell.click();
    const notes = bar.locator('.drop.wide');
    await expectGrows(notes, bell);
    await page.keyboard.press('Escape');
    await expect(notes).toHaveCount(0);
    await expect(bell).toBeFocused();

    const catBtn = bar.locator('.pill').getByRole('button', { name: 'Kategorien' });
    await catBtn.click();
    const cats = page.getByRole('region', { name: 'Kategorien' });
    await expectGrows(cats, catBtn);
    await page.mouse.click(1200, 700); // a click outside closes it
    await expect(cats).toHaveCount(0);

    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    const pop = page.locator('.ma-pop');
    await expectGrows(pop, more);
    await expect(pop).toHaveClass(/\bfrost-safe\b/); // artwork can sit behind it
  });

  test('closing reverses (200 ms) and leaves nothing behind', async ({ page }) => {
    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    const pop = page.locator('.ma-pop');
    await settled(pop);
    const r = (await pop.boundingBox())!;
    await page.keyboard.press('Escape');
    expect(await pop.count()).toBe(1); // still there: it folds back
    expect((await anim(pop)).duration).toBe(200);
    await expect(more).toBeFocused();
    await page.waitForTimeout(400);
    await expect(pop).toHaveCount(0);
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.ma-pop'), [r.x + r.width / 2, r.y + r.height / 2])).toBe(false);
  });

  test('toggle fast: open, close mid-open, open again — ends open with one popover', async ({ page }) => {
    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    await more.click();
    await more.click();
    const pop = page.locator('.ma-pop');
    await expect(pop).toHaveCount(1);
    await settled(pop);
    await expect(pop).toHaveCount(1);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(await css(pop, 'opacity')).toBe('1');
    expect(await css(pop, 'transform')).toBe('none');
  });

  test('mid-flight: a close during the open shrinks from where it is; a reopen during the close grows from there', async ({ page }) => {
    await hoverCard(page);
    const run = (closeFirst: boolean) => page.evaluate(async (closeFirst) => {
      const btn = document.querySelector<HTMLButtonElement>('.dpv button.ma')!;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const at = (): { s: number; o: number } | null => {
        const p = document.querySelector<HTMLElement>('.ma-pop');
        if (!p) return null;
        const cs = getComputedStyle(p);
        return { s: cs.transform === 'none' ? 1 : new DOMMatrixReadOnly(cs.transform).a, o: Number(cs.opacity) };
      };
      const esc = () => document.querySelector('.ma-pop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const out: Array<{ s: number; o: number }> = [];
      const until = async (ok: (v: { s: number; o: number } | null) => boolean, ms = 2000) => {
        const t0 = performance.now();
        for (;;) { await frame(); const v = at(); if (v) out.push(v); if (ok(v) || performance.now() - t0 > ms) return v; }
      };
      // condition-driven (a loaded host has long frames): act once the popover is mid-flight. A frame stall can let the running
      // half finish before the other one starts (then it rightly starts from the end, which looks like a restart): such a try is
      // retried. A real restart looks like that every time, so it still fails.
      const settledOpen = () => until(() => !document.querySelector('.ma-pop')?.getAnimations().length && at()?.s === 1);
      for (let tries = 0; tries < 5; tries++) {
        out.length = 0;
        if (closeFirst) {
          if (!at()) btn.click(); // open, then wait until it is fully open
          await settledOpen();
          out.length = 0;
          esc();
          const v = await until((x) => !!x && x.s < 0.97); // folding back
          const mark = out.length;
          if (!v || v.s < 0.75) { await until((x) => !x); continue; } // overshot: gone too far, try again
          btn.click(); // reopen mid-close
          const first = await until(() => true);
          if (first && first.s < v.s - 0.2) { await settledOpen(); continue; } // stalled
          await settledOpen();
          return { out, mark };
        }
        btn.click();
        const v = await until((x) => !!x && x.s > 0.45); // growing
        const mark = out.length;
        if (!v || v.s > 0.9) { esc(); await until((x) => !x); continue; } // overshot: nearly open already, try again
        esc(); // close mid-open
        const first = await until(() => true);
        if (first && first.s === 1 && first.o === 1) { await until((x) => !x); continue; } // stalled
        await until((x) => !x);
        return { out, mark };
      }
      return { out, mark: -1 };
    }, closeFirst);
    const dump = (r: { out: Sample[]; mark: number }) => JSON.stringify(r.out.map((x) => [+x.s.toFixed(3), +x.o.toFixed(2)]));
    // close mid-open: caught mid-way, it turns back within a frame or two and only shrinks and fades from there (a restart
    // would first jump to full size)
    const a = await run(false);
    expect(a.mark, dump(a)).toBeGreaterThan(0);
    const after = a.out.slice(a.mark);
    expect(after.length, dump(a)).toBeGreaterThan(1);
    expect(a.out[a.mark - 1]!.s, dump(a)).toBeGreaterThan(0.4);
    expect(after.some((x) => x.s === 1 && x.o === 1), dump(a)).toBe(false); // never the full-size start of a restarted close
    const peak = after.findIndex((x) => x.s === Math.max(...after.map((y) => y.s)));
    expect(peak, dump(a)).toBeLessThanOrEqual(3); // the turn comes within a frame or two
    for (let k = peak + 1; k < after.length; k++) expect(after[k]!.s, dump(a)).toBeLessThanOrEqual(after[k - 1]!.s + 0.001);
    await expect(page.locator('.ma-pop')).toHaveCount(0);
    // reopen mid-close: it grows back from where the fold-back was (a restart would drop to .4 and opacity 0 first)
    const b = await run(true);
    expect(b.mark, dump(b)).toBeGreaterThan(0);
    const again = b.out.slice(b.mark);
    expect(again.length, dump(b)).toBeGreaterThan(1);
    expect(b.out[b.mark - 1]!.s, dump(b)).toBeLessThan(0.999); // it was folding back
    expect(again.some((x) => x.s === 0.4 && x.o === 0), dump(b)).toBe(false); // never the start of a restarted open
    expect(Math.min(...again.map((x) => x.s)), dump(b)).toBeGreaterThan(0.45);
    await expect(page.locator('.ma-pop')).toHaveCount(1);
    await settled(page.locator('.ma-pop'));
  });

  test('menu text passes AA over a pure white backdrop (rows, notes, the light pill, a danger row)', async ({ page, api }) => {
    await page.goto('/');
    await whiteBehind(page);
    const bar = page.locator('[data-desk-bar]');
    await bar.getByRole('button', { name: /Profilmenü/ }).click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    await settled(menu);
    await page.waitForTimeout(100);
    await page.mouse.move(2, 790);
    await textPasses(page, menu);
    await menu.getByRole('menuitem', { name: 'Konto & Einstellungen' }).hover(); // white on the light pill
    await textPasses(page, menu.getByRole('menuitem', { name: 'Konto & Einstellungen' }));
    await page.keyboard.press('Escape');
    await bar.getByRole('button', { name: /Benachrichtigungen/ }).click();
    const notes = bar.locator('.drop.wide');
    await settled(notes);
    await page.mouse.move(2, 790);
    await textPasses(page, notes);
    await page.keyboard.press('Escape');
    await bar.locator('.pill').getByRole('button', { name: 'Kategorien' }).click();
    const cats = page.getByRole('region', { name: 'Kategorien' });
    await expect(cats.getByRole('link', { name: 'Drama' })).toBeVisible();
    await settled(cats);
    await textPasses(page, cats);

    // a ⋯ menu with destructive rows (a user's device: "Abmelden", "Entfernen"): white text, the red only on their icons
    api.asAdmin = true;
    await page.goto(`/admin/users/${auid(2)}?tab=devices`);
    await whiteBehind(page);
    await page.getByRole('tabpanel', { name: 'Geräte' }).getByRole('button', { name: 'Aktionen für Chrome auf Windows' }).click();
    const pop = page.locator('.ma-pop');
    await expect(pop.locator('.mi.danger')).toHaveCount(2);
    await settled(pop);
    await page.mouse.move(2, 790);
    await textPasses(page, pop);
  });

  test('toast text passes AA over a pure white backdrop', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    await whiteBehind(page);
    await page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ }).getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    const toast = page.locator('.toast.frost');
    await settled(toast);
    await textPasses(page, toast);
  });

  test('selected row is a light pill', async ({ page }) => {
    const dpv = await hoverCard(page);
    const more = dpv.locator('button.ma');
    await more.click();
    const pop = page.locator('.ma-pop');
    const fav = pop.getByRole('button', { name: 'Als Favorit markieren' });
    await expect(fav).toBeFocused(); // the focus moved into the menu (its first row)
    await page.keyboard.press('Enter'); // a toggle: now pressed (the pointer stays on the card)
    await expect(pop).toHaveCount(0);
    await more.click();
    const on = pop.locator('.mi[aria-pressed="true"]');
    await expect(on).toHaveCount(1);
    await settled(pop);
    await page.mouse.move(2, 400); // not hovering it
    expect(await css(on, 'background-color')).toBe('rgba(255, 255, 255, 0.13)');
    expect(await css(on, 'border-top-left-radius')).toBe('12px');
    expect((await on.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test('toast: a glass pill bottom centre with a status dot, Undo and a 5 s ring that pauses on hover', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    const row = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
    await row.getByRole('button', { name: /Aktionen/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    const toast = page.locator('.toast.frost');
    await expect(toast).toBeVisible();
    await expect(toast).toHaveClass(/\bfrost-pill\b/);
    await settled(toast);
    const b = (await toast.boundingBox())!;
    expect(Math.abs(b.x + b.width / 2 - 640)).toBeLessThanOrEqual(2);
    expect(800 - (b.y + b.height)).toBeGreaterThanOrEqual(34); // 36 px from the bottom
    await expect(toast.locator('.dot.success')).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Rückgängig' })).toBeVisible();
    const fg = toast.locator('.ring .fg');
    const ring = await anim(fg);
    expect(Math.abs(ring.duration - 5000)).toBeLessThanOrEqual(100); // the time left when it started (≈ 5 s)
    await toast.locator('.msg').hover();
    await expect.poll(() => fg.evaluate((e) => e.getAnimations()[0]?.playState)).toBe('paused');
    await page.mouse.move(640, 300);
    await expect.poll(() => fg.evaluate((e) => e.getAnimations()[0]?.playState)).toBe('running');
  });

  test('toast rises in and slides out; calm is instant', async ({ page, api }) => {
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    const ignore = async () => {
      const r = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
      await r.getByRole('button', { name: /Aktionen/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    };
    await ignore();
    const toast = page.locator('.toast.frost');
    expect((await anim(toast)).duration).toBe(420);
    await settled(toast);
    await toast.getByRole('button', { name: 'Hinweis schließen' }).click();
    expect(await toast.count()).toBe(1); // it slides out
    expect((await anim(toast)).duration).toBe(260);
    await expect(toast).toHaveCount(0);
  });

  test('calm mode: menus and toasts appear and go at once, solid', async ({ page, api }) => {
    await calmMode(page);
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    await expect(page.locator('html')).toHaveClass(/m-still/);
    const r = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
    await r.getByRole('button', { name: /Aktionen/ }).click();
    const pop = page.locator('.ma-pop');
    await expect(pop).toBeVisible();
    expect(await pop.evaluate((e) => e.getAnimations().length)).toBe(0);
    expect(await css(pop, 'backdrop-filter')).toBe('none');
    expect(await css(pop, 'background-color')).toBe('rgb(28, 26, 33)');
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    const toast = page.locator('.toast.frost');
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((e) => e.getAnimations().length)).toBe(0);
    expect(await toast.locator('.ring .fg').evaluate((e) => e.getAnimations().length)).toBe(0); // the ring shows full
    await toast.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect(toast).toHaveCount(0, { timeout: 150 });
  });

  test('reduced motion (the OS setting): menus and toasts appear and go at once', async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    api.asAdmin = true;
    await page.goto('/admin/hygiene');
    await expect(page.locator('html')).toHaveClass(/m-still/);
    const r = page.getByRole('table', { name: 'Bibliothekspflege' }).getByRole('row', { name: /Old Reel/ });
    await r.getByRole('button', { name: /Aktionen/ }).click();
    const pop = page.locator('.ma-pop');
    await expect(pop).toBeVisible();
    expect(await pop.evaluate((e) => e.getAnimations().length)).toBe(0);
    await page.getByRole('dialog').getByRole('button', { name: '„Seltenes Videoformat“ ignorieren' }).click();
    await expect(pop).toHaveCount(0, { timeout: 150 });
    const toast = page.locator('.toast.frost');
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((e) => e.getAnimations().length)).toBe(0);
    await toast.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect(toast).toHaveCount(0, { timeout: 150 });
  });

  test('a tripped frame guard: menus and toasts crossfade (160 ms, opacity only)', async ({ page, api }) => {
    await page.addInitScript(() => { (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1, frames: 1 }; }); // every frame is slow
    api.asAdmin = true;
    await page.goto('/');
    // start motion: a row card under the pointer, then the row glides a page (as glass.spec.ts)
    const rw = row(page, /Weil du/);
    await rw.scrollIntoViewIfNeeded();
    await rw.locator('article.card').first().hover();
    await rw.getByRole('heading', { name: /Weil du/ }).hover();
    await rw.locator('button.pg.next').click();
    await expect(page.locator('html')).toHaveClass(/tv-motion-reduced/);
    const opacityOnly = (loc: Locator) => loc.evaluate((e) => e.getAnimations().every((a) => (a.effect as KeyframeEffect).getKeyframes().every((k) => !('transform' in k))));
    const acct = page.locator('[data-desk-bar]').getByRole('button', { name: /Profilmenü/ });
    await acct.click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    expect((await anim(menu)).duration).toBe(160);
    expect(await opacityOnly(menu)).toBe(true);
    await settled(menu);
    await page.keyboard.press('Escape');
    expect((await anim(menu)).duration).toBe(160);
    await expect(menu).toHaveCount(0);
    // a toast on the next page (client-side navigation: the guard stays tripped)
    await acct.click();
    await menu.getByRole('menuitem', { name: /Admin/ }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('html')).toHaveClass(/tv-motion-reduced/);
    await page.getByRole('region', { name: 'Wartet auf dich' }).getByRole('button', { name: '„Dunmoor: Part Two“ freigeben' }).click();
    const toast = page.locator('.toast.frost');
    expect((await anim(toast)).duration).toBe(160);
    expect(await opacityOnly(toast)).toBe(true);
  });

  test('TV and kids: menus solid', async ({ page }) => {
    // TV: a card's actions (OK held) are a solid glass-shaped dialog that appears at once
    await page.goto('/?tv=1');
    const thumb = page.locator('.card .thumb').first();
    await expect(thumb).toBeVisible();
    await thumb.focus();
    await page.keyboard.down('Enter'); await page.waitForTimeout(800); await page.keyboard.up('Enter');
    const sheet = page.locator('.sheet.tvsheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveClass(/\bfrost\b/);
    expect(await css(sheet, 'backdrop-filter')).toBe('none');
    expect(await css(sheet, 'background-color')).toBe('rgb(28, 26, 33)');
    expect(await sheet.evaluate((e) => e.getAnimations().length)).toBe(0);

    // kids: no kids flow shows a menu or a toast (the kids UI has neither), so a shared menu surface injected on /kids checks
    // that it keeps the solid fallback with the new shape
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, profileCount: 3, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } } }));
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await page.goto('/kids');
    await expect(page.locator('html')).toHaveClass(/(^|\s)kids(\s|$)/);
    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'km'; d.className = 'frost frost-menu frost-safe'; d.style.cssText = 'position:fixed;left:10px;top:100px;width:200px;height:100px'; document.body.appendChild(d); });
    const km = page.locator('#km');
    expect(await css(km, 'backdrop-filter')).toBe('none');
    expect(await css(km, 'border-top-left-radius')).toBe('20px');
  });
});
