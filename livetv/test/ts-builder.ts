// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Minimal MPEG-TS for tests: a PAT, a PMT and one PES start per elementary stream, each with the PTS given (90 kHz). */
const PMT_PID = 0x1000;
function packet(pid: number, payload: number[], pusi: boolean): Buffer {
  const b = Buffer.alloc(188, 0xff);
  b[0] = 0x47;
  b[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  b[2] = pid & 0xff;
  b[3] = 0x10;
  Buffer.from(payload).copy(b, 4);
  return b;
}
const crc = [0, 0, 0, 0];
function pat(): Buffer {
  const section = [0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff, ...crc];
  return packet(0, [0x00, ...section], true);
}
function pmt(streams: Array<{ pid: number; type: number }>): Buffer {
  const es = streams.flatMap((s) => [s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0, 0x00]);
  const len = 9 + es.length + 4;
  const section = [0x02, 0xb0 | (len >> 8), len & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, ...es, ...crc];
  return packet(PMT_PID, [0x00, ...section], true);
}
/** the 5 bytes of a PTS (33 bits) with the 4-bit prefix */
export function ptsBytes(pts: number, prefix = 0b0010): number[] {
  const hi = Math.floor(pts / 2 ** 30) & 0x7;
  const mid = Math.floor(pts / 2 ** 15) & 0x7fff;
  const lo = pts % 2 ** 15;
  return [(prefix << 4) | (hi << 1) | 1, mid >> 7, ((mid & 0x7f) << 1) | 1, lo >> 7, ((lo & 0x7f) << 1) | 1];
}
function pes(pid: number, streamId: number, pts: number, dts?: number): Buffer {
  const header = dts === undefined ? [0x80, 0x80, 5, ...ptsBytes(pts)] : [0x80, 0xc0, 10, ...ptsBytes(pts, 0b0011), ...ptsBytes(dts, 0b0001)];
  return packet(pid, [0x00, 0x00, 0x01, streamId, 0x00, 0x00, ...header, 0x00, 0x00, 0x00, 0x01], true);
}

export interface Es { pid: number; type: number; streamId: number; pts: number[]; dts?: number }
/** a segment: PAT, PMT, then the PES starts of each stream in the order given (interleaved by index) */
export function tsSegment(streams: Es[]): Buffer {
  const parts = [pat(), pmt(streams)];
  const n = Math.max(...streams.map((s) => s.pts.length));
  for (let i = 0; i < n; i++) for (const s of streams) if (i < s.pts.length) parts.push(pes(s.pid, s.streamId, s.pts[i]!, i === 0 ? s.dts : undefined));
  return Buffer.concat(parts);
}
export const H264 = (pid: number, ...pts: number[]): Es => ({ pid, type: 0x1b, streamId: 0xe0, pts });
export const AAC = (pid: number, ...pts: number[]): Es => ({ pid, type: 0x0f, streamId: 0xc0, pts });
export const ID3 = (pid: number, ...pts: number[]): Es => ({ pid, type: 0x15, streamId: 0xbd, pts });
