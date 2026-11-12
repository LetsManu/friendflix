// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Media Session for the cast session: the lock screen / Control Center / notification shows what plays on the TV and its
 * buttons drive the TV (play, pause, seek, ±10 s, next episode) through the cast engine. Without a session the handlers and
 * the metadata are cleared again (the page's own media, if any, gets the browser's defaults back).
 */
import type { Readable } from 'svelte/store';
import { img } from '#lib/api';
import type { CastEngine, CastSession } from './engine';
import { tr } from '#lib/i18n';
import { liveCast } from './bar';
import { episodeRange } from './joined';

type Eng = Pick<CastEngine, 'playPause' | 'seek' | 'skip' | 'next' | 'prev'>;
/** the part of `navigator.mediaSession` used here (tests pass a fake) */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(action: string, fn: ((d: { seekTime?: number; seekOffset?: number }) => void) | null): void;
  setPositionState?(s: { duration: number; position: number; playbackRate: number }): void;
}
export const CAST_ACTIONS = ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack'] as const;
export type MediaSessionHandler = (d: { seekTime?: number; seekOffset?: number }) => void;

/** setActionHandler that tolerates actions the browser does not support */
export function setActionHandlerSafe(ms: MediaSessionLike, action: string, fn: MediaSessionHandler | null): void {
  try { ms.setActionHandler(action, fn); } catch { /* action not supported here */ }
}
/** position state with the position clamped to [0, duration]; skipped while the duration is unknown */
export function setPositionClamped(ms: MediaSessionLike, duration: number, position: number, playbackRate: number): void {
  if (!Number.isFinite(duration) || duration <= 0) return;
  const pos = Number.isFinite(position) ? Math.min(duration, Math.max(0, position)) : 0;
  try { ms.setPositionState?.({ duration, position: pos, playbackRate }); } catch { /* invalid state */ }
}
/** drop the given handlers, the metadata and the playback state */
export function clearMediaSession(ms: MediaSessionLike, actions: readonly string[]): void {
  for (const a of actions) setActionHandlerSafe(ms, a, null);
  ms.metadata = null;
  ms.playbackState = 'none';
}

// one owner at a time: the cast binding and the player binding never write over each other
let owner: symbol | null = null;
const ownerListeners = new Set<(o: symbol | null) => void>();
const setOwner = (o: symbol | null) => { owner = o; for (const fn of [...ownerListeners]) { try { fn(o); } catch { /* one bad listener must not stop the rest */ } } };
export function claimMediaSession(o: symbol): void { if (owner !== o) setOwner(o); }
/** true when `o` held the session (it is then free); a non-owner's release changes nothing */
export function releaseMediaSession(o: symbol): boolean { if (owner !== o) return false; setOwner(null); return true; }
export function mediaSessionOwner(): symbol | null { return owner; }
export function onMediaSessionOwner(fn: (o: symbol | null) => void): () => void { ownerListeners.add(fn); return () => { ownerListeners.delete(fn); }; }
const CAST_OWNER = Symbol('cast');

/** whether the page is in front (a locked or backgrounded page cannot keep a joined stream's per-episode lock screen current) */
export interface PageVisibility { visible(): boolean; onChange(fn: () => void): () => void }
export const documentVisibility = (): PageVisibility | undefined => typeof document === 'undefined' ? undefined : {
  visible: () => !document.hidden,
  onChange: (fn) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); },
};

export function bindCastMediaSession(
  session: Readable<CastSession | null>, eng: Eng,
  ms: MediaSessionLike | undefined = typeof navigator !== 'undefined' ? (navigator.mediaSession as unknown as MediaSessionLike | undefined) : undefined,
  meta: (m: { title: string; artist: string; artwork: Array<{ src: string; sizes: string }> }) => unknown = (m) => new MediaMetadata(m),
  page?: PageVisibility,
): () => void {
  if (!ms) return () => undefined;
  let bound = false, lastKey = '', lastPrev: boolean | null = null;
  const set = (a: string, fn: MediaSessionHandler | null) => setActionHandlerSafe(ms, a, fn);
  const clear = () => {
    if (!bound) return;
    bound = false; lastKey = ''; lastPrev = null;
    // give up ownership first; blank only if nobody (the player) took over in the meantime
    if (releaseMediaSession(CAST_OWNER) && mediaSessionOwner() === null) clearMediaSession(ms, CAST_ACTIONS);
  };
  let cur: CastSession | null = null;
  const apply = (s: CastSession | null) => {
    cur = s;
    if (!liveCast(s)) { clear(); return; } // a detached cast has nothing to drive
    if (!bound) {
      bound = true;
      // the claim must come before the handler set() calls below: a bound player clears all its handlers on takeover
      claimMediaSession(CAST_OWNER);
      set('play', () => { if (cur?.paused) eng.playPause(); });
      set('pause', () => { if (cur && !cur.paused) eng.playPause(); });
      set('seekto', (d) => { if (typeof d.seekTime === 'number') eng.seek(d.seekTime); });
      set('seekbackward', (d) => eng.skip(-(d.seekOffset || 10)));
      set('seekforward', (d) => eng.skip(d.seekOffset || 10));
    }
    const j = s.joined;
    // a joined stream while the page is hidden: the series and the episode range, the position on the whole stream (the page cannot follow the episodes)
    const series = Boolean(j) && page !== undefined && !page.visible();
    // previous episode only inside a joined stream, after the first episode
    const prev = Boolean(j && j.index > 0);
    if (prev !== lastPrev) { lastPrev = prev; set('previoustrack', prev ? () => eng.prev() : null); }
    // the next-episode button only for episodes (the engine's next(): the offered one, else the one after)
    const key = series && j ? `series|${s.title}|${j.items.length}|${j.items[0]?.itemId}` : `${s.itemId}|${s.title}|${s.subtitle}|${s.isEpisode}`;
    if (key !== lastKey) {
      lastKey = key;
      set('nexttrack', s.isEpisode ? () => void eng.next() : null);
      try {
        ms.metadata = series && j
          ? meta({ title: s.title, artist: episodeRange(j.items, tr), artwork: [{ src: img(s.seriesId ?? s.posterId, 512), sizes: '512x512' }] })
          : meta({ title: s.subtitle || s.title, artist: s.subtitle ? s.title : s.device, artwork: [{ src: img(s.posterId, 512), sizes: '512x512' }] });
      } catch { /* no MediaMetadata */ }
    }
    ms.playbackState = s.state === 'playing' && !s.paused ? 'playing' : 'paused';
    if (series && j) setPositionClamped(ms, j.streamDuration, j.streamPosition, 1);
    else setPositionClamped(ms, s.duration, s.position, 1);
  };
  const off = session.subscribe(apply);
  const offPage = page?.onChange(() => { if (bound) apply(cur); });
  return () => { off(); offPage?.(); clear(); };
}
