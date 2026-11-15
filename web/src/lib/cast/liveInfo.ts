// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** A live channel on a TV (live TV spec §13) as a cast session describes it; shared by the web engine and the app's cast bar source. */

/** `now` = the programme's title, `next` = the following one as "21:00 Wetter am Hafen" */
export interface LiveInfo { channelId: string; number: number | null; name: string; now?: string; next?: string }

/** the one way a session becomes a live one: `live` and `isLive` together, so the two never disagree */
export const liveFields = (live: LiveInfo): { live: LiveInfo; isLive: true } => ({ live, isLive: true });

/** a FriendFlix recording on a TV (spec §15.7, plan Phase 3 Task 10) as a cast session describes it */
export interface RecInfo { recordingId: string; channel: string; growing: boolean }

/** what the receiver loads for a recording (lib/cast.ts `loadLiveOnCast` takes it) */
export interface RecCastMedia {
  contentId: string;
  contentType: 'application/x-mpegURL';
  /** a finished recording is a plain VOD; a growing one an EVENT playlist, which the receiver plays like a live stream it can seek in */
  streamType: 'BUFFERED' | 'LIVE';
  /** the play answer's `segments`, always named: the Default Media Receiver must not guess TS for an fMP4 recording (or the reverse) */
  hlsSegmentFormat: 'ts' | 'fmp4';
  /** the position the receiver starts at (s) */
  startTime: number;
  metadata: { title: string; subtitle: string; images: string[] };
  customData: { ui: { live: false } };
}

/** the receiver's media for a recording: `url` is absolute (origin + the answer's `/media/r/<token>/index.m3u8`) */
export function recCastMedia(o: { url: string; segments: 'ts' | 'fmp4'; growing: boolean; startS: number; title: string; subtitle: string; logo: string | null }): RecCastMedia {
  return {
    contentId: o.url, contentType: 'application/x-mpegURL', streamType: o.growing ? 'LIVE' : 'BUFFERED', hlsSegmentFormat: o.segments === 'fmp4' ? 'fmp4' : 'ts',
    startTime: Math.max(0, Math.floor(o.startS)), metadata: { title: o.title, subtitle: o.subtitle, images: o.logo ? [o.logo] : [] }, customData: { ui: { live: false } },
  };
}
