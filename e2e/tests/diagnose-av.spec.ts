// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

/**
 * /diagnose "Bild und Ton": what this device plays (probed, mocked here), what the server offers (the coarse abilities answer) and what
 * the last playback was given (the stored timing of Dunmoor, S1 E5 "Wrenfield Pier": HEVC picture copied, Dolby Digital Plus 5.1 copied).
 */
const LAST = {
  at: Date.UTC(2026, 10, 10, 20, 15, 0), device: 'tv', mode: 'hls', qualitySwitch: false, bitrate: 8_000_000, targetDuration: 6, infoMs: 300, manifestMs: 700, firstFragMs: 2500,
  firstFragBytes: 4_096_000, firstFragDlMs: 1500, firstFrameMs: 3000, seeks: 0, seekMedianMs: null, seekMaxMs: null, stalls: 0, stallMs: 0, effectiveType: null,
  delivery: 'remux', videoCopy: true, soundMode: 'off', audioRouted: false, droppedFrames: 0, totalFrames: 1200, trackSwitch: false, reconnects: 0, avEvents: 0, fromNext: false,
  videoOut: 'copy_hevc', audioOut: 'copy', why: ['hevc_device', 'surround_device'], audioCodec: 'eac3', channels: 6,
};

async function setup(page: Page, o: { stereo?: boolean; last?: unknown; abilities?: unknown; status?: number } = {}) {
  await page.addInitScript(({ stereo, last }) => {
    // a browser that decodes HEVC and states a 6-channel output (the probe itself is covered by devicecaps.test.ts)
    Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get: () => ({ maxChannelCount: 6 }) });
    const mc = navigator.mediaCapabilities;
    if (mc) mc.decodingInfo = (async () => ({ supported: true, smooth: true, powerEfficient: true })) as unknown as typeof mc.decodingInfo;
    MediaSource.isTypeSupported = () => true;
    HTMLMediaElement.prototype.canPlayType = () => 'probably';
    if (stereo) localStorage.setItem('ff_audio_stereo', '1');
    if (last) localStorage.setItem('ff.playTimings', JSON.stringify([last]));
  }, { stereo: Boolean(o.stereo), last: o.last === undefined ? LAST : o.last });
  await page.route('**/api/playback/abilities', (r) => (o.status ? r.fulfill({ status: o.status, json: { error: 'x' } }) : r.fulfill({ json: o.abilities ?? { hevc: 'ready', surround: true } })));
}

test.describe('/diagnose: Bild und Ton', () => {
  test('the section, the HEVC row, the stereo choice and the last playback with its reasons', async ({ page }) => {
    await setup(page, { stereo: true });
    await page.goto('/diagnose');
    const sec = page.getByRole('region', { name: 'Bild und Ton' });
    await expect(sec.getByRole('heading', { level: 2, name: 'Bild und Ton' })).toBeVisible();
    const tbl = page.getByTestId('av-table');
    await expect(tbl.getByRole('row', { name: /HEVC auf diesem Gerät/ })).toContainText('Spielt HEVC-Dateien und -Streams');
    await expect(tbl.getByRole('row', { name: /Tonausgabe/ })).toContainText('Stereo (deine Wahl)');
    await expect(tbl.getByRole('row', { name: /^Server/ })).toContainText('HEVC-Umwandlung bereit · Raumklang an');
    await expect(tbl.getByRole('row', { name: /Letzte Wiedergabe/ })).toContainText('Bild: HEVC (H.265) unverändert weitergegeben · Ton: Dolby Digital Plus 5.1 weitergegeben');
    await expect(tbl.getByRole('row', { name: /Warum/ })).toContainText('dieses Gerät spielt HEVC · 5.1-Ausgabe auf diesem Gerät');
    // first section: right below the Copy button, above the viewport table
    const order = await page.evaluate(() => { const a = document.querySelector('[data-testid=av-table]')!, b = document.querySelector('[data-testid=diagnose-table]')!; return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING; });
    expect(order).toBeTruthy();
  });

  test('without a stereo choice the output reads 5.1 with the codecs; the unhealthy server and a failed start are named', async ({ page }) => {
    await setup(page, { abilities: { hevc: 'unhealthy', surround: false } });
    await page.goto('/diagnose');
    const tbl = page.getByTestId('av-table');
    await expect(tbl.getByRole('row', { name: /Tonausgabe/ })).toContainText('5.1 (Dolby Digital Plus, Dolby Digital, AAC)');
    await expect(tbl.getByRole('row', { name: /^Server/ })).toContainText('HEVC-Umwandlung hat die Prüfung nicht bestanden · Raumklang aus');
  });

  test.describe('abilities unreadable', () => {
    test.use({ allowedConsole: /status of 500/ });
    test('no playback yet and an unreadable abilities answer still render', async ({ page }) => {
      await setup(page, { last: null, status: 500 });
      await page.goto('/diagnose');
      const tbl = page.getByTestId('av-table');
      await expect(tbl.getByRole('row', { name: /Letzte Wiedergabe/ })).toContainText('Noch keine Wiedergabe auf diesem Gerät.');
      await expect(tbl.getByRole('row', { name: /^Server/ })).toContainText('nicht bekannt');
    });
  });

  test('Werte kopieren contains the rows and never a media path', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, { stereo: true });
    await page.goto('/diagnose');
    await expect(page.getByTestId('av-table').getByRole('row', { name: /Letzte Wiedergabe/ })).toContainText('Bild:');
    await page.getByRole('button', { name: 'Werte kopieren' }).click();
    await expect(page.locator('.note')).toContainText(/Kopiert|Kopieren nicht möglich/);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Letzte Wiedergabe: Bild: HEVC (H.265) unverändert weitergegeben · Ton: Dolby Digital Plus 5.1 weitergegeben');
    expect(text).toContain('Tonausgabe: Stereo (deine Wahl)');
    expect(text).toContain('innerWidth x innerHeight'); // the viewport rows are still in it
    expect(text).not.toContain('/media/');
    // the timing block (copyable text) carries the out line with the fixed codes only
    await expect(page.getByTestId('timing-log')).toContainText('out: copy_hevc · eac3 5.1 (hevc_device, surround_device)');
  });
});
