// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeServerViaHome, goToAppHome, HIST_BASE_KEY, HOME_LEAVE_MS, recordHistoryBase, stepsToAppHome } from './home';

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('stepsToAppHome', () => {
  it('counts back to the start page', () => {
    expect(stepsToAppHome(2, 2)).toBe(-1);
    expect(stepsToAppHome(7, 2)).toBe(-6);
  });
  it('is null without a usable base', () => {
    expect(stepsToAppHome(5, null)).toBeNull();
    expect(stepsToAppHome(1, 3)).toBeNull();
  });
});

describe('recordHistoryBase', () => {
  it('stores the length once and never overwrites', () => {
    const s = store();
    recordHistoryBase({ history: { length: 2 }, sessionStorage: s });
    expect(s.m.get(HIST_BASE_KEY)).toBe('2');
    recordHistoryBase({ history: { length: 9 }, sessionStorage: s });
    expect(s.m.get(HIST_BASE_KEY)).toBe('2');
  });
  it('does not throw when storage is blocked', () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => recordHistoryBase({ history: { length: 2 }, sessionStorage: bad })).not.toThrow();
  });
});

describe('goToAppHome', () => {
  it('goes back to the start page', () => {
    const go = vi.fn();
    const ok = goToAppHome({ history: { length: 7, go }, sessionStorage: store({ [HIST_BASE_KEY]: '2' }) });
    expect(ok).toBe(true);
    expect(go).toHaveBeenCalledWith(-6);
  });
  it('is false (no throw) with storage blocked', () => {
    const go = vi.fn();
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(goToAppHome({ history: { length: 7, go }, sessionStorage: bad })).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});

describe('changeServerViaHome', () => {
  afterEach(() => vi.useRealTimers());
  const mkWin = (o: { length: number; base?: string }) => {
    const ls = new Map<string, () => void>();
    return {
      history: { length: o.length, go: vi.fn() },
      sessionStorage: store(o.base === undefined ? {} : { [HIST_BASE_KEY]: o.base }),
      addEventListener: (t: string, f: () => void) => void ls.set(t, f),
      removeEventListener: (t: string) => void ls.delete(t),
      fire: (t: string) => ls.get(t)?.(),
      ls,
    };
  };
  it('is 1.5 s', () => expect(HOME_LEAVE_MS).toBe(1500));
  it('the way is unknown: the hint at once, no navigation', () => {
    const w = mkWin({ length: 4 }), stuck = vi.fn();
    changeServerViaHome(stuck, w);
    expect(stuck).toHaveBeenCalledOnce();
    expect(w.history.go).not.toHaveBeenCalled();
  });
  it('goes back and stays quiet when the page is left (pagehide)', () => {
    vi.useFakeTimers();
    const w = mkWin({ length: 5, base: '2' }), stuck = vi.fn();
    changeServerViaHome(stuck, w);
    expect(w.history.go).toHaveBeenCalledWith(-4);
    w.fire('pagehide');
    vi.advanceTimersByTime(HOME_LEAVE_MS);
    expect(stuck).not.toHaveBeenCalled();
    expect(w.ls.has('pagehide')).toBe(false);
  });
  it('the page is still there after 1.5 s (the start page was pruned from the history): the hint', () => {
    vi.useFakeTimers();
    const w = mkWin({ length: 50, base: '2' }), stuck = vi.fn();
    changeServerViaHome(stuck, w);
    expect(w.history.go).toHaveBeenCalled();
    vi.advanceTimersByTime(HOME_LEAVE_MS - 1);
    expect(stuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stuck).toHaveBeenCalledOnce();
    expect(w.ls.has('pagehide')).toBe(false);
  });
});
