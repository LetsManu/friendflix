// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/** User agent of the Fire TV app's WebView: the Android System WebView on a Fire TV 4K, plus the app's marker. */
export const FIRETV_UA_FULL = 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 FriendFlixFireTV/3.0.0 FFDisplay/1080';

/** a recording `window.FriendFlixTv` port (the shell's message bridge): every postMessage lands in `window.__ftv` */
export async function stubFireTvPort(page: Page): Promise<{ messages: () => Promise<string[]> }> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ftv: string[]; FriendFlixTv: { postMessage(m: string): void } };
    w.__ftv = [];
    w.FriendFlixTv = { postMessage(m: string) { w.__ftv.push(m); } };
  });
  return { messages: () => page.evaluate(() => [...(window as unknown as { __ftv: string[] }).__ftv]) };
}

/**
 * Makes the page a stand-in Fire TV app: its user agent (set over CDP, so it reaches both navigator.userAgent and the request
 * headers), the recording port, and a media engine that confirms every codec (`canPlayType` -> 'probably'). Call before the
 * first navigation.
 */
export async function asFireTvApp(page: Page): Promise<{ messages: () => Promise<string[]> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: FIRETV_UA_FULL });
  const port = await stubFireTvPort(page);
  await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => 'probably'; });
  return port;
}

/** a remote key as the shell sends it: a keydown with `key` on the focused element */
export const fireKey = (page: Page, key: string) =>
  page.evaluate((key) => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }, key);
