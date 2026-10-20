// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In the Android app, in-page navigation to the watch page (`/watch/<id>` from a link the page routes itself, or a `goto`) goes to the
 * native player like a Play button does. The shell only sees full page loads; the web UI's own router never reaches it, so the layout
 * asks here first (one `beforeNavigate`). A declined start falls back to the web player once, without asking again (as the shell does
 * for a declined page load).
 */
import { native } from './bridge';
import { tryNativePlay } from './play';

const WATCH = /^\/watch\/([A-Za-z0-9-]{1,64})\/?$/;
const TRACK = /^[A-Za-z0-9_-]{1,32}$/;

/** the watch URL (path + query) whose native start was declined: its next navigation goes to the web player */
let webOnce: string | null = null;
/** a native start is waiting for the app's answer: further watch navigations meanwhile are swallowed (no double start) */
let pending = false;

const key = (u: URL) => u.pathname + u.search;

/** [url] is to play in the web player (the app declined it): its next navigation is let through. */
export function allowWebWatchOnce(url: URL | string): void {
  webOnce = key(typeof url === 'string' ? new URL(url, 'https://base.invalid') : url); // path + query only: the base never matters
}

export interface WatchTarget { itemId: string; positionTicks?: number; audio?: string; subtitle?: string }

/** the watch page of this origin as the native player takes it (same rules as the shell's WatchLinks.parse); null for anything else */
export function watchTarget(url: URL, origin: string): WatchTarget | null {
  if (url.origin !== origin) return null;
  const m = WATCH.exec(url.pathname);
  if (!m) return null;
  const out: WatchTarget = { itemId: m[1]! };
  const t = Number(url.searchParams.get('t'));
  if (Number.isFinite(t) && t > 0 && t < 86_400) out.positionTicks = Math.floor(t) * 10_000_000;
  const a = url.searchParams.get('audio'), s = url.searchParams.get('sub');
  if (a && TRACK.test(a)) out.audio = a;
  if (s && TRACK.test(s)) out.subtitle = s;
  return out;
}

export interface WatchNav {
  type: string;
  willUnload: boolean;
  from: { url: URL } | null;
  to: { url: URL } | null;
  cancel(): void;
}

/**
 * Called from the layout's beforeNavigate. Returns true when it cancelled the navigation and asked the native player; [goWeb] is then
 * called with the URL if the app declines and the viewer is still where they were.
 */
export function interceptWatch(nav: WatchNav, goWeb: (url: URL) => void, opts: { castActive?: boolean } = {}): boolean {
  if (!native.available || nav.willUnload || (nav.type !== 'link' && nav.type !== 'goto') || !nav.to) return false;
  const url = nav.to.url;
  const target = watchTarget(url, location.origin);
  if (!target) return false;
  if (webOnce === key(url)) { webOnce = null; return false; }
  webOnce = null;
  // a cast session: the watch page is the TV's remote; the web player moving on to its next episode keeps playing in the page
  if (opts.castActive || nav.from?.url.pathname.startsWith('/watch/')) return false;
  nav.cancel();
  if (pending) return true;
  pending = true;
  const where = location.href;
  const opt = { audio: target.audio, subtitle: target.subtitle };
  void tryNativePlay({ id: target.itemId, positionTicks: target.positionTicks }, opt)
    .then((ok) => {
      if (ok || location.href !== where) return;
      allowWebWatchOnce(url);
      goWeb(url);
    })
    .finally(() => { pending = false; });
  return true;
}

/** tests only */
export const resetWatchIntercept = () => { webOnce = null; pending = false; };
