// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Media Session for the page's own player: lock screen / Control Center / notification show what plays here and their
 * buttons drive the player. One owner at a time (see cast/mediasession.ts): while a cast owns the session this binding
 * stays silent and takes the session back (metadata, handlers, position) when the owner returns to nobody.
 * Artwork goes through the image proxy only; no token ever appears in the metadata.
 */
import { img } from '#lib/api';
import {
  claimMediaSession, clearMediaSession, mediaSessionOwner, onMediaSessionOwner, releaseMediaSession,
  setActionHandlerSafe, setPositionClamped, type MediaSessionHandler, type MediaSessionLike,
} from '#lib/cast/mediasession';

export const PLAYER_ACTIONS = ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack'] as const;
export interface PlayerMediaItem { title: string; artist: string; artworkIds: string[] }
export interface PlayerMediaActions {
  play(): void; pause(): void; seekTo(sec: number): void; seekBy(delta: number): void;
  next: (() => void) | null; prev: (() => void) | null;
}
export interface MediaElementLike extends EventTarget { currentTime: number; duration: number; playbackRate: number; paused: boolean }
type Meta = (m: { title: string; artist: string; artwork: Array<{ src: string }> }) => unknown;

export function bindPlayerMediaSession(
  el: MediaElementLike, item: PlayerMediaItem, actions: PlayerMediaActions,
  ms: MediaSessionLike | undefined = typeof navigator !== 'undefined' ? (navigator.mediaSession as unknown as MediaSessionLike | undefined) : undefined,
  meta: Meta = (m) => new MediaMetadata(m),
  now: () => number = () => Date.now(),
): { update(item: PlayerMediaItem, actions: PlayerMediaActions): void; release(): void } {
  if (!ms) return { update: () => undefined, release: () => undefined };
  const me = Symbol('player');
  let cur = item, act = actions, bound = true, lastPos = -Infinity;
  const owns = () => bound && mediaSessionOwner() === me;
  const set = (a: string, fn: MediaSessionHandler | null) => setActionHandlerSafe(ms, a, fn);

  const writeMeta = () => {
    try { ms.metadata = meta({ title: cur.title, artist: cur.artist, artwork: cur.artworkIds.map((id) => ({ src: img(id, 512) })) }); } catch { /* no MediaMetadata */ }
  };
  const writeHandlers = () => {
    set('play', () => { if (owns()) act.play(); });
    set('pause', () => { if (owns()) act.pause(); });
    set('seekto', (d) => { if (owns() && typeof d.seekTime === 'number') act.seekTo(d.seekTime); });
    set('seekbackward', (d) => { if (owns()) act.seekBy(-(d.seekOffset || 10)); });
    set('seekforward', (d) => { if (owns()) act.seekBy(d.seekOffset || 10); });
    set('nexttrack', act.next ? () => { if (owns()) act.next?.(); } : null);
    set('previoustrack', act.prev ? () => { if (owns()) act.prev?.(); } : null);
  };
  const writeState = () => { ms.playbackState = el.paused ? 'paused' : 'playing'; };
  const writePos = () => { lastPos = now(); setPositionClamped(ms, el.duration, el.currentTime, el.playbackRate || 1); };
  const applyAll = () => { writeMeta(); writeHandlers(); writeState(); writePos(); };

  const guard = (fn: () => void) => () => { if (owns()) fn(); };
  const on: Array<[string, () => void]> = [
    ['loadedmetadata', guard(() => { writeState(); writePos(); })], ['emptied', guard(writeState)], ['seeked', guard(writePos)], ['ratechange', guard(writePos)],
    ['timeupdate', guard(() => { if (now() - lastPos >= 1000) writePos(); })],
    ['play', guard(() => { ms.playbackState = 'playing'; })], ['pause', guard(() => { ms.playbackState = 'paused'; })],
  ];
  for (const [e, fn] of on) el.addEventListener(e, fn);

  const claimAndApply = () => { claimMediaSession(me); applyAll(); };
  const offOwner = onMediaSessionOwner((o) => { if (!bound) return;
    if (o === null) claimAndApply();
    else if (o !== me) for (const a of PLAYER_ACTIONS) set(a, null); // another owner: nothing of ours stays armed
  });
  if (mediaSessionOwner() === null) claimAndApply();

  return {
    update(i, a) {
      cur = i; act = a;
      if (!owns()) return;
      writeMeta(); writeHandlers();
    },
    release() {
      if (!bound) return;
      bound = false;
      offOwner();
      for (const [e, fn] of on) el.removeEventListener(e, fn);
      if (releaseMediaSession(me) && mediaSessionOwner() === null) clearMediaSession(ms, PLAYER_ACTIONS);
    },
  };
}
