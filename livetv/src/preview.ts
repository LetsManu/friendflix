// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Log } from './log.js';
import type { Run } from './run.js';

/**
 * Channel previews (spec §3.2, `GET /v1/streams/:channelId/preview.jpg`): while a stream runs, at most every 60 s its newest
 * segment is turned into one 320-px JPEG by ffmpeg, kept in memory only. Driven by the streams' `onSegment` hook, so a preview
 * never starts a stream; dropped with the stream (`onStop`). One render per channel at a time; a failed, timed-out or non-JPEG
 * render keeps the previous image.
 *
 * Only MPEG-TS segments (`.ts`: remux, transcode, TS passthrough) are rendered. An fMP4 passthrough segment (`.m4s`) cannot be
 * decoded without its `init-<n>.mp4`, so those streams have no preview (yet): their segments are skipped, not rendered to fail.
 */
export const PREVIEW_INTERVAL_MS = 60_000;
export const PREVIEW_TIMEOUT_MS = 15_000;

/** ffmpeg reads only the local segment file */
export function previewArgs(segment: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'mpegts', '-i', segment, '-frames:v', '1', '-vf', 'scale=320:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
}

const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;

interface Slot { jpeg: Buffer | null; at: number | null; busy: boolean }

export class Previews {
  private readonly slots = new Map<string, Slot>();
  private readonly now: () => number;

  constructor(private readonly o: { run: Run; now?: () => number; log?: Log }) {
    this.now = o.now ?? Date.now;
  }

  /** a new segment of a running stream (its file path): renders when the last render is 60 s old, or there was none */
  segment(channelId: string, path: string): void {
    if (!path.endsWith('.ts')) return;
    let slot = this.slots.get(channelId);
    if (!slot) {
      slot = { jpeg: null, at: null, busy: false };
      this.slots.set(channelId, slot);
    }
    const now = this.now();
    if (slot.busy || (slot.at !== null && now - slot.at < PREVIEW_INTERVAL_MS)) return;
    slot.busy = true;
    slot.at = now;
    const s = slot;
    const log = this.o.log;
    void Promise.resolve()
      .then(() => this.o.run('ffmpeg', previewArgs(path), { timeoutMs: PREVIEW_TIMEOUT_MS, ...(log ? { stderrLog: { channelId, log } } : {}) }))
      .then((r) => {
        if (this.slots.get(channelId) !== s) return;
        if (r.code === 0 && !r.truncated && isJpeg(r.stdout)) s.jpeg = r.stdout;
      }, () => {})
      .finally(() => { s.busy = false; });
  }

  get(channelId: string): Buffer | null {
    return this.slots.get(channelId)?.jpeg ?? null;
  }

  drop(channelId: string): void {
    this.slots.delete(channelId);
  }
}
