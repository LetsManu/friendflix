// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watcher } from './watch';
import { POLL_MS, RECONNECT_MS, WATCH_MAX_MS } from './updater';
import { POLL_TIMEOUT_MS, backoff } from './watch';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('update poll watcher', () => {
  it('failed polls are reconnecting (slower), then it ends once the backend answers and nothing runs', async () => {
    const answers = [false, false, true, true];
    let busy = true;
    const ticks: boolean[] = [];
    const done = vi.fn(), timeout = vi.fn();
    const w = watcher({ poll: async () => answers.shift() ?? true, busy: () => busy, tick: (ok) => ticks.push(ok), done, timeout });
    w.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(ticks).toEqual([false]);
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    expect(ticks).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(6_000); // backing off
    expect(ticks).toEqual([false, false, true]);
    busy = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(done).toHaveBeenCalledOnce();
    expect(timeout).not.toHaveBeenCalled();
    expect(w.running).toBe(false);
  });

  it('stop() while a poll is in flight: no next poll is scheduled (a destroyed card keeps nothing running)', async () => {
    let release!: (ok: boolean) => void;
    const poll = vi.fn(() => new Promise<boolean>((res) => { release = res; }));
    const w = watcher({ poll, busy: () => true, done: vi.fn(), timeout: vi.fn() });
    w.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(poll).toHaveBeenCalledOnce();
    w.stop();
    release(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after the watch limit', async () => {
    const timeout = vi.fn();
    const w = watcher({ poll: async () => false, busy: () => true, done: vi.fn(), timeout });
    w.start();
    await vi.advanceTimersByTimeAsync(WATCH_MAX_MS + RECONNECT_MS * 2);
    expect(timeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backoff while the backend is away: 3 s, 6 s, then at most 10 s; back to 2 s after an answer', () => {
    expect([backoff(0), backoff(1), backoff(2), backoff(3), backoff(9)]).toEqual([POLL_MS, 3_000, 6_000, 10_000, 10_000]);
  });

  it('a poll that hangs is aborted after its timeout and counts as not answered; stop() aborts one in flight', async () => {
    const signals: AbortSignal[] = [];
    const ticks: boolean[] = [];
    const poll = (signal: AbortSignal) => { signals.push(signal); return new Promise<boolean>((res) => signal.addEventListener('abort', () => res(false))); };
    const w = watcher({ poll, busy: () => true, tick: (ok) => ticks.push(ok), done: vi.fn(), timeout: vi.fn() });
    w.start();
    await vi.advanceTimersByTimeAsync(POLL_MS + POLL_TIMEOUT_MS);
    expect(signals[0]!.aborted).toBe(true);
    expect(ticks).toEqual([false]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(signals).toHaveLength(2);
    w.stop();
    expect(signals[1]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals).toHaveLength(2);
  });
});
