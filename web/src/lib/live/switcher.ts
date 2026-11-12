// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LiveChannel } from './api';
import { neighbour } from './order';

export interface SwitcherOptions {
  /** the request goes out this long after the last press (spec §12.2: 400 ms) */
  delayMs: number;
  /** the zapping order of the filter the list was on */
  order(): LiveChannel[];
  /** the id of the channel that plays (or starts) now */
  current(): string;
  /** the banner follows every press at once */
  onCard(c: LiveChannel): void;
  /** one switch after the last press */
  onCommit(c: LiveChannel): void;
  timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
}

/**
 * Debounced zapping: each press moves a pending card one channel on (from the pending one, else the playing one) and shows it;
 * the switch happens `delayMs` after the last press. Presses that end on the playing channel switch nothing. `jump` (last channel,
 * number entry, a running channel from the full sheet) switches at once and drops a pending press.
 */
export function createSwitcher(o: SwitcherOptions): { press(dir: 1 | -1): void; jump(c: LiveChannel): void; dispose(): void } {
  let pending: LiveChannel | null = null;
  let handle: unknown = null;
  const clear = () => { if (handle !== null) { o.timers.clear(handle); handle = null; } };
  return {
    press(dir) {
      const list = o.order();
      if (!list.length) return;
      const c = neighbour(list, pending ? pending.id : o.current(), dir);
      pending = c;
      o.onCard(c);
      clear();
      handle = o.timers.set(() => {
        handle = null;
        const p = pending;
        pending = null;
        if (p && p.id !== o.current()) o.onCommit(p);
      }, o.delayMs);
    },
    jump(c) {
      clear();
      pending = null;
      o.onCard(c);
      o.onCommit(c);
    },
    dispose() {
      clear();
      pending = null;
    },
  };
}
