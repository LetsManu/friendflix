// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { episodes, MOVIE } from '../mocks/fixtures.js';
import { available, castOn, castSessions, mockHls, playOnAirPlay, stubAirPlay, wireless } from '../mocks/cast.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { airplayRemote } from './cast-remote-setup.js';
import type { Locator, Page } from '@playwright/test';

const HINT = 'Untertitel über AirPlay sind neu; manche Fernseher zeigen sie nicht.';

/** Phone without AirPlay / Chromecast receivers: the "Mehr" menu points to the TV mode (<host>/tv + phone as remote) instead. */
test('phone More menu: TV-mode hint when no AirPlay or Chromecast receiver is around', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.pause());
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await page.getByRole('button', { name: 'Mehr' }).tap();
  const hint = page.getByTestId('tv-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(`${new URL(page.url()).host}/tv`);
  await expect(page.getByTestId('playon')).toHaveCount(0);
});

test('AirPlay remote shows the subtitles chip and the hint', async ({ page, api: _api }) => {
  const { sessions } = await airplayRemote(page, { tracks: true });
  const screen = page.getByTestId('airplay-active');
  const line = page.locator('#rs-subs-hint');
  const chip = screen.getByRole('button', { name: /^Untertitel: / });
  await expect(chip).toHaveAccessibleName('Untertitel: Aus');
  await expect(chip).toHaveAccessibleDescription(''); // the invisible hint is not read
  await expect(line).toHaveAttribute('aria-hidden', 'true');
  await expect(line).toHaveCSS('opacity', '0'); // its room is there, it is just not shown yet
  const before = await line.boundingBox();
  await chip.click();
  await screen.getByRole('menuitemradio', { name: 'Deutsch (SDH)' }).click();
  await expect(screen.getByRole('button', { name: 'Untertitel: Deutsch (SDH)' })).toBeVisible();
  await expect(line).toBeVisible();
  await expect(line).toHaveCSS('opacity', '1');
  expect(await line.boundingBox()).toEqual(before); // nothing jumped
  expect(sessions.at(-1)).toMatchObject({ via: 'airplay', subtitleIndex: 3 });
  await expect(page.getByRole('status').filter({ hasText: HINT })).toHaveCount(1); // announced politely
  // off again: a new token without the key, the hint fades out
  await screen.getByRole('button', { name: /^Untertitel: / }).click();
  await screen.getByRole('menuitemradio', { name: 'Aus' }).click();
  await expect(line).toHaveCSS('opacity', '0');
  await expect.poll(() => sessions.length).toBe(3);
  expect('subtitleIndex' in sessions.at(-1)!).toBe(false);
});

test('AirPlay: a server that cannot put subtitles into the stream shows the chip disabled with the reason', async ({ page, api }) => {
  api.serverCaps = { castHlsSubtitles: false }; // as Plex
  const { sessions } = await airplayRemote(page, { tracks: true });
  const screen = page.getByTestId('airplay-active');
  const chip = screen.getByRole('button', { name: 'Untertitel: Aus' });
  await expect(chip).toHaveAttribute('aria-disabled', 'true');
  await expect(chip).toHaveAccessibleDescription('Dieser Server kann noch keine Untertitel an AirPlay senden.');
  const n = sessions.length;
  await chip.click({ force: true }); // aria-disabled: Playwright would wait for it
  await expect(screen.getByRole('menu')).toHaveCount(0);
  expect(sessions).toHaveLength(n);
});

test('AirPlay: the subtitle that was on locally goes into the first token and shows on the remote', async ({ page, api: _api }) => {
  const { sessions } = await airplayRemote(page, { tracks: true, localSub: true });
  const screen = page.getByTestId('airplay-active');
  expect(sessions[0]).toMatchObject({ via: 'airplay', subtitleIndex: 3 });
  await expect(screen.getByRole('button', { name: 'Untertitel: Deutsch (SDH)' })).toBeVisible();
  await expect(page.locator('#rs-subs-hint')).toHaveCSS('opacity', '1');
});

test('AirPlay: the subtitle turned off after the token was asked for it (before the TV is chosen) still shows what the stream carries', async ({ page, api: _api }) => {
  const { sessions } = await airplayRemote(page, { tracks: true, localSub: true, subOffBeforeTv: true });
  const screen = page.getByTestId('airplay-active');
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ via: 'airplay', subtitleIndex: 3 });
  await expect(screen.getByRole('button', { name: 'Untertitel: Deutsch (SDH)' })).toBeVisible(); // the TV shows track 3: the chip must not say "Aus"
});

