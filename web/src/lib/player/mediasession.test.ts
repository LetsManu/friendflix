// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CastSession } from '#lib/cast/engine';
import { bindCastMediaSession, mediaSessionOwner, type MediaSessionLike } from '#lib/cast/mediasession';
import { bindPlayerMediaSession as bindRaw, type MediaElementLike, type PlayerMediaActions, type PlayerMediaItem } from './mediasession';

const bound: Array<{ release(): void }> = [];
const bindPlayerMediaSession: typeof bindRaw = (...a) => { const b = bindRaw(...a); bound.push(b); return b; };
afterEach(() => { for (const b of bound.splice(0)) b.release(); });
type H = (d: { seekTime?: number; seekOffset?: number }) => void;
function fake(throwOn?: string) {
  const handlers = new Map<string, H | null>();
  const metaWrites: unknown[] = [];
  let metadata: unknown = undefined;
  const ms: MediaSessionLike & { pos: unknown[] } = {
    get metadata() { return metadata; },
    set metadata(v: unknown) { metaWrites.push(v); metadata = v; },
    playbackState: 'none', pos: [],
    setActionHandler: (a, fn) => { if (a === throwOn) throw new Error('unsupported'); handlers.set(a, fn); },
    setPositionState(s) { this.pos.push(s); },
  };
  return { ms, handlers, metaWrites };
}
function el(over: Partial<MediaElementLike> = {}): MediaElementLike {
  return Object.assign(new EventTarget(), { currentTime: 30, duration: 600, playbackRate: 1, paused: true }, over);
}
const item: PlayerMediaItem = { title: 'The Lantern Road', artist: 'Dunmoor · S1:F4', artworkIds: ['ep9', 's3'] };
const acts = (over: Partial<PlayerMediaActions> = {}): PlayerMediaActions => ({
  play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), seekBy: vi.fn(), next: vi.fn(), prev: vi.fn(), ...over,
});
const castView = (): CastSession => ({
  kind: 'chromecast', device: 'Stube-TV', itemId: 'c1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:E1 First', posterId: 'c1', isEpisode: true,
  position: 60, duration: 1800, paused: false, buffering: false, state: 'playing', audioTracks: [], subtitles: [], subIndex: -1, autoplay: true,
});
const castEng = { playPause: vi.fn(), seek: vi.fn(), skip: vi.fn(), next: vi.fn(async () => undefined) };

