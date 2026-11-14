// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Live-TV, tab *Quellen* (spec §9.1, §10): the wire shapes of the sources routes (plan Task 15), the refresh (Task 16) and
 * the own feeds (Task 20), and thin callers. The browser never gets a provider URL: `urlHint` / `epgHint` ("https://host/…") are the
 * only form it sees (F13), and a URL travels only from the sheet to the server. The own-feeds source is `kind: 'feeds'` on the wire
 * (stored `'manual'`, F16); `refresh: 'manual'` is the interval and has nothing to do with it.
 */
import { api } from '#lib/api';

/** `guide` = an extra programme guide (extra-guides plan Task 1): no channels, its import fills channels the lists' guides leave empty */
export type SourceKind = 'm3u' | 'feeds' | 'guide';
export type GuideProvider = 'xmltv_url' | 'xmltv_file';
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
  /** kind `guide` only (null otherwise): where the guide comes from */
  guideProvider: GuideProvider | null;
  /**
   * kind `guide`: the source ids (lists, the own-feeds source) whose channels it may serve; null = all channels; `[]` = every scoped
   * source was deleted (the guide is then disabled: "Gilt für keine Quelle mehr")
   */
  guideScope: string[] | null;
  /** an uploaded guide (`guideProvider: 'xmltv_file'`): the file's name and size, null before the first upload / for every other source */
  fileName: string | null;
  fileBytes: number | null;
  /** channels currently matched to this source's guide (`epg_source_id`) */
  servedChannels: number;
  state: SourceState;
}
/**
 * `SourceBody` (backend/src/livetv/sources.ts `sourceCreate` / `sourcePatch`, both `.strict()`): POST sends all of it, `epgUrl: null` for
 * no guide; PATCH sends only what changed (absent `url`/`epgUrl` = unchanged, `epgUrl: null` removes, `userAgent: null` clears).
 */
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
 * A link guide (extra-guides plan Task 1): POST sends `kind: 'guide'`; `guideScope` null = all channels, else a non-empty list of list /
 * own-feeds ids (`[]` is refused 400 `invalid`, field `guideScope`). PATCH takes only the fields below plus `position`.
 */
export interface GuideBody {
  kind: 'guide';
  name: string;
  epgUrl: string;
  userAgent?: string | null;
  allowLan?: boolean;
  refresh?: Refresh;
  epgShiftMin?: number;
  guideScope: string[] | null;
  enabled?: boolean;
}
/** A file guide (Stage 2): POST sends no link, agent, LAN switch or interval (the backend refuses them, 400); the file follows with `uploadGuideFile` */
export interface FileGuideBody {
  kind: 'guide';
  guideProvider: 'xmltv_file';
  name: string;
  guideScope: string[] | null;
  epgShiftMin?: number;
  enabled?: boolean;
}
/** a file guide's PATCH never carries `epgUrl` / `refresh` (nor agent / LAN switch) */
export type GuidePatch = Partial<Pick<GuideBody, 'name' | 'epgUrl' | 'refresh' | 'epgShiftMin' | 'guideScope' | 'enabled'>> & { position?: number };
/**
 * POST /sources/test: a missing `url` / `epgUrl` / `userAgent` with `sourceId` uses the stored one; `epgUrl: null` = no guide. Refusals:
 * 400 `{ error: 'invalid' | 'refused' | 'lan_required', field }`, 404 `not_found`, 409 `test_running` (one test per admin at a time),
 * 422 `{ error: code }` from livetv, 503 `livetv_unreachable`.
 */
