// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { api, ApiError, getActiveProfile, getCsrf, sessionGone } from '#lib/api';
import { t } from '#lib/i18n';

/**
 * Web side of the live TV user API (backend: livetv/routes.ts, Tasks 31 and 33). Types and calls only; screens build on it.
 * The backend endpoints may be newer than this file: the shapes below are the declared contracts.
 */

/** one programme; `start` / `end` are ISO timestamps */
export interface Prog { title: string; start: string; end: string; subtitle?: string }

/** a channel as the person may see it (GET /api/livetv/channels) */
export interface LiveChannel {
  id: string;
  /** null: an own feed created without a number (show the name alone: `channelHead`) */
  number: number | null;
  name: string;
  logo: string | null;
  groupId: string | null;
  /** a shared stream is running right now (a preview image exists, a start is instant) */
  running: boolean;
  /** push feeds only: false = the encoder sends nothing right now */
  receiving?: boolean;
  /** `ok` = a programme covers now, `gap` = mapped to an EPG but nothing covers now, `none` = no EPG mapping (ruling 58) */
  epg: 'ok' | 'gap' | 'none';
  /** `/api/livetv/channels/<id>/preview.jpg`, only while running */
  preview?: string;
  now?: Prog;
  next?: Prog;
  favourite: boolean;
  /** position of the channel's group; only needed when two channels share a number (a missing value falls back to the list position) */
  groupPos?: number;
}

export interface LiveGroup { id: string; name: string }

export interface LiveList {
  groups: LiveGroup[];
  channels: LiveChannel[];
  /** channel ids in the person's own order */
  favourites: string[];
  /** channel ids, newest first, at most 10 */
  recent: string[];
  /** the last watched channel and the one before it */
  last: { id: string; previous: string | null } | null;
  dvrSeconds: number;
}

/** a channel that is running now (the "already on, starts at once" list of a full budget) */
export interface RunningChannel { id: string; number: number | null; name: string; logo: string | null; now?: Prog }

export type LiveMode = 'passthrough' | 'remux' | 'transcode';

/** POST /api/livetv/channels/:id/watch, 200 */
export interface WatchAnswer {
  token: string;
  url: string;
  expiresAt: number;
  dvrSeconds: number;
  mode: LiveMode;
  /** the playlist's segment format (an fMP4 / CMAF passthrough is `fmp4`); absent from an older backend = TS (bughunt M2) */
  segments?: 'ts' | 'fmp4';
  channel: { id: string; number: number | null; name: string; logo: string | null };
  now?: Prog;
  next?: Prog;
}

/** every refusal of `watch` */
export type WatchError =
  | { status: 503; error: 'live_full'; running: RunningChannel[] }
  | { status: 503; error: 'provider_limit'; max: number; running: RunningChannel[] }
  | { status: 502; error: 'channel_unreachable' }
  | { status: 409; error: 'not_receiving' }
  /** an admin stopped the channel or this viewer's stream a few minutes ago (Live-Status / Wiedergabe-Check *Stoppen*) */
  | { status: 409; error: 'stopped_by_admin' }
  | { status: 429; error: 'max_streams'; max: number }
  | { status: 403; error: 'forbidden' }
  | { status: 404; error: 'livetv_off' }
  | { status: 404; error: 'not_found' };

/** a refusal of `watch` as its typed error (null: not one of them); the cast engine reads its own calls' errors with it too */
export function watchError(e: ApiError): WatchError | null {
  const b = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
  const running = Array.isArray(b.running) ? (b.running as RunningChannel[]) : [];
  const max = typeof b.max === 'number' ? b.max : 0;
  switch (e.status) {
    case 503: return b.error === 'live_full' ? { status: 503, error: 'live_full', running } : b.error === 'provider_limit' ? { status: 503, error: 'provider_limit', max, running } : null;
    case 502: return b.error === 'channel_unreachable' ? { status: 502, error: 'channel_unreachable' } : null;
    case 409: return b.error === 'not_receiving' ? { status: 409, error: 'not_receiving' } : b.error === 'stopped_by_admin' ? { status: 409, error: 'stopped_by_admin' } : null;
    case 429: return b.error === 'max_streams' ? { status: 429, error: 'max_streams', max } : null;
    case 403: return { status: 403, error: 'forbidden' };
    case 404: return { status: 404, error: b.error === 'livetv_off' ? 'livetv_off' : 'not_found' };
    default: return null;
  }
}

