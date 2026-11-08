// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { mockPlayer, videoReady } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';
import { noHorizontalOverflow } from '../helpers.js';

/** Block 17 P1 on a phone: cast & info opens from More (phone player, spec 2026-11-08 block 4), the scenes panel spans the width. */
const SHOTS = process.env.P1_SHOTS;
/** the control bar hides after 3 s of playback: a tap on the picture brings it back (only when hidden; a second tap would hide it) */
const showControls = async (page: import('@playwright/test').Page) => {
  if (await page.locator('.ctl.hide').count()) await page.locator('.stage').tap({ position: { x: 195, y: 300 } });
  await expect(page.locator('.ctl.hide')).toHaveCount(0);
};

test('phone: cast & info from More -> panel, scenes panel, no horizontal overflow', async ({ page, api: _api }) => {
  await mockPlayer(page);
  await page.goto('/watch/' + MOVIE.id);
  await videoReady(page);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await showControls(page);
  await expect(page.locator('.pill').getByRole('button', { name: 'Besetzung & Infos' })).toHaveCount(0); // not in the pills
  await page.getByRole('button', { name: 'Mehr', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Mehr' }).getByRole('button', { name: 'Besetzung & Infos' }).tap();
  const ci = page.getByRole('complementary', { name: 'Besetzung & Infos' });
  await expect(ci.getByText('Lena Doria')).toBeVisible();
  await expect(ci.getByText('als Dom Cobb')).toBeVisible();
  await expect(ci.getByText('Mehr: I')).toHaveCount(0); // no key hint on touch
  const box = (await ci.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await noHorizontalOverflow(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-castinfo.png` });
  await ci.getByRole('button', { name: 'Besetzung & Infos schließen' }).tap();
  await expect(ci).toHaveCount(0);

  await showControls(page);
  await page.getByRole('button', { name: 'Mehr', exact: true }).tap(); // phones: scenes live in "More"
  await page.getByRole('button', { name: 'Szenen', exact: true }).tap();
  const scenes = page.getByRole('dialog', { name: 'Szenen' });
  await expect(scenes.getByRole('button', { name: /^Die Verfolgung/ })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-scenes.png` });
});
