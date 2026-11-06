// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/** User agent of the Android shell: a normal Chrome UA plus the marker the shell appends. */
export const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 FriendFlixAndroid/2.0.0';

export interface NativeCfg {
  /** capabilities the fake app reports */
  caps?: { play: boolean; download: boolean; cast?: boolean };
  /** what play / download answer */
  playResult?: boolean;
  downloadResult?: boolean;
  /** what downloads() lists */
  downloads?: unknown[];
  /** answer play after this many ms (default 5) */
  playDelayMs?: number;
}
export interface NativeCall { id: string; method: string; args: Record<string, unknown> }

/**
 * Installs a fake of the object the Android shell injects (`window.FriendFlixNative`: postMessage(string) in, `message` events out),
 * before any page script runs. Every request is recorded in `window.__nativeCalls`; `window.__nativePush(obj)` emits an app event.
 */
export async function fakeNativeApp(page: Page, cfg: NativeCfg = {}) {
  await page.addInitScript((c) => {
    const w = window as any;
    const conf = { caps: { play: true, download: true, cast: false }, playResult: true, downloadResult: true, downloads: [], ...c };
    w.__nativeCalls = [];
    const listeners = new Set<(e: { data: string }) => void>();
    const emit = (o: unknown) => listeners.forEach((l) => l({ data: JSON.stringify(o) }));
    w.__nativePush = emit;
    w.__nativeCfg = conf;
    w.FriendFlixNative = {
      postMessage(s: string) {
        const req = JSON.parse(s);
        w.__nativeCalls.push(req);
        const k = w.__nativeCfg;
        // like the app: a deleted download is gone from the next listing
        if (req.method === 'deleteDownload') k.downloads = (k.downloads as Array<{ licenseId?: string }>).filter((d) => d.licenseId !== req.args?.licenseId);
        const result: Record<string, unknown> = {
          capabilities: { api: 1, ...k.caps }, play: k.playResult, download: k.downloadResult, downloads: k.downloads, deleteDownload: true, openSettings: true,
        };
        setTimeout(() => emit({ id: req.id, ok: true, result: result[req.method] }), req.method === 'play' && k.playDelayMs ? k.playDelayMs : 5);
      },
      addEventListener(_t: string, l: (e: { data: string }) => void) { listeners.add(l); },
      removeEventListener(_t: string, l: (e: { data: string }) => void) { listeners.delete(l); },
    };
  }, cfg);
}

export const nativeCalls = (page: Page, method?: string): Promise<NativeCall[]> =>
  page.evaluate((m) => ((window as any).__nativeCalls as NativeCall[]).filter((c) => !m || c.method === m), method);
