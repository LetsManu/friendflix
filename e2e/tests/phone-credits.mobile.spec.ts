// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { ME } from '../mocks/fixtures.js';
import { CREDITS_AT, NEXT, openEpisode, openMovie, seekPlaying, toChip } from '../mocks/credits.js';
import { forceSafeArea, LAND_L, PORTRAIT, setSafeArea, type Insets } from '../mocks/phone.js';

/**
 * Credits sequence on phones (spec 2026-11-08 §4): the chip at the end-side bottom, then the picture glides into the top-start
 * corner (landscape scale .42; portrait the letterboxed picture rises to just below the status bar), then the next episode with
 * the countdown and "More like this" beside it (landscape) or below it (portrait). Everything inside the safe areas, every button
 * at least 44 px. A tap on the small picture or "Watch credits" backs out. The page clock is paused once the chip is up.
 */
const LAYOUTS = [
  { name: 'landscape, cut-out left', viewport: { width: 844, height: 390 }, safe: LAND_L },
  { name: 'portrait', viewport: { width: 390, height: 844 }, safe: PORTRAIT },
] as const;

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

/** the small picture: landscape in the start half, inside the cut-out's inset; portrait below the status bar, under half high */
async function pictureChecks(page: Page, safe: Insets) {
  const { width: vw, height: vh } = page.viewportSize()!;
  const v = await box(page, 'video');
  if (vw > vh) {
    expect(v.x).toBeGreaterThanOrEqual(safe.left);
    expect(v.y).toBeGreaterThanOrEqual(0);
    expect(v.x + v.width).toBeLessThan(vw / 2);
  } else {
    expect(v.y).toBeGreaterThanOrEqual(safe.top);
    expect(v.height).toBeLessThan(vh / 2);
    expect(v.x).toBeGreaterThanOrEqual(safe.left);
    expect(v.x + v.width).toBeLessThanOrEqual(vw - safe.right);
  }
  return v;
}