export interface SourceTestBody { url?: string; epgUrl?: string | null; userAgent?: string; allowLan: boolean; sourceId?: string }
/** POST /sources/test for a guide: a missing `epgUrl` with `sourceId` uses the stored link */
export interface GuideTestBody { kind: 'guide'; epgUrl?: string; userAgent?: string; allowLan: boolean; sourceId?: string }
export interface GuideTest {
  epgChannels: number;
  /** up to eight channel display names */
  samples: string[];
}
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
 * The part of the admin channel (plan Task 19's `AdminChannel`, backend/src/livetv/ownfeeds.ts) the own-feeds card reads; the rows come
 * from `GET /api/admin/livetv/channels?source=<id>` (Task 19's list, spec §10 `{ channels, total }`). `push` is there for SRT push feeds
 * only: the port, `hint` = "ff-" + 6 characters (ruling 35; no ellipsis, the card adds "…") and whether the port is still in the range.
 */
export interface FeedChannel {
  id: string;
  name: string;
  number: number | null;
  streamKind: StreamKind;
  push?: { port: number; hint: string; portInRange: boolean };
}
/**
 * The state of a push feed (Task 20): `receiving` / `idle` from livetv, `pending` = livetv does not know the feed yet, `out_of_range` =
 * its port left LIVETV_SRT_PORTS, `off` = withdrawn from livetv (the channel is hidden or its source disabled), `error` = livetv not
 * reached.
 */
export type FeedState = 'receiving' | 'idle' | 'pending' | 'out_of_range' | 'off' | 'error';
export const FEED_STATES: readonly FeedState[] = ['receiving', 'idle', 'pending', 'out_of_range', 'off', 'error'];
/** `GET /api/admin/livetv/ingest` (Task 20): `ports` null while livetv cannot tell or the range is empty (then no ports line) */
export interface IngestView {
  /** LIVETV_SRT_HOST / the PUBLIC_URL host; null while unknown (not shown on the card) */
  host: string | null;
  ports: { from: number; to: number } | null;
  feeds: Array<{ channelId: string; state: FeedState; rejected1h: number }>;
}
/**
 * The one-time answer of a new push feed or new credentials (`cache-control: no-store`); never stored by the page. `host` (and with
 * it `url`) is null while neither LIVETV_SRT_HOST nor PUBLIC_URL is known.
 */
export interface PushResult { host: string | null; port: number; streamId: string; passphrase: string; url: string | null }
export type NewStream =
  | { ingest: 'pull'; name: string; url: string; kind?: StreamKind; number?: number; groupId?: string; allowLan?: boolean }
  | { ingest: 'push'; name: string; number?: number; groupId?: string };
export interface GroupOption { id: string; name: string }

const B = '/api/admin/livetv';
const enc = encodeURIComponent;

/** a bare array (backend adminRoutes.ts `GET /sources` → `listSources(ctx)`) */
export const listSources = () => api<SourceView[]>(`${B}/sources`);
export const createSource = (b: SourceBody) => api<SourceView>(`${B}/sources`, { method: 'POST', body: b });
export const createGuide = (b: GuideBody) => api<SourceView>(`${B}/sources`, { method: 'POST', body: b });
export const createFileGuide = (b: FileGuideBody) => api<SourceView>(`${B}/sources`, { method: 'POST', body: b });
/**
 * PUT /sources/:id/file: the file's bytes as they are; its name in the header `x-ff-file-name` (percent-encoded UTF-8; a header, not the
 * query, so it stays out of proxy access logs). 202 `{ started }`; refusals: 400 `invalid` (`field: 'file'`: an empty or broken-off
 * upload), 404, 409 `import_running` / `livetv_off`, 413 `too_large`.
 */
export const uploadGuideFile = (id: string, file: File) => api<{ started: boolean }>(`${B}/sources/${enc(id)}/file`, {
  method: 'PUT', raw: new Blob([file], { type: 'application/octet-stream' }), headers: { 'x-ff-file-name': encodeURIComponent(file.name) },
});
export const updateGuide = (id: string, patch: GuidePatch) => api<SourceView>(`${B}/sources/${enc(id)}`, { method: 'PATCH', body: patch });
export const testGuide = (b: GuideTestBody) => api<GuideTest>(`${B}/sources/test`, { method: 'POST', body: b });
export const updateSource = (id: string, patch: SourcePatch) => api<SourceView>(`${B}/sources/${enc(id)}`, { method: 'PATCH', body: patch });
export const deleteSource = (id: string) => api<{ channels: number }>(`${B}/sources/${enc(id)}`, { method: 'DELETE' });
/**
 * Task 16: 202 `{ started }`; the refresh runs in the background and its result arrives through polling `GET /sources` (`started: false`
 * = one is already running, its result comes the same way). 409 `no_list` (the own-feeds source), 409 `livetv_off` (not installed).
 */
export const refreshSource = (id: string) => api<{ started: boolean }>(`${B}/sources/${enc(id)}/refresh`, { method: 'POST' });
export const testSource = (b: SourceTestBody) => api<SourceTest>(`${B}/sources/test`, { method: 'POST', body: b });

export const listFeeds = (sourceId: string) => api<{ channels: FeedChannel[]; total: number }>(`${B}/channels?source=${enc(sourceId)}&limit=200`);
export const ingestView = () => api<IngestView>(`${B}/ingest`);
/** `{ groups, pending }` (Task 18); only the groups are read */
export const listGroups = () => api<{ groups: GroupOption[] }>(`${B}/groups`).then((r) => r.groups);
/**
 * The own-feed writes (Task 20) answer `synced`: livetv took the new ingest set (always true for a pull feed); false = the backend retries
 * it (livetvIngestTick), the page says "Wird an Live-TV übertragen …". push-port refuses a port still in the range (409 `port_in_range`).
 */
export const addStream = (b: NewStream) => api<{ channel: FeedChannel; push?: PushResult; synced: boolean }>(`${B}/channels`, { method: 'POST', body: b });
export const newCredentials = (id: string) => api<{ channel: FeedChannel; push: PushResult; synced: boolean }>(`${B}/channels/${enc(id)}/push-credentials`, { method: 'POST' });
export const newPort = (id: string) => api<{ port: number; synced: boolean }>(`${B}/channels/${enc(id)}/push-port`, { method: 'POST' });
export const deleteChannel = (id: string) => api<{ ok: true; synced: boolean }>(`${B}/channels/${enc(id)}`, { method: 'DELETE' });
