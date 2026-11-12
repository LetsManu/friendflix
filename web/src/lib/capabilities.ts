// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import { ALL_PERMS, type PermKey, type Perms } from './perms';

/**
 * What the media server behind FriendFlix supports (backend: media/types.ts, sent once in /api/me as `server.capabilities`).
 * UI for an unsupported feature is hidden. Until /api/me answers - and for older backends that send nothing - everything
 * counts as supported, so a Jellyfin instance looks exactly as before.
 */
export interface ServerCaps {
  /** skip-segment types (intro / outro / recap / preview) */
  segments: string[];
  trickplay: boolean;
  /** announced episodes (calendar) */
  upcoming: boolean;
  /** remote subtitle search in the player */
  subtitleSearch: boolean;
  webhooks: boolean;
  changeFeed: boolean;
  planB: boolean;
  /** subtitles come from FriendFlix itself (their URLs in the playback answer already point there; informational) */
  subtitleExtract: boolean;
  /** chapter marks on the seek bar + the player's "Szenen" panel (Block 17) */
  chapters: boolean;
  /** POST /api/playback/info may be prefetched on hover / focus (false: that call starts the server's transcode, e.g. Plex) */
  playbackPrefetch: boolean;
  /** the server can put one WebVTT subtitle rendition into an AirPlay stream (Jellyfin; Plex false) */
  castHlsSubtitles: boolean;
}

export const ALL_CAPS: ServerCaps = {
  segments: ['intro', 'outro', 'recap', 'preview'], trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false, chapters: true, playbackPrefetch: true, castHlsSubtitles: true,
};

/** Lenient parse: a missing or malformed field keeps its "supported" default. */
export function capsFrom(raw: unknown): ServerCaps {
  if (!raw || typeof raw !== 'object') return { ...ALL_CAPS, segments: [...ALL_CAPS.segments] };
  const r = raw as Record<string, unknown>;
  const flag = (k: Exclude<keyof ServerCaps, 'segments'>) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : ALL_CAPS[k]);
  return {
    segments: Array.isArray(r.segments) ? r.segments.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()) : [...ALL_CAPS.segments],
    trickplay: flag('trickplay'), upcoming: flag('upcoming'), subtitleSearch: flag('subtitleSearch'), webhooks: flag('webhooks'), changeFeed: flag('changeFeed'), planB: flag('planB'),
    subtitleExtract: flag('subtitleExtract'), chapters: flag('chapters'), playbackPrefetch: flag('playbackPrefetch'), castHlsSubtitles: flag('castHlsSubtitles'),
  };
}

export const serverCaps = writable<ServerCaps>(capsFrom(undefined));
/** media server kind of this instance (/api/me server.kind): 'jellyfin' until known and for anything that is not a plain kind name */
export const serverKind = writable<string>('jellyfin');
export const kindFrom = (v: unknown): string => (typeof v === 'string' && /^[a-z]{2,16}$/.test(v) ? v : 'jellyfin');

/** a skip button / timeline mark for this segment type may show */
export const segmentShown = (c: ServerCaps, type: string) => c.segments.includes(type.toLowerCase());

/**
 * Optional services of this instance (sent in /api/me as `features`, not a media server capability). Until /api/me answers - and
 * for older backends that send nothing - everything counts as on, except `surround` (a feature only a server that offers it turns on).
 */
export interface Features {
  /** a request service is set up: wishes, upcoming titles (the /requests page keeps its reminders without it) */
  requests: boolean;
  /** 1.1 post-play screen (POSTPLAY_ENABLED): the "Done? See what's next" card, the end-of-title overlay and /postplay/:id */
  postplay: boolean;
  /** SURROUND_AUDIO is on and the server is Jellyfin: the per-device "Surround sound" switch is offered (only an explicit true counts) */
  surround: boolean;
  /** the optional Live TV container is installed and switched on (only an explicit true counts) */
  livetv: boolean;
}
export const ALL_FEATURES: Features = { requests: true, postplay: true, surround: false, livetv: false };
/** Lenient parse: only an explicit false turns a feature off (`surround` and `livetv` are the reverse: only an explicit true turns them on). */
export function featuresFrom(raw: unknown): Features {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { requests: r.requests !== false, postplay: r.postplay !== false, surround: r.surround === true, livetv: r.livetv === true };
}
/** The features the person gets from an /api/me answer: no right to request = like no request service (one fold for every reader). */
export const featuresOfMe = (m: { features?: unknown; perms?: unknown }): Features => {
  const f = m.features && typeof m.features === 'object' ? (m.features as Record<string, unknown>) : {};
  const p = m.perms && typeof m.perms === 'object' ? (m.perms as Record<string, unknown>) : {};
  return featuresFrom({ ...f, requests: f.requests !== false && p.requests !== false });
};
export const features = writable<Features>(featuresFrom(undefined));
/**
 * `features` holds what /api/me answered (true) or only the default / the last visit's boot hint (false). A page that renders early
 * from the hint must not call a service on that guess: the request service may have been removed since (see UpcomingRow, /new).
 */
export const featuresKnown = writable(false);

/** pages that only make sense with a capability or a feature (menus, footer, admin nav): href -> required flag */
const NEEDS: Record<string, Exclude<keyof ServerCaps, 'segments'>> = { '/calendar': 'upcoming' };
const FEATURE_NEEDS: Record<string, keyof Features> = { '/upcoming': 'requests', '/admin/requests': 'requests' };
/** ... or a right of the acting profile (lib/perms.ts) */
const PERM_NEEDS: Record<string, PermKey> = { '/party': 'party' };
export const linkShown = (c: ServerCaps, href: string, f: Features = ALL_FEATURES, p: Perms = ALL_PERMS) => {
  const k = NEEDS[href], fk = FEATURE_NEEDS[href], pk = PERM_NEEDS[href];
  return (!k || c[k]) && (!fk || f[fk]) && (!pk || p[pk]);
};