/** every button of the sequence inside the viewport minus the insets and at least 44 px tall */
async function buttonChecks(page: Page, safe: Insets) {
  const { width: vw, height: vh } = page.viewportSize()!;
  const buttons = await page.locator('.cs button').all();
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) {
    const r = (await b.boundingBox())!;
    const name = (await b.textContent())?.trim();
    expect.soft(r.x, `${name} left`).toBeGreaterThanOrEqual(safe.left - 0.5);
    expect.soft(r.x + r.width, `${name} right`).toBeLessThanOrEqual(vw - safe.right + 0.5);
    expect.soft(r.y, `${name} top`).toBeGreaterThanOrEqual(safe.top - 0.5);
    expect.soft(r.y + r.height, `${name} bottom`).toBeLessThanOrEqual(vh - safe.bottom + 0.5);
    expect.soft(r.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
}

/** the corner beat's layout: the picture, then up next beside it (landscape) or below it (portrait), nothing over the picture */
async function cornerChecks(page: Page, safe: Insets) {
  const { width: vw, height: vh } = page.viewportSize()!;
  await expect(page.locator('.stage.cred')).toHaveCount(1);
  const v = await pictureChecks(page, safe);
  const up = page.locator('.cs .up');
  await expect(up).toBeVisible();
  const u = (await up.boundingBox())!;
  if (vw > vh) expect(u.x).toBeGreaterThanOrEqual(v.x + v.width);
  else expect(u.y).toBeGreaterThanOrEqual(v.y + v.height);
  const sugg = page.locator('.cs .sugg');
  if (await sugg.count()) {
    const s = (await sugg.boundingBox())!;
    if (vw > vh) expect(s.x).toBeGreaterThanOrEqual(v.x + v.width);
    else expect(s.y).toBeGreaterThanOrEqual(u.y + u.height);
  }
  await buttonChecks(page, safe);
}

test.beforeEach(({ page }) => page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'))); // no brand intro over the player

for (const L of LAYOUTS) {
  test.describe(`phone credits, ${L.name}`, () => {
    test.use({ viewport: L.viewport });
    test.beforeEach(async ({ page }) => { await forceSafeArea(page, L.safe); });

    test('chip, then the picture glides into the corner, then up next with the countdown', async ({ page, api: _api }) => {
      await openEpisode(page);
      await expect(page.locator('.stage.pui')).toHaveCount(1);
      await toChip(page);
      const chip = page.locator('.cs .chip');
      await expect(chip.getByRole('button', { name: 'Abspann ansehen' })).toBeVisible();
      await expect(chip.getByRole('button', { name: 'Nächste Folge' })).toBeVisible();
      await buttonChecks(page, L.safe);
      await expect(page.locator('.stage.cred')).toHaveCount(0); // beat 1: still full screen
      await page.clock.runFor(2100);
      await cornerChecks(page, L.safe);
      const up = page.locator('.cs .up');
      await expect(up).toContainText(NEXT.name);
      await expect(up).toContainText('Als Nächstes');
      await expect(page.locator('.cs .ring')).toHaveCount(1);
      await expect(page.locator('.cs .sugg a')).toHaveCount(5);
      await expect(page.locator('.next')).toHaveCount(0); // the phone's next-up card gives way to the sequence
      await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/);
    });

    test('the countdown plays the next episode', async ({ page, api: _api }) => {
      await openEpisode(page);
      await toChip(page);
      await page.clock.runFor(2100);
      await expect(page.locator('.cs .up')).toBeVisible();
      await page.clock.runFor(10_500);
      await page.clock.resume();
      await expect(page).toHaveURL(new RegExp(`/watch/${NEXT.id}$`));
    });

    test('a tap on the small picture backs out; the sequence does not return', async ({ page, api: _api }) => {
      await openEpisode(page);
      await toChip(page);
      await page.clock.runFor(2100);
      await expect(page.locator('.stage.cred')).toHaveCount(1);
      const v = await box(page, 'video');
      await page.touchscreen.tap(v.x + v.width / 2, v.y + v.height / 2);
      await expect(page.locator('.stage.cred')).toHaveCount(0);
      await expect(page.locator('.cs .up')).toHaveCount(0);
      await page.clock.runFor(5000);
      await expect(page.locator('.cs .up')).toHaveCount(0);
      await expect(page.locator('.stage.cred')).toHaveCount(0);
    });

    test('Watch credits backs out to full screen', async ({ page, api: _api }) => {
      await openEpisode(page);
      await toChip(page);
      await page.clock.runFor(2100);
      await expect(page.locator('.stage.cred')).toHaveCount(1);
      await page.locator('.cs .wc').getByText('Abspann ansehen').tap();
      await expect(page.locator('.stage.cred')).toHaveCount(0);
      await expect(page.locator('.cs')).toHaveCount(0);
      await page.clock.runFor(900); // phones: the box stays cut to the picture until the spring back has landed (.credout)
      await expect(page.locator('.stage.credout')).toHaveCount(0);
      const { width: vw, height: vh } = page.viewportSize()!;
      const v = await box(page, 'video'); // full screen again
      expect(Math.round(v.width)).toBe(vw);
      expect(Math.round(v.height)).toBe(vh);
    });

    test('a film shows suggestions without a countdown', async ({ page, api: _api }) => {
      await openMovie(page);
      await seekPlaying(page, CREDITS_AT + 5, true);
      const more = page.locator('.cs .chip').getByRole('button', { name: 'Mehr davon' });
      await expect(more).toBeVisible();
      await more.tap();
      await expect(page.locator('.cs .up')).toContainText('Du hast „Inkwell“ gesehen');
      await expect(page.locator('.cs .ring')).toHaveCount(0);
      await cornerChecks(page, L.safe);
      // the post-play card sits at the start-side bottom, clear of the picture and the column
      const card = page.getByTestId('postplay-card');
      await expect(card).toBeVisible();
      const c = (await card.boundingBox())!, v = await box(page, 'video');
      const { width: vw, height: vh } = page.viewportSize()!;
      expect(c.x).toBeGreaterThanOrEqual(L.safe.left);
      expect(c.x + c.width).toBeLessThanOrEqual(vw - L.safe.right);
      expect(c.y + c.height).toBeLessThanOrEqual(vh - L.safe.bottom);
      expect(c.y).toBeGreaterThanOrEqual(v.y + v.height);
      for (const sel of ['.cs .up', '.cs .sugg']) {
        const b = await box(page, sel);
        const apart = c.x + c.width <= b.x + 0.5 || b.x + b.width <= c.x + 0.5 || c.y + c.height <= b.y + 0.5 || b.y + b.height <= c.y + 0.5;
        expect(apart, `${sel} clear of the post-play card`).toBe(true);
      }
    });
  });
}

test.describe('phone credits, rotation', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => { await forceSafeArea(page, PORTRAIT); });

  test('rotating in the corner keeps the picture in the corner', async ({ page, api: _api }) => {
    await openEpisode(page);
    await toChip(page);
    await page.clock.runFor(2100);
    await cornerChecks(page, PORTRAIT);
    await page.setViewportSize({ width: 844, height: 390 });
    await setSafeArea(page, LAND_L);
    await expect(page.locator('.stage.pui.port')).toHaveCount(0);
    await expect(page.locator('.stage.cred')).toHaveCount(1);
    await expect.poll(async () => (await box(page, 'video')).y).toBeGreaterThanOrEqual(0);
    await cornerChecks(page, LAND_L);
  });
});

test.describe('phone credits, with motion', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  test.beforeEach(async ({ page }) => { await forceSafeArea(page, PORTRAIT); });

  test('the picture glides on a spring and back, never a cut', async ({ page, api: _api }) => {
    await openEpisode(page);
    await toChip(page);
    await expect(page.locator('.stage.cmo')).toHaveCount(1);
    const tr = await page.locator('video').first().evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(tr).toContain('transform');
    await page.clock.runFor(2100);
    await expect(page.locator('.stage.cred')).toHaveCount(1);
    await page.locator('.cs .wc').tap();
    // backing out: the box stays cut to the picture while the spring runs back (.credout), then the stage lets go of it
    await expect(page.locator('.stage.credout')).toHaveCount(1);
    await page.clock.runFor(900);
    await expect(page.locator('.stage.credout')).toHaveCount(0);
  });
});

test('kids on a phone keep the next-episode card', async ({ page, api: _api }) => {
  const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
  await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
  await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
  await openEpisode(page);
  await expect(page.locator('.stage.phone')).toHaveCount(1);
  await seekPlaying(page, CREDITS_AT + 5, true);
  await expect(page.locator('.next')).toBeVisible();
  await expect(page.locator('.next')).toContainText(NEXT.name);
  await expect(page.locator('.cs .chip')).toHaveCount(0);
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(0);
  await expect(page.locator('.cs')).toHaveCount(0);
});
