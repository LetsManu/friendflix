// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchError } from '../src/fetch.js';
import { InputEnd, MAX_HOLE_S, SEGMENT_FAILS, openInput, type InputDeps } from '../src/inputs.js';
import { GUARD, INPUT, ONE_MASTER, provider, reader, seqs, win, type Script } from './hls-provider.js';

/**
 * H1 (item 2): one segment that is gone (404) or fails to load is retried once and then skipped (a gap); only SEGMENT_FAILS in a
 * row end the run. A failed playlist poll is tried again at the next poll. In a separate-audio pair a discontinuity that both
 * renditions carry keeps the run; one in a single rendition ends it (the driver aligns both again).
 */
const T = Date.parse('2026-11-15T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ now: T }); });
afterEach(() => { vi.useRealTimers(); });

/** the provider's edge moves on by one segment every poll (half a segment's `dur` of fake time): 100..109 at the start */
const at = (dur = 4) => Math.floor((Date.now() - T) / (dur * 500));
const moving = (prefix: string, o: { disc?: number[]; dur?: number; base?: number; pdt?: number } = {}) => () => {
  const k = at(o.dur);
  const b = o.base ?? 100;
  return win(b + k, b + 9 + k, { prefix, ...o, ...(o.pdt !== undefined ? { pdt: o.pdt + k * (o.dur ?? 4) * 1000 } : {}) });
};

async function pair(script: Script, ms: number, deps: Partial<InputDeps> = {}) {
  vi.setSystemTime(T);
  const p = provider(script);
  const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch, ...deps });
  if (o.ffInput.kind !== 'pipe' || !o.ffInput.audio) throw new Error('pair expected');
  const v = reader(o.ffInput.stdin);
  const a = reader(o.ffInput.audio.stdin);
  await vi.advanceTimersByTimeAsync(ms);
  o.close();
  await Promise.all([v.done, a.done]);
  return { v, a, o, p };
}
const code = (e: unknown) => (e instanceof InputEnd || e instanceof FetchError ? e.code : String(e));

describe('a segment that fails', () => {
  it('a 404 once: retried, nothing is lost', async () => {
    const { v, a } = await pair({ video: moving('v'), audio: moving('a'), segment: (n, i) => (n === 'a113.ts' && i === 0 ? new FetchError('not_found') : undefined) }, 12_500);
    expect([v.error, a.error]).toEqual([undefined, undefined]);
    expect(seqs(a.got)).toEqual([107, 108, 109, 110, 111, 112, 113, 114, 115]);
  });

  it('a 404 twice: the segment is skipped (a gap) and the run goes on; the other rendition is untouched; said in fixed words', async () => {
    const logs: string[] = [];
    const { v, a, p } = await pair({ video: moving('v'), audio: moving('a'), segment: (n) => (n === 'a113.ts' ? new FetchError('not_found') : undefined) }, 12_500, { log: (m) => logs.push(m) });
    expect([v.error, a.error]).toEqual([undefined, undefined]);
    expect(seqs(a.got)).toEqual([107, 108, 109, 110, 111, 112, 114, 115]);
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 111, 112, 113, 114, 115]);
    expect(p.asked.get('a113.ts')).toBe(2);
    expect(logs).toEqual(['audio segment skipped after a retry (not_found)']);
  });

  it(`${SEGMENT_FAILS} segments in a row that fail end the run (segments_failed), blamed on their rendition`, async () => {
    const { a, v, o } = await pair({ video: moving('v'), audio: moving('a'), segment: (n) => (/^a11[345]\.ts$/.test(n) ? new FetchError('unreachable') : undefined) }, 13_000);
    expect(code(a.error)).toBe('segments_failed');
    expect(seqs(a.got)).toEqual([107, 108, 109, 110, 111, 112]);
    expect(v.ended).toBe(true);
    expect(o.audioFault?.(false)).toBe(true);
  });

  it(`in a pair the skipped time stays under ${MAX_HOLE_S} s in a row (ffmpeg would close a longer hole in one input only)`, async () => {
    const six = (prefix: string) => moving(prefix, { dur: 6 });
    const { a } = await pair({ video: six('v'), audio: six('a'), segment: (n) => (/^a11[34]\.ts$/.test(n) ? new FetchError('not_found') : undefined) }, 16_000);
    expect(code(a.error)).toBe('segments_failed');
    expect(seqs(a.got)).toEqual([107, 108, 109, 110, 111, 112]);
  });

  it('one playlist: an unreachable segment is retried, then skipped; the run goes on', async () => {
    const p = provider({ master: ONE_MASTER, video: moving('v'), segment: (n) => (n === 'v113.ts' ? new FetchError('unreachable') : undefined) });
    const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch });
    if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const v = reader(o.ffInput.stdin);
    await vi.advanceTimersByTimeAsync(12_500);
    o.close();
    await v.done;
    expect(v.error).toBeUndefined();
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 111, 112, 114, 115]);
  });

  it('a failed playlist poll is tried again at the next poll, not the end of the run', async () => {
    const video = (read: number) => (read === 2 ? new FetchError('timeout') : moving('v')());
    const { v, a } = await pair({ video, audio: moving('a') }, 8_500);
    expect([v.error, a.error]).toEqual([undefined, undefined]);
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 111, 112, 113]);
  });
});

describe('discontinuities in a separate-audio pair', () => {
  it('both renditions carry it at the same media sequence: the run goes on', async () => {
    const { v, a } = await pair({ video: moving('v', { disc: [112] }), audio: moving('a', { disc: [112] }) }, 10_500);
    expect([v.error, a.error]).toEqual([undefined, undefined]);
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 111, 112, 113, 114]);
    expect(seqs(a.got)).toEqual([107, 108, 109, 110, 111, 112, 113, 114]);
  });

  it('only one rendition carries it: the run ends (discontinuity), so the driver aligns both again; not the rendition\'s fault', async () => {
    for (const side of ['video', 'audio'] as const) {
      const { v, a, o } = await pair({ video: moving('v', side === 'video' ? { disc: [112] } : {}), audio: moving('a', side === 'audio' ? { disc: [112] } : {}) }, 10_500);
      const own = side === 'video' ? v : a;
      expect(code(own.error)).toBe('discontinuity');
      expect(seqs(own.got)).toEqual([107, 108, 109, 110, 111]);
      expect(o.audioFault?.(false)).toBe(false);
    }
  });

  it('by date-time (different numbering): the same discontinuity is found by its date-time', async () => {
    const t0 = T - 40_000;
    const video = moving('v', { pdt: t0, disc: [112] });
    const audio = moving('a', { base: 500, pdt: t0, disc: [512] });
    const { v, a } = await pair({ video, audio }, 10_500);
    expect([v.error, a.error]).toEqual([undefined, undefined]);
    expect(seqs(a.got)).toEqual([507, 508, 509, 510, 511, 512, 513, 514]);
  });
});
