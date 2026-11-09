// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is this page running inside the FriendFlix Fire TV app? The app's WebView appends ` FriendFlixFireTV/<version> FFDisplay/<height>`
 * to its user agent; no browser on the device carries that marker, so it alone counts (no URL hint needed). The app listens for a
 * few plain-string messages on `window.FriendFlixTv.postMessage` (android/firetv: TvMessages.kt).
 */
export const FIRETV_UA = ' FriendFlixFireTV/';

export type FireTvMessage = 'exit' | 'changeServer' | 'keepAwake:1' | 'keepAwake:0';

/** the parts of `window` this module reads (loose on purpose: tests pass small fakes) */
export interface FireWin {
  navigator?: { userAgent?: string };
  FriendFlixTv?: { postMessage?: (m: string) => void };
  innerWidth?: number;
  innerHeight?: number;
}

const ua = (win: FireWin) => win.navigator?.userAgent ?? '';
/** the page's window, or undefined during the server render / prerender (no window there) */
const pageWin = (): FireWin | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as FireWin));

export function isFireTvApp(win: FireWin | undefined = pageWin()): boolean {
  return Boolean(win) && ua(win!).includes(FIRETV_UA);
}

/** the display height the app reports (FFDisplay/<h>): 2160 for a 4K display (or more), anything else or missing 1080 */
export function fireTvDisplayHeight(win: FireWin | undefined = pageWin()): number {
  const h = Number(/ FFDisplay\/(\d{3,4})(?!\d)/.exec(win ? ua(win) : '')?.[1] ?? 0);
  return h >= 2160 ? 2160 : 1080;
}

/** '<Android version>/<model>' from the user agent (e.g. '9/AFTMM'), else null */
export function fireTvOs(win: FireWin | undefined = pageWin()): string | null {
  const m = /Android (\d+(?:\.\d+)?);\s*([A-Za-z0-9_-]+)/.exec(win ? ua(win) : '');
  return m ? `${m[1]}/${m[2]}` : null;
}

/** sends one message to the app; false outside the app, without the port, or when it throws */
export function postFireTv(m: FireTvMessage, win: FireWin | undefined = pageWin()): boolean {
  if (!win || !isFireTvApp(win)) return false;
  const port = win.FriendFlixTv;
  if (!port || typeof port.postMessage !== 'function') return false;
  try { port.postMessage(m); return true; } catch { return false; }
}

/** inside the app the page lays out 1920 px wide like the LG app (the WebView scales it to the screen); true when set */
export function applyFireTvViewport(doc: Document | undefined = typeof document === 'undefined' ? undefined : document, win: FireWin | undefined = pageWin()): boolean {
  if (!doc || !isFireTvApp(win)) return false;
  let meta = doc.querySelector('meta[name=viewport]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.setAttribute('name', 'viewport');
    doc.head.appendChild(meta);
  }
  meta.setAttribute('content', 'width=1920');
  return true;
}

interface HideDoc { hidden?: boolean; addEventListener(t: 'visibilitychange', f: () => void): void; removeEventListener(t: 'visibilitychange', f: () => void): void }

/**
 * In the app: calls `pause` whenever the page becomes hidden (Home on the remote). The shell pauses its WebView, but that alone
 * does not silence HTML5 audio on every Fire OS WebView. Elsewhere it installs nothing. Returns the teardown.
 */
export function pauseWhenHidden(pause: () => void, doc: HideDoc | undefined = typeof document === 'undefined' ? undefined : document, win: FireWin | undefined = pageWin()): () => void {
  if (!doc || !isFireTvApp(win)) return () => undefined;
  const on = () => { if (doc.hidden) pause(); };
  doc.addEventListener('visibilitychange', on);
  return () => doc.removeEventListener('visibilitychange', on);
}
