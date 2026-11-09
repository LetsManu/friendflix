// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickHold, currentSection, SETTLE_MS, SPY_OFFSET } from './sections';

describe('currentSection', () => {
  const tops = [100, 500, 900, 1400];
  it('no sections: -1', () => {
    expect(currentSection([], 0)).toBe(-1);
    expect(currentSection([], 500, SPY_OFFSET, true)).toBe(-1);
  });
  it('before the first section: the first', () => {
    expect(SPY_OFFSET).toBe(120);
    expect(currentSection(tops, 0, 0)).toBe(0);
    expect(currentSection([300, 600], 0)).toBe(0);
  });
  it('the last section whose top passed the line', () => {
    expect(currentSection(tops, 0)).toBe(0);
    expect(currentSection(tops, 379)).toBe(0);
    expect(currentSection(tops, 380)).toBe(1);
    expect(currentSection(tops, 800)).toBe(2);
    expect(currentSection(tops, 800, 0)).toBe(1);
    expect(currentSection(tops, 5000)).toBe(3);
  });
  it('at the bottom: the last section', () => {
    expect(currentSection(tops, 400, SPY_OFFSET, true)).toBe(3);
  });
  it('a held (clicked) section wins, even at the bottom; out of range it is ignored', () => {
    expect(currentSection(tops, 400, SPY_OFFSET, true, 2)).toBe(2);
    expect(currentSection(tops, 0, SPY_OFFSET, false, 3)).toBe(3);
    expect(currentSection(tops, 400, SPY_OFFSET, true, 9)).toBe(3);
    expect(currentSection([], 0, SPY_OFFSET, false, 0)).toBe(-1);
  });
});

describe('clickHold', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds through the click\'s own scroll, the next scroll after it settled ends it', () => {
    const h = clickHold();
    expect(h.held).toBe(-1);
    h.scrolled(); // nothing held: nothing happens
    expect(h.held).toBe(-1);
    h.hold(4);
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(SETTLE_MS - 50); h.scrolled(); } // the smooth scroll runs
    expect(h.held).toBe(4);
    vi.advanceTimersByTime(SETTLE_MS); // it stopped
    expect(h.held).toBe(4); // still marked
    h.scrolled(); // the user scrolls
    expect(h.held).toBe(-1);
  });

  it('a click that scrolls nowhere still holds until the user scrolls; clear drops it', () => {
    const h = clickHold();
    h.hold(1);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(h.held).toBe(1);
    h.hold(2);
    h.clear();
    expect(h.held).toBe(-1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
