// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { episodes, SERIES } from '../mocks/fixtures.js';
import { offer } from '../mocks/handoff.js';
import { dunmoor } from './cast-remote-setup.js';

/** Device hand-off, the title page's hint on the phone page (spec device hand-off 2.5): the line under the buttons, no extra row. */
dunmoor();

test('series page: the line is replaced in place, the play link starts at the position', async ({ page, api }) => {
  await page.route('**/api/library/nextup*', (r) => r.fulfill({ json: { items: [episodes[0]] } }));
  await page.goto('/item/' + SERIES.id);
  const playBtn = page.locator('.dbody a.play');
  const line = page.locator('.dbody p.resume');
  await expect(line).toContainText('Noch');
  const before = { play: (await playBtn.boundingBox())!, line: (await line.boundingBox())! };
  api.handoff.byItem[SERIES.id] = offer();
  await page.reload();
  await expect(line).toHaveText('S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)');
  await expect(playBtn).toHaveAttribute('href', /[?&]t=1390$/);
  await expect(playBtn).toHaveAccessibleName('Weiter S1·F4, weiter ab 23:10, zuletzt auf LG-Fernseher');
  const after = { play: (await playBtn.boundingBox())!, line: (await line.boundingBox())! };
  expect(after.play).toEqual(before.play);
  expect(after.line.y).toBe(before.line.y);
  expect(after.line.height).toBe(before.line.height);
});

for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test(`phone ${vp.width}: the late long hint moves nothing`, async ({ page, api }) => {
    await page.setViewportSize(vp);
    api.handoff.byItem[SERIES.id] = offer({ positionTicks: 50_000_000_000, device: { kind: 'web', name: 'Safari auf iPhone', via: 'airplay' } });
    let release = () => {};
    const gate = new Promise<void>((ok) => { release = ok; });
    await page.route('**/api/handoff*', async (r) => { await gate; await r.fallback(); });
    await page.route('**/api/library/nextup*', (r) => r.fulfill({ json: { items: [episodes[0]] } }));
    await page.goto('/item/' + SERIES.id);
    const line = page.locator('.dbody p.resume');
    await expect(line).toContainText('Noch');
    await page.waitForTimeout(600);
    const sels = ['.dbody a.play', '.dbody p.resume', '.dbody .syn', '.dbody .lab', '[role=tablist]'];
    const get = () => Promise.all(sels.map((s) => page.locator(s).first().boundingBox()));
    const before = await get();
    release();
    await expect(line).toContainText('Weiter ab 1:23:20');
    await page.waitForTimeout(300);
    expect(await get()).toEqual(before);
    await expect(page.locator('.dbody a.play')).toHaveAccessibleName(/zuletzt auf AirPlay \(Safari auf iPhone\)$/);
  });
}