/** The channel list. With the ETag of the last answer a 304 comes back as `notModified`. */
export async function channels(etag?: string): Promise<{ notModified: true } | { notModified: false; list: LiveList; etag: string | null }> {
  const profile = getActiveProfile();
  const res = await fetch('/api/livetv/channels', {
    credentials: 'same-origin',
    headers: { 'x-csrf-token': getCsrf(), ...(profile ? { 'x-ff-profile': profile } : {}), ...(etag ? { 'if-none-match': etag } : {}) },
  });
  if (res.status === 304) return { notModified: true };
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: handled below */ }
  await sessionGone(res.status, json); // an expired session leaves like it does in api(): the same redirect
  if (!res.ok || !json) throw new ApiError(res.status, json);
  return { notModified: false, list: json as LiveList, etag: res.headers.get('etag') };
}

/** Start or join a channel. Refusals come back typed; anything unexpected is thrown. */
export async function watch(id: string, via?: 'local' | 'chromecast' | 'airplay'): Promise<{ ok: true; answer: WatchAnswer } | { ok: false; error: WatchError }> {
  try {
    return { ok: true, answer: await api<WatchAnswer>(`/api/livetv/channels/${encodeURIComponent(id)}/watch`, { method: 'POST', body: via ? { via } : {} }) };
  } catch (e) {
    const err = e instanceof ApiError ? watchError(e) : null;
    if (err) return { ok: false, error: err };
    throw e;
  }
}

/** Keeps the viewer's token alive (every ~15 s); 410 `gone` throws an ApiError. */
export const beat = (token: string) => api<{ ok: true; expiresAt: number }>('/api/livetv/beat', { method: 'POST', body: { token } });

/** Ends a watch; `keepalive` lets it survive a page unload. */
export const stopWatching = (token: string, keepalive: boolean) => api<{ ok: true }>('/api/livetv/watch', { method: 'DELETE', body: { token }, keepalive });

/** Remembers the channel as watched (feeds "Zuletzt gesehen" and the last channel). */
export const setLast = (id: string) => api<{ ok: true }>('/api/livetv/last', { method: 'PUT', body: { id } });

export const favourite = (id: string, on: boolean) => api<{ ok: true }>(`/api/livetv/favourites/${encodeURIComponent(id)}`, { method: on ? 'POST' : 'DELETE' });

/** Saves the complete favourites order. */
export const setFavouriteOrder = (ids: string[]) => api<{ ok: true }>('/api/livetv/favourites', { method: 'PUT', body: { ids } });

const two = (n: number) => (n < 10 ? `0${n}` : String(n));
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
const line = (p: Prog) => `${clock(p.start)} ${p.title}`;

/**
 * The two reserved lines of a channel (list row, banner, panel) by data state: a push feed that is not receiving, no EPG, an EPG
 * that ran out, else the programmes. `next` null = the line stays reserved but empty.
 */
export function nowLines(c: LiveChannel): { now: string; next: string | null } {
  const tr = get(t);
  if (c.receiving === false) return { now: tr('live.notReceiving'), next: null };
  if (c.epg === 'gap') return { now: tr('live.gap'), next: null };
  if (c.epg === 'none' || !c.now) return { now: tr('live.liveOnly'), next: tr('live.noEpg') };
  return { now: line(c.now), next: c.next ? line(c.next) : null };
}