/**
 * The AirPlay connecting layout (device hand-off spec 4): the watch page of Dunmoor's film with a receiver in reach, the AirPlay row
 * of "Play on" tapped. `slowToken`: the token request hangs until `release()`; the stubbed picker does not pick a TV by itself.
 */
async function airplayTap(page: Page, o: { slowToken?: boolean; paused?: boolean } = {}) {
  await stubAirPlay(page);
  await mockPlayer(page);
  await castOn(page);
  await mockHls(page);
  const tokens = await castSessions(page);
  let release = () => {};
  if (o.slowToken) {
    const gate = new Promise<void>((ok) => { release = ok; });
    await page.route('**/api/cast/session', async (r) => { if (r.request().method() === 'POST') await gate; await r.fallback(); });
  }
  await page.goto('/watch/' + MOVIE.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  if (o.paused) await page.evaluate(() => document.querySelector('video')!.pause()); // the token stays paused: the TV is the first to play it
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await playOnAirPlay(page, 'tap');
  return { ...tokens, release };
}
const layout = (page: Page) => page.getByTestId('airplay-connecting');
/** the TV was picked in the system picker (Safari's RemotePlayback says so before the target is wireless) */
const remoteConnecting = (page: Page) => page.evaluate(() => document.querySelector('video')!.remote.dispatchEvent(new Event('connecting')));

test('busy shows the connecting layout over the backdrop', async ({ page, api: _api }) => {
  const { release } = await airplayTap(page, { slowToken: true });
  const box = layout(page);
  await expect(box.getByRole('status')).toHaveText('Verbinde mit AirPlay …');
  await expect(box.locator('img')).toHaveAttribute('src', new RegExp(`/${MOVIE.id}/Images/Backdrop`)); // the title's picture, never the video frame
  await expect(box.getByRole('button', { name: 'Abbrechen' })).toBeVisible();
  const [v, o] = await Promise.all([page.locator('video').first().boundingBox(), box.boundingBox()]);
  expect(o!.x).toBeLessThanOrEqual(v!.x + 1);
  expect(o!.y).toBeLessThanOrEqual(v!.y + 1);
  expect(o!.x + o!.width).toBeGreaterThanOrEqual(v!.x + v!.width - 1);
  expect(o!.y + o!.height).toBeGreaterThanOrEqual(v!.y + v!.height - 1);
  const before = await page.locator('video').first().boundingBox();
  release();
  await expect(layout(page)).toHaveCount(0); // the picker prompt takes over
  expect(await page.locator('video').first().boundingBox()).toEqual(before); // nothing moved
});

test('the remote screen says Verbinde mit AirPlay …, then Läuft über AirPlay', async ({ page, api: _api }) => {
  await airplayTap(page, { paused: true });
  await expect(page.getByTestId('airplay-ready')).toBeVisible();
  await wireless(page, true);
  const screen = page.getByTestId('airplay-active');
  await expect(screen.getByRole('status').filter({ hasText: 'Verbinde mit AirPlay …' })).toHaveCount(1);
  await expect(layout(page)).toHaveCount(0); // the remote screen replaces the layout
  const eyebrow = screen.locator('.now .eyebrow');
  await expect(eyebrow).toHaveCSS('opacity', '0'); // its room is kept, nothing says "plays" yet
  const before = await eyebrow.boundingBox();
  await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('playing')));
  await expect(eyebrow).toHaveText('Läuft über AirPlay');
  await expect(eyebrow).toHaveCSS('opacity', '1');
  expect(await eyebrow.boundingBox()).toEqual(before); // nothing jumped
  await expect(page.getByRole('status').filter({ hasText: /^Läuft über AirPlay$/ })).toHaveCount(1); // announced politely, once
  await expect(screen.getByRole('status').filter({ hasText: 'Verbinde mit AirPlay …' })).toHaveCount(0); // the status line is gone: it plays
});

test('the connecting layout takes no gestures and hides the player controls', async ({ page, api: _api }) => {
  await airplayTap(page);
  await expect(page.getByTestId('airplay-ready')).toBeVisible();
  await remoteConnecting(page);
  const box = layout(page);
  await expect(box).toBeVisible();
  await expect(page.locator('.ctl')).toBeHidden(); // no control bar
  const state = () => page.evaluate(() => { const v = document.querySelector('video')!; return { t: Math.round(v.currentTime), p: v.paused }; });
  const was = await state();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('k'); // keys act through the layout like taps did: they do not
  const b = (await box.boundingBox())!;
  const x = b.x + b.width * 0.85, y = b.y + b.height * 0.4;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await page.mouse.dblclick(x, y);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
  const now = await state();
  expect(now.p).toBe(was.p);
  expect(Math.abs(now.t - was.t)).toBeLessThan(3); // the stream only played on (no +10 s)
});

