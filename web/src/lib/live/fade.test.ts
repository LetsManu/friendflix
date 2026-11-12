// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { minute, untilNextMinute } from './fade';

describe('untilNextMinute', () => {
  it('the wait to just after the next full minute', () => {
    expect(untilNextMinute(0)).toBe(60_025);
    expect(untilNextMinute(59_990)).toBe(35);
    expect(untilNextMinute(10_000 + 120_000)).toBe(50_025);
  });
});

describe('minute', () => {
  afterEach(() => vi.useRealTimers());
  it('renews the time after every full minute, and only then', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 20, 37, 10));
    const seen: number[] = [];
    const stop = minute.subscribe((d) => seen.push(d.getMinutes()));
    expect(seen).toEqual([37]);
    vi.advanceTimersByTime(40_000);
    expect(seen).toEqual([37]);
    vi.advanceTimersByTime(10_100);
    expect(seen).toEqual([37, 38]);
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([37, 38, 39]);
    stop();
    vi.advanceTimersByTime(180_000);
    expect(seen).toHaveLength(3);
    expect(get(minute) instanceof Date).toBe(true);
  });
});
