// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The LG probe's home check comes back as `/tv?probe=1&ff_app=webos&home=ok`. A paired TV's /tv page may `location.replace('/')`
 * before the probe overlay mounts, and the URL hint would be lost. So the hint is copied into sessionStorage `ff.lgProbeHome` as
 * early as possible: when this module loads (the layout imports it), again in the layout's onMount and in shouldLgProbe().
 */
import { isLgApp, type LgWin } from './detect';

export const HOME_HINT_KEY = 'ff.lgProbeHome';

/** copy `home=` from the URL into sessionStorage (LG app only); never throws */
export function rememberLgProbeHome(win: LgWin | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (!win) return;
  try {
    const h = new URLSearchParams(win.location?.search ?? '').get('home');
    if (h === null || !isLgApp(win)) return;
    win.sessionStorage?.setItem(HOME_HINT_KEY, h);
  } catch { /* storage blocked: the URL hint still works on this page */ }
}

rememberLgProbeHome();
