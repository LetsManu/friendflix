// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { chromecastRemote, DIAG_SHOTS, dunmoor, leaveRemoteTo, seedCastLog, type LogSeed } from './cast-remote-setup.js';

/** /diagnose, casting section on a phone: nothing overflows, targets are 44 px, the table reads as stacked rows. */
dunmoor();

const T = Date.UTC(2026, 10, 9, 21, 14, 0);
const LOG: LogSeed[] = [
  { at: T, level: 'info', tag: 'session', text: 'session adopted · airplay · S1 E4' },
  { at: T + 180_000, level: 'info', tag: 'session', text: 'session started · Wohnzimmer-TV' },
  { at: T + 200_000, level: 'warn', tag: 'network', text: 'TV buffering for more than 2 s' },
  { at: T + 210_000, level: 'error', tag: 'load', text: 'token request refused · HTTP 429' },
];

test.describe('/diagnose casting (phone)', () => {
  test('fits the screen and its buttons are 44 px', async ({ page, api: _api }) => {
    test.setTimeout(45_000);
    await seedCastLog(page, LOG);
    await chromecastRemote(page);
    await leaveRemoteTo(page, '/diagnose');
    const sec = page.getByTestId('diagnose-cast');
    await expect(sec.getByTestId('diagnose-cast-cc')).toContainText('Gültig');
    const m = await sec.evaluate((el) => {
      const vw = document.documentElement.clientWidth;
      const small = [...el.querySelectorAll<HTMLElement>('button')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && (r.height < 44 || r.width < 44)).length;
      return { over: Math.max(...[...el.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right)) - vw, scrolls: document.documentElement.scrollWidth - vw, small };
    });
    expect(m.small).toBe(0);
    expect(m.over).toBeLessThanOrEqual(0.5);
    expect(m.scrolls).toBeLessThanOrEqual(0);
    await expect(sec.getByTestId('cast-events').getByRole('row', { name: /network/ })).toContainText('Warnung');
  });
});

test.describe('screenshots', () => {
  test.use({ deviceScaleFactor: 1 });
  test('phone 390', async ({ page, api: _api }) => {
    test.setTimeout(45_000);
    await seedCastLog(page, LOG, ['Wohnzimmer-TV']);
    await chromecastRemote(page);
    await leaveRemoteTo(page, '/diagnose');
    await expect(page.getByTestId('diagnose-cast-cc')).toContainText('Gültig');
    await page.waitForTimeout(500);
    await page.getByTestId('diagnose-cast').screenshot({ path: `${DIAG_SHOTS}/phone-390.png` });
  });
});
