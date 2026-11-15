// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where ffmpeg starts an MPEG-TS input, read from its first bytes (H1 item 5). ffmpeg moves each input of a run to start at 0 by
 * itself, at the input's start time: the smallest first PTS among its audio and video streams (each stream's first PES, data
 * streams such as timed ID3 left out). Reading the same number from the first segment of each rendition of a separate-audio pair
 * gives their real offset on the encoder's shared 90-kHz clock, whatever segments they start with, so the run can move one input
 * by exactly that (ffmpegArgs `audioInput.shift`). Only the PAT, the PMT and PES headers are read; the bytes are never changed.
 */
export const PTS_WRAP = 2 ** 33;
const PACKET = 188;
const SYNC = 0x47;
/** PMT stream types that are video or audio; anything else (timed ID3 0x15, SCTE-35 0x86, private sections) is data */
const AV_TYPES = new Set([
  0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xd1, 0xea, // MPEG-1/2, MPEG-4 part 2, H.264, HEVC, CAVS, Dirac, VC-1
  0x03, 0x04, 0x0f, 0x11, 0x1c, 0x81, 0x82, 0x83, 0x84, 0x85, 0x87, // MPEG audio, AAC (ADTS, LATM), AC-3, DTS, TrueHD, E-AC-3
]);

/** `a − b` on the 33-bit PTS clock, the short way round (−2^32 … 2^32) */
export function ptsDelta(a: number, b: number): number {
  const d = (((a - b) % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  return d >= PTS_WRAP / 2 ? d - PTS_WRAP : d;
}

const readPts = (p: Uint8Array, o: number): number =>
  ((p[o]! >> 1) & 0x07) * 2 ** 30 + p[o + 1]! * 2 ** 22 + (p[o + 2]! >> 1) * 2 ** 15 + p[o + 3]! * 2 ** 7 + (p[o + 4]! >> 1);

export class TsClock {
  private carry = Buffer.alloc(0);
  private pmtPids = new Set<number>();
  /** the audio and video PIDs of the PMT (null until it is read) */
  private av: Set<number> | null = null;
  private first = new Map<number, number>();

  /** every listed audio and video stream has started */
  get ready(): boolean {
    return this.av !== null && this.av.size > 0 && [...this.av].every((pid) => this.first.has(pid));
  }

  /** the input's start (90 kHz) as far as read: the earliest first PTS, wrap-aware; null when none was found */
  get start(): number | null {
    let best: number | null = null;
    for (const [pid, pts] of this.first) {
      if (this.av !== null && !this.av.has(pid)) continue;
      if (best === null || ptsDelta(pts, best) < 0) best = pts;
    }
    return best;
  }

  push(chunk: Uint8Array): void {
    let buf = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let i = 0;
    while (buf.length - i >= PACKET) {
      if (buf[i] !== SYNC) { i++; continue; }
      this.packet(buf.subarray(i, i + PACKET));
      i += PACKET;
    }
    buf = buf.subarray(i);
    this.carry = Buffer.from(buf);
  }

  private packet(p: Buffer): void {
    const pid = ((p[1]! & 0x1f) << 8) | p[2]!;
    const pusi = (p[1]! & 0x40) !== 0;
    const afc = (p[3]! >> 4) & 0x03;
    if (!pusi || (afc & 0x01) === 0) return;
    const start = afc === 0x03 ? 5 + p[4]! : 4;
    if (start >= PACKET) return;
    const payload = p.subarray(start);
    if (pid === 0) this.pat(payload);
    else if (this.pmtPids.has(pid)) this.pmt(payload);
    else if (!this.first.has(pid)) this.pes(pid, payload);
  }

  /** the section after the pointer field, cut to its declared length */
  private static section(payload: Buffer, tableId: number): Buffer | null {
    const at = 1 + payload[0]!;
    const t = payload.subarray(at);
    if (t.length < 12 || t[0] !== tableId) return null;
    const len = ((t[1]! & 0x0f) << 8) | t[2]!;
    return t.subarray(0, Math.min(t.length, 3 + len - 4));
  }

  private pat(payload: Buffer): void {
    const t = TsClock.section(payload, 0x00);
    if (!t) return;
    for (let i = 8; i + 4 <= t.length; i += 4) {
      const program = (t[i]! << 8) | t[i + 1]!;
      if (program !== 0) this.pmtPids.add(((t[i + 2]! & 0x1f) << 8) | t[i + 3]!);
    }
  }

  private pmt(payload: Buffer): void {
    const t = TsClock.section(payload, 0x02);
    if (!t) return;
    const av = this.av ?? new Set<number>();
    for (let i = 12 + (((t[10]! & 0x0f) << 8) | t[11]!); i + 5 <= t.length; i += 5 + (((t[i + 3]! & 0x0f) << 8) | t[i + 4]!)) {
      if (AV_TYPES.has(t[i]!)) av.add(((t[i + 1]! & 0x1f) << 8) | t[i + 2]!);
    }
    this.av = av;
  }

  private pes(pid: number, p: Buffer): void {
    if (p.length < 14 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return;
    const id = p[3]!;
    // audio 0xC0–0xDF, video 0xE0–0xEF, private stream 1 (AC-3 and others) 0xBD, extended 0xFD
    if (!((id >= 0xc0 && id <= 0xef) || id === 0xbd || id === 0xfd)) return;
    if ((p[7]! & 0x80) === 0) return;
    this.first.set(pid, readPts(p, 9));
  }
}
