// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ME } from '../mocks/fixtures.js';
import { expect, test } from '../fixtures.js';
import { meanOf, pixelCols, redPixels, worstStep } from '../helpers.js';

/** Desktop top bar (spec desktop browse §1): logo, a floating pill with the tabs, search that stretches open, bell, avatar. */
test.describe('desktop pill bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: false } }));
  });

  test('pill tabs: Home active, clicking Series moves aria-current and the fill', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    await expect(bar).toBeVisible();
    const active = bar.locator('.pill [aria-current="page"]');
    await expect(active).toHaveText('Start');
    const fill = bar.locator('.pill .fill');
    await expect(fill).toHaveCount(1);
    await expect.poll(() => fill.evaluate((e) => getComputedStyle(e).opacity)).toBe('0.13'); // a light fill (group opacity)
    const before = await fill.evaluate((e) => e.style.transform);
    await bar.locator('.pill').getByRole('link', { name: 'Serien' }).click();
    await expect(page).toHaveURL(/\/browse\/series$/);
    await expect(active).toHaveText('Serien');
    await expect.poll(() => fill.evaluate((e) => e.style.transform)).not.toBe(before);
    // the fill sits under the active tab
    const box = async (sel: string) => (await bar.locator(sel).boundingBox())!;
    await expect.poll(async () => Math.round((await box('.pill .fill')).x - (await box('.pill [aria-current="page"]')).x)).toBe(0);
    // and its width follows the tab (transform only: caps + a scaled middle)
    const fillW = () => bar.locator('.pill .fill').evaluate((e) => { const l = e.getBoundingClientRect().left; return Math.max(...[...e.children].map((c) => c.getBoundingClientRect().right)) - l; });
    await expect.poll(async () => Math.abs(Math.round((await fillW()) - (await box('.pill [aria-current="page"]')).width))).toBeLessThanOrEqual(1);
  });

  test.describe('with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test.beforeEach(({ page }) => page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'))); // no brand intro over the page (frozen clocks keep it there)
    test('the fill slides and its width glides (springs running right after the click)', async ({ page }) => {
      await page.goto('/watchlist');
      const bar = page.locator('[data-desk-bar]');
      await expect(bar.locator('.pill [aria-current="page"]')).toHaveText('Merkliste');
      await expect.poll(() => bar.locator('.pill .fill').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.13');
      // a per-frame watcher started before the click (the spring lasts ~350 ms: a poll's growing intervals can miss it)
      // (installed and running in the page before the click is sent; awaited after it)
      await bar.locator('.pill .fill').evaluate((e) => {
        (window as unknown as { __sawSpring: Promise<boolean> }).__sawSpring = new Promise<boolean>((res) => {
          const t0 = performance.now();
          const f = () => (e.getAnimations({ subtree: true }).length ? res(true) : performance.now() - t0 > 4000 ? res(false) : requestAnimationFrame(f));
          f();
        });
      });
      await bar.locator('.pill').getByRole('link', { name: 'Serien' }).click();
      expect(await page.evaluate(() => (window as unknown as { __sawSpring: Promise<boolean> }).__sawSpring)).toBe(true);
    });

    // regression (v3.0.1): each glass half of the pill blurred its own backdrop, and the later one's box (it reaches far over the
    // other half, for the slide) took the other half's milk into its blur: a light band from the pill's middle to the right
    test('scrolled: the shade holds the whole pill; the glass pill is even across its middle and has no light at rest', async ({ page }) => {
      await page.addInitScript(() => { (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 }; });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/browse/movies');
      await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
      const bar = page.locator('[data-desk-bar]');
      const pill = bar.locator('.pill');
      await expect(pill).toBeVisible();
      await page.mouse.move(720, 700); // the pointer away from the bar
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect(bar).toHaveClass(/solid/);
      await expect.poll(() => bar.locator('.scrim').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      // every painted bar-wide layer holds the pill's whole box (no band that ends across or above the pill)
      const bands = await bar.evaluate((b) => {
        const p = b.querySelector('.pill')!.getBoundingClientRect();
        return [b, ...b.querySelectorAll<HTMLElement>('*')].filter((e) => {
          const cs = getComputedStyle(e), r = e.getBoundingClientRect();
          return r.width >= innerWidth * .9 && Number(cs.opacity) > 0 && (cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)');
        }).map((e) => { const r = e.getBoundingClientRect(); return { cls: String(e.className), holds: r.top <= p.top && r.bottom >= p.bottom && r.left <= p.left && r.right >= p.right }; });
      });
      expect(bands.length).toBeGreaterThan(0);
      for (const band of bands) expect(band, band.cls).toMatchObject({ holds: true });
      const pb = (await pill.boundingBox())!;
      // the shade's opaque part reaches below the pill (the page colour on both sides of it, top to bottom)
      for (const x of [pb.x - 40, pb.x + pb.width + 12]) {
        const col = (await redPixels(page, x, 0, 1, Math.ceil(pb.y + pb.height + 2))).map((r) => r[0]!);
        expect(Math.max(...col.map((v) => Math.abs(v - 16))), `column ${x}`).toBeLessThan(3); // --bg #101418
      }
      // at rest, with the pointer elsewhere, the sheen is out
      await expect.poll(() => pill.locator('.frost-sheen').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
      // the glass is even across the split of its two halves (a strip above the labels, averaged over 4 rows)
      const mid = pb.x + pb.width / 2;
      const strip = await pixelCols(page, mid - 24, pb.y + 4, 48, 4);
      expect(Math.abs(meanOf(strip, 0, 20) - meanOf(strip, 28, 48))).toBeLessThan(4);
    });

    // regression (v3.0.2): the pill's blur was two blurring halves whose boxes overlap (each reaches far over the other, for
    // the slide): the later one blurs the earlier one's output again, a step at the middle that a busy picture shows plainly
    // (a flat backdrop hides it). And the sheen's blend mode reached out to the whole bar, so Chrome dropped the blur under
    // the sheen's box (a band without blur where the pointer last was), here: everywhere. So: a sharp, bright, busy picture
    // under the bar (as the billboard); its shade hidden (on the pages without a billboard it would cover the picture)
    test('one blur under the pill: no step along the glass or across the active tab\'s light over a busy picture, at rest and mid-morph', async ({ page }) => {
      await page.addInitScript(() => { (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 }; });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
      await page.addStyleTag({ content: '#busy { position: fixed; inset: 0; z-index: 49; pointer-events: none; background: repeating-linear-gradient(90deg, #f2e600 0 22px, #2fae3a 22px 44px, #fffbe0 44px 52px, #0b3d12 52px 60px); } [data-desk-bar] > .scrim { display: none; }' });
      await page.evaluate(() => { const d = document.createElement('div'); d.id = 'busy'; document.body.append(d); });
      const bar = page.locator('[data-desk-bar]');
      const pill = bar.locator('.pill');
      /** the glass's ends on screen (each half's outer end, wherever they are mid-flight) and how many blurs cover each point */
      const shape = () => pill.evaluate((p) => {
        const l = p.querySelector('.pbg .l > i.frost')!.getBoundingClientRect(), r = p.querySelector('.pbg .r > i.frost')!.getBoundingClientRect();
        const blurs = [...document.querySelectorAll('*')].flatMap((e) => [null, '::before', '::after'].map((ps) => ({ e, ps })))
          .filter(({ e, ps }) => { const v = getComputedStyle(e, ps).backdropFilter; return !!v && v !== 'none'; }).map(({ e }) => e.getBoundingClientRect());
        let most = 0, least = Infinity;
        for (let x = l.left + 1; x < r.right - 1; x += 4) for (const y of [l.top + 2, l.top + l.height / 2, l.bottom - 2]) {
          const n = blurs.filter((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom).length;
          most = Math.max(most, n); least = Math.min(least, n);
        }
        return { left: l.left, right: r.right, top: l.top, height: l.height, most, least };
      });
      /** the glass along a row in its bottom padding (under the labels and the tab light; the round ends left out) */
      const glassStep = async () => {
        const s = await shape();
        expect({ most: s.most, least: s.least }, 'blurs over each point of the pill').toEqual({ most: 1, least: 1 });
        return worstStep(await pixelCols(page, s.left + 20, s.top + s.height - 5, s.right - s.left - 40, 3), 8);
      };
      for (const name of ['Start', 'Serien', 'Filme', 'Neu & demnächst', 'Merkliste']) {
        if (name !== 'Start') await pill.getByRole('link', { name }).click();
        await expect(pill.locator('[aria-current="page"]')).toHaveText(name);
        await page.mouse.move(720, 800); // the pointer away from the bar
        await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
        await expect.poll(() => pill.locator('.fill').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.13');
        expect((await glassStep()).step, `glass, ${name} active`).toBeLessThan(4);
        // across the active tab's light, below its label (its round ends left out)
        const f = await pill.locator('.fill').evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: Math.max(...[...e.children].map((c) => c.getBoundingClientRect().right)) - b.left }; });
        expect(worstStep(await pixelCols(page, f.x + 9, f.y + 28, f.w - 18, 3), 8).step, `tab light, ${name} active`).toBeLessThan(4);
      }
      // mid-morph: the field opens (both ends spring out) and closes; every animation held at a few moments of the spring
      // (the pointer is on the magnifier, so the sheen is out of the way: its soft light is a slope, not a seam; the sheen's
      // effect on the blur was checked above, at rest)
      await page.addStyleTag({ content: '[data-desk-bar] .pill > .sclip { display: none; }' });
      /** once the pill's glass has started to slide: every animation held `t` ms in */
      const holdAt = (t: number) => page.evaluate(async (t) => {
        const half = document.querySelector('[data-desk-bar] .pbg .l > i.frost')!;
        await new Promise<void>((res) => { const f = () => (half.getAnimations().length ? res() : requestAnimationFrame(f)); f(); });
        for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
      }, t);
      for (const t of [32, 96, 180]) {
        await pill.locator('.mag').click();
        await holdAt(t);
        expect((await glassStep()).step, `glass opening, ${t} ms`).toBeLessThan(4);
        await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // the focus leaves the field: it closes
        await holdAt(t);
        expect((await glassStep()).step, `glass closing, ${t} ms`).toBeLessThan(4);
        await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); });
        await page.mouse.move(720, 800);
      }
    });
  });

  test('bar is transparent over the billboard and solid after scrolling 40px; no full-width band', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).not.toHaveClass(/solid/);
    const scrim = bar.locator('.scrim');
    await expect.poll(() => scrim.evaluate((e) => getComputedStyle(e).opacity)).toBe('0'); // nothing over the billboard
    expect(await bar.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await bar.evaluate((e) => getComputedStyle(e).backgroundImage)).toBe('none');
    await page.evaluate(() => window.scrollTo(0, 40));
    await expect(bar).toHaveClass(/solid/);
    expect(await bar.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)'); // the pill turns opaque, not the bar
    await expect.poll(() => scrim.evaluate((e) => getComputedStyle(e).opacity)).toBe('1'); // a soft shade behind logo and buttons
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).not.toHaveClass(/solid/);
    // a page without a billboard: solid right away
    await page.goto('/watchlist');
    await expect(bar).toHaveClass(/solid/);
  });

  test('search lives in the pill: the magnifier is its last item; click and "/" open the field inside it and the pill grows; Esc clears, then closes', async ({ page }) => {
    await page.goto('/watchlist');
    const bar = page.locator('[data-desk-bar]');
    const pill = bar.locator('.pill');
    const mag = pill.locator('button.mag');
    const input = bar.locator('#hq');
    await expect(mag).toHaveAccessibleName('Suche öffnen');
    // no separate search button beside the pill any more: bell and avatar only
    await expect(bar.locator('.right').getByRole('button', { name: /Such/ })).toHaveCount(0);
    // the last control in the pill
    const lastRight = await pill.evaluate((p) => Math.max(...[...p.querySelectorAll('a, button')].filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect().right)));
    expect(Math.round(lastRight)).toBe(Math.round((await mag.boundingBox())!.x + (await mag.boundingBox())!.width));
    const w0 = (await pill.boundingBox())!.width;
    await mag.click();
    await expect(input).toBeFocused();
    await expect(pill.locator('#hq')).toHaveCount(1); // the field is inside the pill
    await expect.poll(async () => (await pill.boundingBox())!.width).toBeGreaterThan(w0 + 150);
    await expect.poll(async () => Math.round((await input.boundingBox())?.width ?? 0)).toBeGreaterThan(150);
    // the field sits at the pill's right end, inside it
    const pb = (await pill.boundingBox())!, ib = (await input.boundingBox())!;
    expect(ib.x + ib.width).toBeLessThanOrEqual(pb.x + pb.width);
    expect(ib.x).toBeGreaterThan(pb.x + pb.width / 2);
    // Esc on an empty field closes it: the pill shrinks back, focus on the magnifier
    await input.press('Escape');
    await expect(pill).not.toHaveClass(/open/);
    await expect(mag).toBeFocused();
    await expect.poll(async () => Math.round((await pill.boundingBox())!.width)).toBe(Math.round(w0));
    // clicking outside closes it too (off /search the open field shows the search sheet over a dimmed page: the click lands on the dim)
    await mag.click();
    await expect(input).toBeFocused();
    await expect(page.locator('#ds-sheet')).toBeVisible();
    await page.mouse.click(5, 300);
    await expect(pill).not.toHaveClass(/open/);
    await expect(page.locator('#ds-sheet')).toHaveCount(0);

    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await expect(pill).toHaveClass(/open/);
    await page.keyboard.type('nolan', { delay: 30 });
    await expect(page).toHaveURL(/\/watchlist$/); // typing opens the sheet, Enter goes to /search
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=nolan$/);
    await expect(input).toHaveValue('nolan');
    await input.press('Escape');
    await expect(input).toHaveValue('');
    await expect(page).toHaveURL(/\/search$/);
    await input.press('Escape');
    await expect(mag).toBeFocused();
    await page.keyboard.press('Control+K');
    await expect(input).toBeFocused();
    // the close button shrinks it back as well (on /search the field stays open, the focus goes to the magnifier)
    await pill.getByRole('button', { name: 'Suche schließen' }).click();
    await expect(mag).toBeFocused();
  });

  test('off /search: a click elsewhere in the typing pause closes the field and drops the search; the window losing focus keeps it', async ({ page }) => {
    await page.goto('/watchlist');
    const bar = page.locator('[data-desk-bar]');
    const pill = bar.locator('.pill');
    const input = bar.locator('#hq');
    // the shell renders once /api/me answered: a "/" pressed before that has no bar to open (wait for the placed tab fill)
    await expect(pill).toHaveClass(/\bon\b/);
    // typed, and the focus leaves for the page before the 220 ms pause ends (one task: deterministic)
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await input.evaluate((el: HTMLInputElement) => { el.value = 'nol'; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); });
    await expect(pill).not.toHaveClass(/open/);
    await expect(input).toHaveValue('');
    await expect(page.locator('#ds-sheet')).toHaveCount(0);
    await page.waitForTimeout(400); // the dropped search never navigates nor reopens the sheet
    await expect(page).toHaveURL(/\/watchlist$/);
    await expect(page.locator('#ds-sheet')).toHaveCount(0);

    // the window loses the focus (alt-tab): the field and its text stay
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await input.evaluate((el: HTMLInputElement) => {
      el.value = 'nol'; el.dispatchEvent(new Event('input', { bubbles: true }));
      document.hasFocus = () => false; // what a real window blur reports
      el.blur();
    });
    await page.waitForTimeout(50);
    await expect(pill).toHaveClass(/open/);
    await expect(input).toHaveValue('nol');
    await expect(page.locator('#ds-sheet')).toBeVisible();
  });

  for (const width of [1024, 1280, 1440]) {
    test(`${width}px: the pill never overlaps the logo or the bell, closed or open`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/watchlist');
      const bar = page.locator('[data-desk-bar]');
      const check = async (state: string) => {
        const logo = (await bar.locator('a.logo').boundingBox())!, pill = (await bar.locator('.pill').boundingBox())!, right = (await bar.locator('.right').boundingBox())!;
        expect(pill.x, `${state}: pill clear of the logo`).toBeGreaterThanOrEqual(logo.x + logo.width);
        expect(pill.x + pill.width, `${state}: pill clear of the bell`).toBeLessThanOrEqual(right.x);
        expect(right.x + right.width, `${state}: buttons on screen`).toBeLessThanOrEqual(width);
      };
      await check('closed');
      await page.keyboard.press('/');
      await expect(bar.locator('#hq')).toBeFocused();
      await check('open');
      await page.keyboard.type('nolan', { delay: 20 });
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/q=nolan$/);
      await check('typing');
      await page.locator('main').click({ position: { x: 5, y: 400 } });
      await check('on /search, unfocused');
    });
  }

  test('800px (a half-screen window): only the tab links go; the pill keeps the magnifier ("/" opens the field in it) and Categories', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    const pill = bar.locator('.pill');
    await expect(pill).toBeVisible();
    await expect(pill.getByRole('link', { name: 'Serien' })).toBeHidden();
    const mag = pill.locator('button.mag');
    await expect(mag).toBeVisible();
    const input = bar.locator('#hq');
    await page.keyboard.press('/');
    await expect(input).toBeFocused();
    await expect(input).toBeVisible();
    await expect(pill).toHaveClass(/open/);
    // clear of the logo and the round buttons with the field open
    const logo = (await bar.locator('a.logo').boundingBox())!, box = (await pill.boundingBox())!, right = (await bar.locator('.right').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(logo.x + logo.width);
    expect(box.x + box.width).toBeLessThanOrEqual(right.x);
    await page.keyboard.press('Escape');
    await expect(pill).not.toHaveClass(/open/);
    await pill.getByRole('button', { name: 'Kategorien' }).click();
    await expect(page.getByRole('region', { name: 'Kategorien' }).getByRole('link', { name: 'Drama' })).toBeVisible();
  });

  test('narrow window (1024px) on /search: tabs are usable while the field is unfocused; focusing it makes room by collapsing them', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/search?q=nolan');
    const bar = page.locator('[data-desk-bar]');
    const pill = bar.locator('.pill');
    const input = bar.locator('#hq');
    await expect(input).toHaveValue('nolan');
    await expect(pill).toHaveClass(/open/);
    const series = pill.getByRole('link', { name: 'Serien' });
    await expect(series).toBeVisible();
    // focused (the magnifier: the narrowed field is magnifier-only here): the field gets room, the tabs fade out of the way
    await pill.locator('button.mag').click();
    await expect(input).toBeFocused();
    await expect(series).toBeHidden();
    await expect.poll(async () => Math.round((await input.boundingBox())!.width)).toBeGreaterThan(200);
    // leaving it brings the tabs back and they work
    await page.locator('main').click({ position: { x: 5, y: 400 } });
    await expect(series).toBeVisible();
    await expect(input).toHaveValue('nolan');
    await series.click();
    await expect(page).toHaveURL(/\/browse\/series$/);
  });

  test.describe('search with motion', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('the pill background springs open (transform only, text never scaled) and a close mid-flight reverses without a jump', async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1')); // no brand intro over the page
      await page.goto('/watchlist');
      const bar = page.locator('[data-desk-bar]');
      const pill = bar.locator('.pill');
      await expect(bar.locator('.pill [aria-current="page"]')).toHaveText('Merkliste');
      await page.waitForTimeout(400); // the first fill placement settles
      // open, then sample the same frame: the background layer animates a transform, nothing with text scales
      const mid = await page.evaluate(() => {
        const p = document.querySelector<HTMLElement>('[data-desk-bar] .pill')!;
        p.querySelector<HTMLButtonElement>('button.mag')!.click();
        const bg = p.querySelector<HTMLElement>('.pbg')!;
        const anims = bg.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
        const props = anims.flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k).filter((n) => !['offset', 'easing', 'composite', 'computedOffset'].includes(n))));
        const scaled = [...p.querySelectorAll<HTMLElement>('a, button, input')].filter((e) => { const m = new DOMMatrix(getComputedStyle(e).transform === 'none' ? '' : getComputedStyle(e).transform); return Math.abs(m.a - 1) > 1e-3; }).length;
        return { n: anims.length, props: [...new Set(props)], scaled };
      });
      expect(mid.n).toBeGreaterThan(0);
      expect(mid.props).toEqual(['transform']);
      expect(mid.scaled).toBe(0);
      // close 100 ms in: the background's right edge carries on from where it is (no jump), then settles at the closed pill
      await page.waitForTimeout(100);
      const jump = await page.evaluate(() => {
        const p = document.querySelector<HTMLElement>('[data-desk-bar] .pill')!;
        const edge = () => p.querySelector<HTMLElement>('.pbg .r > i.frost')!.getBoundingClientRect().right;
        const before = edge();
        p.querySelector<HTMLInputElement>('#hq')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return Math.abs(edge() - before);
      });
      expect(jump).toBeLessThan(2);
      await expect(pill).not.toHaveClass(/open/);
      await expect.poll(() => pill.evaluate((p) => p.getAnimations({ subtree: true }).length), { timeout: 3000 }).toBe(0);
      // at rest the background is exactly the pill
      const edges = await pill.evaluate((p) => {
        // (two halves, each clipped at the split: the left one carries the left edge, the right one the right edge)
        const r = p.getBoundingClientRect(), l = p.querySelector('.pbg .l > i.frost')!.getBoundingClientRect(), rr = p.querySelector('.pbg .r > i.frost')!.getBoundingClientRect();
        return { l: Math.round(l.left - r.left), r: Math.round(r.right - rr.right) };
      });
      expect(edges).toEqual({ l: 0, r: 0 });
    });
  });

  test('categories, notifications and profile menus open from the bar and close with Esc', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('[data-desk-bar]');
    await bar.locator('.pill').getByRole('button', { name: 'Kategorien' }).click();
    const cats = page.getByRole('region', { name: 'Kategorien' });
    await expect(cats.getByRole('link', { name: 'Drama' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cats).toHaveCount(0);

    const bell = bar.getByRole('button', { name: /Benachrichtigungen/ });
    await expect(bell.locator('.dot')).toHaveText('1');
    await bell.click();
    await expect(page.getByRole('menuitem', { name: /Annas Klassiker/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: /Annas Klassiker/ })).toHaveCount(0);

    await bar.getByRole('button', { name: /Profilmenü/ }).click();
    const menu = page.getByRole('menu', { name: 'Profilmenü' });
    await expect(menu.getByRole('menuitem', { name: 'Konto & Einstellungen' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('phone layout (390px) still renders header.nav.m; TV (?tv=1) still renders nav.rail', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('header.nav.m')).toBeVisible();
    await expect(page.locator('[data-desk-bar]')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.routeWebSocket(/\/ws\/remote/, () => {});
    await page.goto('/?tv=1');
    await expect(page.locator('nav.rail')).toBeAttached();
    await expect(page.locator('[data-desk-bar]')).toHaveCount(0);
  });
});
