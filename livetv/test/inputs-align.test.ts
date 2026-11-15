// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputEnd, MEASURE_MS, alignStart, openInput, type Resume } from '../src/inputs.js';
import { parseMedia } from '../src/passthrough.js';
import { AAC, H264, tsSegment } from './ts-builder.js';
import { GUARD, INPUT, provider, reader, win } from './hls-provider.js';

/**
 * H1 (item 5): the offset between a video and its separate audio rendition is measured from the first PTS of each (both MPEG-TS
 * from one encoder share the 90-kHz clock), not assumed from equal sequence numbers, so it is the same at every restart. Logged
 * as a number. Clocks that do not match the playlists fall back to the playlist alignment with a code; so does a sequence
 * alignment where only one side has a date-time.
 */
const T = Date.parse('2026-11-15T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ now: T }); });
afterEach(() => { vi.useRealTimers(); });

const SEG = 4 * 90_000;
/** MPEG-TS segments: video `v<seq>` starts at vBase + (seq − 100) × 4 s, audio `a<seq>` at aBase + the same */
const tsSegments = (vBase: number, aBase: number) => (name: string) => {
  const m = /^([va])(\d+)\.ts$/.exec(name);
  if (!m) return undefined;
  const k = Number(m[2]) - 100;
  return m[1] === 'v' ? tsSegment([H264(0x100, vBase + k * SEG)]) : tsSegment([AAC(0x101, aBase + k * SEG)]);
};
const at = (prefix: string, o: { pdt?: number } = {}) => () => win(100, 109, { prefix, ...o });

async function open(vBase: number, aBase: number, o: { vpdt?: number; apdt?: number; resume?: Resume } = {}) {
  const logs: string[] = [];
  const p = provider({
    video: at('v', o.vpdt !== undefined ? { pdt: o.vpdt } : {}), audio: at('a', o.apdt !== undefined ? { pdt: o.apdt } : {}),
    segment: tsSegments(vBase, aBase),
  });
  const opened = await openInput(INPUT, { guard: GUARD, fetch: p.fetch, log: (m) => logs.push(m), ...(o.resume ? { resume: o.resume } : {}) });
  if (opened.ffInput.kind !== 'pipe' || !opened.ffInput.audio) throw new Error('pair expected');
  const v = reader(opened.ffInput.stdin);
  const a = reader(opened.ffInput.audio.stdin);
  await vi.advanceTimersByTimeAsync(100);
  opened.close();
  await Promise.all([v.done, a.done]);
  return { shift: opened.ffInput.audio.shift, logs, v: v.got, a: a.got };
}

describe('separate audio aligned by the first timestamps', () => {
  it('equal sequence numbers, the audio 300 ms after the video on the clock: shift 0.3, logged as a number, no URL', async () => {
    const r = await open(900_000, 900_000 + 27_000);
    expect(r.shift).toBe(0.3);
    expect(r.logs).toEqual(['separate audio: aligned by timestamps, offset 300 ms']);
    expect(r.logs.join(' ')).not.toMatch(/example\.com|\.m3u8|\.ts/);
    // nothing of the bytes is lost to the measuring: three segments each, in order
    expect([r.v.length, r.a.length]).toEqual([3, 3]);
  });

  it('the audio before the video: a negative shift (ffmpeg then moves the video later)', async () => {
    expect((await open(900_000, 900_000 - 45_000)).shift).toBe(-0.5);
  });

  it('the same offset at every restart, whichever segments each rendition resumes at', async () => {
    const first = await open(900_000, 900_000 + 9_000);
    const resumed = await open(900_000, 900_000 + 9_000, { resume: { video: 106, audio: 105 } });
    expect([first.shift, resumed.shift]).toEqual([0.1, 0.1]);
  });

  it('no common numbering and no date-time (each starts at its own edge): the measured offset instead of an arbitrary one', async () => {
    const logs: string[] = [];
    const p = provider({ video: at('v'), audio: () => win(1000, 1009, { prefix: 'a' }), segment: (n) => {
      const m = /^([va])(\d+)\.ts$/.exec(n);
      if (!m) return undefined;
      // the audio's 1007 starts 1.2 s after the video's 107
      return m[1] === 'v' ? tsSegment([H264(0x100, 900_000 + (Number(m[2]) - 107) * SEG)]) : tsSegment([AAC(0x101, 900_000 + 108_000 + (Number(m[2]) - 1007) * SEG)]);
    } });
    const opened = await openInput(INPUT, { guard: GUARD, fetch: p.fetch, log: (m) => logs.push(m) });
    if (opened.ffInput.kind !== 'pipe' || !opened.ffInput.audio) throw new Error('pair expected');
    expect(opened.ffInput.audio.shift).toBe(1.2);
    expect(logs).toEqual(['separate audio: no common media sequence or program date-time, each rendition starts at its live edge', 'separate audio: aligned by timestamps, offset 1200 ms']);
    opened.close();
  });

  it('clocks that do not fit the playlists (another encoder): the playlist alignment, with a code', async () => {
    const r = await open(900_000, 4_000_000_000);
    expect(r.shift).toBeUndefined();
    expect(r.logs).toEqual(['separate audio: timestamps do not fit the playlists (clock_mismatch), aligned by sequence']);
  });
});

describe('a resumed run at the live edge (review I2)', () => {
  it('the resume segment is listed only ~6 s later: the offset is still measured (the deadline starts when both begin to load)', async () => {
    const logs: string[] = [];
    // read 0 is openInput's own; polls every 2 s; 110 appears with read 3 (~6 s)
    const list = (prefix: string) => (read: number) => win(100, read >= 3 ? 110 : 109, { prefix });
    const p = provider({ video: list('v'), audio: list('a'), segment: tsSegments(900_000, 900_000 + 27_000) });
    const pending = openInput(INPUT, { guard: GUARD, fetch: p.fetch, log: (m) => logs.push(m), resume: { video: 109, audio: 109 } });
    await vi.advanceTimersByTimeAsync(8_000);
    const o = await pending;
    if (o.ffInput.kind !== 'pipe' || !o.ffInput.audio) throw new Error('pair expected');
    expect(o.ffInput.audio.shift).toBe(0.3);
    expect(logs).toEqual(['separate audio: aligned by timestamps, offset 300 ms']);
    o.close();
  });

  it('a resume segment that is never listed: the wait ends with the not-advancing timeout (12 s at target 4), not later', async () => {
    const p = provider({ video: at('v'), audio: at('a'), segment: tsSegments(900_000, 900_000) });
    const pending = openInput(INPUT, { guard: GUARD, fetch: p.fetch, resume: { video: 109, audio: 109 } }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(11_500);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending as InputEnd).code).toBe('not_advancing');
  });

  it('a first segment that is listed but does not arrive within MEASURE_MS once loading began: timestamps_late', async () => {
    const logs: string[] = [];
    const p = provider({ video: at('v'), audio: at('a'), segment: tsSegments(900_000, 900_000) });
    const fetch: typeof p.fetch = async (url, o) => (url.endsWith('/a107.ts') ? new Promise((_, rej) => o.signal?.addEventListener('abort', () => rej(new Error('aborted')))) : p.fetch(url, o));
    const pending = openInput(INPUT, { guard: GUARD, fetch, log: (m) => logs.push(m) });
    await vi.advanceTimersByTimeAsync(MEASURE_MS + 100);
    const o = await pending;
    expect(logs).toEqual(['separate audio: first timestamps not read in time (timestamps_late), aligned by sequence']);
    o.close();
  });
});

