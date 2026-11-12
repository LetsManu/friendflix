// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer shapes of the livetv container as the backend reads them. The backend never imports from livetv/ (separate image), so
 * each shape is declared again here, field for field equal to the declaration there (pinned by test/livetv-detect.test.ts); the task
 * that first consumes another answer adds its shape to this file.
 */

/** the H.264 encoders livetv can use (livetv/src/system.ts `Encoder`) */
export type Encoder = 'h264_qsv' | 'h264_vaapi' | 'h264_nvenc' | 'libx264';

/** `GET /v1/system` (spec §3.2; livetv/src/system.ts `SystemView`) */
export interface LivetvSystem {
  cpu: { model: string; cores: number; loadPct: number };
  gpu: { devices: string[]; driver: string | null; readable: boolean; busyPct: number | null };
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
