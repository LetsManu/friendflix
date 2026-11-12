// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live TV keys on a Samsung TV (spec §14). Tizen sends a remote key only when the app registered it, and then often with
 * `e.key === 'Unidentified'`: only the keyCode tells which key it was. `registerLiveKeys` registers the live keys when the Live area
 * opens (each in its own try/catch, like `probe.ts`) and returns the code -> name map the TV reported (`getKey(name).code`, ruling 30);
 * the constants below are only the fallback. `normaliseTizenKey` turns a keydown into the standard name `resolveLiveKey` understands.
 */
import type { TizenLike } from './probe';

/** the keys every Samsung TV with the TV input device API can send */
export const TIZEN_LIVE_KEYS = ['ChannelUp', 'ChannelDown', 'PreviousChannel', 'Info', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'ColorF0Red', 'ColorF3Blue'] as const;
/** registered only where `getSupportedKeys()` lists them (owner decision 2026-11-12) */
export const TIZEN_OPTIONAL_KEYS = ['ChannelList', 'Guide'] as const;

/** the documented codes: used when there is no `tizen` object (a browser, a test) or a TV does not answer `getKey` */
const FALLBACK: Readonly<Record<number, string>> = {
  427: 'ChannelUp', 428: 'ChannelDown', 10190: 'PreviousChannel', 457: 'Info', 403: 'ColorF0Red', 406: 'ColorF3Blue', 10073: 'ChannelList', 458: 'Guide',
};
const FALLBACK_CODE: Readonly<Record<string, number>> = Object.keys(FALLBACK).reduce<Record<string, number>>((o, c) => { o[FALLBACK[Number(c)]!] = Number(c); return o; }, {});

export function registerLiveKeys(tz: TizenLike | undefined): Record<number, string> {
  const dev = tz?.tvinputdevice;
  if (!dev) return { ...FALLBACK };
  let supported: string[] | null = null;
  try { supported = (dev.getSupportedKeys?.() ?? []).map((k) => k.name); } catch { /* unknown: the optional keys stay off */ }
  const names: string[] = [...TIZEN_LIVE_KEYS, ...TIZEN_OPTIONAL_KEYS.filter((n) => supported?.includes(n))];
  const map: Record<number, string> = {};
  for (const name of names) {
    try { dev.registerKey(name); } catch { continue; } // this TV does not have the key: the others still register
    let code: number | undefined;
    try { code = dev.getKey?.(name).code; } catch { /* the constant below */ }
    if (typeof code !== 'number') code = FALLBACK_CODE[name];
    if (typeof code === 'number') map[code] = name;
  }
  return map;
}

/** a real `e.key` is never overridden: only an unidentified key is looked up by its code */
export function normaliseTizenKey(e: { key: string; keyCode: number }, map: Record<number, string>): string {
  return e.key === 'Unidentified' || e.key === '' ? map[e.keyCode] ?? e.key : e.key;
}
