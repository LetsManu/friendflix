// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KeyInput } from '#lib/player/keymap';
import { isTizenApp, type TizenWin } from '#lib/tizen/detect';
import { normaliseTizenKey, registerLiveKeys } from '#lib/tizen/livekeys';
import type { TizenLike } from '#lib/tizen/probe';
import { isLgApp, type LgWin } from '#lib/webos/detect';
import { normaliseLgKey } from '#lib/webos/keys';

/** the parts of a keydown the remote maps look at */
export interface RemoteEvent { key: string; keyCode: number; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }
export interface LiveRemote {
  /** the LG webOS app: its colour keys act in `resolveLiveKey` */
  lg: boolean;
  /** the standard key name of this keydown (what `resolveLiveKey` and `noteKey` understand) */
  keyName(e: RemoteEvent): string;
  /** the keydown as `resolveLiveKey` input: the event itself, or a copy carrying the normalised key */
  input(e: RemoteEvent): KeyInput;
}

/**
 * Called when the Live area opens (list, player): on a Samsung TV it registers the live keys and keeps their code map, on an LG TV it
 * uses the fixed LG table (`normaliseLgKey`), anywhere else keys stay as the browser sent them. Registering again is harmless.
 */
export function liveRemote(win: (TizenWin & LgWin & { tizen?: unknown }) | undefined = typeof window === 'undefined' ? undefined : (window as never)): LiveRemote {
  const lg = isLgApp(win);
  const map = !lg && win && isTizenApp(win) ? registerLiveKeys(win.tizen as TizenLike | undefined) : null;
  const keyName = (e: RemoteEvent) => (lg ? normaliseLgKey(e) : map ? normaliseTizenKey(e, map) : e.key);
  return {
    lg,
    keyName,
    input: (e) => {
      const key = keyName(e);
      return key === e.key ? e : { key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey };
    },
  };
}
