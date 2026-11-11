// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({ castControl: vi.fn(async (_a: string) => true), goto: vi.fn(async (..._a: unknown[]) => {}), engine: { playPause: vi.fn(), next: vi.fn(async () => {}), stop: vi.fn(async () => {}) } }));
vi.mock('#lib/native/bridge', async () => {
  const { writable } = await import('svelte/store');
  return { nativeCast: writable(null), native: { castControl: h.castControl } };
});
vi.mock('./engine', async () => {
  const { writable } = await import('svelte/store');
  return { castSession: writable(null), castEngine: h.engine };
});
vi.mock('$app/navigation', () => ({ goto: h.goto }));

import { nativeCast } from '#lib/native/bridge';
import { castSession } from './engine';
import { engineSource, nativeSource } from './barSource';

const SNAP = { kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ep4', title: 'Dunmoor', subtitle: 'The Lantern Road', posterId: 'ep4p', isEpisode: true, positionMs: 61000, durationMs: 1800000, paused: false, state: 'playing', next: { itemId: 'ep5', label: 'E5 · Wrenfield Pier' } } as const;

beforeEach(() => { (nativeCast as ReturnType<typeof writable>).set(null); (castSession as ReturnType<typeof writable>).set(null); vi.clearAllMocks(); });

describe('nativeSource', () => {
  it('maps a snapshot to a session', () => {
    const src = nativeSource();
    expect(get(src.session)).toBeNull();
    (nativeCast as ReturnType<typeof writable>).set(SNAP);
    expect(get(src.session)).toMatchObject({
      kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ep4', title: 'Dunmoor', subtitle: 'The Lantern Road', posterId: 'ep4p', isEpisode: true,
      position: 61, duration: 1800, paused: false, state: 'playing', upcoming: { itemId: 'ep5', label: 'E5 · Wrenfield Pier' }, autoplay: true,
    });
    expect(get(src.session)?.next).toBeUndefined();
    expect(src.canExpand).toBe(false);
  });
  it('a film without subtitle and next maps to empty subtitle and no upcoming; ended and paused carry over', () => {
    const src = nativeSource();
    (nativeCast as ReturnType<typeof writable>).set({ ...SNAP, isEpisode: false, subtitle: undefined, next: undefined, paused: true, state: 'ended' });
    const s = get(src.session)!;
    expect(s).toMatchObject({ subtitle: '', isEpisode: false, paused: true, state: 'ended' });
    expect(s.upcoming).toBeUndefined();
  });
  it('the session ends with the snapshot', () => {
    const src = nativeSource();
    (nativeCast as ReturnType<typeof writable>).set(SNAP);
    (nativeCast as ReturnType<typeof writable>).set(null);
    expect(get(src.session)).toBeNull();
  });
  it('stop and open call castControl', async () => {
    const src = nativeSource();
    await src.stop();
    src.open();
    src.playPause();
    src.next();
    expect(h.castControl.mock.calls.map((c) => c[0])).toEqual(['stop', 'open', 'playPause', 'next']);
    expect(h.goto).not.toHaveBeenCalled();
  });
});

describe('engineSource', () => {
  it('is the web engine: its session, its controls, the watch page as the remote', async () => {
    const src = engineSource();
    (castSession as ReturnType<typeof writable>).set({ itemId: 'ep4', state: 'playing' });
    expect(get(src.session)).toMatchObject({ itemId: 'ep4' });
    expect(src.canExpand).toBe(true);
    src.playPause(); src.next(); await src.stop(); src.open();
    expect(h.engine.playPause).toHaveBeenCalled();
    expect(h.engine.next).toHaveBeenCalled();
    expect(h.engine.stop).toHaveBeenCalled();
    expect(h.goto).toHaveBeenCalledWith('/watch/ep4');
    expect(h.castControl).not.toHaveBeenCalled();
  });
});
