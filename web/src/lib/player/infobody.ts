// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The body of POST /api/playback/info, built in ONE place for the player and for the prefetch on the play buttons
 * (lib/player/prefetch.ts): the prefetched answer is only reused when both bodies are identical.
 */
import { autoBps } from './abr';
import { loadStoredEstimate } from './bandwidth';
import { firstInfoBody } from './bar';
import { appCaps, type ClientCapsBody } from '#lib/webos/caps';

/** /api/playback/info answer (backend PlaybackDto) as far as the web player uses it */
export interface PlaybackDto {
  playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string; resumeTicks: number; maxBitrate: number;
  roleMaxBitrate?: number;
  /** why the server transcodes (absent on direct play) */
  transcodeReason?: string;
  trickplay?: { width: number; height: number; tileWidth: number; tileHeight: number; count: number; interval: number; url: string };
  /** audio track the server baked into hlsUrl (audioLang matched a non-default track) */
  audioIndex?: number;
  audioTracks: Array<{ index: number; title: string; isDefault: boolean; language?: string }>;
  subtitles: Array<{ index: number; title: string; url: string; language?: string; isDefault: boolean }>;
  /** what the server planned for the HLS stream (absent on direct play, Plex and old servers): fixed codes only */
  delivery?: StreamDelivery;
}
/** backend StreamDelivery: the picture / sound the HLS stream carries and why (`videoCodec` is the output codec, `channels` the output channels) */
export interface StreamDelivery {
  video: 'copy' | 'h264' | 'hevc'; videoCodec: 'h264' | 'hevc'; audio: 'copy' | 'stereo' | 'surround'; audioCodec: string; channels: number; why: string[];
}

export type ReasonHint = 'network' | 'manual';
export interface InfoBody { itemId: string; startTicks?: number; audioIndex?: number; maxBitrate?: number; reasonHint: ReasonHint; audioLang?: string; caps?: ClientCapsBody;
  /** the one automatic fallback: which feature the device gave up, and the play session that failed (the server counts HEVC failures) */
  fellBack?: 'hevc' | 'surround' | 'both'; prevPs?: string;
  /**
   * `maxBitrate` is the 720p start of a device without a stored bandwidth estimate (new device, private mode, a week idle): a guess,
   * not the viewer's pick or a measured line. At a full conversion budget the server then still offers the copy up to the ceiling.
   * Not part of bodyKey.
   */
  startRung?: true;
  /** asked by a hover / focus prefetch (prefetch.ts), not by a player: only such a grant replaces the device's earlier one. Not part of bodyKey. */
  prefetch?: true }

/** seconds -> Jellyfin ticks (same rounding as secToTicks in lib/api) */
const ticks = (sec: number) => Math.floor(sec * 10_000_000);

/** bps = Infinity asks for the original (no maxBitrate); undefined fields are left out, like JSON.stringify does */
export function playbackInfoBody(o: { itemId: string; startSec?: number; audioIndex?: number; bps: number; hint: ReasonHint; audioLang?: string; caps?: ClientCapsBody | null; fellBack?: InfoBody['fellBack']; prevPs?: string; startRung?: boolean }): InfoBody {
  const b: InfoBody = { itemId: o.itemId, reasonHint: o.hint };
  if (o.startSec !== undefined) b.startTicks = ticks(o.startSec);
  if (o.audioIndex !== undefined) b.audioIndex = o.audioIndex;
  if (Number.isFinite(o.bps)) b.maxBitrate = o.bps;
  if (o.audioLang) b.audioLang = o.audioLang;
  if (o.caps) b.caps = o.caps;
  if (o.fellBack) { b.fellBack = o.fellBack; if (o.prevPs) b.prevPs = o.prevPs; }
  if (o.startRung && Number.isFinite(o.bps)) b.startRung = true;
  return b;
}

/** the start rung without a stored estimate: no saved quality (Auto), no ABR yet, nothing measured on this device within a week */
export const noEstimateStart = (quality: number, estimate: number | null): boolean => !quality && estimate === null;

/**
 * The first request of a player session: the saved quality (a pick = 'manual') or the rung for the remembered bandwidth
 * estimate ('network'), plus the preferred audio language (`audioPick` = detail-page pick / series choice wins over the profile default).
 */
export function firstPlaybackRequest(itemId: string, pf: { quality?: number; audioLang?: string }, audioPick = '', startSec?: number): { body: InfoBody; quality: number; hint: ReasonHint; bps: number } {
  const fb = firstInfoBody(pf, audioPick);
  const quality = fb.maxBitrate ?? 0;
  const hint: ReasonHint = quality ? 'manual' : 'network';
  const estimate = loadStoredEstimate();
  const bps = quality || autoBps(estimate);
  return { body: playbackInfoBody({ itemId, startSec, bps, hint, audioLang: fb.audioLang, caps: appCaps(), startRung: noEstimateStart(quality, estimate) }), quality, hint, bps };
}

/** flags about who asks and why, not about what is asked: a prefetched answer is reused whatever they say */
const KEYLESS = new Set(['startRung', 'prefetch']);
/** order-independent comparison key of a body (undefined fields do not count, nor do `startRung` and `prefetch`) */
export function bodyKey(b: object): string {
  const o = b as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).filter((k) => o[k] !== undefined && !KEYLESS.has(k)).sort().map((k) => [k, o[k]]));
}
