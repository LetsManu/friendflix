// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { derived, get, type Readable } from 'svelte/store';
import { goto } from '$app/navigation';
import { native, nativeCast, type NativeCastSnapshot } from '#lib/native/bridge';
import { castEngine, castSession, type CastSession } from './engine';

/** Where the cast bar gets its session from and where its buttons go: the page's own cast engine, or the Android app's Chromecast session. */
export interface CastBarSource {
  session: Readable<CastSession | null>;
  playPause(): void;
  next(): void;
  stop(): Promise<void>;
  /** the bar's text / thumbnail was tapped: show the remote */
  open(): void;
  /** the bar can grow into the expanded sheet (the web engine's; the app has none) */
  canExpand: boolean;
  /** the Next button shows only while a next episode is known (`session.upcoming`): the app's `next` answers false otherwise */
  nextNeedsQueue: boolean;
}

/** today's behaviour: the page's engine drives the TV, the watch page is its remote */
export function engineSource(): CastBarSource {
  return {
    session: castSession,
    playPause: () => castEngine.playPause(),
    next: () => void castEngine.next(),
    stop: () => castEngine.stop(),
    open: () => { const c = get(castSession); if (c) void goto('/watch/' + c.itemId); },
    canExpand: true,
    nextNeedsQueue: false,
  };
}

/** the app's snapshot as a bar session; the queued next episode is the `upcoming` one (known from the start, no countdown) */
function toSession(n: NativeCastSnapshot): CastSession {
  return {
    kind: 'chromecast', device: n.device, itemId: n.itemId, title: n.title, subtitle: n.subtitle ?? '', posterId: n.posterId, isEpisode: n.isEpisode,
    position: n.positionMs / 1000, duration: n.durationMs / 1000, paused: n.paused, buffering: false, state: n.state,
    audioTracks: [], subtitles: [], subIndex: -1, autoplay: true,
    ...(n.next ? { upcoming: { itemId: n.next.itemId, label: n.next.label } } : {}),
  };
}

/** the app's own Chromecast session (the shell shows it while browsing); every button is a `castControl` to the app */
export function nativeSource(): CastBarSource {
  return {
    session: derived(nativeCast, (n) => (n ? toSession(n) : null)),
    playPause: () => void native.castControl('playPause'),
    next: () => void native.castControl('next'),
    stop: async () => { await native.castControl('stop'); },
    open: () => void native.castControl('open'),
    canExpand: false,
    nextNeedsQueue: true,
  };
}
