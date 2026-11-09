// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { open } from 'node:fs/promises';

/**
 * Timestamp continuity of a concatenated fragmented MP4 (the download preparer's part file: init segment + moof/mdat fragments).
 * Only box headers, `moov` and the `moof` boxes are read (the media data is skipped by size), so a multi-GB file costs a few MB of reads.
 *
 * For every track: each fragment's start (moof > traf > tfdt) must equal the previous fragment's start plus its duration (the sum of the
 * trun sample durations, or the tfhd / trex default). Inside one transcode that holds by construction. Where two transcodes meet (the
 * job was paused, or resumed after a restart) a gap or overlap shows up here; copied into one MP4 it becomes a lasting A/V offset,
 * because players play the audio samples back to back.
 */
export interface TrackScan { timescale: number; fragments: Array<{ start: bigint; duration: bigint }> }
export interface Fmp4Scan { tracks: Map<number, TrackScan> }
export interface Discontinuity { track: number; fragment: number; gapSec: number }

/** reads `len` bytes at `pos` (fewer at the end of the file) */
export type ByteReader = (pos: number, len: number) => Promise<Buffer>;

export class Fmp4ScanError extends Error {}

const MAX_HEADER_BOX = 64 * 1024 * 1024; // a moov / moof larger than this is not a download fragment

/** Box iteration inside an in-memory buffer: fn(type, bodyStart, end). */
function boxes(buf: Buffer, from: number, to: number, fn: (type: string, body: number, end: number) => void): void {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) throw new Fmp4ScanError('truncated box');
      size = Number(buf.readBigUInt64BE(p + 8));
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head || p + size > to) throw new Fmp4ScanError('broken box size');
    fn(buf.toString('latin1', p + 4, p + 8), p + head, p + size);
    p += size;
  }
}

/** moov: track id -> timescale (trak > tkhd, trak > mdia > mdhd) and default sample duration (mvex > trex) */
function readMoov(buf: Buffer, from: number, to: number) {
  const timescale = new Map<number, number>();
  const defaultDur = new Map<number, number>();
  boxes(buf, from, to, (type, body, end) => {
    if (type === 'trak') {
      let id = 0, ts = 0;
      boxes(buf, body, end, (t, b, e) => {
        if (t === 'tkhd') id = buf.readUInt32BE(b + (buf[b] === 1 ? 20 : 12));
        else if (t === 'mdia') {
          boxes(buf, b, e, (tt, bb) => {
            if (tt === 'mdhd') ts = buf.readUInt32BE(bb + (buf[bb] === 1 ? 20 : 12));
          });
        }
      });
      if (id && ts) timescale.set(id, ts);
    } else if (type === 'mvex') {
      boxes(buf, body, end, (t, b) => {
        if (t === 'trex') defaultDur.set(buf.readUInt32BE(b + 4), buf.readUInt32BE(b + 12));
      });
    }
  });
  return { timescale, defaultDur };
}

/** one traf: track id, tfdt, summed sample durations */
function readTraf(buf: Buffer, from: number, to: number, trexDur: Map<number, number>) {
  let track = 0, tfhdDur: number | undefined, start: bigint | undefined, duration = 0n, durationKnown = true;
  const truns: Array<[number, number]> = [];
  boxes(buf, from, to, (type, body, end) => {
    if (type === 'tfhd') {
      const flags = buf.readUIntBE(body + 1, 3);
      track = buf.readUInt32BE(body + 4);
      let p = body + 8;
      if (flags & 0x01) p += 8; // base-data-offset
      if (flags & 0x02) p += 4; // sample-description-index
      if (flags & 0x08) { if (p + 4 > end) throw new Fmp4ScanError('broken tfhd'); tfhdDur = buf.readUInt32BE(p); }
    } else if (type === 'tfdt') {
      start = buf[body] === 1 ? buf.readBigUInt64BE(body + 4) : BigInt(buf.readUInt32BE(body + 4));
    } else if (type === 'trun') truns.push([body, end]);
  });
  for (const [body, end] of truns) {
    const flags = buf.readUIntBE(body + 1, 3);
    const count = buf.readUInt32BE(body + 4);
    let p = body + 8;
    if (flags & 0x001) p += 4; // data-offset
    if (flags & 0x004) p += 4; // first-sample-flags
    if (flags & 0x100) {
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
      if (p + count * stride > end) throw new Fmp4ScanError('broken trun');
      for (let i = 0; i < count; i++) duration += BigInt(buf.readUInt32BE(p + i * stride));
    } else {
      const d = tfhdDur ?? trexDur.get(track);
      if (d === undefined) durationKnown = false;
      else duration += BigInt(d) * BigInt(count);
    }
  }
  if (!track || start === undefined) throw new Fmp4ScanError('traf without track or tfdt');
  if (!durationKnown) throw new Fmp4ScanError('fragment duration unknown');
  return { track, start, duration };
}

