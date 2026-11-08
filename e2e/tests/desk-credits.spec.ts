// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { items, MOVIE } from '../mocks/fixtures.js';
import { endTitle } from '../mocks/postplay.js';
import { mockPlayer } from '../mocks/scenes.js';
import { CREDITS_AT, EP, NEXT, openEpisode, openMovie, toChip } from '../mocks/credits.js';

/**
 * Desktop credits sequence (spec 2026-11-08 §4): beat 1 the chip ("Watch credits", "Next episode" filling over 2 s), beat 2 the
 * picture glides into the top-left corner, beat 3 the next episode with a countdown ring and five suggestions. "Watch credits"
 * backs out for good (also through the end of the episode), seeking back before the credits backs out, a film shows the
 * post-play headline without a countdown. The page clock is paused once the chip is up (`toChip`); `runFor` drives the beats.
 */
test('credits: chip, then the picture glides into the corner, then up next with the countdown', async ({ page, api: _api }) => {
  await openEpisode(page);
  await toChip(page);
  const chip = page.locator('.cs .chip');
  await expect(chip.getByRole('button', { name: 'Abspann ansehen' })).toBeVisible();
  await expect(chip.getByRole('button', { name: 'Nächste Folge' })).toBeVisible();
  await expect(page.locator('.stage.cred')).toHaveCount(0); // beat 1: still full screen
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
  const up = page.locator('.cs .up');
  await expect(up).toBeVisible();
  await expect(up).toContainText('Als Nächstes');
  await expect(up).toContainText(NEXT.name);
  await expect(page.locator('.cs .ring')).toHaveCount(1);
  await expect(page.locator('.cs .sugg a')).toHaveCount(5);
  await expect(page.locator('.ctl')).toHaveClass(/\bhide\b/); // the bar hides in the corner beat
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

test('Watch credits backs out to full screen and the sequence does not return, not even when the episode ends', async ({ page, api: _api }) => {
  await openEpisode(page);
  await toChip(page);
  await page.locator('.cs .chip').getByRole('button', { name: 'Abspann ansehen' }).click();
  await expect(page.locator('.stage.cred')).toHaveCount(0);
  await expect(page.locator('.cs')).toHaveCount(0); // after its 200 ms outro
  await page.clock.runFor(5000);
  await expect(page.locator('.cs')).toHaveCount(0);
  // the episode ends: the dismissed sequence stays away and no countdown starts
  await endTitle(page);
  await page.clock.runFor(12_000);
  await expect(page.locator('.cs')).toHaveCount(0);
  await expect(page.locator('.stage.cred')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/watch/${EP.id}$`));
});

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test.beforeEach(({ page }) => page.addInitScript(() => sessionStorage.setItem('ff-intro-seen', '1'))); // no brand intro over the player

  test('backing out reverses: the parts leave with an outro and the picture springs back, never a cut', async ({ page, api: _api }) => {
    await openEpisode(page);
    await toChip(page);
    await page.clock.runFor(2100);
    await expect(page.locator('.cs .up')).toBeVisible();
    expect(await page.locator('.stage.cred > video').evaluate((v) => getComputedStyle(v).transitionProperty)).toContain('transform');
    await expect.poll(() => page.locator('.cs .wc').evaluate((el) => el.getAnimations().length)).toBe(0); // its stagger is over
    // click and look in one evaluate: the outro (real-time WAAPI, 200 ms) cannot finish during a Playwright round trip. Svelte
    // flushes on microtasks (rAF / timers are paused with the page clock), so the outro has started after a few of them
    const seen = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('.cs .wc')!.click();
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        const cs = document.querySelector('.cs');
        if (!cs) return { present: false, anims: false, cred: Boolean(document.querySelector('.stage.cred')) };
        if (cs.getAnimations().length) return { present: true, anims: true, cred: Boolean(document.querySelector('.stage.cred')) };
      }
      return { present: Boolean(document.querySelector('.cs')), anims: false, cred: Boolean(document.querySelector('.stage.cred')) };
    });
    // the layer is still there, running its outro, while the picture (no longer .cred) glides back
    expect(seen).toEqual({ present: true, anims: true, cred: false });
    await expect(page.locator('.stage.cred')).toHaveCount(0);
    await expect(page.locator('.cs')).toHaveCount(0);
  });
});

test('Esc backs out without leaving the player', async ({ page, api: _api }) => {
  await openEpisode(page);
  await toChip(page);
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.stage.cred')).toHaveCount(0);
  await expect(page.locator('.cs')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/watch/${EP.id}$`));
});

test('a click on the small picture backs out', async ({ page, api: _api }) => {
  await openEpisode(page);
  await toChip(page);
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
  await expect.poll(() => page.locator('.stage.cred > video').evaluate((v) => v.getAnimations().length)).toBe(0); // the glide is over
  const v = (await page.locator('.stage.cred > video').boundingBox())!;
  await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
  await expect(page.locator('.stage.cred')).toHaveCount(0);
  await expect(page.locator('.cs')).toHaveCount(0);
});

test('seeking back before the credits backs out', async ({ page, api: _api }) => {
  await openEpisode(page);
  await toChip(page);
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
  // the timeline has no Home key: the seek it would do, straight on the <video>
  await page.evaluate((to) => { document.querySelector('video')!.currentTime = to; }, CREDITS_AT - 30);
  await expect(page.locator('.stage.cred')).toHaveCount(0);
  await expect(page.locator('.cs')).toHaveCount(0);
});

test('a film shows suggestions without a countdown', async ({ page, api: _api }) => {
  await openMovie(page);
  await toChip(page);
  await expect(page.locator('.cs .chip').getByRole('button', { name: 'Mehr davon' })).toBeVisible();
  await page.clock.runFor(2100);
  await expect(page.locator('.stage.cred')).toHaveCount(1);
  await expect(page.locator('.cs .up')).toContainText('Du hast „Inkwell“ gesehen');
  await expect(page.locator('.cs .ring')).toHaveCount(0);
  await expect(page.locator('.cs .sugg a')).toHaveCount(5);
  await page.clock.runFor(12_000);
  await expect(page).toHaveURL(new RegExp(`/watch/${MOVIE.id}$`)); // nothing starts by itself
});

test.describe('watch party', () => {
  // the party route renders the Player without the watch page's next-up / credits layer: nothing there can shrink the picture
  test('no credits sequence', async ({ page, api: _api }) => {
    await mockPlayer(page);
    await page.routeWebSocket(/\/ws\/party\//, (ws) => {
      ws.send(JSON.stringify({ t: 'welcome', you: 'u2', hostId: 'u1', mode: 'host', itemId: items[0]!.id, title: 'Testfilm', members: [{ id: 'u1', name: 'Mia', buffering: false }, { id: 'u2', name: 'Ben', buffering: false }], state: { playing: false, position: 0, at: Date.now(), hold: false }, serverNow: Date.now() }));
      ws.onMessage((m) => { const msg = JSON.parse(String(m)); if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() })); });
    });
    await page.goto('/party/room1');
    await expect(page.locator('.stage video')).toHaveCount(1); // the player is up
    await expect(page.getByRole('group', { name: 'Live-Reaktionen' })).toBeVisible(); // ... inside the party page
    await expect(page.locator('.cs')).toHaveCount(0);
    await expect(page.locator('.stage.cred')).toHaveCount(0);
  });
});
