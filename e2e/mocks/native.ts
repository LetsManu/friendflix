// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/** User agent of the Android shell: a normal Chrome UA plus the marker the shell appends. */
export const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 FriendFlixAndroid/2.0.0';

export interface NativeCfg {
  /** capabilities the fake app reports */
  caps?: { play: boolean; download: boolean; cast?: boolean; castBar?: boolean };
  /** the API version it reports (default 1: the apps before the cast bar; 2 knows castState / castControl / sessionChanged) */
  api?: number;
  /** the app's running cast (a snapshot as the app sends it) at page load; `castState` answers it */
  cast?: NativeCastSnap | null;
  /** answer sessionChanged after this many ms (the app replies once the stop report and token revoke went out; default 5) */
  sessionDelayMs?: number;
  /** what play / download answer */
  playResult?: boolean;
  downloadResult?: boolean;
  /** what downloads() lists */
  downloads?: unknown[];
  /** answer play after this many ms (default 5) */
  playDelayMs?: number;
}
/** the app's cast snapshot (bridge `castState` / the 'cast' event) */
export interface NativeCastSnap {
  kind: 'chromecast'; device: string; itemId: string; title: string; subtitle?: string; posterId: string; isEpisode: boolean;
  positionMs: number; durationMs: number; paused: boolean; state: 'connecting' | 'playing' | 'ended'; next?: { itemId: string; label: string };
}
export interface NativeCall { id: string; method: string; args: Record<string, unknown>; /** epoch ms the request arrived */ at: number }

/**
 * Installs a fake of the object the Android shell injects (`window.FriendFlixNative`: postMessage(string) in, `message` events out),
 * before any page script runs. Every request is recorded in `window.__nativeCalls`; `window.__nativePush(obj)` emits an app event.
 */
export async function fakeNativeApp(page: Page, cfg: NativeCfg = {}) {
  await page.addInitScript((c) => {
    const w = window as any;
    const conf = { api: 1, cast: null, sessionDelayMs: 5, caps: { play: true, download: true, cast: false, castBar: false }, playResult: true, downloadResult: true, downloads: [], ...c };
    // survives a page reload (a profile switch / sign-out reloads the page): kept in sessionStorage
    try { w.__nativeCalls = JSON.parse(sessionStorage.getItem('__nativeCalls') ?? '[]'); } catch { w.__nativeCalls = []; }
    const listeners = new Set<(e: { data: string }) => void>();
    const emit = (o: unknown) => listeners.forEach((l) => l({ data: JSON.stringify(o) }));
    w.__nativePush = emit;
    w.__nativeCfg = conf;
    w.FriendFlixNative = {
      postMessage(s: string) {
        const req = JSON.parse(s);
        req.at = Date.now();
        w.__nativeCalls.push(req);
        try { sessionStorage.setItem('__nativeCalls', JSON.stringify(w.__nativeCalls)); } catch { /* ignore */ }
        const k = w.__nativeCfg;
        // like the app: a deleted download is gone from the next listing
        if (req.method === 'deleteDownload') k.downloads = (k.downloads as Array<{ licenseId?: string }>).filter((d) => d.licenseId !== req.args?.licenseId);
        let delay = req.method === 'play' && k.playDelayMs ? k.playDelayMs : 5;
        let castAnswer: unknown = true;
        if (req.method === 'castState') castAnswer = k.cast;
        if (req.method === 'sessionChanged') delay = k.sessionDelayMs;
        if (req.method === 'castControl') {
          const a = req.args?.action;
          // like the app: next answers false without a queued episode, open without a running cast; stop ends the cast (event), playPause flips it
          if (a === 'next') castAnswer = Boolean(k.cast?.next);
          else if (a === 'open') castAnswer = Boolean(k.cast);
          else if (a === 'stop' && k.cast) { k.cast = null; setTimeout(() => emit({ event: 'cast', detail: null }), 20); }
          else if (a === 'playPause' && k.cast) { k.cast = { ...k.cast, paused: !k.cast.paused }; const c = k.cast; setTimeout(() => emit({ event: 'cast', detail: c }), 20); }
        }
        const result: Record<string, unknown> = {
          capabilities: { api: k.api, ...k.caps }, castState: castAnswer, castControl: castAnswer, sessionChanged: true, play: k.playResult, download: k.downloadResult, downloads: k.downloads, deleteDownload: true, openSettings: true,
        };
        setTimeout(() => emit({ id: req.id, ok: true, result: result[req.method] }), delay);
      },
      addEventListener(_t: string, l: (e: { data: string }) => void) { listeners.add(l); },
      removeEventListener(_t: string, l: (e: { data: string }) => void) { listeners.delete(l); },
    };
  }, cfg);
}

/** the app emits a cast event (a snapshot, or null when the cast ends) and `castState` answers the same from now on */
export const pushCast = (page: Page, snap: NativeCastSnap | null) =>
  page.evaluate((c) => { const w = window as any; w.__nativeCfg.cast = c; w.__nativePush({ event: 'cast', detail: c }); }, snap);

export const nativeCalls = (page: Page, method?: string): Promise<NativeCall[]> =>
  page.evaluate((m) => ((window as any).__nativeCalls as NativeCall[]).filter((c) => !m || c.method === m), method);
