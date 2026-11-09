// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { freshClock, onPong, onServerStamp } from './partyclock';

describe('watch party clock', () => {
  it('takes the raw server stamp only until the first ping answer', () => {
    const c = onServerStamp(freshClock(), 10_500, 10_000);
    expect(c).toEqual({ offset: 500, bestRtt: Infinity });
    const corrected = onPong(c, 20_000, 20_560, 20_100, 0.5); // rtt 100 ms: server time + 50 ms
    expect(corrected).toEqual({ bestRtt: 100, offset: 510 });
    // a later state message (late by the one-way delay) must not replace the corrected offset
    expect(onServerStamp(corrected, 30_480, 30_000)).toBe(corrected);
  });

  it('a steady clock gives a steady offset across state messages (no jumps that would flip the rate)', () => {
    let c = onPong(freshClock(), 0, 1050, 100, 0.5); // offset 1000, rtt 100
    const offsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      c = onServerStamp(c, 2000 + i * 1000 + 1000 - 40 * (i % 2), 2000 + i * 1000); // stamps jitter by the network delay
      offsets.push(c.offset);
    }
    expect(new Set(offsets)).toEqual(new Set([1000]));
  });

  it('prefers faster round trips and follows a slower network now and then', () => {
    let c = onPong(freshClock(), 0, 1100, 200, 0.9); // rtt 200 -> offset 1000
    expect(c).toEqual({ bestRtt: 200, offset: 1000 });
    expect(onPong(c, 1000, 2300, 1400, 0.9)).toBe(c); // slower (400), not sampled: kept
    c = onPong(c, 1000, 2140, 1080, 0.9); // faster (80) -> taken
    expect(c).toEqual({ bestRtt: 80, offset: 1100 });
    const s = onPong(c, 2000, 3250, 2300, 0.05); // slower, sampled: taken, the best rtt grows by at most 20 %
    expect(s).toEqual({ bestRtt: 80 * 1.2, offset: 1100 });
  });

  it('ignores broken answers', () => {
    const c = onPong(freshClock(), 0, 1000, 100, 0.5);
    expect(onPong(c, 500, 1000, 400, 0)).toBe(c); // negative round trip (clock jumped back)
    expect(onPong(c, 0, Number.NaN, 100, 0)).toBe(c);
    expect(onServerStamp(freshClock(), Number.NaN, 0)).toEqual(freshClock());
  });
});
