// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test, type MockState } from '../fixtures.js';
import { mockLivePlayer } from '../helpers.js';
import { ME } from '../mocks/fixtures.js';

// Recording from the live player (Phase 3 Task 7, spec §15.1, §15.4, §20): the info panel's *Aufnehmen* on *Jetzt* and *Danach*
// opens the programme's detail sheet (RecordSheet); its *Aufnehmen* plans the recording, *Serie aufnehmen* a series rule; a
// conflict shows the §20 line in a reserved slot (nothing moves) with *Trotzdem planen* (force). Without `liveRecord` (guests) and
// for kids profiles there is no *Aufnehmen*. Less than a whole programme (DVR follow-ups): a running programme reads *Ab jetzt
// aufnehmen*, a running recording ends early and stays (*Aufnahme beenden*) or is cancelled and deleted after a second ask, and
// *Eigenen Zeitraum aufnehmen …* opens the time-span sheet prefilled. A fake clock stands at Thursday 2026-11-12 20:37:10 (local).
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
  test('info panel Aufnehmen records the running programme from now', async ({ page, api }) => {
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
    // it runs: the recording starts now (the backend counts no gap before the request)
    await expect(s.getByRole('button', { name: 'Aufnehmen', exact: true })).toHaveCount(0);
    await s.getByRole('button', { name: 'Ab jetzt aufnehmen' }).click();
    await expect.poll(() => api.livetv.recCalls).toEqual([`POST /api/livetv/recordings ${JSON.stringify({ channelId: 'ch-nord', start: new Date(2026, 10, 12, 20, 15).toISOString() })}`]);
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Aufnahme läuft')).toBeVisible();
    // a running recording ends early (kept) or is cancelled and deleted
    await expect(s.getByRole('button', { name: 'Aufnahme beenden' })).toBeVisible();
    await expect(s.getByRole('button', { name: 'Abbrechen und löschen' })).toBeVisible();

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

  test('a series rule with a forecast conflict shows the line without Trotzdem planen', async ({ page, api }) => {
    api.livetv.recConflict = { slots: { used: 3, limit: 2 }, parallel: { used: 2, max: 4 }, provider: null, conflict: true };
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).first().click();
    const s = sheet(page, 'Die Leuchtturmwärter');
    await s.getByRole('button', { name: 'Serie aufnehmen' }).click();
    await expect(s.getByText('Zu dieser Zeit sind schon 2 von 2 Umwandlungsplätzen für Aufnahmen verplant. Diese Aufnahme kann ausfallen.')).toBeVisible();
    await expect(s.getByRole('button', { name: 'Trotzdem planen' })).toHaveCount(0); // the rule is on; nothing to force
    expect(api.livetv.recCalls.filter((c) => c.startsWith('POST /api/livetv/recordings'))).toEqual([]);
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


  test('Aufnahme beenden ends a running recording early and keeps it; Abbrechen und löschen asks again in the reserved slot', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).first().click();
    const s = sheet(page, 'Die Leuchtturmwärter');
    await s.getByRole('button', { name: 'Ab jetzt aufnehmen' }).click();
    const stop = s.getByRole('button', { name: 'Aufnahme beenden' });
    await expect(stop).toBeVisible();
    const id = api.livetv.recordings[0]!.id;
    const del = s.getByRole('button', { name: 'Abbrechen und löschen' });
    const series = s.getByRole('button', { name: 'Serie aufnehmen' });
    const before = [(await stop.boundingBox())!, (await del.boundingBox())!, (await series.boundingBox())!];
    // the second ask appears in the slot that was reserved from the start: nothing moves
    await del.click();
    const ask = s.getByText('Was bisher aufgenommen wurde, wird gelöscht. Mit „Aufnahme beenden“ bleibt es erhalten.');
    await expect(ask).toBeVisible();
    await expect(s.getByRole('button', { name: 'Löschen', exact: true })).toBeVisible();
    const after = [(await stop.boundingBox())!, (await del.boundingBox())!, (await series.boundingBox())!];
    for (let i = 0; i < 3; i++) { expect(after[i]!.y).toBeCloseTo(before[i]!.y, 0); expect(after[i]!.height).toBeCloseTo(before[i]!.height, 0); }
    await del.click(); // pressed again: the ask goes, nothing is sent
    await expect(ask).toHaveCount(0);
    expect(api.livetv.recCalls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    // Aufnahme beenden: it ends now and stays (done, playable); the sheet offers recording again
    await stop.click();
    await expect.poll(() => api.livetv.recCalls.at(-1)).toBe(`POST /api/livetv/recordings/${id}/stop`);
    await expect(page.getByRole('region', { name: 'Hinweise' }).getByText('Aufnahme beendet. Das Aufgenommene bleibt erhalten.')).toBeVisible();
    expect(api.livetv.recordings.find((r) => r.id === id)!.state).toBe('done');
    await expect(s.getByRole('button', { name: 'Ab jetzt aufnehmen' })).toBeFocused();
    // a new one is cancelled and deleted after the second ask
    await s.getByRole('button', { name: 'Ab jetzt aufnehmen' }).click();
    await expect(s.getByRole('button', { name: 'Aufnahme beenden' })).toBeVisible();
    const id2 = api.livetv.recordings[0]!.id;
    await s.getByRole('button', { name: 'Abbrechen und löschen' }).click();
    await s.getByRole('button', { name: 'Löschen', exact: true }).click();
    await expect.poll(() => api.livetv.recCalls.at(-1)).toBe(`DELETE /api/livetv/recordings/${id2}`);
    await expect(s.getByRole('button', { name: 'Ab jetzt aufnehmen' })).toBeVisible();
    expect(api.livetv.recordings.some((r) => r.id === id)).toBe(true); // the stopped one stays
  });

  test('Eigenen Zeitraum aufnehmen opens the time-span sheet with this channel, now and the programme end; a shorter span is sent', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).first().click();
    const s = sheet(page, 'Die Leuchtturmwärter');
    await s.getByRole('button', { name: 'Eigenen Zeitraum aufnehmen …' }).click();
    await expect(s).toHaveCount(0);
    const t = page.getByRole('dialog', { name: 'Neue Aufnahme' });
    await expect(t).toBeVisible();
    await expect(t.getByLabel('Sender')).toHaveValue('ch-nord');
    await expect(t.getByLabel('Datum')).toHaveValue('2026-11-12');
    await expect(t.getByLabel('Beginn')).toHaveValue('20:37');
    await expect(t.getByLabel('Dauer (Minuten)')).toHaveValue('23');
    await expect(t.getByLabel('Titel')).toHaveValue('Die Leuchtturmwärter');
    // the length takes the focus: the next 10 minutes only (typing digits zaps no channel)
    await expect(t.getByLabel('Dauer (Minuten)')).toBeFocused();
    await t.getByLabel('Dauer (Minuten)').fill('10');
    await t.getByRole('button', { name: 'Aufnahme planen' }).click();
    await expect(t).toHaveCount(0);
    await expect.poll(() => api.livetv.recCalls.length).toBe(1);
    expect(JSON.parse(api.livetv.recCalls[0]!.replace(/^POST \/api\/livetv\/recordings /, ''))).toEqual({
      channelId: 'ch-nord', start: new Date(2026, 10, 12, 20, 37).toISOString(), end: new Date(2026, 10, 12, 20, 47).toISOString(), title: 'Die Leuchtturmwärter',
    });
    expect(api.livetv.recordings[0]!.end).toBe(new Date(2026, 10, 12, 20, 47).toISOString());
    await expect(page).toHaveURL((u) => u.pathname === '/live/watch/ch-nord');
  });

  test('an upcoming programme\'s own span starts at its start; Escape closes the time-span sheet', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Aufnehmen' }).nth(1).click();
    const s = sheet(page, 'Wetter am Hafen');
    await s.getByRole('button', { name: 'Eigenen Zeitraum aufnehmen …' }).click();
    const t = page.getByRole('dialog', { name: 'Neue Aufnahme' });
    await expect(t.getByLabel('Beginn')).toHaveValue('21:00');
    await expect(t.getByLabel('Dauer (Minuten)')).toHaveValue('15');
    await expect(t.getByLabel('Titel')).toHaveValue('Wetter am Hafen');
    await page.keyboard.press('Escape');
    await expect(t).toHaveCount(0);
    expect(api.livetv.recCalls).toEqual([]);
    await expect(page.locator('[data-live-state]')).toHaveAttribute('data-live-state', 'playing'); // the player stays
  });

  test('the sheet takes the focus and keeps it (keyboard and TV D-pad); closing gives it back', async ({ page, api }) => {
    await arm(page, api);
    await openPanel(page);
    const trigger = panel(page).getByRole('button', { name: 'Aufnehmen' }).nth(1);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const s = sheet(page, 'Wetter am Hafen');
    // the main action once the programme detail is there
    await expect(s.getByRole('button', { name: 'Aufnehmen', exact: true })).toBeFocused();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await s.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(s).toHaveCount(0);
    await expect(trigger).toBeFocused();
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
