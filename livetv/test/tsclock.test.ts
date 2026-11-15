// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PTS_WRAP, TsClock, ptsDelta } from '../src/tsclock.js';
import { AAC, H264, ID3, tsSegment } from './ts-builder.js';

/** ffmpeg starts an MPEG-TS input at the smallest first PTS among its audio and video streams; TsClock reads the same from the bytes */
describe('TsClock', () => {
  it('the start is the smallest first PTS of the audio and video streams; data streams (timed ID3) do not count', () => {
    const c = new TsClock();
    c.push(tsSegment([H264(0x100, 1_800_000, 1_803_600), AAC(0x101, 1_799_000, 1_800_920), ID3(0x102, 1_000)]));
    expect(c.ready).toBe(true);
    expect(c.start).toBe(1_799_000);
  });

  it('the first PES of a stream counts, not a smaller later one (leading B-frames), as ffmpeg does', () => {
    const c = new TsClock();
    c.push(tsSegment([H264(0x100, 900_000, 896_400, 903_600)]));
    expect(c.start).toBe(900_000);
  });

  it('reads across chunk borders and through a broken sync byte; not ready until every listed stream has started', () => {
    const bytes = tsSegment([H264(0x100, 450_000), AAC(0x101, 451_440)]);
    const c = new TsClock();
    // PAT, PMT and the video start, cut in the middle of a packet
    c.push(bytes.subarray(0, 3 * 188 + 50));
    expect(c.ready).toBe(false);
    expect(c.start).toBe(450_000);
    c.push(Buffer.from([0x00, 0x12]));
    c.push(bytes.subarray(3 * 188 + 50));
    expect(c.ready).toBe(true);
    expect(c.start).toBe(450_000);
  });

  it('bytes that are not MPEG-TS give no start', () => {
    const c = new TsClock();
    c.push(Buffer.from('v107;'));
    c.push(Buffer.alloc(4000, 0x47));
    expect([c.ready, c.start]).toEqual([false, null]);
  });

  it('a start across the 33-bit wrap: the earlier stream is the one just before the wrap', () => {
    const c = new TsClock();
    c.push(tsSegment([H264(0x100, PTS_WRAP - 9_000), AAC(0x101, 9_000)]));
    expect(c.start).toBe(PTS_WRAP - 9_000);
    expect(ptsDelta(9_000, PTS_WRAP - 9_000)).toBe(18_000);
    expect(ptsDelta(PTS_WRAP - 9_000, 9_000)).toBe(-18_000);
  });
});
