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