test('Abbrechen restores local playback', async ({ page, api: _api }) => {
  const { deleted } = await airplayTap(page);
  await expect(page.getByTestId('airplay-ready')).toBeVisible();
  await remoteConnecting(page);
  await layout(page).getByRole('button', { name: 'Abbrechen' }).tap();
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]); // DELETE /api/cast/session/<id>
  await expect(layout(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.querySelector('video')!.src)).toMatch(/^blob:/); // hls.js again
});

test('closing the picker without a TV hides the connecting layout', async ({ page, api: _api }) => {
  await page.clock.install();
  const { deleted } = await airplayTap(page);
  await expect(page.getByTestId('airplay-ready')).toBeVisible();
  await remoteConnecting(page); // a short false signal: the picker is closed again, no TV was chosen
  await expect(layout(page)).toBeVisible();
  await page.clock.runFor(31_000); // the 30 s connect window ends
  await expect(layout(page)).toHaveCount(0);
  await page.clock.runFor(91_000); // ARM_MS: the arm timeout revokes and restores
  await expect(layout(page)).toHaveCount(0);
  await expect.poll(() => deleted).toEqual(['c'.repeat(32)]); // the arm revoke only
});

test('the connecting layout does not jump after it mounts, and Back stays reachable', async ({ page, api: _api }) => {
  await airplayTap(page);
  await expect(page.getByTestId('airplay-ready')).toBeVisible();
  await remoteConnecting(page);
  const box = layout(page);
  const boxes = async () => box.evaluate((el) => ['.msg', 'button'].map((q) => { const r = el.querySelector(q)!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }));
  const first = await boxes(); // the first frame
  expect(first[0]![2]).toBeGreaterThan(150); // the text is already in the pill
  await page.waitForTimeout(200);
  expect(await boxes()).toEqual(first);
  await page.waitForTimeout(4000); // past the 3 s auto-hide
  await expect(page.getByRole('button', { name: 'Zurück', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zurück', exact: true }).first()).toHaveCSS('opacity', '1');
});

/** Dunmoor's first three episodes as one joined stream (44 and 47 min for the last two) */
const joinedOf = (count = 3) => ({
  items: [1, 2, 3].slice(0, count).map((n) => ({ itemId: episodes[n - 1]!.id, title: `Folge ${n}`, season: 1, episode: n, start: [0, 2700, 5340][n - 1]!, duration: [2700, 2640, 2820][n - 1]! })),
  subtitles: false,
});
const TRACKS = {
  subtitles: [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }],
  audioTracks: [{ index: 1, title: 'Deutsch', language: 'deu', isDefault: true }, { index: 2, title: 'English', language: 'eng', isDefault: false }],
};
/** the continuous remote: the TV picked while the token is still paused, so the screen starts in its connecting state; the first token is joined, later ones are single */
async function joinedRemote(page: Page, o: { next?: boolean; renew?: boolean; count?: number } = {}) {
  await stubAirPlay(page);
  await mockPlayer(page);
  // after mockPlayer (its routes would win otherwise): the offer a single token shows is episode 2
  if (o.next) await page.route('**/api/items/*/next', (r) => { const u = r.request().url(); return r.fulfill({ json: { item: u.includes(episodes[0]!.id) ? episodes[1] : u.includes(episodes[1]!.id) ? episodes[2] : null } }); });
  await castOn(page, true, undefined, { airplayContinuous: true });
  await mockHls(page);
  await page.route('**/api/playback/info', (r) => r.fulfill({ json: {
    resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', roleMaxBitrate: 20_000_000, ...TRACKS,
    hlsUrl: '/media/hls/4000000/out.m3u8', maxBitrate: 4_000_000, transcodeReason: 'network',
  } }));
  let n = 0;
  const { sessions } = await castSessions(page, { deliver: (b) => {
    const sub = b.subtitleIndex === undefined ? {} : { hlsSub: true };
    // `renew`: the first token expires soon, so the Player's own renewal (no track change) brings the single token
    return ++n === 1 ? { joined: joinedOf(o.count), runtimeTicks: 81_600_000_000, ...(o.renew ? { expiresAt: Date.now() + 10 * 60_000 + 5000 } : {}), ...sub } : { ...sub, runtimeTicks: 27_000_000_000 };
  } });
  await page.goto('/watch/' + episodes[0]!.id);
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await available(page);
  await page.evaluate(() => document.querySelector('video')!.pause()); // the TV is the first to play it
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 30, y: page.viewportSize()!.height * 0.3 } });
  await playOnAirPlay(page, 'tap');
  await wireless(page, true);
  const screen = page.getByTestId('airplay-active');
  await expect(screen.getByRole('status').filter({ hasText: 'Verbinde mit AirPlay …' })).toHaveCount(1);
  return { screen, sessions };
}
/** the boxes that must not move (x, y, width, height, rounded) */
const boxes = (screen: Locator) => screen.evaluate((root) => Object.fromEntries(['.now', '.unslot', '.cont', '.mid', '.cp', '.times', '.tp', '.disc', '.rows'].map((q) => {
  const r = root.querySelector(q)?.getBoundingClientRect();
  return [q, r ? [r.x, r.y, r.width, r.height].map(Math.round) : null];
})));

