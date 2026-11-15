// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputEnd, openInput } from '../src/inputs.js';
import { STALE_READS, follow } from '../src/passthrough.js';
import { GUARD, INPUT, ONE_MASTER, provider, reader, seqs, win } from './hls-provider.js';

/**
 * H1 (item 1): a playlist read from a CDN node a little behind the previous one is "no update", never a restart. Before, a pair
 * ended its run on it (both pipes, ffmpeg restarted) and a single playlist fed the segments it had fed already once more.
 */
const T = Date.parse('2026-11-15T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ now: T }); });
afterEach(() => { vi.useRealTimers(); });

/** each read moves the edge on by one (from 109), except the reads in `stale`, which come from a node `back` segments behind the read before */
const moving = (prefix: string, stale: number[] = [], back = 1) => (read: number) => {
  const newest = 109 + read - (stale.includes(read) ? back + 1 : 0);
  return win(newest - 9, newest, { prefix });
};
const inOrder = (xs: number[]) => xs.every((x, i) => i === 0 || x === xs[i - 1]! + 1);

describe('follow (the next segments of a playlist read)', () => {
  const segs = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => ({ seq: first + i }));
  it('a read at the last one or a little older is no update; STALE_READS of them in a row are a restart', () => {
    const st = { stale: 0 };
    expect(follow(segs(100, 109), 109, st)).toEqual({ take: [], jump: 'none' });
    for (let i = 1; i < STALE_READS; i++) expect(follow(segs(99, 108), 109, st)).toEqual({ take: [], jump: 'none' });
    expect(follow(segs(99, 108), 109, st)).toEqual({ take: segs(106, 108), jump: 'restart' });
    // the count starts again after a read that is not stale
    expect(follow(segs(99, 108), 109, st).jump).toBe('none');
    expect(follow(segs(101, 110), 109, st)).toEqual({ take: segs(110, 110), jump: 'none' });
    expect(follow(segs(99, 108), 109, st).jump).toBe('none');
  });
  it('a sequence that drops by more than the window is a restart at once; missed segments are a gap', () => {
    expect(follow(segs(0, 9), 109, { stale: 0 })).toEqual({ take: segs(7, 9), jump: 'restart' });
    expect(follow(segs(115, 124), 109, { stale: 0 })).toEqual({ take: segs(122, 124), jump: 'gap' });
    expect(follow(segs(100, 109), null, { stale: 0 })).toEqual({ take: segs(107, 109), jump: 'none' });
  });
});

describe('a stale playlist read in openInput', () => {
  it('separate audio: one read one segment behind is no update, the run goes on in order', async () => {
    const p = provider({ video: moving('v', [3]), audio: moving('a') });
    const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch });
    if (o.ffInput.kind !== 'pipe' || !o.ffInput.audio) throw new Error('pair expected');
    const v = reader(o.ffInput.stdin);
    const a = reader(o.ffInput.audio.stdin);
    await vi.advanceTimersByTimeAsync(10_500);
    o.close();
    await Promise.all([v.done, a.done]);
    expect(v.error).toBeUndefined();
    expect(a.error).toBeUndefined();
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 111, 112, 113, 114]);
    expect(inOrder(seqs(a.got))).toBe(true);
    expect(p.reads.video).toBe(6);
  });

  it('one playlist: a stale read feeds no segment twice', async () => {
    const p = provider({ master: ONE_MASTER, video: moving('v', [3], 3) });
    const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch });
    if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const v = reader(o.ffInput.stdin);
    await vi.advanceTimersByTimeAsync(10_500);
    o.close();
    await v.done;
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 111, 112, 113, 114]);
  });

  it(`${STALE_READS} stale reads in a row are an encoder restart: one playlist starts at the new edge, a pair ends with code restart`, async () => {
    // reads 2, 3, 4 show 98..107 (newest 107, three behind the 110 taken)
    const back = (prefix: string) => (read: number) => (read >= 2 && read <= 4 ? win(98, 107, { prefix }) : win(100 + read, 109 + read, { prefix }));
    const one = provider({ master: ONE_MASTER, video: back('v') });
    const o1 = await openInput(INPUT, { guard: GUARD, fetch: one.fetch });
    if (o1.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const v1 = reader(o1.ffInput.stdin);
    await vi.advanceTimersByTimeAsync(8_500);
    o1.close();
    await v1.done;
    expect(seqs(v1.got)).toEqual([107, 108, 109, 110, 105, 106, 107]);

    const pair = provider({ video: back('v'), audio: moving('a') });
    const o2 = await openInput(INPUT, { guard: GUARD, fetch: pair.fetch });
    if (o2.ffInput.kind !== 'pipe' || !o2.ffInput.audio) throw new Error('pair expected');
    const v2 = reader(o2.ffInput.stdin);
    const a2 = reader(o2.ffInput.audio.stdin);
    await vi.advanceTimersByTimeAsync(8_500);
    await Promise.all([v2.done, a2.done]);
    expect(seqs(v2.got)).toEqual([107, 108, 109, 110]);
    expect(v2.error).toBeInstanceOf(InputEnd);
    expect((v2.error as InputEnd).code).toBe('restart');
    expect(o2.audioFault?.(false)).toBe(false);
  });

  it('a drop by more than the window is a restart at once', async () => {
    const p = provider({ master: ONE_MASTER, video: (read) => (read >= 2 ? win(read - 2, read + 7, { prefix: 'v' }) : win(100 + read, 109 + read, { prefix: 'v' })) });
    const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch });
    if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const v = reader(o.ffInput.stdin);
    await vi.advanceTimersByTimeAsync(6_500);
    o.close();
    await v.done;
    expect(seqs(v.got)).toEqual([107, 108, 109, 110, 7, 8, 9, 10]);
  });
});
