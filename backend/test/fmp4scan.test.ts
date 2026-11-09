// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discontinuities, Fmp4ScanError, scanFmp4, scanFmp4File, type ByteReader } from '../src/fmp4scan.js';
import { AUDIO_TS, fragment, initSegment, VIDEO_TS } from './fmp4build.js';

const reader = (b: Buffer): ByteReader => async (pos, len) => b.subarray(pos, pos + len);
const scan = (b: Buffer) => scanFmp4(reader(b), b.length);
/** n fragments; from fragment `seamAt` on they come from a restarted transcode whose audio is moved by `gap` seconds */
const file = (n: number, seamAt = n, gap = 0) =>
  Buffer.concat([initSegment(), ...Array.from({ length: n }, (_, i) => fragment(i, { restartGapSec: i >= seamAt ? gap : 0 }))]);

describe('fMP4 continuity scan (download seams)', () => {
  it('reads timescales and every fragment of both tracks', async () => {
    const s = await scan(file(4));
    expect(s.tracks.get(1)).toMatchObject({ timescale: VIDEO_TS });
    expect(s.tracks.get(2)).toMatchObject({ timescale: AUDIO_TS });
    expect(s.tracks.get(1)!.fragments).toHaveLength(4);
    expect(s.tracks.get(2)!.fragments).toHaveLength(4);
    expect(s.tracks.get(1)!.fragments[1]).toEqual({ start: 540_000n, duration: 540_000n });
  });

  it('a file from one transcode is continuous', async () => {
    expect(discontinuities(await scan(file(5)), 0.01)).toEqual([]);
  });

  it('finds the audio jump where a restarted transcode was appended (gap and overlap)', async () => {
    const late = discontinuities(await scan(file(5, 3, 0.045)), 0.01);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ track: 2, fragment: 3 });
    expect(late[0]!.gapSec).toBeCloseTo(0.045, 3);
    const early = discontinuities(await scan(file(5, 2, -0.0213)), 0.01); // AAC priming: one frame early
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ track: 2, fragment: 2 });
    expect(early[0]!.gapSec).toBeLessThan(-0.02);
  });

  it('jumps below the tolerance are fine', async () => {
    expect(discontinuities(await scan(file(4, 2, 0.004)), 0.01)).toEqual([]);
  });

  it('uses the trex default duration when the fragments carry none', async () => {
    const b = Buffer.concat([initSegment(), ...[0, 1, 2].map((i) => fragment(i, { audioDefaults: true }))]);
    expect(discontinuities(await scan(b), 0.01)).toEqual([]);
  });

  it('refuses what it cannot read for sure', async () => {
    await expect(scan(Buffer.from('INIT-SEGMENT<seg0><seg1>'))).rejects.toBeInstanceOf(Fmp4ScanError);
    await expect(scan(Buffer.concat([fragment(0), initSegment()]))).rejects.toThrow(/before moov/);
    const cut = file(2);
    await expect(scan(cut.subarray(0, cut.length - 5))).rejects.toBeInstanceOf(Fmp4ScanError);
    // durations neither in the trun nor in a default (the mvex box with the trex defaults renamed away)
    const patched = Buffer.concat([initSegment(), fragment(0, { audioDefaults: true })]);
    patched.write('free', patched.indexOf('mvex'), 'latin1');
    await expect(scan(patched)).rejects.toThrow(/duration unknown/);
  });

  it('reads a file on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-scan-'));
    const p = join(dir, 'x.part');
    writeFileSync(p, file(3, 1, 0.1));
    const d = discontinuities(await scanFmp4File(p), 0.01);
    expect(d.map((x) => x.fragment)).toEqual([1]);
  });
});
