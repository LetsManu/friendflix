// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { episodes, ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/** Desktop player bar (spec 2026-11-08 §1–2): title block, timeline row with both times, two glass pills, labels, panels. */
async function open(page: Page) {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => { const v = document.querySelector('video')!; return v.play().catch(() => undefined); });
}

test('desktop bar: title block, both pills, times on the timeline row', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await open(page);
  for (const size of [{ width: 1024, height: 700 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.locator('.stage').hover();
    await expect(page.locator('.stage.desk')).toBeVisible();
    await expect(page.locator('.stage.desk .ttlblock')).toContainText(MOVIE.name);
    await expect(page.locator('.stage.desk .pill')).toHaveCount(2);
    await expect(page.locator('.stage.desk .tlrow .el')).toBeVisible();
    await expect(page.locator('.stage.desk .tlrow .rem')).toBeVisible();
    await expect(page.locator('.stage.desk .tlrow .el')).toHaveText(/^(\d+:)?\d+:\d\d$/);
    await expect(page.locator('.stage.desk .tlrow .rem')).toHaveText(/^−(\d+:)?\d+:\d\d$/);
    await expect(page.locator('.ctl .mid')).toHaveCount(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
  }
});

test('narrow desktop window: every tool stays inside the stage (series episode, all tools)', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 760, height: 700 });
  await mockPlayer(page);
  await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: episodes[1] } })); // "next episode" button shown
  await page.goto('/watch/' + episodes[0]!.id);
  await videoReady(page);
  await page.locator('.stage').hover();
  await expect(page.locator('.stage.desk')).toBeVisible();
  await expect(page.locator('.stage.desk .pill').getByRole('button', { name: 'Nächste Folge', exact: true })).toBeVisible();
  await expect(page.locator('.stage.desk .pill').getByRole('button', { name: 'Folgen', exact: true })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const stage = (await page.locator('.stage.desk').boundingBox())!;
  const boxes = await page.locator('.stage.desk .pill button.ic').evaluateAll((els) => els
    .filter((e) => (e as HTMLElement).offsetParent !== null)
    .map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, n: e.getAttribute('aria-label') }; }));
  expect(boxes.length).toBeGreaterThanOrEqual(9);
  for (const b of boxes) {
    expect(b.l, `${b.n} left`).toBeGreaterThanOrEqual(stage.x - 0.5);
    expect(b.r, `${b.n} right`).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
    expect(b.t, `${b.n} top`).toBeGreaterThanOrEqual(stage.y - 0.5);
    expect(b.b, `${b.n} bottom`).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
  }
});

test('a label rises above a tool on hover', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  const more = page.getByRole('button', { name: 'Mehr', exact: true });
  await expect(more).toHaveAttribute('data-label', 'Mehr');
  expect(await more.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('0');
  await more.hover();
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1');
});

test('the bar fades after 3 s idle and returns on movement', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await page.clock.runFor(3500);
  await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/);
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
});

test('a panel opens from its button; Esc closes it and focus returns', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  const opener = page.getByRole('button', { name: 'Audio und Untertitel' });
  await opener.click();
  await expect(page.locator('.menu.tracks')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu.tracks')).toBeHidden();
  await expect(opener).toBeFocused();
});

type Box = { x: number; y: number; width: number; height: number };
/** two boxes share pixels */
const meets = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const titleShown = (page: Page) => page.locator('.stage.desk .ttlblock').evaluate((e) => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && Number(s.opacity) > 0; });

test('cast & info never covers the title block or the timeline', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }]) {
    await page.setViewportSize(size);
    await page.locator('.stage').hover();
    const btn = page.locator('.stage.desk .pill').getByRole('button', { name: 'Besetzung & Infos', exact: true });
    if (!(await page.locator('.ci').count())) { await btn.click(); await btn.click(); } // playing: the peek first, then the panel
    await expect(page.locator('.ci')).toBeVisible();
    const ci = await box(page, '.ci');
    expect(meets(ci, await box(page, '.stage.desk .ttlblock')), `panel vs title at ${size.width}`).toBe(false);
    expect(meets(ci, await box(page, '.stage.desk .tlrow')), `panel vs timeline at ${size.width}`).toBe(false);
    expect(await titleShown(page)).toBe(true); // the title stays: the panel sits above it
  }
});

