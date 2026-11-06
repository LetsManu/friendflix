// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LG remotes send media and colour keys often with `e.key === 'Unidentified'`; only `keyCode` is reliable.
 * This maps those codes to the standard key names the player keymap understands.
 */
const LG_KEYS: Record<number, string> = {
  415: 'MediaPlay', 19: 'MediaPause', 10252: 'MediaPlayPause', 413: 'MediaStop',
  417: 'MediaFastForward', 412: 'MediaRewind',
  403: 'ColorF0Red', 404: 'ColorF1Green',
};

export function lgKeyName(keyCode: number): string | null {
  return LG_KEYS[keyCode] ?? null;
}

export function normaliseLgKey(e: { key: string; keyCode: number }): string {
  return lgKeyName(e.keyCode) ?? e.key;
}