for (const vp of [{ w: 390, h: 844 }, { w: 900, h: 800 }, { w: 1280, h: 800 }]) {
  test(`continuous remote ${vp.w}: nothing moves from connecting to playing, nor when a re-mint turns the stream single`, async ({ page, api: _api }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    const { screen, sessions } = await joinedRemote(page);
    await expect(screen.locator('.now .eyebrow')).toHaveCSS('opacity', '0'); // really connecting
    const connecting = await boxes(screen);
    expect(connecting['.cont']).not.toBeNull(); // the panel's room is there from the first frame
    await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('playing')));
    await expect(screen.locator('.now .eyebrow')).toHaveText('Läuft über AirPlay');
    await page.waitForTimeout(300);
    const playing = await boxes(screen);
    expect(playing).toEqual(connecting);
    if (vp.w === 390) { // all three rows, no nested scroller, above the fold
      const rows = await screen.locator('.rows').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
      expect(rows.sh).toBe(rows.ch);
      expect(playing['.cont']![1]! + playing['.cont']![3]!).toBeLessThanOrEqual(vp.h);
    }
    // a subtitle change on the TV: the new token is single (the last episode's, as after a renewal)
    await screen.getByRole('button', { name: /^Untertitel: / }).click();
    await screen.getByRole('menuitemradio', { name: 'Deutsch (SDH)' }).click();
    await expect.poll(() => sessions.length).toBe(2);
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('playing')));
    await page.waitForTimeout(600);
    expect(await boxes(screen)).toEqual(playing);
    await expect(screen.locator('.rows li')).toHaveCount(3); // the list stays for the rest of the session
  });
}

test('continuous remote shows Folge 1 von 3 and the list', async ({ page, api: _api }) => {
  const { screen } = await joinedRemote(page);
  await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('playing')));
  await expect(screen.locator('.now .eyebrow')).toHaveText('Läuft über AirPlay');
  await expect(screen.locator('.times.ep')).toHaveText('0:00 gesehen · Folge 1 von 3 · noch 45:00');
  await expect(screen.getByRole('heading', { name: 'Durchgehende Wiedergabe' })).toBeVisible();
  await expect(screen.getByText('Experimentell')).toBeVisible();
  await expect(screen.getByText('Folgen 1\u20133 laufen am Stück')).toBeVisible();
  const rows = screen.locator('.rows li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Jetzt');
  await expect(rows.nth(1)).toContainText('44 Min.');
  await expect(rows.nth(2)).toContainText('47 Min.');
  await expect(screen.getByRole('button', { name: 'Vorherige Folge (keine: das ist die erste)' })).toHaveAttribute('aria-disabled', 'true');
  await expect(screen.getByRole('button', { name: 'Nächste Folge' })).not.toHaveAttribute('aria-disabled', 'true');
});