/** Walks the top-level boxes of a file of `size` bytes. Throws Fmp4ScanError for anything it cannot read for sure. */
export async function scanFmp4(read: ByteReader, size: number): Promise<Fmp4Scan> {
  const tracks = new Map<number, TrackScan>();
  let moov: ReturnType<typeof readMoov> | null = null;
  let pos = 0;
  while (pos < size) {
    if (size - pos < 8) throw new Fmp4ScanError('trailing bytes');
    const head = await read(pos, 16);
    let boxSize = head.readUInt32BE(0);
    let hlen = 8;
    if (boxSize === 1) { boxSize = Number(head.readBigUInt64BE(8)); hlen = 16; } else if (boxSize === 0) boxSize = size - pos;
    const type = head.toString('latin1', 4, 8);
    if (boxSize < hlen || pos + boxSize > size) throw new Fmp4ScanError(`broken ${type} box at ${pos}`);
    if (type === 'moov' || type === 'moof') {
      if (boxSize > MAX_HEADER_BOX) throw new Fmp4ScanError(`${type} too large`);
      const buf = await read(pos, boxSize);
      if (buf.length < boxSize) throw new Fmp4ScanError('short read');
      if (type === 'moov') {
        moov = readMoov(buf, hlen, boxSize);
        for (const [id, ts] of moov.timescale) tracks.set(id, { timescale: ts, fragments: [] });
      } else {
        if (!moov) throw new Fmp4ScanError('fragment before moov');
        const m = moov;
        boxes(buf, hlen, boxSize, (t, b, e) => {
          if (t !== 'traf') return;
          const f = readTraf(buf, b, e, m.defaultDur);
          const tr = tracks.get(f.track);
          if (!tr) throw new Fmp4ScanError(`fragment of unknown track ${f.track}`);
          tr.fragments.push({ start: f.start, duration: f.duration });
        });
      }
    }
    pos += boxSize;
  }
  if (!moov || !tracks.size) throw new Fmp4ScanError('no moov');
  return { tracks };
}

/** Every jump between consecutive fragments of a track that is larger than `toleranceSec` (gap > 0, overlap < 0). */
export function discontinuities(scan: Fmp4Scan, toleranceSec: number): Discontinuity[] {
  const out: Discontinuity[] = [];
  for (const [track, t] of scan.tracks) {
    for (let i = 1; i < t.fragments.length; i++) {
      const prev = t.fragments[i - 1]!, cur = t.fragments[i]!;
      const gapSec = Number(cur.start - (prev.start + prev.duration)) / t.timescale;
      if (Math.abs(gapSec) > toleranceSec) out.push({ track, fragment: i, gapSec });
    }
  }
  return out;
}

/** scanFmp4 over a file on disk */
export async function scanFmp4File(path: string): Promise<Fmp4Scan> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    return await scanFmp4(async (pos, len) => {
      const n = Math.max(0, Math.min(len, size - pos));
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      return buf.subarray(0, bytesRead);
    }, size);
  } finally {
    await fh.close();
  }
}