describe('player media session', () => {
  it('binds metadata, handlers and position', () => {
    const { ms, handlers } = fake();
    const b = bindPlayerMediaSession(el(), item, acts(), ms, (m) => m);
    expect(ms.metadata).toEqual({ title: 'The Lantern Road', artist: 'Dunmoor · S1:F4', artwork: [
      { src: '/media/Items/ep9/Images/Primary?maxWidth=512&quality=85' }, { src: '/media/Items/s3/Images/Primary?maxWidth=512&quality=85' }] });
    expect((ms.metadata as { artwork: object[] }).artwork.every((a) => !('sizes' in a))).toBe(true);
    for (const a of ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack']) expect(handlers.get(a)).toBeTypeOf('function');
    expect(ms.pos.at(-1)).toEqual({ duration: 600, position: 30, playbackRate: 1 });
    b.release();
  });

  it('actions call the player', () => {
    const { ms, handlers } = fake();
    const a = acts();
    bindPlayerMediaSession(el(), item, a, ms, (m) => m);
    handlers.get('seekbackward')!({});
    handlers.get('seekforward')!({ seekOffset: 30 });
    handlers.get('seekto')!({ seekTime: 120 });
    handlers.get('nexttrack')!({});
    handlers.get('previoustrack')!({});
    handlers.get('play')!({}); handlers.get('pause')!({});
    expect((a.seekBy as ReturnType<typeof vi.fn>).mock.calls).toEqual([[-10], [30]]);
    expect(a.seekTo).toHaveBeenCalledWith(120);
    expect(a.next).toHaveBeenCalledTimes(1);
    expect(a.prev).toHaveBeenCalledTimes(1);
    expect(a.play).toHaveBeenCalledTimes(1); expect(a.pause).toHaveBeenCalledTimes(1);
  });

  it('no next or previous without a target', () => {
    const { ms, handlers } = fake();
    const b = bindPlayerMediaSession(el(), item, acts({ next: null, prev: null }), ms, (m) => m);
    expect(handlers.get('nexttrack')).toBeNull();
    expect(handlers.get('previoustrack')).toBeNull();
    b.update(item, acts());
    expect(handlers.get('nexttrack')).toBeTypeOf('function');
  });

  it('position clamped and at most once a second', () => {
    const { ms } = fake();
    const e = el({ currentTime: 700 });
    let t = 10_000;
    bindPlayerMediaSession(e, item, acts(), ms, (m) => m, () => t);
    expect(ms.pos.at(-1)).toEqual({ duration: 600, position: 600, playbackRate: 1 });
    ms.pos.length = 0;
    e.dispatchEvent(new Event('timeupdate')); // same instant as the initial write
    expect(ms.pos).toHaveLength(0);
    t += 1000; e.currentTime = -5;
    e.dispatchEvent(new Event('timeupdate'));
    e.dispatchEvent(new Event('timeupdate'));
    expect(ms.pos).toEqual([{ duration: 600, position: 0, playbackRate: 1 }]);
    e.currentTime = 50;
    e.dispatchEvent(new Event('seeked')); // not throttled
    e.playbackRate = 2; e.dispatchEvent(new Event('ratechange'));
    expect(ms.pos.at(-1)).toEqual({ duration: 600, position: 50, playbackRate: 2 });
    ms.pos.length = 0;
    (e as { duration: number }).duration = NaN;
    e.dispatchEvent(new Event('loadedmetadata'));
    expect(ms.pos).toHaveLength(0);
  });

  it('playbackState mirrors play and pause events', () => {
    const { ms } = fake();
    const e = el();
    bindPlayerMediaSession(e, item, acts(), ms, (m) => m);
    expect(ms.playbackState).toBe('paused');
    e.dispatchEvent(new Event('play')); expect(ms.playbackState).toBe('playing');
    e.dispatchEvent(new Event('pause')); expect(ms.playbackState).toBe('paused');
  });

  it('artwork never carries a cast token', () => {
    const { ms } = fake();
    bindPlayerMediaSession(el(), item, acts(), ms, (m) => m);
    const art = (ms.metadata as { artwork: Array<{ src: string }> }).artwork;
    expect(art.length).toBeGreaterThan(0);
    for (const a of art) { expect(a.src).not.toContain('/media/c/'); expect(a.src).not.toMatch(/token/i); }
  });

  it('the cast binding takes over; the player stops writing', () => {
    const { ms, metaWrites } = fake();
    const b = bindPlayerMediaSession(el(), item, acts(), ms, (m) => m);
    const s = writable<CastSession | null>(null);
    const off = bindCastMediaSession(s, castEng, ms, (m) => m);
    s.set(castView());
    expect(ms.metadata).toMatchObject({ title: 'S1:E1 First' });
    b.update({ ...item, title: 'Other' }, acts()); // not the owner: leaves the cast's metadata
    expect(ms.metadata).toMatchObject({ title: 'S1:E1 First' });
    b.release();
    expect(ms.metadata).toMatchObject({ title: 'S1:E1 First' });
    expect(metaWrites).not.toContain(null);
    off();
  });

  it('when the cast ends and the player is still bound the player gets the session back without a blank moment', () => {
    const { ms, metaWrites } = fake();
    const b = bindPlayerMediaSession(el(), item, acts(), ms, (m) => m);
    const s = writable<CastSession | null>(null);
    const off = bindCastMediaSession(s, castEng, ms, (m) => m);
    s.set(castView());
    s.set(null);
    expect(ms.metadata).toMatchObject({ title: 'The Lantern Road' });
    expect(metaWrites).not.toContain(null);
    expect(ms.pos.at(-1)).toEqual({ duration: 600, position: 30, playbackRate: 1 });
    b.release(); off();
  });

  it('the cast blanks the session when it ends and nobody else owns it', () => {
    const { ms, handlers } = fake();
    const s = writable<CastSession | null>(null);
    const off = bindCastMediaSession(s, castEng, ms, (m) => m);
    s.set(castView());
    s.set(null);
    expect(ms.metadata).toBeNull();
    expect(mediaSessionOwner()).toBeNull();
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
    off();
  });

  it('a throwing setActionHandler is caught', () => {
    const { ms, handlers } = fake('previoustrack');
    expect(() => bindPlayerMediaSession(el(), item, acts(), ms, (m) => m)).not.toThrow();
    expect(handlers.get('nexttrack')).toBeTypeOf('function');
  });

  it('release clears what it owns', () => {
    const { ms, handlers } = fake();
    const e = el();
    const b = bindPlayerMediaSession(e, item, acts(), ms, (m) => m);
    b.release();
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe('none');
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
    expect(mediaSessionOwner()).toBeNull();
    ms.pos.length = 0;
    e.dispatchEvent(new Event('seeked'));
    expect(ms.pos).toHaveLength(0);
  });
});
