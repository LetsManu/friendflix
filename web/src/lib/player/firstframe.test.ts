// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_FRAME_MS, watchFirstFrame as watch } from './firstframe';

type Fake = ReturnType<typeof fakeVideo>;
const watchFirstFrame = (v: Fake, ms: number, cb: () => void) => watch(v as unknown as Parameters<typeof watch>[0], ms, cb);

function fakeVideo() {
  const l = new Map<string, Set<() => void>>();
  return {
    addEventListener: (t: string, f: () => void) => { (l.get(t) ?? l.set(t, new Set()).get(t)!).add(f); },
    removeEventListener: (t: string, f: () => void) => { l.get(t)?.delete(f); },
    emit: (t: string) => [...(l.get(t) ?? [])].forEach((f) => f()),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe('watchFirstFrame', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is 10 s', () => expect(FIRST_FRAME_MS).toBe(10_000));

  it('fires once when no picture arrives, and removes its listeners', () => {
    const v = fakeVideo(), cb = vi.fn();
    watchFirstFrame(v, FIRST_FRAME_MS, cb);
    vi.advanceTimersByTime(9_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(v.count()).toBe(0);
  });

  it.each(['loadeddata', 'playing'])('%s at 3 s means no call', (ev) => {
    const v = fakeVideo(), cb = vi.fn();
    watchFirstFrame(v, FIRST_FRAME_MS, cb);
    vi.advanceTimersByTime(3_000);
    v.emit(ev);
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    expect(v.count()).toBe(0);
  });

  it('cancel before 10 s means no call', () => {
    const v = fakeVideo(), cb = vi.fn();
    const cancel = watchFirstFrame(v, FIRST_FRAME_MS, cb);
    vi.advanceTimersByTime(5_000);
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    expect(v.count()).toBe(0);
  });
});
