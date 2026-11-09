// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tiny synthetic fragmented MP4 for the download tests: an init segment (moov with a 90 kHz video track 1 and a 48 kHz audio
 * track 2) and media fragments of a given length. `restartGapSec` shifts the audio of a fragment like a restarted transcode does
 * (every fragment of that transcode carries the same shift, so only the seam to the earlier transcode jumps).
 */
const box = (type: string, ...body: Buffer[]) => {
  const b = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + b.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, b]);
};
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };

export const VIDEO_TS = 90_000, AUDIO_TS = 48_000;
const VIDEO_FRAME = 3750; // 24 fps
const AUDIO_FRAME = 1024; // AAC

const trak = (id: number, timescale: number) => box('trak',
  box('tkhd', u32(0), u32(0), u32(0), u32(id), u32(0), u32(0)),
  box('mdia', box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0))));

/** init segment; `trexAudioDur` gives the audio track a trex default duration (fragments may then leave durations out) */
export function initSegment(trexAudioDur = AUDIO_FRAME): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('iso5'), u32(512), Buffer.from('iso6mp41')),
    box('moov', box('mvhd', u32(0), Buffer.alloc(96)), trak(1, VIDEO_TS), trak(2, AUDIO_TS),
      box('mvex', box('trex', u32(0), u32(1), u32(1), u32(VIDEO_FRAME), u32(0), u32(0)), box('trex', u32(0), u32(2), u32(1), u32(trexAudioDur), u32(0), u32(0)))),
  ]);
}

/** trun with per-sample durations (flags data-offset + duration + size) */
const trunWithDurations = (durs: number[]) => box('trun', u32(0x000301), u32(durs.length), u32(0), ...durs.flatMap((d) => [u32(d), u32(10)]));
/** trun without durations (flags data-offset + size): the default comes from tfhd / trex */
const trunNoDurations = (n: number) => box('trun', u32(0x000201), u32(n), u32(0), ...Array.from({ length: n }, () => u32(10)));
const tfdt = (t: bigint) => box('tfdt', u32(0x01000000), u64(t));

/**
 * Media fragment `n` of `segSec` seconds (one moof with a video and an audio traf, then mdat). `restartGapSec` moves the audio start
 * (a restarted transcode's encoder priming); `audioDefaults` leaves the audio durations to trex.
 */
export function fragment(n: number, o: { segSec?: number; restartGapSec?: number; audioDefaults?: boolean } = {}): Buffer {
  const seg = o.segSec ?? 6;
  const vCount = Math.round((seg * VIDEO_TS) / VIDEO_FRAME);
  // audio frames do not divide a segment evenly: the fragment boundary falls on the frame that starts at or after the cut
  const aStart = (k: number) => Math.ceil((k * seg * AUDIO_TS) / AUDIO_FRAME) * AUDIO_FRAME;
  const shift = Math.round((o.restartGapSec ?? 0) * AUDIO_TS);
  const a0 = aStart(n) + shift, a1 = aStart(n + 1) + shift;
  const aCount = Math.max(1, Math.round((a1 - a0) / AUDIO_FRAME));
  const aDurs = Array.from({ length: aCount }, (_, i) => (i === aCount - 1 ? a1 - a0 - AUDIO_FRAME * (aCount - 1) : AUDIO_FRAME));
  const video = box('traf', box('tfhd', u32(0x020000), u32(1)), tfdt(BigInt(n * vCount * VIDEO_FRAME)), trunWithDurations(Array.from({ length: vCount }, () => VIDEO_FRAME)));
  const audio = box('traf', box('tfhd', u32(0x020000), u32(2)), tfdt(BigInt(a0)), o.audioDefaults ? trunNoDurations(aCount) : trunWithDurations(aDurs));
  return Buffer.concat([box('moof', box('mfhd', u32(0), u32(n + 1)), video, audio), box('mdat', Buffer.alloc(32, n))]);
}
