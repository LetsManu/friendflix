// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watcher } from './watch';
import { POLL_MS, RECONNECT_MS, WATCH_MAX_MS } from './updater';

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
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
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
});