describe('a rendition that ends while its first timestamps are read (review M10)', () => {
  it('an audio restart (the provider went back) is no fault of the audio: InputEnd with its side, not AudioUnavailable', async () => {
    // the resume points wait for 110; the audio playlist goes back meanwhile (3 stale reads, 1-s polls), the video stays
    const one = (prefix: string, first: number, last: number) => win(first, last, { prefix, dur: 1 });
    const p = provider({ video: () => one('v', 100, 109), audio: (read) => (read === 0 ? one('a', 100, 109) : one('a', 98, 107)), segment: tsSegments(900_000, 900_000) });
    const pending = openInput(INPUT, { guard: GUARD, fetch: p.fetch, resume: { video: 109, audio: 109 } }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_000);
    const e = await pending;
    expect(e).toBeInstanceOf(InputEnd);
    expect([(e as InputEnd).code, (e as InputEnd).side]).toEqual(['restart', 'audio']);
  });
});

describe('a sequence alignment where only one side has a date-time', () => {
  it('alignStart says so; openInput logs the code even when the timestamps take over', async () => {
    const P = (prefix: string, pdt?: number) => parseMedia(win(100, 109, { prefix, ...(pdt !== undefined ? { pdt } : {}) }))!;
    expect(alignStart(P('v', T), P('a'))).toEqual({ video: 107, audio: 107, shift: 0, by: 'sequence', note: 'pdt_one_sided' });
    expect(alignStart(P('v', T), P('a', T))).toEqual({ video: 107, audio: 107, shift: 0, by: 'sequence' });
    const r = await open(900_000, 900_000, { vpdt: T });
    expect(r.logs).toEqual(['separate audio: aligned by sequence, date-time on one side only (pdt_one_sided)', 'separate audio: aligned by timestamps, offset 0 ms']);
  });
});
