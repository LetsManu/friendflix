// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { goToAppHome, HIST_BASE_KEY, recordHistoryBase, stepsToAppHome } from './home';

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
