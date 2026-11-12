// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createLongOk, LONG_OK_MS } from './longok';

function rig(ms?: number) {
  let now = 0;
  let pending: { at: number; fn: () => void; h: number } | null = null;
  let seq = 0;
  const log: string[] = [];
  const lo = createLongOk({
    ms,
    timers: { set: (fn, d) => { pending = { at: now + d, fn, h: ++seq }; return seq; }, clear: (h) => { if (pending && pending.h === h) pending = null; } },
    onShort: () => log.push('short'),
    onLong: () => log.push('long'),
  });
  const advance = (d: number) => {
    now += d;
    if (pending && pending.at <= now) { const p: { fn: () => void } = pending; pending = null; p.fn(); }
  };
  return { lo, log, advance };
}

describe('createLongOk', () => {
  it('is 600 ms', () => { expect(LONG_OK_MS).toBe(600); });
  it('a keyup at 300 ms is a short press', () => {
    const { lo, log, advance } = rig();
    lo.down({ repeat: false }); advance(300); lo.up();
    expect(log).toEqual(['short']);
  });
  it('held for 600 ms fires long once; the keyup after it does nothing', () => {
    const { lo, log, advance } = rig();
    lo.down({ repeat: false }); advance(599); expect(log).toEqual([]);
    advance(1); expect(log).toEqual(['long']);
    advance(3000); lo.up(); expect(log).toEqual(['long']);
  });
  it('key repeats do not restart the timer, and repeat-less repeats of a held key are ignored too', () => {
    const { lo, log, advance } = rig();
    lo.down({ repeat: false }); advance(400); lo.down({ repeat: true }); lo.down({ repeat: false }); advance(200);
    expect(log).toEqual(['long']);
    lo.up(); expect(log).toEqual(['long']);
  });
  it('a new press after the keyup works again', () => {
    const { lo, log, advance } = rig();
    lo.down({ repeat: false }); advance(100); lo.up(); lo.down({ repeat: false }); advance(600); lo.up();
    expect(log).toEqual(['short', 'long']);
  });
  it('cancel drops a pending press without a callback', () => {
    const { lo, log, advance } = rig();
    lo.down({ repeat: false }); lo.cancel(); advance(1000); lo.up();
    expect(log).toEqual([]);
  });
  it('a keyup without a keydown does nothing; a custom ms is used', () => {
    const { lo, log, advance } = rig(200);
    lo.up(); expect(log).toEqual([]);
    lo.down({ repeat: false }); advance(200); expect(log).toEqual(['long']);
  });
});
