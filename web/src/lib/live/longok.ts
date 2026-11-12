// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** how long OK has to be held to count as a long press */
export const LONG_OK_MS = 600;

export interface LongOkOptions {
  ms?: number;
  timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
  /** the key went up before the long press fired */
  onShort(): void;
  /** the key is still down after `ms`; fires once per press */
  onLong(): void;
}

/**
 * Long OK for the TV remote (list: favourite, player: channel list). The first keydown starts the timer; key repeats do not
 * (some TVs send repeats with `repeat: false`, so a keydown while a press is still open is ignored as well). The keyup decides:
 * before the timer it is a short press, after it nothing is left to do. `cancel()` drops an open press (blur, route change).
 */
export function createLongOk(o: LongOkOptions): { down(e: { repeat: boolean }): void; up(): void; cancel(): void } {
  const ms = o.ms ?? LONG_OK_MS;
  let open = false;
  let handle: unknown = null;
  let fired = false;
  const clear = () => { if (handle !== null) { o.timers.clear(handle); handle = null; } };
  return {
    down(e) {
      if (e.repeat || open) return;
      open = true;
      fired = false;
      handle = o.timers.set(() => { handle = null; fired = true; o.onLong(); }, ms);
    },
    up() {
      if (!open) return;
      const wasLong = fired;
      clear();
      open = false;
      fired = false;
      if (!wasLong) o.onShort();
    },
    cancel() { clear(); open = false; fired = false; },
  };
}
