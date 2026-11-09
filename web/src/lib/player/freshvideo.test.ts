// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameShown, snapshotFrame, swapAllowed, type SwapState } from './freshvideo';

const calm: SwapState = { paused: true, party: false, remote: false, airplay: false, busy: false, creditsCorner: false };

describe('fresh <video> for the plain sound path', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('swaps only while paused and nothing else is going on', () => {
    expect(swapAllowed(calm)).toBe(true);
    for (const k of ['party', 'remote', 'airplay', 'busy', 'creditsCorner'] as const) expect(swapAllowed({ ...calm, [k]: true })).toBe(false);
    expect(swapAllowed({ ...calm, paused: false })).toBe(false);
  });

  it('snapshots the current frame at its own size as a JPEG data URL', () => {
    const drawn: number[][] = [];
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (_v: unknown, x: number, y: number, w: number, h: number) => { drawn.push([x, y, w, h]); } }), toDataURL: (t: string, q: number) => `data:${t};q=${q},AAA` };
    const v = { videoWidth: 1920, videoHeight: 800, readyState: 4 } as unknown as HTMLVideoElement;
    expect(snapshotFrame(v, () => canvas)).toBe('data:image/jpeg;q=0.92,AAA');
    expect(drawn).toEqual([[0, 0, 1920, 800]]);
    expect(canvas).toMatchObject({ width: 1920, height: 800 });
  });

  it('no snapshot without a frame, a canvas context or with a tainted picture', () => {
    const canvas = (o: { ctx?: boolean; url?: () => string } = {}) => () => ({ width: 0, height: 0, getContext: () => (o.ctx === false ? null : { drawImage: () => undefined }), toDataURL: o.url ?? (() => 'data:image/jpeg,A') });
    const v = (readyState: number, w = 640) => ({ videoWidth: w, videoHeight: 360, readyState }) as unknown as HTMLVideoElement;
    expect(snapshotFrame(v(1), canvas())).toBeNull();
    expect(snapshotFrame(v(4, 0), canvas())).toBeNull();
    expect(snapshotFrame(v(4), canvas({ ctx: false }))).toBeNull();
    expect(snapshotFrame(v(4), canvas({ url: () => { throw new Error('SecurityError'); } }))).toBeNull();
    expect(snapshotFrame(v(4), canvas({ url: () => 'data:,' }))).toBeNull(); // the browser could not encode it
  });

  /** an element whose state the test moves, firing the events the swap listens to */
  function fakeVideo(state: { seeking: boolean; readyState: number; currentTime: number }) {
    const ls = new Map<string, Set<() => void>>();
    return Object.assign(state, {
      addEventListener: (e: string, f: () => void) => { if (!ls.has(e)) ls.set(e, new Set()); ls.get(e)!.add(f); },
      removeEventListener: (e: string, f: () => void) => { ls.get(e)?.delete(f); },
      fire: (e: string) => { for (const f of [...(ls.get(e) ?? [])]) f(); },
      listeners: () => [...ls.values()].reduce((n, s) => n + s.size, 0),
    });
  }

  it('waits until the new element has its own frame at the old position, then stops listening', async () => {
    const v = fakeVideo({ seeking: false, readyState: 0, currentTime: 0 });
    let settled: boolean | undefined;
    void frameShown(v as unknown as HTMLVideoElement, 1500).then((r) => { settled = r; });
    v.readyState = 2; v.fire('loadeddata'); // a frame, but still at 0
    await Promise.resolve();
    expect(settled).toBeUndefined();
    v.currentTime = 1500; v.seeking = true; v.fire('timeupdate'); // seeking there
    await Promise.resolve();
    expect(settled).toBeUndefined();
    v.seeking = false; v.fire('seeked');
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(v.listeners()).toBe(0);
  });

  it('answers at once when the frame is already there, and gives up after the timeout', async () => {
    expect(await frameShown(fakeVideo({ seeking: false, readyState: 4, currentTime: 99.6 }) as unknown as HTMLVideoElement, 100)).toBe(true);
    vi.useFakeTimers();
    const v = fakeVideo({ seeking: false, readyState: 1, currentTime: 0 });
    const p = frameShown(v as unknown as HTMLVideoElement, 100, 5000);
    vi.advanceTimersByTime(5000);
    expect(await p).toBe(false);
    expect(v.listeners()).toBe(0);
  });
});
