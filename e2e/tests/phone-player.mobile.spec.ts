// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';
import { episodes, items, ME, MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { boxes, forceIosVolume, forceSafeArea, LAND_L, LAND_R, openPhoneEpisode, overlap, PORTRAIT, setSafeArea, showControls, type Box, type Insets } from '../mocks/phone.js';

/**
 * Phone player (spec 2026-11-08, block 4): top bar of glass circles, one bottom dock (title + skip, timeline, two glass pills),
 * in landscape with the camera cut-out on either side and in portrait. Nothing may overlap, everything stays inside the safe area.
 */
const SERIES = 'Die außergewöhnlich lange Chronik der Schmiede im Tal der vergessenen Königinnen und Könige';
const LONG_EP = 'Der Schmied, der nicht aufhören wollte zu reden, und sein Lehrling';
const INTRO = [{ type: 'Intro', start: 0, end: 300 }];
const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const LAYOUTS = [
  { name: 'landscape, cut-out left', viewport: { width: 844, height: 390 }, safe: LAND_L },
  { name: 'landscape, cut-out right', viewport: { width: 844, height: 390 }, safe: LAND_R },
  { name: 'portrait', viewport: { width: 390, height: 844 }, safe: PORTRAIT },
] as const;

/** the long title with the intro's skip button; paused, so the controls stay while measuring */
async function openLong(page: Page, next: unknown = null) {
  await openPhoneEpisode(page, LONG_EP, { series: SERIES, segments: INTRO, next });
  await page.evaluate(() => document.querySelector('video')!.pause());
  await showControls(page);
  await expect(page.locator('.ptitle .skipbtn')).toBeVisible();
}

const DOCK = ['.ptitle .ptx', '.ptitle .skipbtn', '.ctl .tlrow', '.pill.lp', '.pill.tp', '.ptop', '.top .icon-btn'];

/** dock order, no overlap, inside the safe area, targets ≥ 44 px, both times */
async function dockChecks(page: Page, safe: Insets) {
  const { width: vw, height: vh } = page.viewportSize()!;
  await expect(page.locator('.stage.pui')).toHaveCount(1);
  await expect(page.locator('.cc')).toHaveCount(0);
  const found = await boxes(page, DOCK);
  found.forEach((b, i) => expect(b, `${DOCK[i]} present`).not.toBeNull());
  const B = found as Box[];
  for (let i = 0; i < B.length; i++) {
    const b = B[i]!;
    expect.soft(b.x, `${b.name} left`).toBeGreaterThanOrEqual(safe.left - 0.5);
    expect.soft(b.x + b.w, `${b.name} right`).toBeLessThanOrEqual(vw - safe.right + 0.5);
    expect.soft(b.y, `${b.name} top`).toBeGreaterThanOrEqual(safe.top - 0.5);
    expect.soft(b.y + b.h, `${b.name} bottom`).toBeLessThanOrEqual(vh - safe.bottom + 0.5);
    for (const o of B.slice(i + 1)) expect.soft(overlap(b, o), `${b.name} overlaps ${o.name}`).toBe(false);
  }
  const [ptx, skip, tl, lp, tp] = B as [Box, Box, Box, Box, Box];
  expect(ptx.y + ptx.h).toBeLessThanOrEqual(tl.y + 0.5);
  expect(tl.y).toBeLessThanOrEqual(Math.min(lp.y, tp.y));
  if (vw > vh) {
    const [dock, row] = (await boxes(page, ['.ctl.dock', '.ptitle'])) as [Box, Box];
    expect(ptx.w).toBeLessThanOrEqual(0.58 * dock.w);
    const cy = skip.y + skip.h / 2;
    expect(cy).toBeGreaterThanOrEqual(row.y);
    expect(cy).toBeLessThanOrEqual(row.y + row.h);
  } else {
    expect(skip.y).toBeGreaterThanOrEqual(ptx.y + ptx.h - 0.5);
  }
  for (const b of await page.locator('.pill button, .ptop button').all()) {
    const r = (await b.boundingBox())!;
    const name = await b.getAttribute('aria-label') ?? await b.textContent();
    expect.soft(r.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect.soft(r.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('.ctl .el')).toHaveText(/^(\d+:)?\d+:\d\d$/);
  await expect(page.locator('.ctl .rem')).toHaveText(/^−(\d+:)?\d+:\d\d$/);
}

/** the accessible names of the tools pill's buttons, in order */
const toolNames = (page: Page) => page.locator('.pill.tp').evaluate((el) => [...el.querySelectorAll(':scope > button, :scope > .mwrap > button')].map((b) => b.getAttribute('aria-label') ?? ''));

for (const L of LAYOUTS) {
  test.describe(`phone player, ${L.name}`, () => {
    test.use({ viewport: L.viewport });
    test.beforeEach(async ({ page }) => { await forceSafeArea(page, L.safe); });

    test('dock order and no overlap with a long title', async ({ page, api: _api }) => {
      await openLong(page);
      await dockChecks(page, L.safe);
    });

    test('tools per orientation', async ({ page, api: _api }) => {
      const land = L.viewport.width > L.viewport.height;
      await openPhoneEpisode(page, undefined, { next: episodes[3] });
      await page.evaluate(() => document.querySelector('video')!.pause());
      await showControls(page);
      const names = await toolNames(page);
      if (land) {
        expect(names).toHaveLength(5);
        expect(names.slice(0, 3)).toEqual(['Nächste Folge', 'Folgen', 'Audio und Untertitel']);
        expect(names[3]).toMatch(/^Wiedergabetempo/);
        expect(names[4]).toBe('Mehr');
      } else {
        expect(names).toEqual(['Folgen', 'Audio und Untertitel', 'Mehr']);
        await page.locator('.pill.tp').getByRole('button', { name: 'Mehr', exact: true }).tap();
        const more = page.getByRole('dialog', { name: 'Mehr' });
        await expect(more.getByRole('button', { name: /^Wiedergabetempo/ })).toBeVisible();
        await expect(more.getByRole('button', { name: 'Nächste Folge', exact: true })).toBeVisible();
      }
      await expect(page.locator('.ptop').getByRole('button', { name: 'Bedienung sperren' })).toBeVisible();

      // a film: no next episode, no episodes; cast & info lives in More, not in the pills
      await page.route('**/api/items/*/next', (r) => r.fulfill({ json: { item: null } }));
      await page.goto('/watch/' + MOVIE.id);
      await videoReady(page);
      await page.evaluate(() => document.querySelector('video')!.pause());
      await showControls(page);
      await expect(page.locator('.stage.pui')).toHaveCount(1);
      const film = await toolNames(page);
      expect(film).not.toContain('Nächste Folge');
      expect(film).not.toContain('Folgen');
      expect(film.at(-1)).toBe('Mehr');
      await expect(page.locator('.pill').getByRole('button', { name: 'Besetzung & Infos' })).toHaveCount(0);
      await page.locator('.pill.tp').getByRole('button', { name: 'Mehr', exact: true }).tap();
      const more = page.getByRole('dialog', { name: 'Mehr' });
      await expect(more.getByRole('button', { name: 'Besetzung & Infos' })).toBeVisible();
      await expect(more.getByRole('button', { name: 'Nächste Folge', exact: true })).toHaveCount(0);
      await expect(page.locator('.ptop').getByRole('button', { name: 'Bedienung sperren' })).toBeVisible();
    });
  });
}

test.describe('phone player, portrait', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ page }) => { await forceSafeArea(page, PORTRAIT); });

  test('rotation re-lays out without a reload', async ({ page, api: _api }) => {
    await openLong(page);
    await expect(page.locator('.stage.port')).toHaveCount(1);
    await page.evaluate(() => { (window as unknown as { __ff: number }).__ff = 1; });
    await page.setViewportSize({ width: 844, height: 390 });
    await setSafeArea(page, LAND_L);
    await expect(page.locator('.stage.port')).toHaveCount(0);
    await dockChecks(page, LAND_L);
    expect(await page.evaluate(() => (window as unknown as { __ff?: number }).__ff)).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await setSafeArea(page, PORTRAIT);
    await expect(page.locator('.stage.port')).toHaveCount(1);
    await dockChecks(page, PORTRAIT);
  });

  test('controls hide after 3 s and return on a tap; the progress line shows meanwhile; skip stays', async ({ page, api: _api }) => {
    await page.clock.install();
    await openPhoneEpisode(page, LONG_EP, { series: SERIES, segments: INTRO });
    await expect.poll(() => page.evaluate(() => !document.querySelector('video')!.paused)).toBe(true);
    await page.clock.runFor(3500);
    await expect(page.locator('.ctl.hide')).toHaveCount(1);
    await expect(page.locator('.ovl.hide')).toHaveCount(1);
    await expect(page.locator('.pline.on')).toBeVisible();
    const line = (await page.locator('.pline').boundingBox())!;
    expect(line.y + line.height).toBeLessThanOrEqual(844 - 34);
    const skip = page.locator('.ptitle .skipbtn');
    await expect(skip).toBeVisible();
    await expect(skip).toHaveCSS('opacity', '1');
    const b = (await skip.boundingBox())!;
    expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('.skipbtn')), [b.x + b.width / 2, b.y + b.height / 2])).toBe(true);
    await page.locator('.stage').tap({ position: { x: 30, y: 844 * 0.3 } });
    await expect(page.locator('.ctl.hide')).toHaveCount(0);
    await expect(page.locator('.pline.on')).toHaveCount(0);
  });

  test('double tap right seeks, lock in the top bar holds until hold-to-unlock', async ({ page, api: _api }) => {
    await openPhoneEpisode(page);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await showControls(page);
    const t0 = await page.evaluate(() => document.querySelector('video')!.currentTime);
    const x = 390 * 0.8, y = 844 * 0.4;
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await expect(page.locator('.riplbl.right')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(t0 + 9);
    expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeLessThan(t0 + 11);

    await showControls(page);
    await page.locator('.ptop').getByRole('button', { name: 'Bedienung sperren' }).tap();
    await expect(page.locator('.stage.locked')).toHaveCount(1);
    await expect(page.locator('.ctl.hide')).toHaveCount(1);
    const unlock = page.getByRole('button', { name: 'Entsperren (gedrückt halten)' });
    await expect(unlock).toBeVisible();
    const u = (await unlock.boundingBox())!;
    expect(u.x).toBeGreaterThanOrEqual(PORTRAIT.left);
    expect(u.x + u.width).toBeLessThanOrEqual(390 - PORTRAIT.right);
    expect(u.y).toBeGreaterThanOrEqual(PORTRAIT.top);
    expect(u.y + u.height).toBeLessThanOrEqual(844 - PORTRAIT.bottom);
    // a tap on the picture does not unlock
    await page.touchscreen.tap(195, 844 * 0.4);
    await expect(page.locator('.stage.locked')).toHaveCount(1);
    // holding the unlock button does
    await expect(unlock).toBeVisible();
    const v = (await unlock.boundingBox())!;
    await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(800);
    await page.mouse.up();
    await expect(page.locator('.stage.locked')).toHaveCount(0);
  });

  test('scrubbing holds the dock and commits on release', async ({ page, api: _api }) => {
    await page.clock.install();
    await openPhoneEpisode(page);
    await expect.poll(() => page.evaluate(() => !document.querySelector('video')!.paused)).toBe(true);
    await showControls(page);
    const track = (await page.locator('.ctl .track').boundingBox())!;
    const cy = track.y + track.height / 2;
    // the touch target is at least 44 px tall (the rail itself is 3 px)
    for (const dy of [-22, 22]) expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('.track')), [track.x + track.width / 2, cy + dy])).toBe(true);
    const tipOk = async () => {
      const tip = page.locator('.ctl .tip');
      await expect(tip).toBeVisible();
      const t = (await tip.boundingBox())!;
      expect(t.y + t.height).toBeLessThanOrEqual(track.y + 0.5);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(390);
      expect(t.y).toBeGreaterThanOrEqual(0);
    };
    await page.mouse.move(track.x + track.width * 0.2, cy);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 0.6, cy, { steps: 4 });
    await page.clock.runFor(4000);
    await expect(page.locator('.ctl')).not.toHaveClass(/\bhide\b/);
    await tipOk();
    await page.mouse.move(track.x + track.width * 0.99, cy, { steps: 4 });
    await tipOk();
    await page.mouse.up();
    const d = await page.evaluate(() => document.querySelector('video')!.duration);
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(d * 0.97);
  });

  test('iOS: no mute anywhere; fullscreen in More', async ({ page, api: _api }) => {
    await forceIosVolume(page);
    await openPhoneEpisode(page);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await showControls(page);
    await expect(page.getByRole('button', { name: /^(Stumm|Ton an)$/ })).toHaveCount(0);
    await expect(page.locator('.pill').getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
    await page.locator('.pill.tp').getByRole('button', { name: 'Mehr', exact: true }).tap();
    const more = page.getByRole('dialog', { name: 'Mehr' });
    await expect(more.getByRole('button', { name: 'Vollbild' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Stumm|Ton an)$/ })).toHaveCount(0);
  });

  test('mute lives in More where the volume works', async ({ page, api: _api }) => {
    await openPhoneEpisode(page);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await showControls(page);
    await expect(page.locator('.pill, .ptop').getByRole('button', { name: /^(Stumm|Ton an)$/ })).toHaveCount(0);
    await page.locator('.pill.tp').getByRole('button', { name: 'Mehr', exact: true }).tap();
    const more = page.getByRole('dialog', { name: 'Mehr' });
    const mute = more.getByRole('button', { name: /^(Stumm|Ton an)$/ });
    await expect(mute).toBeVisible();
    const was = await page.evaluate(() => document.querySelector('video')!.muted);
    await mute.tap();
    expect(await page.evaluate(() => document.querySelector('video')!.muted)).toBe(!was);
  });

  test('kids on a phone keep today\'s player', async ({ page, api: _api }) => {
    const KID = { ...ME, profileCount: 2, kids: true, onboarded: true, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(() => { localStorage.setItem('ff-intro:p3', JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); });
    await mockPlayer(page);
    await page.goto('/watch/' + MOVIE.id);
    await videoReady(page);
    await expect(page.locator('.stage.phone')).toHaveCount(1);
    await expect(page.locator('.cc')).toHaveCount(1);
    await expect(page.locator('.stage.pui')).toHaveCount(0);
    await expect(page.locator('.top .ttl')).toBeVisible();
  });
});