test('the tools\' cards stop above the timeline; the title block fades while one is open', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.locator('.stage').hover();
  const tl = await box(page, '.stage.desk .tlrow');
  for (const [name, sel] of [['Audio und Untertitel', '.menu.tracks'], ['Mehr', '.menu.more']] as const) {
    await page.locator('.stage.desk .pill').getByRole('button', { name, exact: true }).click();
    await expect(page.locator(sel)).toBeVisible();
    const card = await box(page, sel);
    expect(meets(card, tl), `${name} vs timeline`).toBe(false);
    expect(card.y + card.height).toBeLessThanOrEqual(tl.y);
    // a wide card can reach the title's column: the title is gone (opacity and visibility) while the card is open
    await expect.poll(() => titleShown(page)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator(sel)).toHaveCount(0);
    await expect.poll(() => titleShown(page)).toBe(true);
  }
});

test('the audio & subtitles card is glass with the menu scrim; its headings have no box of their own', async ({ page, api: _api }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => { (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 }; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
  await page.locator('.stage').hover();
  await page.locator('.stage.desk .pill').getByRole('button', { name: 'Audio und Untertitel', exact: true }).click();
  const menu = page.locator('.menu.tracks');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveClass(/(^|\s)frost(\s|$)/);
  await expect(menu).toHaveClass(/(^|\s)frost-menu(\s|$)/);
  await expect(menu).toHaveClass(/(^|\s)frost-safe(\s|$)/);
  const look = await menu.evaluate((e) => {
    const s = getComputedStyle(e);
    const h = [...e.querySelectorAll('h3')].map((x) => { const c = getComputedStyle(x); return { bg: c.backgroundColor, img: c.backgroundImage, pos: c.position, color: c.color }; });
    const rows = [...e.querySelectorAll('.mi')].map((x) => getComputedStyle(x).color);
    const notes = [...e.querySelectorAll('.fxl small')].map((x) => getComputedStyle(x).color);
    return { scrim: s.getPropertyValue('--fr-scrim').trim(), bg: s.backgroundColor, blur: s.backdropFilter, h, rows, notes };
  });
  // the heavy menu scrim over video (tone.ts SCRIM_MENU: white rows on the light pill and .9 notes pass AA over pure white)
  expect(Number(look.scrim)).toBeGreaterThanOrEqual(0.82);
  expect(look.bg).toBe(`rgba(18, 16, 24, ${look.scrim})`);
  expect(look.blur).toContain('blur(38px)');
  expect(look.h.length).toBeGreaterThanOrEqual(2);
  for (const h of look.h) {
    expect(h.bg).toBe('rgba(0, 0, 0, 0)');
    expect(h.img).toBe('none');
    expect(h.pos).not.toBe('sticky');
    expect(h.color).toBe('rgb(255, 255, 255)');
  }
  for (const c of look.rows) expect(c).toBe('rgb(255, 255, 255)');
  expect(look.notes.length).toBeGreaterThan(0);
  for (const c of look.notes) expect(c).toBe('rgba(255, 255, 255, 0.9)');
});

test('Tab reaches both pills', async ({ page, api: _api }) => {
  await open(page);
  await page.locator('.stage').hover();
  await page.locator('.stage.desk .pill .ic.big').focus();
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Vollbild');
  }
  expect(reached).toBe(true);
  await expect(page.getByRole('button', { name: 'Vollbild', exact: true })).toBeFocused();
});

test('phone and TV keep their bars', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.route('**/api/me', (r) => r.fulfill({ json: { ...ME, tv: true } })); // a paired television (as tv-layout.spec.ts sets it)
  await page.routeWebSocket(/\/ws\/remote/, () => {});
  await page.goto('/watch/' + MOVIE.id);
  await expect(page.locator('html.tv')).toHaveCount(1);
  await expect(page.locator('.stage')).toBeAttached();
  await expect(page.locator('.stage.desk')).toHaveCount(0);
  await expect(page.locator('.stage .pill')).toHaveCount(0);
});