for (const vp of [{ w: 390, h: 844 }, { w: 900, h: 800 }, { w: 1280, h: 800 }]) {
  test(`continuous remote ${vp.w}: a single token's up-next offer takes the slot with the card, in the same room`, async ({ page, api: _api }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    const { screen, sessions } = await joinedRemote(page, { next: true, renew: true });
    await page.evaluate(() => document.querySelector('video')!.dispatchEvent(new Event('playing')));
    await expect(screen.locator('.now .eyebrow')).toHaveText('Läuft über AirPlay');
    await expect(screen.locator('.rows li')).toHaveCount(3);
    const before = await boxes(screen);
    await expect.poll(() => sessions.length, { timeout: 20_000 }).toBe(2); // the renewal: a single token of the same episode
    const card = screen.getByRole('region', { name: 'Als Nächstes' });
    // the new token plays; its position updates look the next episode up (the offer the engine shows before the credits)
    await expect(async () => {
      await page.evaluate(() => { const v = document.querySelector('video')!; v.dispatchEvent(new Event('playing')); v.dispatchEvent(new Event('timeupdate')); });
      await expect(card).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await expect(screen.locator('.rows')).toBeHidden(); // the list keeps its room, unseen
    await page.waitForTimeout(400);
    const after = await boxes(screen);
    for (const q of ['.now', '.unslot', '.mid', '.cp', '.times', '.tp', '.disc']) expect(after[q], q).toEqual(before[q]);
    const [c, u] = await Promise.all([card.boundingBox(), screen.locator('.unslot').boundingBox()]);
    expect(c!.y + c!.height).toBeLessThanOrEqual(u!.y + u!.height + 1); // the card fits the reserved room
    // autoplay off: the card loses its "starts by itself" lines; the room must not shrink, nothing moves
    await card.getByRole('switch', { name: 'Nächste Folge automatisch abspielen' }).click();
    await expect(card).toContainText('Startet, wenn du es willst.');
    await page.waitForTimeout(300);
    const fewer = await boxes(screen);
    const scrolled = fewer['.now']![1]! - before['.now']![1]!; // tapping the switch may scroll the phone's page; what counts is the layout relative to it
    for (const q of ['.now', '.unslot', '.mid', '.cp', '.times', '.tp', '.disc']) expect(fewer[q]!.map((n, i) => (i === 1 ? n - scrolled : n)), q).toEqual(before[q]);
    // the disabled Previous names the truth: this is episode 1, the first
    await expect(screen.getByRole('button', { name: 'Vorherige Folge (keine: das ist die erste)' })).toHaveAttribute('aria-disabled', 'true');
  });
}

/** the TV moves to the next episode (a tap on the card): the watch page follows it and builds a new remote screen */
for (const vp of [{ w: 390, h: 844 }, { w: 900, h: 800 }, { w: 1280, h: 800 }]) {
  test(`continuous remote ${vp.w}: the TV moving on keeps the continuous room, inside the stream and past it`, async ({ page, api: _api }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    const { sessions } = await joinedRemote(page, { next: true, renew: true, count: 2 });
    const screen = page.getByTestId('airplay-active');
    const play = () => page.evaluate(() => { const v = document.querySelector('video')!; v.dispatchEvent(new Event('playing')); v.dispatchEvent(new Event('timeupdate')); });
    const KEEP = ['.now', '.unslot', '.mid', '.cp', '.times', '.tp', '.disc'];
    const same = async (a: Awaited<ReturnType<typeof boxes>>) => { const b = await boxes(page.getByTestId('airplay-active')); for (const q of KEEP) b[q]!.forEach((n, i) => expect(Math.abs(n - a[q]![i]!), `${q}[${i}]`).toBeLessThanOrEqual(1)); }; // a sub-pixel text height may round one px apart
    await play();
    await expect(screen.locator('.rows li')).toHaveCount(2);
    const first = await boxes(screen);
    // the renewal's single token of episode 1 offers episode 2 (the card); tap Play now
    await expect(async () => { await play(); await expect(screen.getByRole('region', { name: 'Als Nächstes' })).toBeVisible({ timeout: 500 }); }).toPass({ timeout: 20_000 });
    await same(first);
    await screen.getByRole('button', { name: 'Jetzt abspielen' }).click();
    await expect(page).toHaveURL(new RegExp(episodes[1]!.id));
    await expect.poll(() => sessions.length).toBeGreaterThanOrEqual(3);
    // inside the stream: the list is back, Previous is there, nothing moved
    const next = page.getByTestId('airplay-active');
    await expect(next.locator('.rows li').nth(1)).toContainText('Jetzt');
    await expect(next.getByRole('button', { name: 'Vorherige Folge' })).toHaveAttribute('aria-disabled', 'true');
    await same(first);
    // episode 2 plays and offers episode 3, which is not in the stream: the plain slot, still the same room
    await expect(async () => { await play(); await expect(next.getByRole('region', { name: 'Als Nächstes' })).toBeVisible({ timeout: 500 }); }).toPass({ timeout: 20_000 });
    await same(first);
    await next.getByRole('button', { name: 'Jetzt abspielen' }).click();
    await expect(page).toHaveURL(new RegExp(episodes[2]!.id));
    await expect(page.getByTestId('airplay-active')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('airplay-active').locator('.rows')).toHaveCount(0); // never a stale list
    await same(first);
    await expect(page.getByTestId('airplay-active').getByRole('button', { name: 'Vorherige Folge' })).toBeVisible();
  });
}
