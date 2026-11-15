// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

// Recording from the live player (Phase 3 Task 7, spec §15.1, §15.4, §20): the info panel's *Aufnehmen* on *Jetzt* and *Danach*
// opens the programme's detail sheet (RecordSheet); its *Aufnehmen* plans the recording, *Serie aufnehmen* a series rule; a
// conflict shows the §20 line in a reserved slot (nothing moves) with *Trotzdem planen* (force). Without `liveRecord` (guests) and
// for kids profiles there is no *Aufnehmen*. A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
const NOW = new Date(2026, 10, 12, 20, 37, 10);
const bar = (page: Page) => page.getByRole('group', { name: 'Wiedergabesteuerung' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Programm' });
const sheet = (page: Page, title: string) => page.getByRole('dialog', { name: title });
const live = (page: Page) => page.locator('[data-live-state]');
const KID = { ...ME, profileCount: 3, kids: true, onboarded: true, features: { livetv: true }, profile: { id: 'p3', name: 'Mia', avatar: 'pink', isOwner: false, kids: true, maxRating: 6 } };
const noIntro = () => { for (const id of ['p1', 'p2', 'p3']) localStorage.setItem(`ff-intro:${id}`, JSON.stringify({ show: false, sound: false })); sessionStorage.setItem('ff-profile-picked', '1'); };

async function arm(page: Page, api: MockState) {
  api.features = { livetv: true };
  await mockLivePlayer(page);
  await page.clock.install({ time: NOW });
}
async function openPanel(page: Page, id = 'ch-nord') {
  await page.goto(`/live/watch/${id}?f=all`);
  await expect(live(page)).toHaveAttribute('data-live-state', 'playing', { timeout: 15_000 });
  await page.mouse.move(600, 300);
  await page.mouse.move(620, 310);
  await bar(page).getByRole('button', { name: 'Programm' }).click();
  await expect(panel(page)).toBeVisible();
}

test.describe('recording from the live player', () => {
  test('info panel Aufnehmen schedules the running programme', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await expect(panel(page).getByText('Wird aufgenommen')).toHaveCount(0);
    // Jetzt and Danach each carry Aufnehmen
    await expect(panel(page).getByRole('button', { name: 'Aufnehmen' })).toHaveCount(2);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).first().click();

    const s = sheet(page, 'Die Leuchtturmwärter');
    await expect(s).toBeVisible();
    await expect(s).toContainText('1 Nordlicht TV');
    await expect(s).toContainText('20:15–21:00');
    await expect(s).toContainText('Zwei Wärter, eine Insel und ein Licht');
    await expect(s.getByRole('button', { name: 'Jetzt ansehen' })).toBeVisible(); // it runs
    await s.getByRole('button', { name: 'Aufnehmen', exact: true }).click();
    await expect.poll(() => api.livetv.recCalls).toEqual([`POST /api/livetv/recordings ${JSON.stringify({ channelId: 'ch-nord', start: new Date(2026, 10, 12, 20, 15).toISOString() })}`]);
    await expect(s.getByRole('button', { name: 'Aufnahme abbrechen' })).toBeVisible();

    // closing the sheet: the panel names it, the focus is back on the panel
    await page.keyboard.press('Escape');
    await expect(s).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('Wird aufgenommen')).toBeVisible();
  });

  test('the Danach programme plans a recording; Aufnahme abbrechen cancels it', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).nth(1).click();
    const s = sheet(page, 'Wetter am Hafen');
    await expect(s).toBeVisible();
    await expect(s.getByRole('button', { name: 'Jetzt ansehen' })).toHaveCount(0); // not on yet
    await s.getByRole('button', { name: 'Aufnehmen', exact: true }).click();
    await expect(s.getByRole('button', { name: 'Aufnahme abbrechen' })).toBeVisible();
    expect(api.livetv.recordings[0]!.state).toBe('scheduled');
    await s.getByRole('button', { name: 'Aufnahme abbrechen' }).click();
    await expect(s.getByRole('button', { name: 'Aufnehmen', exact: true })).toBeVisible();
    expect(api.livetv.recCalls.at(-1)).toBe(`DELETE /api/livetv/recordings/${api.livetv.recordings[0]!.id}`);
  });

  test.describe('a conflict', () => {
    test.use({ allowedConsole: /Failed to load resource: the server responded with a status of 409/ });
    test('conflict shows the warning without moving the buttons; Trotzdem planen sends force', async ({ page, api }) => {
      api.livetv.recConflict = { slots: { used: 3, limit: 2 }, parallel: { used: 2, max: 4 }, provider: null, conflict: true };
      await arm(page, api);
      await openPanel(page);
      await panel(page).getByRole('button', { name: 'Aufnehmen' }).nth(1).click();
      const s = sheet(page, 'Wetter am Hafen');
      const rec = s.getByRole('button', { name: 'Aufnehmen', exact: true });
      const series = s.getByRole('button', { name: 'Serie aufnehmen' });
      await expect(series).toBeVisible();
      const before = [(await rec.boundingBox())!, (await series.boundingBox())!];
      await rec.click();
      const line = s.getByText('Zu dieser Zeit sind schon 2 von 2 Umwandlungsplätzen für Aufnahmen verplant. Diese Aufnahme kann ausfallen.');
      await expect(line).toBeVisible();
      const after = [(await rec.boundingBox())!, (await series.boundingBox())!];
      for (let i = 0; i < 2; i++) { expect(after[i]!.y).toBeCloseTo(before[i]!.y, 0); expect(after[i]!.height).toBeCloseTo(before[i]!.height, 0); }
      await s.getByRole('button', { name: 'Trotzdem planen' }).click();
      await expect.poll(() => api.livetv.recCalls.length).toBe(2);
      expect(JSON.parse(api.livetv.recCalls[1]!.replace(/^POST \/api\/livetv\/recordings /, ''))).toEqual({ channelId: 'ch-nord', start: new Date(2026, 10, 12, 21, 0).toISOString(), force: true });
      await expect(s.getByRole('button', { name: 'Aufnahme abbrechen' })).toBeVisible();
      await expect(line).toHaveCount(0);
    });
  });

  test('Serie aufnehmen sends the rule', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).first().click();
    const s = sheet(page, 'Die Leuchtturmwärter');
    // the series options: only new episodes (on), this channel, keep at most …
    await expect(s.getByRole('switch', { name: 'Nur neue Folgen' })).toHaveAttribute('aria-checked', 'true');
    await expect(s.getByRole('button', { name: 'Nur dieser Sender' })).toHaveAttribute('aria-pressed', 'true');
    await s.getByRole('button', { name: 'Alle Sender' }).click();
    await expect(s.getByText('Alle behalten')).toBeVisible();
    await s.getByRole('button', { name: 'Weniger behalten' }).click();
    await s.getByRole('button', { name: 'Weniger behalten' }).click();
    await expect(s.getByText('Höchstens 9 behalten')).toBeVisible();
    await s.getByRole('button', { name: 'Serie aufnehmen' }).click();
    await expect.poll(() => api.livetv.recCalls.length).toBe(1);
    expect(JSON.parse(api.livetv.recCalls[0]!.replace(/^POST \/api\/livetv\/rules /, ''))).toEqual({
      kind: 'series', channelId: null, seriesKey: 'die leuchtturmwärter', title: 'Die Leuchtturmwärter', onlyNew: true, keepMax: 9,
    });
    await expect(s.getByRole('button', { name: 'Serie nicht mehr aufnehmen' })).toBeVisible();
  });

  test('Vorlauf / Nachlauf under Mehr go with the recording', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).nth(1).click();
    const s = sheet(page, 'Wetter am Hafen');
    await s.getByRole('button', { name: 'Mehr', exact: true }).click();
    await s.getByRole('button', { name: 'Vorlauf: eine Minute mehr' }).click();
    await s.getByRole('button', { name: 'Nachlauf: eine Minute weniger' }).click();
    await s.getByRole('button', { name: 'Aufnehmen', exact: true }).click();
    await expect.poll(() => api.livetv.recCalls.length).toBe(1);
    expect(JSON.parse(api.livetv.recCalls[0]!.replace(/^POST \/api\/livetv\/recordings /, ''))).toEqual({ channelId: 'ch-nord', start: new Date(2026, 10, 12, 21, 0).toISOString(), padBefore: 3, padAfter: 4 });
  });

  test('the padding starts at the admin\'s defaults', async ({ page, api }) => {
    api.livetv.recPadDefaults = { before: 4, after: 10 };
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).nth(1).click();
    const s = sheet(page, 'Wetter am Hafen');
    await s.getByRole('button', { name: 'Mehr', exact: true }).click();
    await expect(s.getByText('4 Min.')).toBeVisible();
    await expect(s.getByText('10 Min.')).toBeVisible();
    await s.getByRole('button', { name: 'Vorlauf: eine Minute mehr' }).click();
    await s.getByRole('button', { name: 'Aufnehmen', exact: true }).click();
    await expect.poll(() => api.livetv.recCalls.length).toBe(1);
    expect(JSON.parse(api.livetv.recCalls[0]!.replace(/^POST \/api\/livetv\/recordings /, ''))).toEqual({ channelId: 'ch-nord', start: new Date(2026, 10, 12, 21, 0).toISOString(), padBefore: 5, padAfter: 10 });
  });

  test('guest sees no Aufnehmen', async ({ page, api }) => {
    api.perms = { liveRecord: false };
    await arm(page, api);
    await openPanel(page);
    await expect(panel(page).getByText('Die Leuchtturmwärter')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Aufnehmen' })).toHaveCount(0);
  });

  test('kids see no Aufnehmen', async ({ page, api }) => {
    await page.route('**/api/me', (r) => r.fulfill({ json: KID }));
    await page.addInitScript(noIntro);
    await arm(page, api);
    await openPanel(page, 'ch-kinder');
    await expect(panel(page).getByText('Abenteuer Wattenmeer')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Aufnehmen' })).toHaveCount(0);
  });
});