/** §3 pause screen: pause with the clock installed, so 5 s can pass without waiting */
async function pauseFor(page: Page) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); document.querySelector('video')!.pause(); });
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(true);
}

test('after 5 s paused the pause screen shows; movement brings the bar back', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(5200);
  await expect(page.locator('.dps')).toBeVisible();
  await expect(page.locator('.dps')).toContainText(MOVIE.name);
  await expect(page.locator('.dps')).toContainText('Du siehst gerade');
  await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/);
  const box = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 3);
  await expect(page.locator('.dps')).toHaveCount(0);
  await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
});

test('no pause screen while a panel is open', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.locator('.stage').hover();
  await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
  await expect(page.locator('.menu.tracks')).toBeVisible();
  await page.clock.runFor(8000);
  await expect(page.locator('.dps')).toHaveCount(0);
});

test('no automatic cast & info panel on desktop', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(8000);
  await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toHaveCount(0);
  await expect(page.locator('.dps')).toBeVisible();
  await page.locator('.dps').getByRole('button', { name: 'Besetzung & Infos', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toBeVisible();
  await expect(page.locator('.dps')).toHaveCount(0);
});

test('Esc closing cast & info opened from the pause screen counts as input: the bar, not the pause screen', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(5200);
  await page.locator('.dps').getByRole('button', { name: 'Besetzung & Infos', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toBeVisible();
  await page.clock.runFor(8000); // longer than the pause-screen delay
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Besetzung & Infos' })).toHaveCount(0);
  await expect(page.locator('.dps')).toHaveCount(0);
  await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
});

test('Space resumes from the pause screen', async ({ page, api: _api }) => {
  await page.clock.install();
  await open(page);
  await pauseFor(page);
  await page.clock.runFor(5200);
  await expect(page.locator('.dps')).toBeVisible();
  await page.keyboard.press(' ');
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.paused)).toBe(false);
});

test.describe('keyboard (accessibility audit 2026-11-09)', () => {
  test('keyboard focus in the bar keeps it up past the idle time; any key brings a hidden bar back (WCAG 2.4.7 / 2.4.11)', async ({ page, api: _api }) => {
    await page.clock.install();
    await open(page);
    await page.keyboard.press('Shift'); // keyboard modality: the scripted focus below is focus-visible, as a Tab would be
    const tracks = page.getByRole('button', { name: 'Audio und Untertitel' });
    await tracks.focus();
    expect(await tracks.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    await page.clock.runFor(8000); // well past the 3 s idle hide
    await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
    await expect(page.locator('.stage')).not.toHaveClass(/\bidle\b/);
    expect(await tracks.evaluate((el) => { let o = 1; for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; })).toBeGreaterThan(0.9);
    // focus leaves the bar: the idle hide is back; a key press (no pointer) shows the bar again
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.clock.runFor(3500);
    await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/);
    await page.keyboard.press('Shift');
    await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
  });

  test('a popover opened from the keyboard takes the focus, and Tabbing out of it closes it (WCAG 2.4.3)', async ({ page, api: _api }) => {
    await open(page);
    await page.keyboard.press('Shift');
    const tracks = page.getByRole('button', { name: 'Audio und Untertitel' });
    await tracks.focus();
    await page.keyboard.press('Enter');
    const pop = page.getByRole('dialog', { name: 'Audio und Untertitel' });
    await expect(pop).toBeVisible();
    await expect.poll(() => pop.evaluate((p) => p.contains(document.activeElement))).toBe(true);
    // Shift+Tab until the focus is neither in the popover nor on its button: the popover has closed
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      const out = await page.evaluate(() => { const a = document.activeElement; return !a?.closest('.menu') && a?.getAttribute('aria-expanded') !== 'true'; });
      if (out) break;
    }
    await expect(pop).toHaveCount(0);
  });

  test('a popover opened with the mouse leaves the focus on its button', async ({ page, api: _api }) => {
    await open(page);
    await page.locator('.stage').hover();
    const tracks = page.getByRole('button', { name: 'Audio und Untertitel' });
    await tracks.click();
    await expect(page.getByRole('dialog', { name: 'Audio und Untertitel' })).toBeVisible();
    await expect(tracks).toBeFocused();
  });
});
