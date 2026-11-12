// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import type { CastSession } from './engine';
import { bindCastMediaSession, type MediaSessionLike } from './mediasession';

const view = (over: Partial<CastSession> = {}): CastSession => ({
  kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:E1 First', posterId: 'ep1', isEpisode: true,
  position: 60, duration: 1800, paused: false, buffering: false, state: 'playing', audioTracks: [], subtitles: [], subIndex: -1, autoplay: true, ...over,
});
function fake() {
  const handlers = new Map<string, ((d: { seekTime?: number; seekOffset?: number }) => void) | null>();
  const ms: MediaSessionLike & { pos: unknown[] } = {
    metadata: undefined, playbackState: 'none', pos: [],
    setActionHandler: (a, fn) => { handlers.set(a, fn); },
    setPositionState(s) { this.pos.push(s); },
  };
  const eng = { playPause: vi.fn(), seek: vi.fn(), skip: vi.fn(), next: vi.fn(async () => undefined), prev: vi.fn() };
  return { ms, handlers, eng };
}

const JI = [
  { itemId: 'ep1', title: 'First', season: 2, episode: 1, start: 0, duration: 600 },
  { itemId: 'ep2', title: 'Second', season: 2, episode: 2, start: 600, duration: 600 },
  { itemId: 'ep3', title: 'Third', season: 2, episode: 3, start: 1200, duration: 600 },
];
const jview = (index: number, over: Partial<CastSession> = {}): CastSession => view({
  title: 'Dunmoor', subtitle: `S2:E${index + 1} ${['First', 'Second', 'Third'][index]}`, itemId: `ep${index + 1}`, posterId: `ep${index + 1}`, position: 50, duration: 600,
  joined: { items: JI, index, streamPosition: index * 600 + 50, streamDuration: 1800 }, ...over,
});
function page(visible = true) {
  const fns = new Set<() => void>();
  return { p: { visible: () => visible, onChange: (fn: () => void) => { fns.add(fn); return () => { fns.delete(fn); }; } }, set(v: boolean) { visible = v; for (const f of [...fns]) f(); } };
}