for (const vp of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
  test.describe(`small phone ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: vp });
    test('small phones: 320×568 and 568×320 keep the dock apart', async ({ page, api: _api }) => {
      await openLong(page);
      await dockChecks(page, NONE);
      expect(await noHorizontalOverflow(page)).toBe(true);
    });
  });
}

for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) test.describe(`phone player, party ${vp.width}×${vp.height}`, () => {
  test.use({ viewport: vp });
  test('watch party: the top inset applies once, one scrim; the party tools fit the dock', async ({ page, api: _api }) => {
    await forceSafeArea(page, PORTRAIT);
    await mockPlayer(page);
    await page.routeWebSocket(/\/ws\/party\//, (ws) => {
      ws.send(JSON.stringify({ t: 'welcome', you: 'u2', hostId: 'u1', mode: 'host', itemId: items[0]!.id, title: 'Testfilm', members: [{ id: 'u1', name: 'Mia', buffering: false }, { id: 'u2', name: 'Ben', buffering: false }], state: { playing: false, position: 0, at: Date.now(), hold: false }, serverNow: Date.now() }));
      ws.onMessage((m) => { const msg = JSON.parse(String(m)); if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() })); });
    });
    await page.goto('/party/room1');
    await expect(page.locator('.stage.pui')).toHaveCount(1);
    await showControls(page);
    const back = (await page.locator('.ovl .top .icon-btn').first().boundingBox())!;
    expect(back.y).toBeGreaterThanOrEqual(PORTRAIT.top);
    expect(back.y).toBeLessThanOrEqual(PORTRAIT.top + 16);
    const top = page.locator('.ovl .top');
    expect(await top.evaluate((e) => getComputedStyle(e).paddingTop)).toBe('0px');
    expect(await top.evaluate((e) => getComputedStyle(e).backgroundImage)).toBe('none');
    // the party's own buttons, title and avatars never run into the top bar's end
    const bar = (await boxes(page, ['.ptop']))[0] as Box;
    for (const el of await page.locator('.ovl .top :is(button, .ttl, .avatars)').all()) {
      const r = await el.boundingBox();
      if (!r) continue; // not rendered (e.g. no avatars yet)
      const name = (await el.getAttribute('aria-label')) ?? (await el.getAttribute('class')) ?? '';
      expect.soft(overlap({ name, x: r.x, y: r.y, w: r.width, h: r.height }, bar), `${name} overlaps the top bar`).toBe(false);
      expect.soft(r.x + r.width, `${name} right`).toBeLessThanOrEqual(vp.width - 16 + 0.5);
    }
    // the party adds its own tools (chat, who controls): both pills stay on screen, apart and below the timeline
    const [lp, tp, tl] = (await boxes(page, ['.pill.lp', '.pill.tp', '.ctl .tlrow'])) as [Box, Box, Box];
    for (const b of [lp, tp]) { expect(b.x).toBeGreaterThanOrEqual(16 - 0.5); expect(b.x + b.w).toBeLessThanOrEqual(vp.width - 16 + 0.5); expect(b.y).toBeGreaterThanOrEqual(tl.y + tl.h); }
    expect(overlap(lp, tp)).toBe(false);
    for (const b of await page.locator('.pill button').all()) { const r = (await b.boundingBox())!; expect.soft(r.width).toBeGreaterThanOrEqual(44); expect.soft(r.height).toBeGreaterThanOrEqual(44); }
    if (process.env.PHONE_SHOTS) await page.screenshot({ path: `${process.env.PHONE_SHOTS}/party-${vp.width}.png` });
  });
});

/** "still watching": nobody touched anything for over 90 minutes (the page clock jumps ahead before the credits) */
for (const vp of [{ width: 844, height: 390 }, { width: 568, height: 320 }]) {
  test.describe(`still watching card ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: vp });
    test('the still-watching card stays between the top bar and the dock', async ({ page, api: _api }) => {
      await forceSafeArea(page, LAND_L);
      await page.clock.install();
      await openPhoneEpisode(page, undefined, { next: episodes[3] });
      await page.evaluate(() => document.querySelector('video')!.pause());
      await page.clock.fastForward(91 * 60_000);
      await expect.poll(() => page.evaluate(() => { const v = document.querySelector('video')!; if (v.currentTime < 575) v.currentTime = 580; return !v.seeking && v.currentTime > 575; })).toBe(true);
      await page.evaluate(() => document.querySelector('video')!.pause());
      const card = page.locator('.next.still');
      await expect(card).toBeVisible();
      await expect(page.locator('.ctl.hide')).toHaveCount(0);
      const [c, back, bar, dock] = (await boxes(page, ['.next.still', '.top .icon-btn', '.ptop', '.ctl .ptitle'])) as [Box, Box, Box, Box];
      for (const o of [back, bar, dock]) expect(overlap(c, o), `card overlaps ${o.name}`).toBe(false);
      expect(c.y).toBeGreaterThanOrEqual(Math.max(back.y + back.h, bar.y + bar.h));
      expect(c.y + c.h).toBeLessThanOrEqual(dock.y);
      // its buttons stay reachable (scrolled into view inside the card when it is short)
      const go = card.getByRole('button', { name: 'Weiter ansehen' });
      await go.scrollIntoViewIfNeeded();
      await expect(go).toBeVisible();
      if (process.env.PHONE_SHOTS) await page.screenshot({ path: `${process.env.PHONE_SHOTS}/still-${vp.width}.png` });
    });
  });
}

