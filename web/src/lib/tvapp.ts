// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The TV apps that open this page as their whole UI (LG webOS, Fire TV): both behave the same, only the way out differs. */
import { isFireTvApp, postFireTv, type FireWin } from './firetv/detect';
import { exitLgApp, isLgApp, type LgWin } from './webos/detect';

type TvWin = LgWin & FireWin;

export function isTvApp(win?: TvWin): boolean {
  return isLgApp(win) || isFireTvApp(win);
}

/** leave the app (Back on the home screen); never throws */
export function exitTvApp(win?: TvWin): void {
  if (isFireTvApp(win)) postFireTv('exit', win);
  else exitLgApp(win);
}
