// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MOVIE } from '../mocks/fixtures.js';
import { mockServerBusy } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/** Live TV 1a: the conversion budget is full (spec §5.5). A copyable title plays as a copy ("Server ausgelastet"), the rest gets 503 and an honest, quiet state. */
test.describe('player: server busy', () => {
  // the short test stream ends during these tests: the post-play screen would cover the controls (postplay.spec.ts)
  test.beforeEach(({ api }) => { api.features = { requests: true, postplay: false }; });

  test('copy fallback shows the chip reason', async ({ page, api: _api }) => {
    await mockServerBusy(page, 'copy');
    await page.goto('/watch/' + MOVIE.id);
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
    const chip = page.getByRole('button', { name: /Umgewandelt/ });
    await expect(chip).toBeVisible();
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Server ausgelastet' })).toBeVisible();
  });

  test.describe('503', () => {
  test.use({ allowedConsole: /503/ }); // the mocked refusal is logged by the browser
  test('503 shows the message and retries only on request', async ({ page, api: _api }) => {
    const st = await mockServerBusy(page, 'busy');
    await page.goto('/watch/' + MOVIE.id);
    const box = page.getByRole('alertdialog');
    await expect(box).toContainText('Server gerade ausgelastet. Versuch es gleich noch einmal.');
    const retry = box.getByRole('button', { name: 'Erneut versuchen' });
    await expect(retry).toBeVisible();
    await expect(page.locator('.spin')).toHaveCount(0); // not a spinner, not "Verbindung unterbrochen"
    await expect(page.getByText('Verbindung unterbrochen')).toHaveCount(0);
    const asked = st.calls;
    expect(asked).toBeGreaterThan(0);
    // no automatic backoff: nothing is asked again for 5 s (a negative check: the wait is the point)
    await page.waitForTimeout(5000);
    expect(st.calls).toBe(asked);
    await expect(box).toContainText('Server gerade ausgelastet');
    // on request: asks again; still busy -> the same message; then free -> plays
    await retry.click();
    await expect.poll(() => st.calls).toBe(asked + 1);
    await expect(box).toContainText('Server gerade ausgelastet');
    st.mode = 'copy';
    await box.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  });
  });
});
