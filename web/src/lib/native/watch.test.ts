// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  (globalThis as { location?: unknown }).location ??= { origin: 'https://friend.example.com', href: 'https://friend.example.com/item/x' };
  return {
  available: true,
  play: vi.fn(async (_i: unknown, _o?: unknown): Promise<boolean> => true),
  };
});
vi.mock('./bridge', () => ({ native: { get available() { return h.available; } } }));
vi.mock('./play', () => ({ tryNativePlay: h.play }));

import { allowWebWatchOnce, interceptWatch, resetWatchIntercept, watchTarget, type WatchNav } from './watch';

const O = location.origin;
function nav(to: string, over: Partial<WatchNav> = {}): WatchNav & { cancelled: number } {
  const n = { type: 'link', willUnload: false, from: { url: new URL('/item/x', O) }, to: { url: new URL(to, O) }, cancelled: 0, cancel() { n.cancelled++; }, ...over };
  return n;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { h.available = true; h.play.mockReset(); h.play.mockResolvedValue(true); resetWatchIntercept(); });

describe('watchTarget', () => {
  it('reads the watch page like the shell does', () => {
    expect(watchTarget(new URL('/watch/abc-1?t=90&audio=ger&sub=off', O), O)).toEqual({ itemId: 'abc-1', positionTicks: 900_000_000, audio: 'ger', subtitle: 'off' });
    expect(watchTarget(new URL('/watch/abc?t=-1&audio=a%20b', O), O)).toEqual({ itemId: 'abc' });
    expect(watchTarget(new URL('/watch/abc', 'https://other.example.com'), O)).toBeNull();
    expect(watchTarget(new URL('/watch/a/b', O), O)).toBeNull();
    expect(watchTarget(new URL('/item/abc', O), O)).toBeNull();
  });
});

describe('interceptWatch', () => {
  it('a watch link goes to the native player and the navigation is cancelled', async () => {
    const n = nav('/watch/ep-1?t=30');
    const web = vi.fn();
    expect(interceptWatch(n, web)).toBe(true);
    expect(n.cancelled).toBe(1);
    await flush();
    expect(h.play).toHaveBeenCalledWith({ id: 'ep-1', positionTicks: 300_000_000 }, { audio: undefined, subtitle: undefined });
    expect(web).not.toHaveBeenCalled();
  });
  it('declined: the web player opens once, and that navigation is not asked again', async () => {
    h.play.mockResolvedValue(false);
    const web = vi.fn();
    interceptWatch(nav('/watch/ep-1'), web);
    await flush();
    expect(web).toHaveBeenCalledTimes(1);
    const again = nav('/watch/ep-1', { type: 'goto' });
    expect(interceptWatch(again, web)).toBe(false);
    expect(again.cancelled).toBe(0);
    expect(h.play).toHaveBeenCalledTimes(1);
    // the next time is a new question
    expect(interceptWatch(nav('/watch/ep-1'), web)).toBe(true);
  });
  it('allowWebWatchOnce lets exactly that URL through once', () => {
    allowWebWatchOnce('/watch/ep-2?t=5');
    expect(interceptWatch(nav('/watch/ep-2?t=5'), vi.fn())).toBe(false);
    expect(interceptWatch(nav('/watch/ep-2?t=5'), vi.fn())).toBe(true);
  });
  it('leaves everything else alone', () => {
    const web = vi.fn();
    expect(interceptWatch(nav('/item/x'), web)).toBe(false);
    expect(interceptWatch(nav('/watch/a', { type: 'popstate' }), web)).toBe(false);
    expect(interceptWatch(nav('/watch/a', { willUnload: true }), web)).toBe(false);
    expect(interceptWatch(nav('/watch/b', { from: { url: new URL('/watch/a', O) } }), web)).toBe(false); // the web player moves on itself
    expect(interceptWatch(nav('/watch/a'), web, { castActive: true })).toBe(false);
    h.available = false;
    expect(interceptWatch(nav('/watch/a'), web)).toBe(false);
    expect(h.play).not.toHaveBeenCalled();
  });
  it('a second tap while the app answers is swallowed', async () => {
    let done!: (v: boolean) => void;
    h.play.mockImplementation(() => new Promise<boolean>((r) => { done = r; }));
    expect(interceptWatch(nav('/watch/a'), vi.fn())).toBe(true);
    const second = nav('/watch/a');
    expect(interceptWatch(second, vi.fn())).toBe(true);
    expect(second.cancelled).toBe(1);
    expect(h.play).toHaveBeenCalledTimes(1);
    done(true);
    await flush();
  });
});
