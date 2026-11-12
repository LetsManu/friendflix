// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KeyInput } from '#lib/player/keymap';

/** Pure key map of the live player (spec §12.3), like `player/keymap.ts`: key + context in, abstract action out. */
export type LiveKeyAction =
  | { type: 'chUp' } | { type: 'chDown' }
  | { type: 'showControls' } | { type: 'channelList' } | { type: 'toggle' }
  | { type: 'seek'; by: number } | { type: 'live' } | { type: 'info' } | { type: 'last' }
  | { type: 'digit'; d: number } | { type: 'enter' } | { type: 'close' }
  | { type: 'controls'; focus: 'back30' | 'fwd30' }
  | { type: 'volume'; delta: number } | { type: 'mute' } | { type: 'fullscreen' };

export interface LiveKeyContext {
  /** 10-foot UI: D-pad + spatial navigation own the arrows, letters stay free */
  tv: boolean;
  /** the LG webOS app: its remote's colour keys act */
  lg: boolean;
  controlsVisible: boolean;
  /** focus is on the page body / the stage (not on a control) */
  onBody: boolean;
  /** a panel, sheet or menu is open and owns the keys */
  overlayOpen: boolean;
  /** the number card is open: Enter / OK commits it */
  numberOpen: boolean;
}

/**
 * Only short presses come here: a long OK is `createLongOk`'s (it opens the channel list). OK never pauses on a TV: with the
 * controls hidden it shows them (focus on Play/Pause), with them visible the focused button handles it. Backspace maps to nothing
 * (it is a back key on TVs, `isBackKey`). Film playback keeps `keymap.ts`.
 */
export function resolveLiveKey(e: KeyInput, c: LiveKeyContext): LiveKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'Escape') return { type: 'close' };
  if (c.overlayOpen) return null;
  if (/^[0-9]$/.test(k)) return { type: 'digit', d: Number(k) };
  if (k === 'Enter') {
    if (c.numberOpen) return { type: 'enter' };
    return c.tv && !c.controlsVisible ? { type: 'showControls' } : null;
  }
  switch (k) {
    case 'ChannelUp': case 'PageUp': return { type: 'chUp' };
    case 'ChannelDown': case 'PageDown': return { type: 'chDown' };
    case 'MediaPlayPause': return { type: 'toggle' };
    case 'MediaFastForward': return { type: 'seek', by: 30 };
    case 'MediaRewind': return { type: 'seek', by: -30 };
    case 'ChannelList': case 'Guide': return { type: 'channelList' };
    case 'PreviousChannel': return { type: 'last' };
    case 'Info': return { type: 'info' };
    default: break;
  }
  if (c.lg && k === 'ColorF0Red') return { type: 'last' };
  if (c.lg && k === 'ColorF3Blue') return { type: 'live' };
  if (c.tv) {
    if (c.controlsVisible) return null; // spatial navigation moves the focus
    if (k === 'ArrowUp') return { type: 'chUp' };
    if (k === 'ArrowDown') return { type: 'chDown' };
    if (k === 'ArrowLeft') return { type: 'controls', focus: 'back30' };
    if (k === 'ArrowRight') return { type: 'controls', focus: 'fwd30' };
    return null; // letters stay free on the TV
  }
  if (k === 'k') return { type: 'toggle' };
  if (k === 'j') return { type: 'seek', by: -30 };
  if (k === 'l') return { type: 'seek', by: 30 };
  if (k === 'End') return { type: 'live' };
  if (k === 'i') return { type: 'info' };
  if (k === 'q') return { type: 'last' };
  if (k === 'm') return { type: 'mute' };
  if (k === 'f') return { type: 'fullscreen' };
  if (!c.onBody) return null; // a focused control keeps Space and the arrows
  if (k === ' ') return { type: 'toggle' };
  if (k === 'ArrowUp') return { type: 'chUp' };
  if (k === 'ArrowDown') return { type: 'chDown' };
  if (k === 'ArrowLeft') return { type: 'seek', by: -10 };
  if (k === 'ArrowRight') return { type: 'seek', by: 10 };
  return null;
}
