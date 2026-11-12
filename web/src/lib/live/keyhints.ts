// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TKey } from '#lib/i18n';

/** the key classes a device has sent; hints name only these (spec §11.3) */
export type SeenKey = 'channel' | 'digit' | 'colour' | 'info';
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

const KEY = 'ff-live-keys-seen';
const CLASSES: SeenKey[] = ['channel', 'digit', 'colour', 'info'];

export function classify(key: string): SeenKey | null {
  if (key === 'ChannelUp' || key === 'ChannelDown' || key === 'PageUp' || key === 'PageDown') return 'channel';
  if (/^[0-9]$/.test(key)) return 'digit';
  if (/^ColorF[0-3](Red|Green|Yellow|Blue)$/.test(key)) return 'colour';
  if (key === 'Info') return 'info';
  return null;
}

/** localStorage, or null where it is blocked or missing */
function defaultStore(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * What this page has seen this session, whatever the storage did: a storage that throws on read or write (private mode, blocked
 * site data) must not make a seen hint vanish again, because every call used to rebuild the set from storage alone.
 */
const memory = new Set<SeenKey>();
/** forgets the in-page keys (tests; a page never calls it) */
export function forgetSeenKeys(): void { memory.clear(); }

/** The classes this device has sent before: storage and this page's own memory. Empty storage, a blocked storage and garbage all mean: none (D-pad hints only). */
export function seenKeys(store?: StorageLike): Set<SeenKey> {
  const out = new Set<SeenKey>(memory);
  try {
    const s = store ?? defaultStore();
    const raw = s ? s.getItem(KEY) : null;
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) for (const x of v) if (CLASSES.includes(x as SeenKey)) out.add(x as SeenKey);
  } catch { /* unreadable: the page's own memory still counts */ }
  return out;
}

/** Remembers the class of a keydown (once per class) and returns what this device has sent so far. A failing storage is swallowed: the memory keeps the hint. */
export function noteKey(key: string, store?: StorageLike): Set<SeenKey> {
  const seen = seenKeys(store);
  const c = classify(key);
  if (!c || seen.has(c)) return seen;
  seen.add(c);
  memory.add(c);
  try {
    const s = store ?? defaultStore();
    if (s) s.setItem(KEY, JSON.stringify([...seen]));
  } catch { /* private mode: the hint stays until the page closes */ }
  return seen;
}

/** The footer hints (message keys, in display order): the D-pad ones always, a shortcut only after the device sent that key. */
export function hintKeys(where: 'list' | 'player', seen: Set<SeenKey>): TKey[] {
  if (where === 'player') return ['live.tvHint.longOkList'];
  const out: TKey[] = ['live.tvHint.ok', 'live.tvHintFav'];
  if (seen.has('channel')) out.push('live.tvHint.chJump');
  if (seen.has('digit')) out.push('live.tvHint.zeroLast');
  return out;
}
