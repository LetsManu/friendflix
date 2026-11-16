// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dialogs share one frame (menus glass stage 1, Task 4): a 24 px glass panel, one title / body / status line and one button
 * row, [secondary, primary] in the DOM with the primary on the right, every button a 44 px pill. Desktop 1440×900 (mocked API).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { dialogActs } from '../helpers.js';
import { auid, type MatrixMockRole } from '../mocks/admin.js';

const ACC_FILL = 'rgb(214, 50, 90)'; // --acc-fill
const DANGER = 'rgb(196, 32, 47)'; // --danger

const extraRole = (api: { admin: { matrix: { roles: MatrixMockRole[] } } }, key: string, label: string, accounts = 0, invites = 0): void => {
  const family = api.admin.matrix.roles.find((r) => r.key === 'family')!;
  api.admin.matrix.roles.splice(4, 0, { ...family, key, label, builtinLabel: false, origin: 'admin', accounts, profiles: accounts ? 3 : 0, kidsProfiles: 0, invites, values: { ...family.values } });
};
const rowMenu = async (page: Page, role: string) => {
  await page.getByRole('button', { name: `Aktionen für ${role}` }).click();
  return page.getByRole('dialog', { name: role });
};

/** the shared frame and button row: the panel's 24 px corners; [secondary, primary] side by side, the primary on the right */
async function sharedRules(dlg: Locator, names: [string, string], primaryBg: string) {
  expect(await dlg.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px');
  expect(await dlg.evaluate((el) => getComputedStyle(el).getPropertyValue('--fr-r-panel').trim())).toBe('24px');
  const a = await dialogActs(dlg);
  expect(a.names).toEqual(names);
  const [sec, pri] = a.btns as [typeof a.btns[0], typeof a.btns[0]];
  expect(pri.x).toBeGreaterThan(sec.x + sec.width - 1);
  expect(Math.abs(pri.y - sec.y)).toBeLessThan(1);
  // the row ends at the panel's right content edge
  expect(Math.abs(pri.x + pri.width - (a.row.x + a.row.width))).toBeLessThan(1);
  for (const b of a.btns) {
    expect(b.height).toBe(44);
    expect(b.radius).toBe('999px'); // --fr-r-pill
  }
  expect(sec.glass).toBe(true);
  expect(pri.glass).toBe(false);
  expect(pri.bg).toBe(primaryBg);
}

test.use({ viewport: { width: 1440, height: 900 } });
// a desktop with a classic scrollbar (Playwright's headless Chromium hides scrollbars by default): the page lock must not move
// anything sideways. The launch options repeat the config's (PW_CHROMIUM), plus the scrollbars.
test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined, args: process.env.PW_CHROMIUM ? ['--no-sandbox'] : [], ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.beforeEach(({ api }) => { api.asAdmin = true; });

test('Neue Rolle: no dead space above the buttons, one focus ring, the shared frame and row', async ({ page, api }) => {
  api.admin.matrix.features.livetv = true;
  await page.goto('/admin/roles');
  await page.getByRole('button', { name: 'Neue Rolle' }).click();
  const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
  const name = dlg.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  // one ring: the white outline 2 px off the field, no box-shadow ring with it
  const ring = await name.evaluate((el) => { const cs = getComputedStyle(el); return { shadow: cs.boxShadow, w: cs.outlineWidth, style: cs.outlineStyle, off: cs.outlineOffset, color: cs.outlineColor }; });
  expect(ring).toEqual({ shadow: 'none', w: '2px', style: 'solid', off: '2px', color: 'rgb(255, 255, 255)' });
  // between the last option and the buttons only the reserved status line (10 + 22 + 8 px), nothing else
  const last = (await dlg.locator('.opt').last().boundingBox())!;
  const acts = (await dlg.locator('.dlg-acts').boundingBox())!;
  const err = (await dlg.locator('.dlg-err').boundingBox())!;
  expect(err.height).toBeGreaterThanOrEqual(22);
  expect(err.y).toBeGreaterThan(last.y + last.height);
  expect(acts.y - (last.y + last.height)).toBeLessThanOrEqual(40);
  await sharedRules(dlg, ['Abbrechen', 'Anlegen'], ACC_FILL);
  // the shared title
  expect(await dlg.locator('.dlg-title').evaluate((el) => { const cs = getComputedStyle(el); return [cs.fontSize, cs.fontWeight]; })).toEqual(['21px', '800']);
  // each description is one line
  for (const d of await dlg.locator('.opt .de').all()) expect((await d.boundingBox())!.height).toBeLessThan(24);
});

test('Neue Rolle: a busy Anlegen keeps its width (the spinner sits over the hidden label)', async ({ page }) => {
  await page.goto('/admin/roles');
  await page.getByRole('button', { name: 'Neue Rolle' }).click();
  const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/admin/roles', async (r) => { if (r.request().method() === 'POST') { await held; await r.abort(); } else await r.fallback(); });
  await dlg.getByRole('textbox', { name: 'Name' }).fill('Hafenblick');
  const ok = dlg.getByRole('button', { name: 'Anlegen' });
  const before = (await ok.boundingBox())!;
  await ok.click();
  await expect(ok).toHaveAttribute('aria-busy', 'true');
  const busy = (await ok.boundingBox())!;
  expect(busy.width).toBe(before.width);
  expect(busy.height).toBe(before.height);
  // the spinner sits in the middle of the button
  const sp = (await ok.locator('.spinner').boundingBox())!;
  expect(Math.abs(sp.x + sp.width / 2 - (busy.x + busy.width / 2))).toBeLessThan(1.5);
  // the label is still the button's name (transparent, not hidden), and it is not seen
  await expect(ok).toHaveAccessibleName('Anlegen');
  expect(await ok.locator('.ui-lbl').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  release();
});

test.describe('the delete dialogs', () => {
  test.use({ allowedConsole: /status of 409/ });

  test('Rolle löschen (people move first): the shared frame, a solid red Löschen on the right', async ({ page, api }) => {
    extraRole(api, 'oma', 'Oma', 2, 1);
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Oma')).getByRole('button', { name: 'Löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Rolle „Oma“ löschen?' });
    await dlg.getByRole('combobox', { name: 'Neue Rolle' }).selectOption({ label: 'Freund' });
    await sharedRules(dlg, ['Abbrechen', 'Löschen'], DANGER);
    await expect(dlg.locator('.dlg-title')).toHaveText('Rolle „Oma“ löschen?');
    await expect(dlg.locator('.dlg-body')).toContainText('2 Personen und 1 offene Einladung');
  });

  test('the confirm dialog (a role nobody holds): the same frame and row', async ({ page, api }) => {
    extraRole(api, 'leer', 'Leer');
    await page.goto('/admin/roles');
    await (await rowMenu(page, 'Leer')).getByRole('button', { name: 'Löschen' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Rolle „Leer“ löschen?' });
    await expect(dlg.locator('.dlg-body')).toContainText('Die Rolle wird entfernt.');
    await sharedRules(dlg, ['Abbrechen', 'Löschen'], DANGER);
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dlg).toHaveCount(0);
  });
});

test('a dialog over a scrolled page with a classic scrollbar: the fixed header, the sticky side bar and the page content stay put', async ({ page, api }) => {
  extraRole(api, 'oma', 'Oma', 2, 1);
  extraRole(api, 'leer', 'Leer');
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/admin/roles');
  await expect(page.getByRole('heading', { level: 1, name: 'Rollen & Rechte' })).toBeVisible();
  // the page scrolls and has a real scrollbar
  expect(await page.evaluate(() => innerWidth - document.documentElement.clientWidth)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const header = page.getByRole('button', { name: /^Profilmenü/ }); // right-aligned in the fixed header: it would move first
  const brand = page.getByRole('link', { name: 'FriendFlix Startseite' });
  const content = page.getByRole('list', { name: 'Rollen' });
  // sticky: the admin side bar would re-anchor to <body> (and jump) if the lock made <body> a scroll container
  const side = page.getByRole('navigation', { name: 'Admin-Bereiche' });
  const boxes = async () => ({ header: await header.boundingBox(), brand: await brand.boundingBox(), content: await content.boundingBox(), side: await side.boundingBox(), y: await page.evaluate(() => scrollY) });
  const before = await boxes();
  expect(before.side!.y).toBeGreaterThan(0); // stuck below the header, on screen
  // a script click: Playwright's own click would first scroll the button (now under the fixed header) into view
  await page.getByRole('button', { name: 'Neue Rolle' }).evaluate((b: HTMLElement) => b.click());
  const dlg = page.getByRole('dialog', { name: 'Neue Rolle' });
  await expect(dlg).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
  expect(await boxes()).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await boxes()).toEqual(before);
  // unlocked again: the page scrolls
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
  await page.mouse.wheel(0, 120);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before.y);
});

test('a plain (not dangerous) confirm: white text on the coral confirm button', async ({ page }) => {
  await page.goto(`/admin/users/${auid(2)}`);
  await page.getByRole('button', { name: 'Aktionen', exact: true }).click();
  await page.getByRole('dialog', { name: 'Anna Beispiel' }).getByRole('button', { name: 'Passwort-Link senden' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'Passwort-Link an Anna Beispiel senden?' });
  await sharedRules(dlg, ['Abbrechen', 'Senden'], ACC_FILL);
  const ok = dlg.getByRole('button', { name: 'Senden' });
  expect(await ok.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
  expect(await dlg.getByRole('button', { name: 'Abbrechen' }).evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dlg).toHaveCount(0);
});

test.describe('with full motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the glass stays frosted while the dialog fades in: no ancestor of the panel goes below opacity 1, the scrim fades on its own', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('ff-intro-seen', '1');
      localStorage.setItem('ff-intro:p1', JSON.stringify({ show: false, sound: false }));
      (window as unknown as { __ffDeskGuard: unknown }).__ffDeskGuard = { slowMs: 1000, frames: 8 }; // a guard no test host trips
    });
    // a tenth of the speed: the 220 ms open spans many frames to sample (the keyframes are the same)
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
    await page.goto('/admin/roles');
    await expect(page.locator('html')).toHaveClass(/(^|\s)m-glass(\s|$)/);
    await page.evaluate(() => {
      const w = window as unknown as { __dlgFrames: Array<{ panel: number; scrim: number; ancestors: number; blur: string }> };
      w.__dlgFrames = [];
      const t0 = performance.now();
      const step = () => {
        const dlg = document.querySelector<HTMLElement>('.ff-dlg');
        if (dlg) {
          let lowest = 1;
          for (let e = dlg.parentElement; e; e = e.parentElement) lowest = Math.min(lowest, Number(getComputedStyle(e).opacity));
          const scrim = dlg.parentElement!.querySelector('.scrim');
          w.__dlgFrames.push({ panel: Number(getComputedStyle(dlg).opacity), scrim: scrim ? Number(getComputedStyle(scrim).opacity) : -1, ancestors: lowest, blur: getComputedStyle(dlg).backdropFilter });
        }
        if (performance.now() - t0 < 3500) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    await page.getByRole('button', { name: 'Neue Rolle' }).click();
    await expect(page.getByRole('dialog', { name: 'Neue Rolle' })).toBeVisible();
    await page.waitForTimeout(3600);
    const frames = await page.evaluate(() => (window as unknown as { __dlgFrames: Array<{ panel: number; scrim: number; ancestors: number; blur: string }> }).__dlgFrames);
    const mid = frames.filter((f) => f.panel > 0.05 && f.panel < 0.95);
    expect(mid.length, JSON.stringify(frames.slice(0, 8))).toBeGreaterThan(3); // the open was caught mid-flight, several times
    for (const f of frames) {
      expect(f.ancestors, JSON.stringify(f)).toBe(1); // the panel's backdrop root stays the page: the blur sees what is behind
      expect(f.blur, JSON.stringify(f)).toContain('blur(38px)');
    }
    expect(frames.some((f) => f.scrim > 0 && f.scrim < 1)).toBe(true); // the scrim fades as its own layer
    expect(frames.at(-1)).toMatchObject({ panel: 1, scrim: 1, ancestors: 1 });
  });
});
