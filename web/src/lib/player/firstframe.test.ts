// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_FRAME_MS, firstFrameMs, watchFirstFrame as watch } from './firstframe';

type Fake = ReturnType<typeof fakeVideo>;
const watchFirstFrame = (v: Fake, ms: number, cb: () => void, opts?: { running: boolean }) => watch(v as unknown as Parameters<typeof watch>[0], ms, cb, opts);

function fakeVideo() {
  const l = new Map<string, Set<() => void>>();
  const v = {
    paused: true,
    addEventListener: (t: string, f: () => void) => { (l.get(t) ?? l.set(t, new Set()).get(t)!).add(f); },
    removeEventListener: (t: string, f: () => void) => { l.get(t)?.delete(f); },
    emit: (t: string) => [...(l.get(t) ?? [])].forEach((f) => f()),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
  };
  return v;
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

  it('counts playing time only: paused at 2 s, resumed at 20 s, fires at 28 s', () => {
    const v = fakeVideo(), cb = vi.fn();
    watchFirstFrame(v, FIRST_FRAME_MS, cb);
    vi.advanceTimersByTime(2_000);
    v.paused = true; v.emit('pause');
    vi.advanceTimersByTime(18_000);
    expect(cb).not.toHaveBeenCalled();
    v.paused = false; v.emit('play');
    vi.advanceTimersByTime(7_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(v.count()).toBe(0);
  });

  it('armed with running:false waits for play', () => {
    const v = fakeVideo(), cb = vi.fn();
    watchFirstFrame(v, FIRST_FRAME_MS, cb, { running: false });
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
    v.emit('play');
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('armed on a paused element with running:true fires at 10 s without a play event', () => {
    const v = fakeVideo(), cb = vi.fn();
    expect(v.paused).toBe(true);
    watchFirstFrame(v, FIRST_FRAME_MS, cb, { running: true });
    vi.advanceTimersByTime(9_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a pause event after arming holds the clock', () => {
    const v = fakeVideo(), cb = vi.fn();
    watchFirstFrame(v, FIRST_FRAME_MS, cb, { running: true });
    vi.advanceTimersByTime(4_000);
    v.emit('pause');
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();
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

describe('firstFrameMs', () => {
  it('is FIRST_FRAME_MS without an override', () => { expect(firstFrameMs({})).toBe(FIRST_FRAME_MS); expect(firstFrameMs(undefined)).toBe(FIRST_FRAME_MS); });
  it('takes a positive finite __ffFirstFrameMs (tests shorten the deadline)', () => { expect(firstFrameMs({ __ffFirstFrameMs: 800 })).toBe(800); });
  it('ignores a bad override', () => {
    for (const v of [0, -5, Infinity, NaN, '800', null]) expect(firstFrameMs({ __ffFirstFrameMs: v })).toBe(FIRST_FRAME_MS);
  });
});
