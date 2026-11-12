// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer shapes of the livetv container as the backend reads them. The backend never imports from livetv/ (separate image), so
 * each shape is declared again here, field for field equal to the declaration there (pinned by test/livetv-detect.test.ts); the task
 * that first consumes another answer adds its shape to this file.
 */

/** the H.264 encoders compiled into livetv's ffmpeg (livetv/src/system.ts `Encoder`; not a sign of hardware) */
export type Encoder = 'h264_qsv' | 'h264_vaapi' | 'h264_nvenc' | 'libx264';

/** `GET /v1/system` (spec §3.2; livetv/src/system.ts `SystemView`) */
export interface LivetvSystem {
  cpu: { model: string; cores: number; loadPct: number };
  gpu: { devices: string[]; driver: string | null; readable: boolean; busyPct: number | null; nvidia: boolean };
  encoders: Encoder[];
  cache: { usedBytes: number; maxBytes: number };
  recordings: { usedBytes: number; freeBytes: number } | null;
  srt: { ports: number[] };
}

/** one live entry of a provider list (livetv/src/m3u.ts `M3uEntry`) */
export interface M3uEntry {
  key: string;
  name: string;
  tvgId?: string;
  tvgName?: string;
  chno?: number;
  group?: string;
  logo?: string;
  shiftMin?: number;
  pos: number /* 0-based among all live entries */;
  url: string;
  kind: 'hls' | 'ts' | 'srt';
  userAgent?: string;
}
/**
 * `POST /v1/fetch/m3u` (livetv/src/m3u.ts `M3uResult`). Refusals are `422 { error }` with a fixed code; `too_big` means more than
 * 50 MB, more than 2 000 live groups or more than 200 000 live entries (Task 14 ruling), not only a large file.
 */
export interface FetchM3uAnswer {
  entries: M3uEntry[];
  /** every group of a live entry, in list order, with its count of live entries (skipped groups included) */
  groups: Array<{ name: string; channels: number }>;
  /** every live entry (skipped groups and entries over the limit included) */
  listed: number;
  skipped: { vod: number; invalid: number; overLimit: number; groups: number };
}

/** livetv/src/fetch.ts `FetchErrorCode` */
export type FetchErrorCode = 'unreachable' | 'denied' | 'timeout' | 'too_big' | 'address_refused' | 'scheme' | 'redirects' | 'not_found' | 'http_error';
/** livetv/src/xmltv.ts `XmltvErrorCode` */
export type XmltvErrorCode = 'doctype' | 'invalid' | 'ratio' | 'too_big';
/** one item of an XMLTV file (livetv/src/xmltv.ts `XmlItem`); `start`/`end` are epoch ms (UTC) */
export type XmlItem =
  | { t: 'channel'; id: string; names: string[]; icon?: string /* first <icon src>, http(s) only */ }
  | {
    t: 'prog'; ch: string; start: number; end: number; title: string; subtitle?: string; desc?: string; cats?: string[]; episode?: string;
    seriesId?: string; isNew?: boolean; prevShown?: boolean; rating?: string;
  };
/**
 * One line of the `POST /v1/fetch/xmltv` NDJSON answer (livetv/src/routes/fetch.ts `XmltvLine`); the last line is `end` (complete) or
 * `error` (failed), never both. A stream without its `end` line failed.
 */
export type XmltvLine =
  | XmlItem
  | { t: 'end'; programmes: number; channels: number }
  | { t: 'error'; code: FetchErrorCode | XmltvErrorCode };

/** the input of `POST /v1/probe` (body `{ input }`; livetv/src/probe.ts `StreamInput`); `{ push }` names the channel id of a push feed */
export type StreamInput = { url: string; kind: 'hls' | 'ts' | 'srt'; userAgent?: string; allowLan: boolean } | { push: string };
/** livetv/src/probe.ts `ProbeError` */
export type ProbeError = 'unreachable' | 'timeout' | 'denied' | 'no_video' | 'invalid' | 'address_refused';
/** `POST /v1/probe` (livetv/src/probe.ts `ProbeResult`); never a URL, a host or ffprobe output */
export interface ProbeResult {
  ok: boolean;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; channels: number };
  needs: 'passthrough' | 'remux' | 'transcode';
  error?: ProbeError;
}

/** how a stream is produced (livetv/src/streams.ts `Mode`) */
export type Mode = 'passthrough' | 'remux' | 'transcode';

/** an item of `GET /v1/streams` (spec §3.3; livetv/src/streams.ts `StreamView`). `streamKey` is the credential of `/s/`: it never leaves the backend. */
export interface StreamView {
  channelId: string;
  streamKey: string /* 32 hex */;
  mode: Mode;
  since: number;
  state: 'starting' | 'running' | 'reconnecting' | 'failed';
  bitrate: number | null;
  errors: Array<{ at: number; code: 'input_lost' | 'input_back'; seconds?: number }>;
  lastSegmentAt: number | null;
}

/** an item of `GET /v1/ingest` (spec §3.2, plan Task 29): one push feed as livetv sees it */
export interface IngestState {
  channelId: string;
  port: number;
  state: 'idle' | 'receiving';
  since: number | null;
  bitrate: number | null;
  rejected1h: number;
}

/** the `POST /v1/streams` body (spec §3.2; livetv/src/streams.ts `StartBody`); answered `{ streamKey, state }`, idempotent per channel */
export interface StartBody { channelId: string; input: StreamInput; mode: Mode; encoder: Encoder; dvrSeconds: number /* 0–7200, ruling 47 */; maxBitrate: number }

/** the `POST /v1/benchmark` answer (spec §3.2; livetv/src/routes/benchmark.ts): 20 s of 1080p25 through `encoder`, speed = 20 / wall seconds */
export interface BenchAnswer { speed: number; encoder: Encoder; seconds: number }
