// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is this page running inside the FriendFlix LG (webOS) TV app? The app opens /tv?ff_app=webos. The LG web browser carries the same
 * 'Web0S' user agent token, so the token alone never counts: the page also needs the URL hint, which is remembered in sessionStorage
 * (`ff.app=webos`) so it survives in-app navigation.
 */
export const SESSION_KEY = 'ff.app';
const UA_TOKEN = 'Web0S';

/** the parts of `window` this module reads (loose on purpose: tests pass small fakes) */
export interface LgWin {
  navigator?: { userAgent?: string };
  location?: { search?: string };
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  PalmSystem?: { platformBack?: () => void };
  close?: () => void;
}

const ua = (win: LgWin) => win.navigator?.userAgent ?? '';

export function isLgApp(win: LgWin = window): boolean {
  if (!ua(win).includes(UA_TOKEN)) return false;
  let stored = false;
  try { stored = win.sessionStorage?.getItem(SESSION_KEY) === 'webos'; } catch { /* storage blocked */ }
  if (stored) return true;
  if (new URLSearchParams(win.location?.search ?? '').get('ff_app') !== 'webos') return false;
  try { win.sessionStorage?.setItem(SESSION_KEY, 'webos'); } catch { /* storage blocked: the URL hint still works for this page */ }
  return true;
}

/** the webOS TV version from the user agent ("webOSTV/6.0", or "webOS.TV-2025" as '25'), else null */
export function webosVersion(win: LgWin = window): string | null {
  const s = ua(win);
  const tv = /webOSTV\/(\d+(?:\.\d+)?)/.exec(s)?.[1];
  if (tv) return tv;
  const year = /webOS\.TV-(\d{4})/.exec(s)?.[1];
  return year ? year.slice(-2) : null;
}

/** leave the app (Back on the home screen); never throws */
export function exitLgApp(win: LgWin = window): void {
  try {
    if (typeof win.PalmSystem?.platformBack === 'function') win.PalmSystem.platformBack();
    else win.close?.();
  } catch { /* nothing more to try */ }
}

/** Back on the TV home screen leaves the app, but only when nothing else wants the key (modal, dropdown, text field) */
export function shouldExitOnBack(s: { path: string; modalId: unknown; dropdownOpen: boolean; editable: boolean }): boolean {
  return s.path === '/' && !s.modalId && !s.dropdownOpen && !s.editable;
}