test.describe('phone player, skip leaving (motion on)', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  test('the title glides down when the skip row goes, never jumps', async ({ page, api: _api }) => {
    await forceSafeArea(page, PORTRAIT);
    await openLong(page);
    const r = await page.evaluate(() => new Promise<{ tops: number[] }>((res) => {
      const ptx = document.querySelector('.ptx')!, tops: number[] = [];
      const t0 = performance.now();
      // read after each frame's layout + resize observers (a task after the frame), i.e. what was painted
      const tick = () => setTimeout(() => { tops.push(ptx.getBoundingClientRect().top); if (performance.now() - t0 < 1400) requestAnimationFrame(tick); else res({ tops }); }, 0);
      requestAnimationFrame(tick);
      (document.querySelector('.ptitle .skipbtn') as HTMLButtonElement).click();
    }));
    await expect(page.locator('.ptitle .skipbtn')).toHaveCount(0);
    const first = r.tops[0]!, last = r.tops.at(-1)!;
    expect(last - first).toBeGreaterThan(40); // the row (44 px + 10 px gap) is gone: the text sits lower
    // a glide: painted frames in between the two places (one jump would have none), and never past the end
    const between = r.tops.filter((y) => y > first + 5 && y < last - 5);
    expect(between.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...r.tops)).toBeLessThanOrEqual(last + 1);
  });
});