describe('cast media session (lock screen / Control Center drive the TV)', () => {
  it('joined: series metadata and stream position while hidden, episode while visible', () => {
    const { ms, eng } = fake();
    const s = writable<CastSession | null>(null);
    const pg = page(false);
    bindCastMediaSession(s, eng, ms, (m) => m, pg.p);
    s.set(jview(1));
    expect(ms.metadata).toMatchObject({ title: 'Dunmoor', artist: 'S2:F1\u2013F3' });
    expect(ms.pos.at(-1)).toEqual({ duration: 1800, position: 650, playbackRate: 1 });
    // the TV moves on while the page sleeps: the series lines stay
    s.set(jview(2));
    expect(ms.metadata).toMatchObject({ title: 'Dunmoor', artist: 'S2:F1\u2013F3' });
    expect(ms.pos.at(-1)).toEqual({ duration: 1800, position: 1250, playbackRate: 1 });
    pg.set(true);
    expect(ms.metadata).toMatchObject({ title: 'S2:E3 Third', artist: 'Dunmoor' });
    expect(ms.pos.at(-1)).toEqual({ duration: 600, position: 50, playbackRate: 1 });
    pg.set(false);
    expect(ms.metadata).toMatchObject({ title: 'Dunmoor', artist: 'S2:F1\u2013F3' });
    expect(ms.pos.at(-1)).toEqual({ duration: 1800, position: 1250, playbackRate: 1 });
  });

  it('joined, hidden: seekto lands on the stream timeline the position state shows', () => {
    const { ms, handlers, eng } = fake();
    const s = writable<CastSession | null>(null);
    const pg = page(false);
    bindCastMediaSession(s, eng, ms, (m) => m, pg.p);
    s.set(jview(1)); // stream position 650
    handlers.get('seekto')!({ seekTime: 100 });
    expect(eng.seek).not.toHaveBeenCalled();
    expect(eng.skip).toHaveBeenCalledWith(100 - 650); // stream second 100, whichever episode that is
    pg.set(true); // visible: the episode's own seconds
    handlers.get('seekto')!({ seekTime: 100 });
    expect(eng.seek).toHaveBeenCalledWith(100);
  });

  it('nexttrack is not armed on the last joined episode', () => {
    const { ms, handlers, eng } = fake();
    const s = writable<CastSession | null>(null);
    bindCastMediaSession(s, eng, ms, (m) => m, page(true).p);
    s.set(jview(1));
    expect(handlers.get('nexttrack')).toBeTypeOf('function');
    s.set(jview(2));
    expect(handlers.get('nexttrack')).toBeNull();
    s.set(jview(1, { joined: { items: JI, index: 1, streamPosition: 700, streamDuration: 1800 } }));
    expect(handlers.get('nexttrack')).toBeTypeOf('function');
  });

  it('joined across seasons: two episode codes in the artist line', () => {
    const { ms, eng } = fake();
    const items = [{ ...JI[0]!, season: 1, episode: 9 }, { ...JI[1]!, season: 2, episode: 1 }];
    bindCastMediaSession(writable<CastSession | null>(jview(0, { joined: { items, index: 0, streamPosition: 5, streamDuration: 1200 } })), eng, ms, (m) => m, page(false).p);
    expect(ms.metadata).toMatchObject({ artist: 'S1:F9\u2013S2:F1' });
  });

  it('previoustrack only after the first episode', () => {
    const { ms, handlers, eng } = fake();
    const s = writable<CastSession | null>(null);
    bindCastMediaSession(s, eng, ms, (m) => m, page(true).p);
    s.set(jview(0));
    expect(handlers.get('previoustrack')).toBeNull();
    s.set(jview(1));
    handlers.get('previoustrack')!({});
    expect(eng.prev).toHaveBeenCalledTimes(1);
    s.set(jview(0));
    expect(handlers.get('previoustrack')).toBeNull();
    // not joined: never
    s.set(view());
    expect(handlers.get('previoustrack') ?? null).toBeNull();
    s.set(null);
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
  });

  it('metadata, state, position and actions follow the cast session; they are cleared without one', () => {
    const { ms, handlers, eng } = fake();
    const s = writable<CastSession | null>(null);
    const off = bindCastMediaSession(s, eng, ms, (m) => m);
    expect(handlers.size).toBe(0);
    s.set(view());
    expect(ms.metadata).toEqual({ title: 'S1:E1 First', artist: 'Bright Valley', artwork: [{ src: '/media/Items/ep1/Images/Primary?maxWidth=512&quality=85', sizes: '512x512' }] });
    expect(ms.playbackState).toBe('playing');
    expect(ms.pos.at(-1)).toEqual({ duration: 1800, position: 60, playbackRate: 1 });
    handlers.get('pause')!({});
    handlers.get('play')!({}); // already playing: no toggle
    expect(eng.playPause).toHaveBeenCalledTimes(1);
    handlers.get('seekto')!({ seekTime: 300 });
    expect(eng.seek).toHaveBeenCalledWith(300);
    handlers.get('seekbackward')!({});
    handlers.get('seekforward')!({ seekOffset: 30 });
    expect(eng.skip.mock.calls).toEqual([[-10], [30]]);
    handlers.get('nexttrack')!({});
    expect(eng.next).toHaveBeenCalledTimes(1);
    s.set(view({ paused: true }));
    expect(ms.playbackState).toBe('paused');
    handlers.get('play')!({});
    expect(eng.playPause).toHaveBeenCalledTimes(2);
    // a film: no next-episode action, film title only
    s.set(view({ itemId: 'f', title: 'Film', subtitle: '', isEpisode: false, posterId: 'f' }));
    expect(handlers.get('nexttrack')).toBeNull();
    expect(ms.metadata).toMatchObject({ title: 'Film', artist: 'Wohnzimmer-TV' });
    s.set(null);
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe('none');
    off();
  });

  it('a detached cast (no live session) is not on the lock screen', () => {
    const { ms, handlers, eng } = fake();
    const s = writable<CastSession | null>(null);
    bindCastMediaSession(s, eng, ms, (m) => m);
    s.set(view());
    expect(handlers.size).toBeGreaterThan(0);
    s.set(view({ state: 'detached' }));
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe('none');
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
  });

  it('is a no-op without the Media Session API', () => {
    expect(() => bindCastMediaSession(writable(view()), fake().eng, undefined)()).not.toThrow();
  });
});
