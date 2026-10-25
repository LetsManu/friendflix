// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is this page running inside the FriendFlix Samsung TV (Tizen) app? The shell adds the user agent marker ' FriendFlixTizen/<version>'
 * when Tizen lets it; otherwise the page recognises it by the injected `tizen` object plus `ff_app=tizen` in the URL (the shell
 * appends it to /tv). The URL hint is remembered in sessionStorage (`ff.app=tizen`) so it survives in-app navigation.
 */
export const UA_MARKER = ' FriendFlixTizen/';
export const SESSION_KEY = 'ff.app';

/** the parts of `window` this module reads (loose on purpose: tests pass small fakes) */
export interface TizenWin {
  navigator?: { userAgent?: string };
  location?: { search?: string };
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  tizen?: unknown;
}

const ua = (win: TizenWin) => win.navigator?.userAgent ?? '';

export function isTizenApp(win: TizenWin = window): boolean {
  if (ua(win).includes(UA_MARKER)) return true;
  if (typeof win.tizen === 'undefined') return false;
  let stored = false;
  try { stored = win.sessionStorage?.getItem(SESSION_KEY) === 'tizen'; } catch { /* storage blocked */ }
  if (stored) return true;
  if (new URLSearchParams(win.location?.search ?? '').get('ff_app') !== 'tizen') return false;
  try { win.sessionStorage?.setItem(SESSION_KEY, 'tizen'); } catch { /* storage blocked: the URL hint still works for this page */ }
  return true;
}

/** the Tizen platform version from the user agent ("Tizen 6.5"), else null */
export function tizenVersion(win: TizenWin = window): string | null {
  return /\bTizen[ /](\d+(?:\.\d+)*)/i.exec(ua(win))?.[1] ?? null;
}
