// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

test('phone: cards stack and buttons are ≥ 44 px', async ({ page }) => {
  await page.goto('/me/account');
  const cards = ['Profil', 'Sicherheit', 'Sitzungen & Geräte'].map((name) => page.getByRole('region', { name }));
  await expect(cards[2]!).toBeVisible();
  // one column: same left edge, each below the previous one
  const boxes = await Promise.all(cards.map((c) => c.boundingBox()));
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(1);
    expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
  // every button and the manage link are comfortable touch targets
  const targets = page.locator('main').getByRole('button').or(page.locator('main').getByRole('link', { name: /Anmeldeseite/ }));
  const n = await targets.count();
  expect(n).toBeGreaterThan(10);
  for (let i = 0; i < n; i++) {
    const b = await targets.nth(i).boundingBox();
    expect(b!.height, await targets.nth(i).innerText()).toBeGreaterThanOrEqual(44);
  }
  // the confirm dialog fits the phone screen
  await page.getByRole('button', { name: 'Alle anderen Geräte abmelden' }).tap();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abmelden' }).tap();
  await expect(page.getByText('2 andere Sitzungen beendet.')).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('phone: delete dialog fits the screen', async ({ page }) => {
  await page.goto('/me/account');
  const link = page.getByRole('region', { name: 'Deine Daten' }).getByRole('link', { name: 'Meine Daten herunterladen' });
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Konto löschen …' }).tap();
  const dlg = page.getByRole('dialog', { name: 'Konto löschen?' });
  await expect(dlg).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await dlg.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(await noHorizontalOverflow(page)).toBe(true);
  const targets = dlg.getByRole('button').or(dlg.getByRole('link'));
  const n = await targets.count();
  expect(n).toBe(3); // download, cancel, delete
  for (let i = 0; i < n; i++) expect((await targets.nth(i).boundingBox())!.height, await targets.nth(i).innerText()).toBeGreaterThanOrEqual(44);
  // the last control can be reached on the phone
  await expect(dlg.getByRole('button', { name: 'Mein Konto löschen' })).toBeInViewport();
});

test('phone: the mail switches are ≥ 44 px and the card fits', async ({ page }) => {
  await page.goto('/me/account');
  const mail = page.getByRole('region', { name: 'E-Mails' });
  const sws = mail.getByRole('switch');
  await expect(sws).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await sws.nth(i).scrollIntoViewIfNeeded();
    const b = (await sws.nth(i).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
  }
  await sws.nth(1).tap();
  await expect(sws.nth(1)).toHaveAttribute('aria-checked', 'false');
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('phone: with the admin block every switch is ≥ 44 px, nothing overflows and the card does not move', async ({ page, api }) => {
  api.accountMail = { ...api.accountMail, admin: true };
  // a slow mail answer; from the first frame the card exists, every frame records its size and its switches (not its place: the
  // sessions card above fills in its own list later and moves everything below it)
  await page.route('**/api/account/mail', async (r) => { if (r.request().method() === 'GET') await new Promise((f) => setTimeout(f, 400)); await r.fallback(); });
  await page.addInitScript(() => {
    const w = window as unknown as { mailBoxes: Array<{ height: number; width: number; switches: number }> };
    w.mailBoxes = [];
    const tick = () => {
      const el = document.getElementById('mail');
      if (el) {
        const r = el.getBoundingClientRect();
        w.mailBoxes.push({ height: Math.round(r.height), width: Math.round(r.width), switches: el.querySelectorAll('[role="switch"]').length });
      }
      if (w.mailBoxes.length < 90) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto('/me/account');
  const mail = page.getByRole('region', { name: 'E-Mails' });
  const sws = mail.getByRole('switch');
  await expect(sws).toHaveCount(8);
  await expect(mail.getByRole('heading', { level: 3, name: 'Für Admins' })).toBeVisible();
  // first paint of the card on: about 1.5 s of frames, one size, all eight switches from the first frame
  await expect.poll(() => page.evaluate(() => (window as unknown as { mailBoxes: unknown[] }).mailBoxes.length), { timeout: 5000 }).toBe(90);
  const boxes = await page.evaluate(() => (window as unknown as { mailBoxes: Array<{ height: number; width: number; switches: number }> }).mailBoxes);
  expect(boxes[0]!.switches).toBe(8);
  for (const b of boxes) expect(b).toEqual(boxes[0]);
  for (let i = 0; i < 8; i++) {
    await sws.nth(i).scrollIntoViewIfNeeded();
    const b = (await sws.nth(i).boundingBox())!;
    expect(b.height, `switch ${i}`).toBeGreaterThanOrEqual(44);
    expect(b.width, `switch ${i}`).toBeGreaterThanOrEqual(44);
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
});
