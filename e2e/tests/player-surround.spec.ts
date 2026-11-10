// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { MOVIE } from '../mocks/fixtures.js';
import { HLS_AUDIO_INIT, HLS_AUDIO_PLAYLIST, HLS_AUDIO_SEG, HLS_INIT, HLS_SEGMENTS } from '../mocks/hls.js';
import { mockPlayer } from '../mocks/scenes.js';
import { expect, test } from '../fixtures.js';

/**
 * The per-device "Raumklang" switch and the one-time fallback. The browser states 6 output channels (AudioContext mocked), the server
 * answers like Jellyfin would for Dunmoor, S1 E5 "Wrenfield Pier" (5.1 AAC in a copied picture) or stereo, over a real 30 s HLS stream.
 */
interface InfoCall { startTicks?: number; audioChannels?: number; fellBack?: string; prevPs?: string; caps?: { audioChannels?: number; hls?: { surround: string[] } } }

const HEVC_SURROUND = { ...{ video: 'copy', videoCodec: 'hevc', audio: 'surround', audioCodec: 'aac', channels: 6, why: ['hevc_device', 'surround_device'] } };
const SURROUND = { video: 'copy', videoCodec: 'h264', audio: 'surround', audioCodec: 'aac', channels: 6, why: ['surround_device'] };
const STEREO = { video: 'copy', videoCodec: 'h264', audio: 'stereo', audioCodec: 'aac', channels: 2, why: ['stereo_choice'] };
const PLAYLIST = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MAP:URI="init.mp4"',
  ...HLS_SEGMENTS.flatMap((_, i) => ['#EXTINF:2.000000,', `s${i}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
/** a master playlist with a separate AAC audio rendition next to the VP9 picture, so hls.js has to open an audio source buffer */
const MASTER = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch 5.1",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="ger",URI="audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="vp09.00.51.08,mp4a.40.2",AUDIO="aud"', 'out.m3u8', ''].join('\n');

async function mock(page: Page, o: { audioCodecFails?: boolean; hevc?: boolean; slowMs?: number; corruptFrom?: number; videoFailsAfterFallback?: boolean; gate?: Promise<void> } = {}) {
  // the browser states a 6-channel output; every decode query passes (the codec checks themselves are in devicecaps.test.ts)
  await page.addInitScript((fail) => {
    Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get: () => ({ maxChannelCount: 6 }) });
    const mc = navigator.mediaCapabilities;
    if (mc) mc.decodingInfo = (async () => ({ supported: true, smooth: true, powerEfficient: true })) as typeof mc.decodingInfo;
    if (fail) {
      // the audio source buffer of the 5.1 stream cannot be created: hls.js reports bufferAddCodecError
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime: string) {
        if (/^audio\//.test(mime) || (/^video\//.test(mime) && (window as unknown as { __videoFail: boolean }).__videoFail)) throw new DOMException('mocked', 'NotSupportedError');
        return add.call(this, mime);
      };
    }
  }, Boolean(o.audioCodecFails));
  await mockPlayer(page);
  const calls: InfoCall[] = [];
  await page.route('**/api/playback/info', async (r) => {
    const b = r.request().postDataJSON() as InfoCall;
    calls.push(b);
    if (b.fellBack && o.videoFailsAfterFallback) await page.evaluate(() => { (window as unknown as { __videoFail: boolean }).__videoFail = true; }); // the reloaded stream's picture cannot be appended either
    const surround = (b.caps?.audioChannels ?? 2) >= 6 && (b.caps?.hls?.surround.length ?? 0) > 0 && !b.fellBack;
    return r.fulfill({ json: {
      resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: `ps-wren-${calls.length}`, roleMaxBitrate: 20_000_000, maxBitrate: 8_000_000, transcodeReason: 'audioCodec', subtitles: [],
      audioTracks: [{ index: 1, title: 'Deutsch 5.1', language: 'ger', isDefault: true }], hlsUrl: surround && o.audioCodecFails ? '/media/hls/wren/master.m3u8' : '/media/hls/wren/out.m3u8',
      delivery: surround ? (o.hevc ? HEVC_SURROUND : SURROUND) : (o.hevc && b.fellBack === 'surround' ? { ...STEREO, videoCodec: 'hevc' } : STEREO),
    } });
  });
  await page.route('**/media/hls/wren/**', async (r) => {
    const f = new URL(r.request().url()).pathname.split('/').pop()!;
    if (o.slowMs && (f === 'out.m3u8' || f === 'init.mp4')) await new Promise((res) => setTimeout(res, o.slowMs));
    if (o.corruptFrom !== undefined && /^s(\d+)\.m4s$/.test(f) && Number(/\d+/.exec(f)![0]) >= o.corruptFrom) { await o.gate; return r.fulfill({ contentType: 'video/mp4', body: HLS_AUDIO_SEG }); } // a fragment of another track, held back until the test says the session has started; then the media source refuses to append it
    if (f === 'master.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: MASTER });
    if (f === 'out.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: PLAYLIST });
    if (f === 'audio.m3u8') return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: HLS_AUDIO_PLAYLIST });
    if (f === 'ainit.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_AUDIO_INIT });
    if (/^a\d+\.m4s$/.test(f)) return r.fulfill({ contentType: 'video/mp4', body: HLS_AUDIO_SEG });
    if (f === 'init.mp4') return r.fulfill({ contentType: 'video/mp4', body: HLS_INIT });
    const m = /^s(\d+)\.m4s$/.exec(f);
    return m ? r.fulfill({ contentType: 'video/mp4', body: HLS_SEGMENTS[Number(m[1])]! }).catch(() => undefined) : r.fulfill({ status: 404 });
  });
  return calls;
}
const playing = async (page: Page) => {
  await page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 20);
  await page.evaluate(() => document.querySelector('video')!.play().catch(() => undefined));
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1);
};
const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Audio und Untertitel' }).click();
  return page.getByRole('dialog', { name: 'Audio und Untertitel' });
};

test.describe('player: surround sound switch', () => {
  test.beforeEach(({ api }) => { api.features = { requests: true, postplay: false, surround: true }; });

  test('the Klang menu offers Raumklang; turning it off asks again for stereo at the current position, and announces it', async ({ page, api: _api }) => {
    const calls = await mock(page);
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.caps).toMatchObject({ audioChannels: 6 });
    expect(calls[0]!.caps!.hls!.surround).toContain('aac');
    const menu = await openMenu(page);
    await expect(menu.getByRole('heading', { name: 'Klang' })).toBeVisible();
    const sw = menu.getByRole('switch', { name: /Raumklang/ });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect((await sw.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const before = await page.evaluate(() => document.querySelector('video')!.currentTime);
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ caps: { audioChannels: 2, hls: { surround: [] } } });
    expect(calls[1]!.fellBack).toBeUndefined();
    expect(calls[1]!.startTicks! / 1e7).toBeGreaterThanOrEqual(before - 0.5);
    expect(await page.evaluate(() => localStorage.getItem('ff_audio_stereo'))).toBe('1');
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'Raumklang aus' })).toHaveCount(1);
    // the choice stays for the next start; turning it on again asks for surround again
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]!.caps).toMatchObject({ audioChannels: 6 });
  });

  test('without the server feature the switch is not offered', async ({ page, api }) => {
    api.features = { requests: true, postplay: false, surround: false };
    await mock(page);
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    const menu = await openMenu(page);
    await expect(menu.getByRole('heading', { name: 'Klang' })).toBeVisible();
    await expect(menu.getByRole('switch', { name: /Raumklang/ })).toHaveCount(0);
  });

  test.describe('a surround stream the browser cannot append', () => {
    test('one more request with fellBack surround, the toast, no third, and the memory', async ({ page, api: _api }) => {
      const calls = await mock(page, { audioCodecFails: true });
      await page.addInitScript(() => { addEventListener('DOMContentLoaded', () => new MutationObserver(() => { const t = document.querySelector('.toast')?.textContent; if (t) (window as unknown as { __toasts: string[] }).__toasts.push(t); }).observe(document.body, { childList: true, subtree: true, characterData: true })); (window as unknown as { __toasts: string[] }).__toasts = []; });
      await page.goto('/watch/' + MOVIE.id);
      await expect.poll(() => calls.length).toBe(2);
      expect(calls[1]).toMatchObject({ fellBack: 'surround', prevPs: 'ps-wren-1', caps: { audioChannels: 6, hls: { surround: [] } } });
      await playing(page);
      await page.waitForTimeout(1500);
      expect(calls).toHaveLength(2);
      expect(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).toContain('Wechsle zu einem Stream, den dieses Gerät abspielt');
      const avoid = JSON.parse((await page.evaluate(() => localStorage.getItem('ff_devcaps_avoid')))!);
      expect(typeof avoid.surround).toBe('number');
      expect(avoid.hevc).toBeUndefined();
    });
  });

  test('B2: a slow start of an HEVC stream is never an HEVC failure', async ({ page, api: _api }) => {
    await page.addInitScript(() => { (globalThis as unknown as { __ffFirstFrameMs: number }).__ffFirstFrameMs = 700; });
    const calls = await mock(page, { hevc: true, slowMs: 2500 });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page); // the playlist and the init segment arrive 2.5 s late, well past the watchdog time
    await page.waitForTimeout(1200);
    expect(calls).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem('ff_devcaps_avoid'))).toBeNull();
  });

  test('S1: after the surround fallback an HEVC picture that cannot be appended is not ignored (no second fallback, no loop)', async ({ page, api: _api }) => {
    const calls = await mock(page, { audioCodecFails: true, hevc: true, videoFailsAfterFallback: true });
    await page.goto('/watch/' + MOVIE.id);
    await expect.poll(() => calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toMatchObject({ fellBack: 'surround' });
    // the reloaded stream is HEVC + AAC and its video buffer cannot be created either: answered by the quality step-down, not ignored,
    // and never by a second fallback
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    expect(calls.slice(2).every((c) => !c.fellBack)).toBe(true);
  });

  test('S3: the one fallback stops the failed session before it asks again', async ({ page, api: _api }) => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const calls = await mock(page, { hevc: true, corruptFrom: 3, gate });
    const order: string[] = [];
    await page.route('**/api/playback/stop', (r) => { order.push('stop'); return r.fulfill({ status: 204 }); });
    page.on('request', (r) => { if (r.url().endsWith('/api/playback/info')) order.push('info'); });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page); // the session has started (play reported) before the corrupt fragments are let through
    open();
    await expect.poll(() => calls.some((c) => c.fellBack), { timeout: 20_000 }).toBe(true);
    const i = order.indexOf('info', 1);
    expect(order.slice(0, i)).toContain('stop');
  });

  test('S4: the fallback after playback started reloads like a quality switch: the timing has one start and a flagged re-start', async ({ page, api: _api }) => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const calls = await mock(page, { hevc: true, corruptFrom: 3, gate });
    await page.goto('/watch/' + MOVIE.id);
    await playing(page);
    open();
    await expect.poll(() => calls.some((c) => c.fellBack), { timeout: 20_000 }).toBe(true);
    const read = (): Promise<Array<{ qualitySwitch: boolean; avEvents: number }>> => page.evaluate(() => JSON.parse(localStorage.getItem('ff.playTimings') ?? '[]')).catch(() => []); // a page that is just navigating has no answer yet
    // the failed session's report is written when its stop is sent (that is the real start); the reload is a flagged re-start, never a new start
    await expect.poll(async () => (await read()).length).toBeGreaterThanOrEqual(1);
    await page.goto('/diagnose'); // leaving the page ends the running session (pagehide writes its report)
    await expect.poll(async () => (await read()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const rows = await read();
    expect(rows.filter((r) => !r.qualitySwitch)).toHaveLength(1); // one start, however many re-starts followed
    expect(rows.at(-1)!.qualitySwitch).toBe(false); // the oldest report is the real start
    expect(rows[0]!.qualitySwitch).toBe(true);
    expect(rows[0]!.avEvents).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows)).not.toMatch(/\/media\/|ps-wren/); // only fixed codes
  });
});
