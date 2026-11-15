// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api, ApiError } from '#lib/api';
import type { InfoBody, PlaybackDto } from './infobody';

/**
 * The player's source seam (spec §15.7, plan Phase 3 Task 9): where `Player.svelte` asks what to play and where it reports. Two
 * implementations: `jellyfinSource` (a library item; the default when the player gets no `source`, and exactly today's calls: the
 * player keeps building its own bodies and sends them through `request` / `report` unchanged) and `recordingSource` (a FriendFlix
 * recording: `POST …/play` for a `/media/r/` token, progress to `…/progress` every 10 s and on pause / stop, the token's heartbeat
 * every 20 s, `DELETE /api/livetv/watch` at the end). `caps` gates what only a library item has (episodes, credits, scenes,
 * trickplay, the quality ladder, bookmarks, the subtitle search).
 */
export interface PlaybackCaps { episodes: boolean; credits: boolean; scenes: boolean; trickplay: boolean; abr: boolean; bookmarks: boolean; subtitleSearch: boolean }
export interface SourceInfo { url: string; kind: 'hls'; growing: boolean; durationS: number | null; positionS: number }
export type SourceState = 'playing' | 'paused' | 'stopped';

interface SourceBase { id: string; caps: PlaybackCaps }

/** a FriendFlix recording: its own token, progress and end calls */
export interface RecordingSource extends SourceBase {
  kind: 'recording';
  /** `via: 'airplay'`: a token the TV may fetch too (a recording; the token it replaces ends) */
  info(startSec?: number, o?: { via?: 'airplay' }): Promise<SourceInfo>;
  progress(posS: number, state: SourceState, o?: { keepalive?: boolean }): Promise<void>;
  beat?(): Promise<void>;
  stop(o?: { keepalive?: boolean }): Promise<void>;
  /** a recording: its token is still alive (false after `stop`, until the next `info`) */
  active?(): boolean;
  /** set by the player: the source learned that what it plays is gone (a 410 heartbeat, a deleted recording) */
  onGone?: () => void;
}

/** a library item: the player builds its own bodies and sends them through these two calls */
export interface JellyfinSource extends SourceBase {
  kind: 'item';
  /** POST /api/playback/info with the player's body, exactly as before the seam */
  request(body: InfoBody): Promise<PlaybackDto | null>;
  /** POST /api/playback/<kind> with the player's report body, exactly as before the seam */
  report(kind: 'start' | 'progress' | 'stop', body: unknown, keepalive?: boolean): Promise<unknown>;
}

export type PlaybackSource = JellyfinSource | RecordingSource;

const ALL: PlaybackCaps = { episodes: true, credits: true, scenes: true, trickplay: true, abr: true, bookmarks: true, subtitleSearch: true };
const NONE: PlaybackCaps = { episodes: false, credits: false, scenes: false, trickplay: false, abr: false, bookmarks: false, subtitleSearch: false };

/** a library item (Jellyfin / Plex through the backend): today's player calls behind the seam */
export function jellyfinSource(itemId: string): JellyfinSource {
  return {
    kind: 'item', id: itemId, caps: ALL,
    request: (body) => api<PlaybackDto | null>('/api/playback/info', { method: 'POST', body }),
    report: (kind, body, keepalive = false) => api(`/api/playback/${kind}`, { method: 'POST', body, keepalive }),
  };
}

/** the recording is not there any more (deleted, no longer shared): the player shows "Aufnahme nicht mehr verfügbar" */
export class GoneError extends Error { readonly gone = true; constructor() { super('gone'); } }

export interface SourceDeps {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (h: ReturnType<typeof setInterval>) => void;
}
const realDeps: SourceDeps = { now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h) };
export const REC_PROGRESS_MS = 10_000;
export const REC_BEAT_MS = 20_000;

/** a FriendFlix recording (spec §15.7): a VOD-like HLS EVENT/VOD playlist under `/media/r/<token>/` */
export function recordingSource(id: string, deps: SourceDeps = realDeps): RecordingSource {
  const enc = encodeURIComponent(id);
  let token: string | null = null;
  let lastSent = -Infinity;
  let beatT: ReturnType<typeof setInterval> | null = null;
  const stopBeat = () => { if (beatT !== null) { deps.clearInterval(beatT); beatT = null; } };
  const gone = (e: unknown) => e instanceof ApiError && (e.status === 410 || e.status === 404);
  const s: RecordingSource = {
    kind: 'recording', id, caps: NONE,
    async info(_startSec, o) {
      let r: { token: string; url: string; growing: boolean; durationS: number | null; positionS: number };
      try { r = await api(`/api/livetv/recordings/${enc}/play`, { method: 'POST', body: o?.via ? { via: o.via } : {} }); } catch (e) { if (gone(e)) throw new GoneError(); throw e; }
      const prev = token;
      token = r.token;
      if (prev && prev !== r.token) void api('/api/livetv/watch', { method: 'DELETE', body: { token: prev } }).catch(() => undefined); // one token per player
      stopBeat();
      beatT = deps.setInterval(() => { void s.beat?.(); }, REC_BEAT_MS);
      return { url: r.url, kind: 'hls', growing: r.growing, durationS: r.durationS, positionS: r.positionS };
    },
    async progress(posS, state, o) {
      const t = deps.now();
      if (state === 'playing' && t - lastSent < REC_PROGRESS_MS) return;
      lastSent = t;
      await api(`/api/livetv/recordings/${enc}/progress`, { method: 'POST', body: { positionS: Math.max(0, Math.floor(posS)) }, keepalive: o?.keepalive }).catch((e) => { if (gone(e)) s.onGone?.(); });
    },
    async beat() {
      if (!token) return;
      try { await api('/api/livetv/beat', { method: 'POST', body: { token } }); } catch (e) { if (gone(e)) { stopBeat(); s.onGone?.(); } }
    },
    active: () => token !== null,
    async stop(o) {
      stopBeat();
      const tok = token;
      token = null;
      if (tok) await api('/api/livetv/watch', { method: 'DELETE', body: { token: tok }, keepalive: o?.keepalive }).catch(() => undefined);
    },
  };
  return s;
}
