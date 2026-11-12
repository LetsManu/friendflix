// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV, tab *Quellen* (spec §9.1, §10): the wire shapes of the sources routes (plan Task 15), the refresh (Task 16) and
 * the own feeds (Task 20), and thin callers. The browser never gets a provider URL: `urlHint` / `epgHint` ("https://host/…") are the
 * only form it sees (F13), and a URL travels only from the sheet to the server. The own-feeds source is `kind: 'feeds'` on the wire
 * (stored `'manual'`, F16); `refresh: 'manual'` is the interval and has nothing to do with it.
 */
import { api } from '#lib/api';

export type SourceKind = 'm3u' | 'feeds';
export type Refresh = '6h' | '12h' | '24h' | 'weekly' | 'manual';
export const REFRESHES: readonly Refresh[] = ['6h', '12h', '24h', 'weekly', 'manual'];
export type Numbering = 'chno' | 'order';
export type LogoPref = 'm3u' | 'xmltv';
export type StreamKind = 'hls' | 'ts' | 'srt';

export interface SourceCounts { channels: number; added: number; removed: number }
export interface SourceState {
  lastRefreshAt: string | null;
  lastOkAt: string | null;
  /** a fixed code (spec §19), never provider text */
  lastError: string | null;
  counts: SourceCounts | null;
  epg: { lastRefreshAt: string | null; lastOkAt: string | null; lastError: string | null; programmes: number | null };
}
/** `SourceView` of backend/src/livetv/sources.ts (Task 15) */
export interface SourceView {
  id: string;
  kind: SourceKind;
  name: string;
  /** "https://iptv.example.com/…": scheme + host only, never a path, query or credentials */
  urlHint: string | null;
  epgHint: string | null;
  userAgent: string | null;
  allowLan: boolean;
  refresh: Refresh;
  skipGroups: string[];
  numbering: Numbering;
  numberBase: number;
  logoPref: LogoPref;
  epgShiftMin: number;
  maxStreams: number | null;
  enabled: boolean;
  position: number;
  channelCount: number;
  /** unreleased groups holding channels of this source */
  pendingGroups: number;
  state: SourceState;
}
/** `SourceBody` (Task 15, `.strict()`): POST sends all of it; PATCH sends only what changed (absent `url`/`epgUrl` = unchanged, `epgUrl: null` removes) */
export interface SourceBody {
  name: string;
  url: string;
  epgUrl?: string | null;
  userAgent?: string | null;
  allowLan: boolean;
  refresh: Refresh;
  skipGroups: string[];
  numbering: Numbering;
  numberBase: number;
  logoPref: LogoPref;
  epgShiftMin: number;
  maxStreams: number | null;
  enabled: boolean;
}
export type SourcePatch = Partial<SourceBody>;
/**
 * POST /sources/test: a missing `url` with `sourceId` uses the stored one. Refusals: 400 `{ error: 'invalid' | 'refused', field }`
 * (not a URL / wrong scheme; a single-label host or an internal address), 422 `{ error: code }` from livetv, 503 `livetv_unreachable`.
 */
export interface SourceTestBody { url?: string; epgUrl?: string; userAgent?: string; allowLan: boolean; sourceId?: string }
export interface SourceTest {
  /** listed channels (every group counted) */
  channels: number;
  /** list order, for the group picker (Task 22) */
  groups: Array<{ name: string; channels: number }>;
  /** up to five channel names */
  samples: string[];
  /** null when there is no XMLTV URL or it failed (then `epgError` says why) */
  epgChannels: number | null;
  /** the XMLTV fetch's error code; the list result still comes back */
  epgError: string | null;
}

/**
 * The part of the admin channel (Task 19's `AdminChannel`) the own-feeds card reads: `GET /api/admin/livetv/channels?source=<id>`.
 * `push` is set for SRT push feeds only: the assigned port, "ff-" + the first 6 random characters of the stream id (ruling 35), and
 * whether the port still lies in `LIVETV_SRT_PORTS`.
 */
export interface FeedChannel {
  id: string;
  name: string;
  number: number | null;
  kind: StreamKind;
  push: { port: number; idHint: string; inRange: boolean } | null;
}
/** `GET /api/admin/livetv/ingest` (from livetv's `GET /v1/ingest` and `/v1/system`): the host shown to encoders, the UDP ports, per feed its state */
export interface IngestView {
  host: string;
  ports: number[];
  feeds: Array<{ channelId: string; state: 'receiving' | 'idle'; rejected1h: number }>;
}
/** the one-time answer of a new push feed or new credentials (`cache-control: no-store`); never stored by the page */
export interface PushResult { host: string; port: number; streamId: string; passphrase: string; url: string }
export type NewStream =
  | { ingest: 'pull'; name: string; url: string; kind?: StreamKind; number?: number; groupId?: string; allowLan?: boolean }
  | { ingest: 'push'; name: string; number?: number; groupId?: string };
export interface GroupOption { id: string; name: string }

const B = '/api/admin/livetv';
const enc = encodeURIComponent;

export const listSources = () => api<{ sources: SourceView[] }>(`${B}/sources`).then((r) => r.sources);
export const createSource = (b: SourceBody) => api<SourceView>(`${B}/sources`, { method: 'POST', body: b });
export const updateSource = (id: string, patch: SourcePatch) => api<SourceView>(`${B}/sources/${enc(id)}`, { method: 'PATCH', body: patch });
export const deleteSource = (id: string) => api<{ channels: number }>(`${B}/sources/${enc(id)}`, { method: 'DELETE' });
/** 202: the refresh runs in the background; its result arrives through polling `GET /sources` (spec §10) */
export const refreshSource = (id: string) => api<unknown>(`${B}/sources/${enc(id)}/refresh`, { method: 'POST' });
export const testSource = (b: SourceTestBody) => api<SourceTest>(`${B}/sources/test`, { method: 'POST', body: b });

export const listFeeds = (sourceId: string) => api<{ channels: FeedChannel[]; total: number }>(`${B}/channels?source=${enc(sourceId)}&limit=200`);
export const ingestView = () => api<IngestView>(`${B}/ingest`);
export const listGroups = () => api<{ groups: GroupOption[] }>(`${B}/groups`).then((r) => r.groups);
export const addStream = (b: NewStream) => api<{ channel: FeedChannel; push?: PushResult }>(`${B}/channels`, { method: 'POST', body: b });
export const newCredentials = (id: string) => api<PushResult>(`${B}/channels/${enc(id)}/push-credentials`, { method: 'POST' });
export const newPort = (id: string) => api<{ port: number }>(`${B}/channels/${enc(id)}/push-port`, { method: 'POST' });
export const deleteChannel = (id: string) => api<unknown>(`${B}/channels/${enc(id)}`, { method: 'DELETE' });
