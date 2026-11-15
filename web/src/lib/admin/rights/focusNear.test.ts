// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { focusNearest, nearestOpen } from './focusNear';

// Stage 3 parked finding: the role page's keepFocus must never land on a locked card; it falls back to the nearest unlocked control
describe('nearestOpen', () => {
  it('the entry itself when it is open', () => {
    expect(nearestOpen([false, true, false], 0)).toBe(0);
  });
  it('else the nearest open one, the next before the previous at the same distance', () => {
    expect(nearestOpen([false, true, false], 1)).toBe(2);
    expect(nearestOpen([false, true, true], 1)).toBe(0);
    expect(nearestOpen([true, true, true, false, true], 1)).toBe(3);
    expect(nearestOpen([false, true, true, true, false], 3)).toBe(4);
    expect(nearestOpen([false, true, true, true, true, true], 3)).toBe(0);
  });
  it('-1 when everything is locked or the start is outside', () => {
    expect(nearestOpen([true, true], 0)).toBe(-1);
    expect(nearestOpen([], 0)).toBe(-1);
    expect(nearestOpen([false], 3)).toBe(-1);
  });
});

describe('focusNearest', () => {
  const el = (name: string, locked = false) => ({ name, focus: vi.fn(), matches: (sel: string) => locked && sel.includes('aria-disabled') });
  it('focuses the target when it is unlocked', () => {
    const a = el('card'), b = el('next');
    expect(focusNearest([a, b], a)).toBe(a);
    expect(a.focus).toHaveBeenCalledOnce();
  });
  it('a locked target: the nearest unlocked control instead (never the locked card)', () => {
    const prev = el('Mediathek'), locked = el('Wünsche', true), alsoLocked = el('Gemeinsam', true), next = el('Live-TV');
    expect(focusNearest([prev, locked, alsoLocked, next], locked)).toBe(prev);
    expect(locked.focus).not.toHaveBeenCalled();
    expect(prev.focus).toHaveBeenCalledOnce();
    expect(focusNearest([prev, alsoLocked, locked, next], locked)).toBe(next);
  });
  it('nothing to focus: null, and nothing is focused', () => {
    const locked = el('Wünsche', true);
    expect(focusNearest([locked], locked)).toBeNull();
    expect(focusNearest([el('x')], locked)).toBeNull();
    expect(locked.focus).not.toHaveBeenCalled();
  });
});
