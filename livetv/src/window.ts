// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The DVR window of one stream (spec §3.3, plan rulings 23 and 47): the segments on disk and the sliding live playlist livetv
 * serves for them, the same for every mode (passthrough, remux, transcode). Local names are `<seq>.<ext>` with `seq` strictly
 * increasing for the stream's whole life, whatever the input does (a provider whose media sequence jumps back, an ffmpeg
 * restart); a gap or restart is a `#EXT-X-DISCONTINUITY`. Every segment line carries `#EXT-X-PROGRAM-DATE-TIME`. The window keeps
 * a segment while the newer ones still cover `dvrSeconds`, never fewer than the newest 3 (the live edge).
 */
export const DVR_MAX_SECONDS = 7200;
/** the live edge: never dropped, by the DVR length or the cache cap */
export const KEEP_NEWEST = 3;
const EPS = 1e-6;

export type SegmentExt = 'ts' | 'm4s';
export interface WindowOptions {
  /** 0–7200 (ruling 47) */
  dvrSeconds: number;
  ext: SegmentExt;
  /** fMP4: the playlist maps `init.mp4` */
  init?: boolean;
  /** a segment the DVR length dropped: the caller deletes its file */
  onDrop?: (file: string) => void;
}
export interface SegmentIn {
  /** the stored file (relative to the stream's directory); never served by this name */
  file: string;
  /** seconds */
  duration: number;
  /** a discontinuity starts with this segment */
  discontinuity?: boolean;
  /** epoch ms of the segment start */
  pdt: number;
  /** the stored size, for the cache cap */
  bytes?: number;
}
interface Seg { seq: number; file: string; duration: number; discontinuity: boolean; pdt: number; bytes: number }

export class SegmentWindow {
  readonly dvrSeconds: number;
  readonly ext: SegmentExt;
  readonly init: boolean;
  private readonly onDrop: (file: string) => void;
  private readonly segs: Seg[] = [];
  private next = 0;
  /** discontinuity tags that left the playlist (`#EXT-X-DISCONTINUITY-SEQUENCE`) */
  private discSeq = 0;
  /** the longest segment ever seen, rounded up: the target duration never shrinks while the playlist lives */
  private target = 1;
  private secs = 0;
  private size = 0;

  constructor(o: WindowOptions) {
    if (!Number.isInteger(o.dvrSeconds) || o.dvrSeconds < 0 || o.dvrSeconds > DVR_MAX_SECONDS) throw new RangeError('dvrSeconds');
    this.dvrSeconds = o.dvrSeconds;
    this.ext = o.ext;
    this.init = o.init === true;
    this.onDrop = o.onDrop ?? (() => {});
  }

  /** adds the newest segment and answers its local number; segments past the DVR length leave through `onDrop` */
  add(s: SegmentIn): number {
    if (!(Number.isFinite(s.duration) && s.duration > 0)) throw new RangeError('duration');
    if (!Number.isFinite(s.pdt)) throw new RangeError('pdt');
    const seq = this.next++;
    const bytes = s.bytes ?? 0;
    this.segs.push({ seq, file: s.file, duration: s.duration, discontinuity: s.discontinuity === true, pdt: s.pdt, bytes });
    this.secs += s.duration;
    this.size += bytes;
    this.target = Math.max(this.target, Math.ceil(s.duration - EPS));
    while (this.segs.length > KEEP_NEWEST && this.secs - this.segs[0]!.duration >= this.dvrSeconds - EPS) this.onDrop(this.shift());
    return seq;
  }

  oldest(): { seq: number; pdt: number } | null {
    const s = this.segs[0];
    return s ? { seq: s.seq, pdt: s.pdt } : null;
  }

  /** the cache cap's step: drops the oldest segment and answers its file; null when only the newest 3 are left */
  dropOldest(): string | null {
    return this.segs.length > KEEP_NEWEST ? this.shift() : null;
  }

  /** the stored file of a local name (`<seq>.<ext>`), null when it is not in the window */
  find(name: string): string | null {
    const m = /^(\d{1,10})\.(ts|m4s)$/.exec(name);
    if (!m || m[2] !== this.ext || this.segs.length === 0) return null;
    return this.segs[Number(m[1]) - this.segs[0]!.seq]?.file ?? null;
  }

  playlist(): string {
    const out = [
      '#EXTM3U',
      `#EXT-X-VERSION:${this.ext === 'm4s' ? 7 : 6}`,
      `#EXT-X-TARGETDURATION:${this.target}`,
      `#EXT-X-MEDIA-SEQUENCE:${this.segs[0]?.seq ?? this.next}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discSeq}`,
    ];
    if (this.init) out.push('#EXT-X-MAP:URI="init.mp4"');
    for (const s of this.segs) {
      if (s.discontinuity) out.push('#EXT-X-DISCONTINUITY');
      out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.pdt).toISOString()}`, `#EXTINF:${s.duration.toFixed(3)},`, `${s.seq}.${this.ext}`);
    }
    return `${out.join('\n')}\n`;
  }

  get seconds(): number { return this.secs; }
  get bytes(): number { return this.size; }
  get length(): number { return this.segs.length; }

  private shift(): string {
    const s = this.segs.shift()!;
    this.secs -= s.duration;
    this.size -= s.bytes;
    if (s.discontinuity) this.discSeq++;
    return s.file;
  }
}
