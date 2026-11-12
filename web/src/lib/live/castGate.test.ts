// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAST_ADOPT_WAIT_MS, startsLocally } from './castGate';

afterEach(() => { vi.useRealTimers(); });

describe('startsLocally', () => {
  it('no live hint, or the app shell: starts at once, without asking the engine', async () => {
    const resume = vi.fn(async () => true);
    expect(await startsLocally({ hint: false, inShell: false, resume, hasLive: () => false })).toBe(true);
    expect(await startsLocally({ hint: true, inShell: true, resume, hasLive: () => false })).toBe(true);
    expect(resume).not.toHaveBeenCalled();
  });

  it('a live hint: the cast is re-adopted first, so no local watch starts', async () => {
    const resume = vi.fn(async () => true);
    expect(await startsLocally({ hint: true, inShell: false, resume, hasLive: () => false })).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    // the engine shows the cast even when resume() itself answered false (another path adopted it)
    expect(await startsLocally({ hint: true, inShell: false, resume: async () => false, hasLive: () => true })).toBe(false);
  });

  it('a live hint but no cast comes back: starts locally', async () => {
    expect(await startsLocally({ hint: true, inShell: false, resume: async () => false, hasLive: () => false })).toBe(true);
    expect(await startsLocally({ hint: true, inShell: false, resume: () => Promise.reject(new Error('x')), hasLive: () => false })).toBe(true);
  });

  it('waits at most the bound for a resume that does not answer', async () => {
    vi.useFakeTimers();
    let done: boolean | null = null;
    const p = startsLocally({ hint: true, inShell: false, resume: () => new Promise<boolean>(() => undefined), hasLive: () => false }).then((v) => { done = v; });
    await vi.advanceTimersByTimeAsync(CAST_ADOPT_WAIT_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});
